/**
 * POST /api/trace-live-analyze
 *
 * Live, intra-session TRACE chart analysis. The frontend (TRACE Live
 * dashboard, fired every 5–10 minutes) sends the latest gamma + charm +
 * delta heatmap captures plus the structured GEX landscape from the
 * existing 1-min cron pipeline. Claude returns a TraceAnalysis JSON
 * object with regime, override read, predicted close, confidence, and
 * a trade recommendation.
 *
 * Architecture (deliberately separate from /api/analyze):
 *   - /api/analyze is the long, 5+ minute pre-trade call with full
 *     market context, lessons, similar past analyses, and 7+ images.
 *   - /api/trace-live-analyze is the short, ~30–90s tick-call: 3 chart
 *     images + structured GEX text, single user message, no DB lookup
 *     before the model call. Cached system prompt = ~14.7K tokens of
 *     skills + override hierarchy + output schema.
 *
 * Persistence:
 *   - Each tick is saved to `trace_live_analyses` (jsonb full response
 *     + `vector(2000)` embedding for retrieval).
 *   - Embedding is built from a pipe-delimited summary of the analysis
 *     (gamma sign, charm direction, override fires, etc.) so similarity
 *     matches on chart topology, not on phrasing.
 *
 * Validation:
 *   - Input: `traceLiveAnalyzeBodySchema` rejects malformed payloads.
 *   - Output: `traceAnalysisSchema` validates the model's response. On
 *     validation failure we return 502 with the raw text so the frontend
 *     can surface the error and the operator can refine the prompt.
 *
 * Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY (for embeddings),
 * DATABASE_URL.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { requireEnv } from './_lib/env.js';
import logger from './_lib/logger.js';
import { traceLiveAnalyzeBodySchema } from './_lib/trace-live-types.js';
import { TRACE_LIVE_STABLE_SYSTEM_TEXT } from './_lib/trace-live-prompts.js';
import { buildTraceLiveUserContent } from './_lib/trace-live-context.js';
import {
  buildTraceLiveSummary,
  saveTraceLiveAnalysis,
} from './_lib/trace-live-db.js';
import { parseAndValidateTraceAnalysis } from './_lib/trace-live-parse.js';
import { generateEmbedding } from './_lib/embeddings.js';
import { uploadTraceLiveImages } from './_lib/trace-live-blob.js';

// 780s ceiling matches /api/analyze. A 3-image structured-output call on
// Sonnet 4.6 with adaptive thinking typically lands in 30–90s, but the
// headroom covers a future Opus 4.7 promotion (which can take 5+ min on
// max-effort runs) without a parallel vercel.json change.
export const config = { maxDuration: 780 };

const anthropic = new Anthropic({
  // 720s — leave 60s of slack under the 780s function ceiling so the SDK
  // surfaces a clean timeout instead of getting killed mid-write.
  timeout: 720_000,
  maxRetries: 2,
});

// Sonnet 4.6 keeps per-tick cost in check — the dashboard fires every
// 5–10 min during the session (~30–60× per day). Promote to
// 'claude-opus-4-7' here when we want the upgrade and can absorb the cost.
const PRIMARY_MODEL = 'claude-sonnet-4-6';

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
}

/**
 * Generate the embedding for a tick's analysis. Best-effort — returns null
 * on any failure so the row save still proceeds (we'd rather have a row
 * without an embedding than no row at all). Logged + Sentry-captured.
 */
async function buildEmbeddingBestEffort(args: {
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  analysis: Parameters<typeof buildTraceLiveSummary>[0]['analysis'];
}): Promise<number[] | null> {
  try {
    const summary = buildTraceLiveSummary(args);
    return await generateEmbedding(summary);
  } catch (err) {
    logger.error({ err }, 'TRACE-live embedding generation failed');
    Sentry.captureException(err);
    return null;
  }
}

