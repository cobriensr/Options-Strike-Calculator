/**
 * POST /api/periscope-chat
 *
 * Manual Periscope chart analysis endpoint. The frontend uploads 1-3
 * screenshots (Periscope chart + GEX heat map + Charm heat map), picks
 * Read or Debrief mode, and gets back a structured Claude analysis using
 * the `periscope` skill. Response + embedding are persisted to
 * `periscope_analyses` (migration 103) for retrieval and calibration.
 *
 * Architecture mirrors /api/trace-live-analyze, with one extension
 * (Phase 9 — two Opus 4.7 calls per submission):
 *   - Pass 1 (extractChartStructure): a fast vision-only Opus call
 *     reads the spot + cone bounds from the chart screenshot. The
 *     extracted fingerprint feeds the retrieval embedding so we
 *     match past reads by chart topology, not by prose context note.
 *   - Pass 2 (callModel): the full analysis with calibration +
 *     retrieval blocks injected as cached system prefixes.
 *   - NDJSON streaming response with 30s keepalive pings (Opus 4.7 +
 *     adaptive thinking high effort can take 3-9 minutes; non-streaming
 *     POST gets killed by intermediate proxies at ~5 min idle).
 *   - Cached system prompt (the periscope skill content, ~10K tokens
 *     stable, ttl: 1h ephemeral cache).
 *   - Per-image Vercel Blob upload via uploadPeriscopeImages (best-effort).
 *   - Embedding from buildPeriscopeSummary() over structured fields +
 *     prose excerpt — text-embedding-3-large @ 2000 dims.
 *
 * Response parsing:
 *   - Claude is instructed (via the skill) to append a fenced JSON code
 *     block at the end of the prose with {spot, cone_lower, cone_upper,
 *     long_trigger, short_trigger, regime_tag}. This endpoint extracts
 *     the LAST fenced ```json block, parses it, and stores the typed
 *     fields. Prose is saved with the JSON block stripped.
 *   - On parse failure: row still saves with NULL structured fields and
 *     a Sentry event. Better to have prose without typed columns than no
 *     row at all.
 *
 * Auth: owner-only (rejectIfNotOwner via guardOwnerEndpoint). This is
 * Anthropic-API-backed and incurs per-call cost; guest path is
 * intentionally not enabled.
 *
 * Spec: docs/superpowers/specs/periscope-chat-2026-04-30.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { requireEnv } from './_lib/env.js';
import logger from './_lib/logger.js';
import { periscopeChatBodySchema } from './_lib/validation.js';
import { uploadPeriscopeImages } from './_lib/periscope-blob.js';
import { generateEmbedding } from './_lib/embeddings.js';
import {
  buildPeriscopeSummary,
  fetchParentChain,
  fetchPeriscopeAnalysisById,
  savePeriscopeAnalysis,
  type ParentChainRow,
  type PeriscopeStructuredFields,
  type PeriscopeMode,
  type PeriscopeParentRead,
} from './_lib/periscope-db.js';
import { buildCalibrationBlock } from './_lib/periscope-calibration.js';
import {
  buildUserContent,
  formatHeatMapBlock,
  parseStructuredFields,
  synthesizeStructuralProse,
} from './_lib/periscope-prompts.js';
import { buildRetrievalBlock } from './_lib/periscope-retrieval.js';
import {
  extractChartStructure,
  extractHeatMapStrikes,
  type HeatMapExtraction,
  type HeatMapImage,
} from './_lib/periscope-extract.js';
import { runCachedAnthropicCall } from './_lib/anthropic-call.js';
import { buildFlowContextBlock } from './_lib/periscope-flow-context.js';
import {
  ctWallClockToUtcMs,
  fetchSPXSpotAtTimestamp,
  type SpotLookupResult,
} from './_lib/spx-candles.js';

// 780s ceiling matches /api/analyze and /api/trace-live-analyze. Opus
// 4.7 with adaptive-thinking high-effort + 3 images can take 5-9 min on
// cold cache; the headroom keeps the function alive across that window.
export const config = { maxDuration: 780 };

const anthropic = new Anthropic({
  // 60s slack under the 780s function ceiling so the SDK surfaces a
  // clean timeout instead of getting killed mid-write.
  timeout: 720_000,
  maxRetries: 2,
});

const MODEL = 'claude-opus-4-7';

// Skill text loaded once at module init. The .claude/skills/**/*.md
// glob is in vercel.json includeFiles so the file ships with the
// function bundle; SKILLS_DIR resolves relative to this module.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', '.claude', 'skills');
const PERISCOPE_SKILL = readFileSync(
  join(SKILLS_DIR, 'periscope', 'SKILL.md'),
  'utf8',
);

