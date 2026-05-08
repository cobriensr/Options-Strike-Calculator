/**
 * POST /api/periscope-chat
 *
 * Manual Periscope chart analysis endpoint. The frontend uploads 1-3
 * screenshots (Periscope chart + GEX heat map + Charm heat map), picks
 * a mode (`pre_trade` / `intraday` / `debrief`), supplies `read_date`
 * and `read_time`, and gets back a structured trading playbook
 * generated via the `periscope` skill. Response + embedding are
 * persisted to `periscope_analyses` (rebuilt in migration 130, original
 * shape from migration 103) for retrieval, calibration, and ML
 * similarity over chained read trajectories.
 *
 * Architecture (three Opus 4.7 calls per submission):
 *   - Pass 1A (extractChartStructure): vision-only, reads spot,
 *     cone_lower, cone_upper, chart_date from the chart screenshot.
 *   - Pass 1B (extractHeatMapStrikes): vision-only, reads top-N
 *     positive/negative MM-attributed Net GEX + Net Charm strikes
 *     from the heat-map screenshots (skipped when no heat maps
 *     uploaded — common for pre_trade chart-only flow).
 *   - Pass 2 (callModel): full analysis with high-effort thinking.
 *     System prompt has 4 cached text blocks (skill, VolSignals
 *     references, calibration, retrieval). User content carries the
 *     mode header, authoritative spot from `index_candles_1m` lookup,
 *     parent-chain summary (intraday/debrief), `ws_flow_alerts` block,
 *     heat-map injected values, and the image attachments.
 *   - NDJSON streaming response with 30s keepalive pings (Opus 4.7 +
 *     adaptive thinking high effort can take 3-9 minutes; non-streaming
 *     POST gets killed by intermediate proxies at ~5 min idle).
 *   - Per-image Vercel Blob upload via uploadPeriscopeImages
 *     (best-effort, isolated from embedding so a blob failure cannot
 *     lose the persisted row).
 *   - Embedding from buildPeriscopeSummary() over structured fields +
 *     mode + prose excerpt — text-embedding-3-large @ 2000 dims.
 *
 * Response parsing:
 *   - Claude appends a trailing fenced JSON block per the skill's
 *     "Structured trading playbook output" section (spot, cone_lower,
 *     cone_upper, long_trigger, short_trigger, regime_tag, bias,
 *     trade_types_recommended/avoided, key_levels, expected_dealer_
 *     behavior, confidence, confidence_basis). Parsing delegates to
 *     `parseTrailingJsonBlock` (api/_lib/json-fence.ts).
 *   - On parse failure: row still saves with NULL structured fields,
 *     `parse_ok=false`, and a Sentry event. Better to have prose
 *     without typed columns than no row at all.
 *
 * Auth: owner-only (rejectIfNotOwner via guardOwnerEndpoint). This is
 * Anthropic-API-backed and incurs per-call cost; guest path is
 * intentionally not enabled.
 *
 * Specs:
 *   - docs/superpowers/specs/periscope-chat-2026-04-30.md (original)
 *   - docs/superpowers/specs/periscope-chat-overhaul-2026-05-05.md
 *     (3-mode lifecycle, DB rebuild, Pass 1B heat-map OCR,
 *     ws_flow_alerts integration, references-block wiring)
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
  type PeriscopeExtractionResult,
} from './_lib/periscope-extract.js';
import { synthesizeFromDb } from './_lib/periscope-synthesize.js';
import {
  fetchActiveLessons,
  formatLessonsBlock,
} from './_lib/periscope-lessons.js';
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

/**
 * Race a promise against a timer (Tier 2 review fix). Anthropic vision
 * extraction calls are bounded — Pass 1A reads spot+cone, Pass 1B reads
 * the heat maps — and have no business taking more than 60s. Without a
 * shorter timeout, a single hung extraction would block on the
 * SDK-level 720s ceiling and burn most of the function's budget for
 * the actual analysis call.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
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
  //   2. References + recent lessons (cached, optional) — VolSignals
  //      MM-heuristics companion file with an optional
  //      "## Recent lessons learned" sub-section appended at request
  //      time from the periscope_lessons table (curate-periscope-lessons
  //      cron). Stable across days; invalidates only when the
  //      distillation file is updated OR when the active-lessons set
  //      changes (Sunday cron run -> Monday's first call rebuilds, all
  //      subsequent reads cached). Skipped if the references file
  //      failed to load at module init.
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
    // Defensive shape (b) per spec: skip the DB roundtrip entirely on
    // cold-start days when no lessons exist. Failure to fetch is
    // best-effort — log + continue with the references file alone.
    let lessonsBlock = '';
    try {
      const activeLessons = await fetchActiveLessons(15);
      if (activeLessons.length > 0) {
        lessonsBlock = formatLessonsBlock(activeLessons);
      }
    } catch (err) {
      Sentry.captureException(err, {
        tags: { module: 'periscope-chat', stage: 'lessons_fetch' },
      });
      logger.warn(
        { err },
        'periscope-chat: lessons fetch failed — continuing without',
      );
    }
    systemBlocks.push({
      type: 'text',
      text: PERISCOPE_REFERENCES_HEADER + PERISCOPE_REFERENCES + lessonsBlock,
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
    } catch (err) {
      // Tier 2 review fix: keep the failure low-severity (this is just
      // a keepalive; the real response path's error handler still runs)
      // but log it so a recurring pattern shows up rather than
      // disappearing into a silent catch. clearInterval still runs in
      // the finally block on the main flow.
      logger.debug({ err }, 'periscope-chat: keepalive write failed');
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
    // Anthropic call. Live-vs-back-read is gated by both the read_date
    // matching today's CT calendar date AND the read_time being near the
    // current CT wall clock (±5 min). Same-day reads with read_time well
    // in the past (e.g. a 15:00 CT debrief submitted at 16:35 CT, or a
    // 10:00 CT recap at noon) are back-reads — they should snap within
    // ±2 min instead of hard-failing on the exact-bar requirement. The
    // hard-fail mode exists for the narrow case where the user is
    // submitting at HH:MM and the cron may not have written the bar yet
    // (data freshness, not back-read intent).
    const now = new Date();
    const todayCt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const nowCtParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const nowCtHour =
      Number.parseInt(
        nowCtParts.find((p) => p.type === 'hour')?.value ?? '00',
        10,
      ) % 24;
    const nowCtMinute = Number.parseInt(
      nowCtParts.find((p) => p.type === 'minute')?.value ?? '00',
      10,
    );
    const nowCtMinuteOfDay = nowCtHour * 60 + nowCtMinute;
    const [readHourStr, readMinuteStr] = body.read_time.split(':');
    const readMinuteOfDay =
      Number.parseInt(readHourStr ?? '0', 10) * 60 +
      Number.parseInt(readMinuteStr ?? '0', 10);
    const minutesFromNow = Math.abs(readMinuteOfDay - nowCtMinuteOfDay);
    const LIVE_FRESHNESS_MIN = 5;
    const isLiveRead =
      body.read_date === todayCt && minutesFromNow <= LIVE_FRESHNESS_MIN;

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
    //
    // Tier 2 review fix — non-essential context fetches are wrapped in
    // .catch() so a transient DB / Neon hiccup degrades to "no
    // calibration" / "no parent chain" instead of failing the whole
    // submission. The handler downstream already accepts null/empty for
    // each.
    const parentFetch: Promise<PeriscopeParentRead | null> =
      body.mode !== 'pre_trade' && body.parentId != null
        ? fetchPeriscopeAnalysisById(body.parentId).catch((err: unknown) => {
            Sentry.captureException(err);
            logger.warn(
              { err, parentId: body.parentId },
              'periscope-chat: parent fetch failed — treating as missing',
            );
            return null;
          })
        : Promise.resolve(null);
    const parentChainFetch: Promise<ParentChainRow[]> =
      body.mode !== 'pre_trade' && body.parentId != null
        ? fetchParentChain(body.parentId).catch((err: unknown) => {
            Sentry.captureException(err);
            logger.warn(
              { err, parentId: body.parentId },
              'periscope-chat: parent chain fetch failed — continuing without chain',
            );
            return [];
          })
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

    // Tier 2 review fix — Pass 1A and Pass 1B are vision-only extraction
    // calls and are best-effort (extraction nullability already handled
    // downstream). Run via Promise.allSettled with a 60s per-call timeout
    // so a hung Pass 1B can never block Pass 1A from finishing in seconds.
    // Pass 1A is similarly bounded — if extraction hangs, we'd rather
    // log + continue with retrieval skipped than burn the function budget.
    const calibrationBlockP = buildCalibrationBlock(body.mode).catch(
      (err: unknown) => {
        Sentry.captureException(err);
        logger.warn(
          { err, mode: body.mode },
          'periscope-chat: calibration block fetch failed — continuing without',
        );
        return null;
      },
    );

    // No-screenshots path: synthesize Pass 1A + Pass 1B from
    // periscope_snapshots + cone_levels. The user's whole goal of the
    // periscope-scraper service was "click analyze and have Claude
    // read the live data" — when images.length === 0, that's the
    // request and we use the DB instead of vision OCR.
    const useDbSynthesis = body.images.length === 0;

    const heatMapFetch: Promise<HeatMapExtraction | null> = hasHeatMaps
      ? extractHeatMapStrikes(heatMapInput, anthropic)
      : Promise.resolve(null);

    let extraction: PeriscopeExtractionResult | null;
    let heatMaps: HeatMapExtraction | null;
    let calibrationBlock: Awaited<typeof calibrationBlockP>;
    let parentRead: Awaited<typeof parentFetch>;
    let parentChain: Awaited<typeof parentChainFetch>;

    if (useDbSynthesis) {
      // No images — skip the vision passes entirely. Run synthesizer
      // alongside the calibration / parent fetches.
      const [synthesized, calBlock, pRead, pChain] = await Promise.all([
        synthesizeFromDb({
          tradingDate,
          readTimeIso,
          spot: spotLookup.price,
        }).catch((err: unknown) => {
          Sentry.captureException(err);
          logger.error(
            { err, tradingDate, readTimeIso },
            'periscope-chat: DB synthesis threw',
          );
          return null;
        }),
        calibrationBlockP,
        parentFetch,
        parentChainFetch,
      ]);

      if (synthesized == null) {
        const msg = `No stored Periscope data for ${body.read_date} ${body.read_time} CT — wait for the scraper to publish the next slot, or upload screenshots manually.`;
        done({ status: 422, error: 'no_periscope_data' });
        res.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        return;
      }

      extraction = synthesized.extraction;
      heatMaps = synthesized.heatMaps;
      calibrationBlock = calBlock;
      parentRead = pRead;
      parentChain = pChain;
      logger.info(
        {
          mode: body.mode,
          tradingDate,
          hasCone: extraction.structured.cone_lower != null,
          gexStrikes: heatMaps?.gex.length ?? 0,
          charmStrikes: heatMaps?.charm.length ?? 0,
        },
        'periscope-chat: using DB synthesis (no images uploaded)',
      );
    } else {
      // Tier 2 review fix — Pass 1A and Pass 1B are vision-only extraction
      // calls and are best-effort (extraction nullability already handled
      // downstream). Run via Promise.allSettled with a 60s per-call timeout
      // so a hung Pass 1B can never block Pass 1A from finishing in seconds.
      // Pass 1A is similarly bounded — if extraction hangs, we'd rather
      // log + continue with retrieval skipped than burn the function budget.
      const [[extractionSettled, heatMapSettled], calBlock, pRead, pChain] =
        await Promise.all([
          Promise.allSettled([
            withTimeout(
              extractChartStructure({ images: body.images }, anthropic),
              60_000,
              'pass1a',
            ),
            withTimeout(heatMapFetch, 60_000, 'pass1b'),
          ]),
          calibrationBlockP,
          parentFetch,
          parentChainFetch,
        ]);

      extraction =
        extractionSettled.status === 'fulfilled'
          ? extractionSettled.value
          : null;
      if (extractionSettled.status === 'rejected') {
        Sentry.captureException(extractionSettled.reason);
        logger.warn(
          { err: extractionSettled.reason, mode: body.mode },
          'periscope-chat: pass 1A extraction failed/timeout — retrieval will be skipped',
        );
      }

      heatMaps =
        heatMapSettled.status === 'fulfilled' ? heatMapSettled.value : null;
      if (heatMapSettled.status === 'rejected') {
        Sentry.captureException(heatMapSettled.reason);
        logger.warn(
          { err: heatMapSettled.reason, mode: body.mode },
          'periscope-chat: pass 1B heat-map OCR failed/timeout — block omitted',
        );
      }

      calibrationBlock = calBlock;
      parentRead = pRead;
      parentChain = pChain;
    }

    // Tier 2 review fix — Fix 3: cross-check that the chart's date label
    // (read by Pass 1A) matches the user-selected trading date. The
    // parent-trading-date guard below hard-blocks chain mismatches; this
    // is the lighter cousin for the "user picked the wrong read_date for
    // this chart upload" case. Sentry-warn only — do NOT block.
    if (extraction?.chartDate != null && tradingDate !== extraction.chartDate) {
      logger.warn(
        {
          chartDateFromExtraction: extraction.chartDate,
          tradingDate,
          readDate: body.read_date,
          mode: body.mode,
        },
        'periscope-chat: extracted chart_date disagrees with trading_date — possible misuploaded chart',
      );
      Sentry.captureMessage('periscope-chat: chart_date mismatch', {
        level: 'warning',
        tags: { mode: body.mode },
        extra: {
          chartDateFromExtraction: extraction.chartDate,
          tradingDate,
          readDate: body.read_date,
        },
      });
    }

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
    //
    // When the inputs come from DB synthesis (no chart image), Claude
    // cannot read the cone bounds visually — they live only in
    // extraction.structured.cone_lower/cone_upper which is used for
    // retrieval/persistence, not the prompt itself. Inject them into
    // the spot directive so the prompt carries the bounds explicitly.
    const spotDirectiveLines = [
      `Read time: ${body.read_date} ${body.read_time} CT.`,
      `Authoritative SPX spot at read time: ${spotLookup.price.toFixed(2)} (source: ${spotLookup.source}).`,
      'Use this as the current spot for all interpretation; do NOT use the chart red dotted spot line.',
    ];
    if (
      useDbSynthesis &&
      extraction?.structured.cone_lower != null &&
      extraction.structured.cone_upper != null
    ) {
      const cl = extraction.structured.cone_lower;
      const cu = extraction.structured.cone_upper;
      const width = cu - cl;
      spotDirectiveLines.push(
        `Straddle cone bounds (from cone_levels DB, computed at the 9:31 ET ATM-straddle anchor): lower ${cl.toFixed(2)}, upper ${cu.toFixed(2)}, width ${width.toFixed(2)} pts. Use these as the cone in your structured output (cone_lower, cone_upper) and frame inside-cone vs outside-cone targets against them.`,
      );
    }
    if (useDbSynthesis) {
      spotDirectiveLines.push(
        'NOTE: this read is using stored Periscope data (no screenshots uploaded). The heat-map block below carries top positive + top negative gamma + charm strikes from periscope_snapshots for the slot. Treat the heat-map values as the per-strike structural map; the chart visual is unavailable.',
      );
    }
    const spotDirective = spotDirectiveLines.join(' ');

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
    // Tier 2 review fix: tag Anthropic failures by class so Sentry
    // dashboards can split rate-limit / auth / generic-API spikes
    // independently. The raw exception is still captured so the SDK
    // class is preserved on the issue page.
    let kind: 'rate_limit' | 'auth' | 'api_error' | 'unknown' = 'unknown';
    if (err instanceof Anthropic.RateLimitError) kind = 'rate_limit';
    else if (err instanceof Anthropic.AuthenticationError) kind = 'auth';
    else if (err instanceof Anthropic.APIError) kind = 'api_error';
    Sentry.captureException(err, {
      tags: { module: 'periscope-chat', kind, mode: body.mode },
    });
    logger.error(
      { err, mode: body.mode, kind },
      'periscope-chat unhandled error',
    );
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