async function callModel(
  model: string,
  userContent: ReturnType<typeof buildTraceLiveUserContent>,
): Promise<CallResult> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 64_000,
    thinking: { type: 'adaptive' },
    // 'medium' is the right setting for a tick-call read that fires every
    // 5 min during the session — the schema is now spelled out enum-by-enum,
    // so the model doesn't need 'high' to converge. 'high' was driving 9-min
    // calls; 'medium' should land in 60-120s.
    output_config: { effort: 'medium' },
    system: [
      {
        type: 'text',
        text: TRACE_LIVE_STABLE_SYSTEM_TEXT,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

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
    model,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/trace-live-analyze');
  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  // Rate limit: 6/min — covers a normal 5-min cadence with manual-retry
  // headroom. Higher than /api/analyze (3/min) since this call is cheaper.
  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-analyze',
    6,
  );
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

  const parsed = traceLiveAnalyzeBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const body = parsed.data;

  const userContent = buildTraceLiveUserContent(body);
  const startTs = Date.now();

  try {
    // No model fallback: Sonnet 4.6 is the primary cost-effective choice,
    // and the dashboard re-fires every 5–10 min, so a transient overload
    // just means the next tick succeeds. Surface the error to the operator
    // and move on.
    const result = await callModel(PRIMARY_MODEL, userContent);

    const durationMs = Date.now() - startTs;

    logger.info(
      {
        model: result.model,
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        durationMs,
        stopReason: result.stopReason,
      },
      'trace-live-analyze usage',
    );

    if (result.usage.cacheRead === 0 && result.usage.cacheWrite > 0) {
      logger.warn(
        { model: result.model },
        'Cache miss on TRACE-live system prompt — prefix may have changed',
      );
    }

    if (result.stopReason === 'refusal') {
      logger.warn({ model: result.model }, 'Claude refused TRACE-live request');
      done({ status: 422 });
      return res
        .status(422)
        .json({ error: 'Analysis was refused by the model.' });
    }

    const analysis = parseAndValidateTraceAnalysis(result.text);
    if (!analysis) {
      metrics.increment('trace_live.parse_failure');
      done({ status: 502 });
      return res.status(502).json({
        error: 'Model output failed schema validation',
        raw: result.text.slice(0, 4000),
        model: result.model,
      });
    }

    // Embed + upload images + save (all best-effort — failure here doesn't
    // block the response). Embedding and Blob upload run in parallel because
    // they're independent — saves ~1s vs sequential. Both are awaited so
    // they land before Vercel kills the runtime.
    const [embedding, imageUrls] = await Promise.all([
      buildEmbeddingBestEffort({
        capturedAt: body.capturedAt,
        spot: body.spot,
        stabilityPct: body.stabilityPct ?? null,
        analysis,
      }),
      uploadTraceLiveImages({
        capturedAt: body.capturedAt,
        images: body.images.map((img) => ({
          chart: img.chart,
          base64: img.data,
        })),
      }),
    ]);

    await saveTraceLiveAnalysis({
      capturedAt: body.capturedAt,
      spot: body.spot,
      stabilityPct: body.stabilityPct ?? null,
      analysis,
      embedding,
      imageUrls,
      model: result.model,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      durationMs,
    });

    done({ status: 200 });
    return res.status(200).json({
      analysis,
      model: result.model,
      durationMs,
      usage: result.usage,
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-analyze unhandled error');
    let errorMsg = err instanceof Error ? err.message : 'Analysis failed';
    if (err instanceof Anthropic.RateLimitError) {
      errorMsg = 'Anthropic rate limit exceeded. Try again shortly.';
    } else if (err instanceof Anthropic.AuthenticationError) {
      errorMsg = 'Anthropic API authentication error. Check API key.';
    } else if (err instanceof Anthropic.APIError) {
      errorMsg = `Analysis service error (${err.status}). Please retry.`;
    }
    return res.status(500).json({ error: errorMsg });
  }
}