// Stable system prompt prefix. The skill content already includes
// role-setting ("You are an expert SPX 0DTE trader..."), the framework,
// the no-cheat protocol, and the JSON-block-output instruction. Keeping
// the wrapper minimal means the cached prefix is the skill itself —
// editing the skill invalidates the cache, which is the desired
// invalidation boundary.
const SYSTEM_TEXT = PERISCOPE_SKILL;

// VolSignals MM-heuristics references file. Distilled from former-MM
// commentary (Imran Lakha / VolSignals) — Phase 4 of the periscope-chat
// overhaul spec. Loaded as a separate cached system block so updates to
// the references invalidate that block independently of the skill.
//
// Defensive fallback: the .claude/skills/**/*.md glob in vercel.json
// includeFiles already covers this path (see commit b8453638), but if
// the file fails to load for any reason we log a Sentry event and
// continue without it. The skill works without references —
// references-as-augmentation is the intent.
let PERISCOPE_REFERENCES: string | null = null;
try {
  PERISCOPE_REFERENCES = readFileSync(
    join(SKILLS_DIR, 'periscope', 'references', 'vol-signals-mm-heuristics.md'),
    'utf8',
  );
} catch (err) {
  // Module-init Sentry capture: surfaced to telemetry but does not
  // crash the function bundle. Subsequent reads will simply skip the
  // references block — fall back to skill-only behavior.
  Sentry.captureException(err, {
    tags: { module: 'periscope-chat', stage: 'references_load' },
  });
}

// Header prepended to the references file when injected as a cached
// system block. Tells the model how to interpret the verification tags
// and how the references layer relative to the skill body.
const PERISCOPE_REFERENCES_HEADER = `# Companion reference — VolSignals MM heuristics

Below are distilled heuristics from former-MM commentary (Imran Lakha / VolSignals). Use them as INFORMED-PRIOR for dealer-flow reasoning when relevant to the read in front of you. Each entry has a verification tag — \`[verified]\` (first-principles math), \`[plausible]\` (Imran's framing, internally consistent), \`[era-specific]\` (pre-2024 / low-VIX-regime context, may not apply today), \`[contested]\` (conflicts with other framings — flag explicitly when citing). Quote tags in parentheses when you cite. The skill body in the prior system block remains the source of truth on Periscope mechanics; these heuristics layer on top, they don't override.

---

`;

interface CallResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  stopReason: string | null;
  model: string;
  /** Full response payload, JSONB-saved for reproducibility. */
  raw: Record<string, unknown>;
}

