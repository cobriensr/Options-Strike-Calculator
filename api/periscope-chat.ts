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
  savePeriscopeAnalysis,
  type PeriscopeStructuredFields,
  type PeriscopeMode,
} from './_lib/periscope-db.js';
import { buildCalibrationBlock } from './_lib/periscope-calibration.js';
import {
  buildUserContent,
  parseStructuredFields,
  synthesizeStructuralProse,
} from './_lib/periscope-prompts.js';
import { buildRetrievalBlock } from './_lib/periscope-retrieval.js';
import { extractChartStructure } from './_lib/periscope-extract.js';

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

// Skill text loaded once at module init. The .claude/skills/**/SKILL.md
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
  // Streaming for the same reason as /api/trace-live-analyze: at high
  // effort on a 3-image call the model can spend 5-9 min generating, and
  // a non-streaming POST holds the connection idle long enough for
  // Vercel's egress NAT (or AWS-side networking) to close it mid-flight.
  // .finalMessage() gives the same Message shape we'd get from .create().
  //
  // System prompt structure (Anthropic supports up to 4 cache breakpoints):
  //   1. Skill text (cached) — stable per skill version
  //   2. Calibration block (cached, optional) — changes when user
  //      stars/unstars or re-tags a starred read; daily-stable in
  //      practice. Skipped entirely when no gold examples exist.
  //   3. Retrieval block (cached, optional) — top-K past reads with
  //      embedding similarity to the user's context note. Skipped
  //      when no context or no above-floor matches. Cache hit rate
  //      depends on the user repeating the same context phrasing,
  //      which they often do ("morning open", "midday flush", etc.)
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: SYSTEM_TEXT,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
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

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 64_000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: systemBlocks,
    messages: [{ role: 'user', content: userContent }],
  });

  const response = await stream.finalMessage();

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => ('text' in c ? c.text : ''))
    .join('');

  return {
    text,
    usage: {
      input: response.usage.input_tokens ?? 0,
      output: response.usage.output_tokens ?? 0,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
    stopReason: response.stop_reason ?? null,
    model: response.model,
    raw: response as unknown as Record<string, unknown>,
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
  // Default trading_date to the capture day. If extraction succeeds and
  // returns a valid chart_date, we override below with the date the
  // chart was actually FOR — back-reads of yesterday's chart shouldn't
  // be tagged with today's date.
  let tradingDate = capturedAt.slice(0, 10);
  const userContent = buildUserContent({
    mode: body.mode,
    parentId: body.parentId ?? null,
    images: body.images,
  });
  const startTs = Date.now();

  try {
    // Phase 9 — two Opus 4.7 calls per submission:
    //   Pass 1 (extractChartStructure): vision-only extraction of spot +
    //          cone bounds from the chart screenshot. Drives retrieval
    //          embedding so we match past reads by chart topology rather
    //          than by the user's prose context note.
    //   Pass 2 (callModel): the full analysis with calibration + retrieval
    //          blocks injected as cached system prefixes.
    //
    // Extraction runs in parallel with the calibration fetch (independent
    // work). Retrieval depends on extraction output, so it's sequential
    // afterward. When extraction fails, we fall back to embedding the
    // user's prose context note (the legacy Phase 8 path).
    const [extraction, calibrationBlock] = await Promise.all([
      extractChartStructure({ images: body.images }),
      buildCalibrationBlock(body.mode),
    ]);

    // Override trading_date with the chart's actual date when extraction
    // pulled it. This makes back-reads correctly tagged: if the user
    // submits a 4/30 chart on 5/1, trading_date = 4/30 (chart date),
    // captured_at = 5/1 (request time). The two columns intentionally
    // diverge for back-reads.
    if (extraction?.chartDate) {
      tradingDate = extraction.chartDate;
    }

    // Build the retrieval query text. When extraction succeeded, use the
    // structural summary so the query embedding has the same shape as
    // stored embeddings (both are buildPeriscopeSummary outputs).
    //
    // Important: stored rows carry an 800-char prose excerpt that
    // dominates the cosine similarity. If we left proseText='' here, the
    // query vector would be all-structure / no-prose and would mostly
    // retrieve rows whose tails happen to coincide rather than rows with
    // analogous structure. We synthesize a short prose sentence carrying
    // the same structural levels so the query has a prose-shaped tail
    // that semantically overlaps with reads whose actual prose discusses
    // similar spot / cone levels. Cheap, no migration required.
    //
    // If extraction failed, retrieval is skipped entirely.
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
      logger.warn(
        { model: result.model, mode: body.mode },
        'Claude refused periscope-chat request',
      );
      done({ status: 422 });
      res.write(JSON.stringify({ ok: false, error: 'refusal' }) + '\n');
      return;
    }

    const { prose, structured } = parseStructuredFields(result.text);

    const [embedding, imageUrls] = await Promise.all([
      buildEmbeddingBestEffort({
        mode: body.mode,
        tradingDate,
        structured,
        proseText: prose,
      }),
      uploadPeriscopeImages({
        capturedAt,
        images: body.images.map((img) => ({
          kind: img.kind,
          base64: img.data,
        })),
      }),
    ]);

    const id = await savePeriscopeAnalysis({
      capturedAt,
      tradingDate,
      mode: body.mode,
      parentId: body.parentId ?? null,
      userContext: null,
      imageUrls,
      proseText: prose,
      fullResponse: result.raw,
      embedding,
      structured,
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

    done({ status: 200 });
    res.write(
      JSON.stringify({
        ok: true,
        id,
        mode: body.mode,
        prose,
        structured,
        model: result.model,
        durationMs,
        usage: result.usage,
      }) + '\n',
    );
  } catch (err) {
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
    clearInterval(keepalive);
    res.end();
  }
}