async function callModel(
  userContent: Anthropic.Messages.ContentBlockParam[],
  calibrationBlock: string | null,
  retrievalBlock: string | null,
): Promise<CallResult> {
  // Streaming via runCachedAnthropicCall (Phase 1f primitive). Streaming is
  // required for the same reason as /api/trace-live-analyze: at high
  // effort on a 3-image call the model can spend 5-9 min generating, and
  // a non-streaming POST holds the connection idle long enough for
  // Vercel's egress NAT (or AWS-side networking) to close it mid-flight.
  //
  // System prompt structure (Anthropic supports up to 4 cache breakpoints):
  //   1. Skill text (cached) — stable per skill version
  //   2. References (cached, optional) — VolSignals MM-heuristics
  //      companion file. Stable across days; invalidates only when the
  //      distillation file is updated. Skipped if the file failed to
  //      load at module init.
  //   3. Calibration block (cached, optional) — changes when user
  //      stars/unstars or re-tags a starred read; daily-stable in
  //      practice. Skipped entirely when no gold examples exist.
  //   4. Retrieval block (cached, optional) — top-K past reads with
  //      embedding similarity to the user's context note. Skipped
  //      when no context or no above-floor matches. Cache hit rate
  //      depends on the user repeating the same context phrasing,
  //      which they often do ("morning open", "midday flush", etc.)
  //
  // Order matters: highest-stability content first so a downstream
  // dynamic block (calibration or retrieval) can't poison cache for
  // the more stable upstream blocks.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: SYSTEM_TEXT,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
  if (PERISCOPE_REFERENCES != null) {
    systemBlocks.push({
      type: 'text',
      text: PERISCOPE_REFERENCES_HEADER + PERISCOPE_REFERENCES,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }
  if (calibrationBlock != null) {
    systemBlocks.push({
      type: 'text',
      text: calibrationBlock,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }
  if (retrievalBlock != null) {
    systemBlocks.push({
      type: 'text',
      text: retrievalBlock,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }

  const result = await runCachedAnthropicCall({
    client: anthropic,
    systemBlocks,
    messages: [{ role: 'user', content: userContent }],
    primaryModel: MODEL,
    maxTokens: 64_000,
    effort: 'high',
    fallbackMetric: 'periscope_chat.opus_fallback',
  });

  // Reconstruct the JSONB-saved `fullResponse` payload from the helper's
  // outputs. The helper intentionally normalizes the SDK response shape;
  // this object preserves the same keys persisted historically (text +
  // usage + stop_reason + model) so the periscope_analyses.full_response
  // column stays stable.
  const raw: Record<string, unknown> = {
    text: result.text,
    usage: {
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      cache_read_input_tokens: result.usage.cacheRead,
      cache_creation_input_tokens: result.usage.cacheWrite,
    },
    stop_reason: result.stopReason,
    model: result.modelUsed,
  };

  return {
    text: result.text,
    usage: result.usage,
    stopReason: result.stopReason,
    model: result.modelUsed,
    raw,
  };
}

async function buildEmbeddingBestEffort(args: {
  mode: PeriscopeMode;
  tradingDate: string;
  structured: PeriscopeStructuredFields;
  proseText: string;
}): Promise<number[] | null> {
  try {
    const summary = buildPeriscopeSummary(args);
    return await generateEmbedding(summary);
  } catch (err) {
    logger.error({ err }, 'periscope-chat embedding generation failed');
    Sentry.captureException(err);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/periscope-chat');
  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  // 6/min — generous given the manual / human-paced flow. The user
  // typically captures 1-4 reads + debriefs per trading day, so this
  // is mostly to cap accidental double-clicks and abuse.
  const rateLimited = await rejectIfRateLimited(req, res, 'periscope-chat', 6);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    requireEnv('ANTHROPIC_API_KEY');
  } catch {
    done({ status: 500, error: 'missing_api_key' });
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const parsed = periscopeChatBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const body = parsed.data;

  // NDJSON streaming response: keepalive pings every 30s prevent
  // intermediate proxies from killing the connection during the long
  // Anthropic call.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const keepalive = setInterval(() => {
    try {
      res.write(JSON.stringify({ ping: true }) + '\n');
    } catch {
      /* response already closed — clearInterval in finally */
    }
  }, 30_000);

  const capturedAt = new Date().toISOString();
  const startTs = Date.now();

  // Resolve trading_date up-front from explicit body fields. read_date
  // is the new authoritative source (Phase 6B); body.tradingDate is a
  // legacy back-compat field that wins only when read_date isn't set
  // (callers in transition).
  const tradingDate =
    body.read_date ?? body.tradingDate ?? capturedAt.slice(0, 10);

  try {
    // Phase 6B: look up SPX spot at the user-picked (read_date, read_time)
    // FIRST so a missing-data condition fails fast before we burn an
    // Anthropic call. Today-vs-back-read is gated by comparing read_date
    // against today's CT calendar date — live reads must hit an exact
    // bar; back-reads may snap within ±2 min.
    const todayCt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const isLiveRead = body.read_date === todayCt;

    let spotLookup: SpotLookupResult | null = null;
    try {
      spotLookup = await fetchSPXSpotAtTimestamp({
        date: body.read_date,
        time: body.read_time,
        toleranceMin: 2,
        isLiveRead,
      });
    } catch (err) {
      Sentry.captureException(err);
      logger.error(
        { err, date: body.read_date, time: body.read_time },
        'periscope-chat: spot lookup threw',
      );
    }
    if (spotLookup == null) {
      const msg = isLiveRead
        ? `No SPX candle for ${body.read_date} ${body.read_time} CT within ±2 min — data may not be fresh yet, retry in 1 min.`
        : `No SPX intraday history for ${body.read_date} ${body.read_time} CT within ±2 min.`;
      done({ status: 422, error: 'no_spx_candle' });
      res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      return;
    }

    // Build the read_time TIMESTAMPTZ for persistence. ctWallClockToUtcMs
    // returns a ms epoch in UTC corresponding to the CT wall-clock pair.
    const readTimeMs = ctWallClockToUtcMs(body.read_date, body.read_time);
    if (readTimeMs == null) {
      const msg = `Could not resolve read_time for ${body.read_date} ${body.read_time}.`;
      done({ status: 422, error: 'bad_read_time' });
      res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      return;
    }
    const readTimeIso = new Date(readTimeMs).toISOString();

    // Phase 9 — two Opus 4.7 calls per submission:
    //   Pass 1 (extractChartStructure): vision-only extraction of spot +
    //          cone bounds from the chart screenshot. Drives retrieval
    //          embedding so we match past reads by chart topology rather
    //          than by the user's prose context note.
    //   Pass 2 (callModel): the full analysis with calibration + retrieval
    //          blocks injected as cached system prefixes.
    //
    // Extraction runs in parallel with the calibration fetch and (for
    // intraday/debrief) the parent-read fetch — all three are independent.
    const parentFetch: Promise<PeriscopeParentRead | null> =
      body.mode !== 'pre_trade' && body.parentId != null
        ? fetchPeriscopeAnalysisById(body.parentId)
        : Promise.resolve(null);
    const parentChainFetch: Promise<ParentChainRow[]> =
      body.mode !== 'pre_trade' && body.parentId != null
        ? fetchParentChain(body.parentId)
        : Promise.resolve([]);

    // Pass 1B inputs: locate gex / charm heat-map images. Skipped when
    // neither is present (pre_trade with chart-only is allowed; intraday
    // requires all three at the frontend layer per the spec).
    const gexImg = body.images.find((i) => i.kind === 'gex');
    const charmImg = body.images.find((i) => i.kind === 'charm');
    const heatMapInput: { gex?: HeatMapImage; charm?: HeatMapImage } = {};
    if (gexImg)
      heatMapInput.gex = { data: gexImg.data, mediaType: gexImg.mediaType };
    if (charmImg)
      heatMapInput.charm = {
        data: charmImg.data,
        mediaType: charmImg.mediaType,
      };
    const hasHeatMaps = gexImg != null || charmImg != null;

    const heatMapFetch: Promise<HeatMapExtraction | null> = hasHeatMaps
      ? extractHeatMapStrikes(heatMapInput, anthropic)
      : Promise.resolve(null);

    const [extraction, heatMaps, calibrationBlock, parentRead, parentChain] =
      await Promise.all([
        extractChartStructure({ images: body.images }, anthropic),
        heatMapFetch,
        buildCalibrationBlock(body.mode),
        parentFetch,
        parentChainFetch,
      ]);

    // Debrief / intraday parent integrity checks. Hard-fail rather than
    // letting Claude proceed without a real parent to anchor against.
    if (body.mode === 'debrief' || body.mode === 'intraday') {
      if (parentRead == null) {
        const msg = `Parent read #${body.parentId} not found. Run today's pre-trade read first.`;
        logger.warn(
          { parentId: body.parentId, mode: body.mode },
          'periscope-chat: parent missing',
        );
        done({ status: 404, error: 'parent_not_found' });
        res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        return;
      }
      if (body.mode === 'debrief' && parentRead.mode === 'debrief') {
        const msg = `Parent #${parentRead.id} is a debrief — debriefs can only be linked to a pre_trade or intraday read.`;
        logger.warn(
          { parentId: parentRead.id, parentMode: parentRead.mode },
          'periscope-chat: debrief parent is itself a debrief',
        );
        done({ status: 422, error: 'parent_is_debrief' });
        res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        return;
      }
      if (tradingDate !== parentRead.tradingDate) {
        const msg = `Chart is dated ${tradingDate} but the linked parent is for ${parentRead.tradingDate}. The chain must stay within the same trading day.`;
        logger.warn(
          {
            parentId: parentRead.id,
            parentDate: parentRead.tradingDate,
            chartDate: extraction?.chartDate ?? null,
            readDate: body.read_date,
            effectiveDate: tradingDate,
          },
          'periscope-chat: chart/parent date mismatch',
        );
        done({ status: 422, error: 'date_mismatch' });
        res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        return;
      }
    }

    // Format the Pass 1B OCR result as a user-content text block. Skipped
    // when no heat-map images were uploaded or extraction failed entirely.
    const heatMapBlock = heatMaps != null ? formatHeatMapBlock(heatMaps) : null;

    // Build the authoritative spot directive. Claude is instructed
    // explicitly to use this number as the current spot rather than
    // reading the chart's red dotted line.
    const spotDirective = [
      `Read time: ${body.read_date} ${body.read_time} CT.`,
      `Authoritative SPX spot at read time: ${spotLookup.price.toFixed(2)} (source: ${spotLookup.source}).`,
      'Use this as the current spot for all interpretation; do NOT use the chart red dotted spot line.',
    ].join(' ');

    // Flow-alert context (Phase 1.5 of the periscope-chat overhaul spec).
    // Best-effort: a failure here MUST NOT lose the read. The helper
    // already swallows DB errors and returns null, but we layer a second
    // try/catch as defense-in-depth in case the formatter throws on
    // malformed input. asOf is the read_time TIMESTAMPTZ so back-reads
    // anchor against the slice they're for, not the capture moment.
    let flowBlock: string | null = null;
    try {
      flowBlock = await buildFlowContextBlock({
        mode: body.mode,
        spot: spotLookup.price,
        asOf: new Date(readTimeMs),
      });
    } catch (err) {
      Sentry.captureException(err);
      logger.warn(
        { err, mode: body.mode },
        'periscope-chat flow-context block build failed — continuing without it',
      );
    }

    // Build the user content AFTER the parent fetch so the debrief
    // preamble can inline the parent's prose + structured fields, and
    // intraday/debrief see the full chain.
    const userContent = buildUserContent({
      mode: body.mode,
      parentId: body.parentId ?? null,
      parentRead,
      parentChain,
      heatMapBlock,
      flowBlock,
      spotDirective,
      images: body.images,
    });

    // Build the retrieval query text. When extraction succeeded, use the
    // structural summary so the query embedding has the same shape as
    // stored embeddings (both are buildPeriscopeSummary outputs). If
    // extraction failed, retrieval is skipped entirely.
    const retrievalQueryText: string | null = extraction
      ? buildPeriscopeSummary({
          mode: body.mode,
          tradingDate,
          structured: extraction.structured,
          proseText: synthesizeStructuralProse(extraction.structured),
        })
      : null;

    const retrievalBlock = await buildRetrievalBlock({
      mode: body.mode,
      queryText: retrievalQueryText,
    });

    if (extraction) {
      logger.info(
        {
          mode: body.mode,
          spot: extraction.structured.spot,
          cone_lower: extraction.structured.cone_lower,
          cone_upper: extraction.structured.cone_upper,
          chart_date: extraction.chartDate,
        },
        'periscope-chat extraction succeeded',
      );
    } else {
      logger.warn(
        { mode: body.mode },
        'periscope-chat extraction failed — retrieval skipped',
      );
    }

    if (hasHeatMaps) {
      if (heatMaps != null) {
        logger.info(
          {
            mode: body.mode,
            gexCount: heatMaps.gex.length,
            charmCount: heatMaps.charm.length,
          },
          'periscope-chat heat-map OCR succeeded',
        );
      } else {
        logger.warn(
          { mode: body.mode },
          'periscope-chat heat-map OCR failed — block omitted',
        );
      }
    }

    const result = await callModel(
      userContent,
      calibrationBlock,
      retrievalBlock,
    );
    const durationMs = Date.now() - startTs;

    logger.info(
      {
        mode: body.mode,
        parentId: body.parentId ?? null,
        model: result.model,
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        durationMs,
        stopReason: result.stopReason,
      },
      'periscope-chat usage',
    );

    if (result.usage.cacheRead === 0 && result.usage.cacheWrite > 0) {
      logger.warn(
        { model: result.model, mode: body.mode },
        'Cache miss on periscope system prompt — prefix may have changed',
      );
    }

    if (result.stopReason === 'refusal') {
      // Stop the keepalive BEFORE the final write so a queued ping can't
      // race the refusal envelope onto the wire (Phase 6E ordering fix).
      clearInterval(keepalive);
      logger.warn(
        { model: result.model, mode: body.mode },
        'Claude refused periscope-chat request',
      );
      done({ status: 422 });
      res.write(JSON.stringify({ ok: false, error: 'refusal' }) + '\n');
      return;
    }

    const { prose, structured, parseOk } = parseStructuredFields(result.text);

    // Phase 6E: split the previous Promise.all([buildEmbedding, uploadImages])
    // into independent best-effort calls so a Vercel Blob outage cannot
    // sink the persisted row. Each helper already swallows its own
    // failures and returns null/empty on error; we awaitAllSettled-style
    // here just to keep the wall-clock parallel.
    const embeddingPromise = buildEmbeddingBestEffort({
      mode: body.mode,
      tradingDate,
      structured,
      proseText: prose,
    });
    const imageUrlsPromise = (async () => {
      try {
        return await uploadPeriscopeImages({
          capturedAt,
          images: body.images.map((img) => ({
            kind: img.kind,
            base64: img.data,
          })),
        });
      } catch (err) {
        Sentry.captureException(err);
        logger.error(
          { err },
          'periscope-chat image upload threw — continuing without urls',
        );
        return {};
      }
    })();
    const [embedding, imageUrls] = await Promise.all([
      embeddingPromise,
      imageUrlsPromise,
    ]);

    const id = await savePeriscopeAnalysis({
      capturedAt,
      tradingDate,
      readTime: readTimeIso,
      spotAtReadTime: spotLookup.price,
      spotSource: spotLookup.source,
      mode: body.mode,
      parentId: body.parentId ?? null,
      userContext: null,
      imageUrls,
      proseText: prose,
      fullResponse: result.raw,
      embedding,
      structured,
      parseOk,
      model: result.model,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      durationMs,
    });

    logger.info(
      { id, mode: body.mode, durationMs, model: result.model },
      'periscope-chat persisted',
    );

    // Stop the keepalive BEFORE writing the final success envelope so a
    // queued ping line can't be interleaved into the response stream
    // mid-flush (Phase 6E ordering fix).
    clearInterval(keepalive);
    done({ status: 200 });
    res.write(
      JSON.stringify({
        ok: true,
        id,
        mode: body.mode,
        prose,
        structured,
        parseOk,
        spotAtReadTime: spotLookup.price,
        spotSource: spotLookup.source,
        readTime: readTimeIso,
        model: result.model,
        durationMs,
        usage: result.usage,
      }) + '\n',
    );
  } catch (err) {
    // Phase 6E: clearInterval at the TOP of the catch so a queued ping
    // can't race the error envelope onto the wire.
    clearInterval(keepalive);
    Sentry.captureException(err);
    logger.error({ err, mode: body.mode }, 'periscope-chat unhandled error');
    done({ status: 500, error: 'unhandled' });
    let errorMsg = err instanceof Error ? err.message : 'Analysis failed';
    if (err instanceof Anthropic.RateLimitError) {
      errorMsg = 'Anthropic rate limit exceeded. Try again shortly.';
    } else if (err instanceof Anthropic.AuthenticationError) {
      errorMsg = 'Anthropic API authentication error. Check API key.';
    } else if (err instanceof Anthropic.APIError) {
      errorMsg = `Analysis service error (${err.status}). Please retry.`;
    }
    res.write(JSON.stringify({ ok: false, error: errorMsg }) + '\n');
  } finally {
    // Defensive: clearInterval is idempotent, so a duplicate call after
    // an early-return branch is a no-op. res.end() must run on every
    // exit path so connections don't dangle.
    clearInterval(keepalive);
    res.end();
  }
}
