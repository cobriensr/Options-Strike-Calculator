/**
 * POST /api/analyze
 *
 * Chart analysis powered by Claude Opus 4.7 with adaptive thinking.
 * Accepts Market Tide, Net Flow, and Periscope screenshots plus
 * calculator context. Returns a comprehensive trading plan.
 *
 * Supports three modes (passed via context.mode):
 *   - "entry"   (default): Pre-trade analysis with structure, delta, strikes, hedge, entries
 *   - "midday":  Mid-day re-analysis comparing current flow to earlier recommendation
 *   - "review":  End-of-day review of what happened vs what was recommended
 *
 * Environment: ANTHROPIC_API_KEY
 */

import { createHash } from 'node:crypto';
import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  rejectIfRateLimited,
  guardOwnerEndpoint,
  respondIfInvalid,
} from './_lib/api-helpers.js';
import { saveAnalysis, saveDarkPoolSnapshot, getDb } from './_lib/db.js';
import {
  analyzeBodySchema,
  analysisResponseSchema,
  type AnalysisResponse,
} from './_lib/validation.js';
import logger from './_lib/logger.js';
import { requireEnv } from './_lib/env.js';
import {
  type EffortLevel,
  SYSTEM_PROMPT_PART1,
  SYSTEM_PROMPT_PART2,
} from './_lib/analyze-prompts.js';
import { MARKET_MECHANICS_CONTEXT } from './_lib/market-mechanics.js';
import { SPOTGAMMA_MECHANICS_CONTEXT } from './_lib/spotgamma-mechanics.js';
import { getCalibrationExample } from './_lib/analyze-calibration.js';
import {
  buildAnalysisContext,
  parseEntryTimeAsUtc,
} from './_lib/analyze-context.js';
import {
  buildAnalysisSummary,
  generateEmbedding,
  saveAnalysisEmbedding,
} from './_lib/embeddings.js';
import { runAnalysisPreCheck } from './_lib/analyze-precheck.js';
import { getETDateStr } from '../src/utils/timezone.js';

// Allow up to 13 minutes for Opus with adaptive thinking
export const config = { maxDuration: 780 };

// Module-level singleton — reads ANTHROPIC_API_KEY from env on first API call.
// Reused across requests for connection pooling.
const anthropic = new Anthropic({
  timeout: 720_000, // 12 minutes — Opus with adaptive thinking can take 5+ min
  maxRetries: 3, // SDK retries with exponential backoff (0.5s → 1s → 2s)
});

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/analyze');
  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }
  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;
  // Rate limit: max 3 analyses per minute (each call hits Claude Opus with images)
  const rateLimited = await rejectIfRateLimited(req, res, 'analyze', 3);
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
  const parsed = analyzeBodySchema.safeParse(req.body);
  if (respondIfInvalid(parsed, res, done)) return;
  const { images, context } = parsed.data;

  // Build analysis context (fetches flow, GEX, candles, dark pool, etc.)
  const {
    content,
    mode,
    lessonsBlock,
    similarAnalysesBlock,
    darkPoolClusters,
  } = await buildAnalysisContext(images, context);

  // Derive analysisDate and asOf for the pre-check (same logic as analyze-context.ts)
  const analysisDate =
    (context.selectedDate as string | undefined) ?? getETDateStr(new Date());
  const asOf = parseEntryTimeAsUtc(
    (context.entryTime as string | undefined) ?? null,
    analysisDate,
  );

  // Run lightweight pre-check with Sonnet to fetch any additional data Claude
  // needs. Uses ~500 tokens of input (vs 75K for the main call). Falls back to
  // null on any error — the main call is completely unaffected.
  const extraContext = await runAnalysisPreCheck(
    anthropic,
    context,
    analysisDate,
    asOf,
  );

  // Stable system prompt (cached 1h) — lessons appended outside cache boundary
  // Calibration example is mode-specific (entry/midday/review) so each mode
  // gets its own cache entry. Placed between rules and output format so the
  // model reads rules → sees what correct output looks like → sees output schema.
  const calibration = getCalibrationExample(mode);
  const stableSystemText =
    SYSTEM_PROMPT_PART1 +
    '\n' +
    MARKET_MECHANICS_CONTEXT +
    '\n' +
    SPOTGAMMA_MECHANICS_CONTEXT +
    '\n' +
    calibration +
    '\n' +
    SYSTEM_PROMPT_PART2;
  const promptHash = createHash('sha256')
    .update(stableSystemText)
    .digest('hex')
    .slice(0, 12);
  const analyzeStart = Date.now();

  // Send keepalive pings every 30s to prevent proxy/browser idle disconnects.
  // Vercel's edge proxy and browsers kill idle connections after ~5-10 minutes.
  // Opus with adaptive thinking can take 5-10 minutes of silence before any
  // response data arrives, so we write periodic newlines to keep the pipe open.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  const keepalive = setInterval(() => {
    try {
      res.write(JSON.stringify({ ping: true }) + '\n');
    } catch {
      // Response already closed — clear interval in finally block
    }
  }, 30_000);

  try {
    // Build shared system parts (used by both tool-loop and final stream)
    const systemParts = [
      {
        type: 'text' as const,
        text: stableSystemText,
        cache_control: { type: 'ephemeral', ttl: '1h' } as const,
      },
      // Lessons and similar analyses change frequently — kept outside cache boundary
      ...(lessonsBlock ? [{ type: 'text' as const, text: lessonsBlock }] : []),
      ...(similarAnalysesBlock
        ? [{ type: 'text' as const, text: similarAnalysesBlock }]
        : []),
    ];

    const toolMessages: MessageParam[] = [
      {
        role: 'user' as const,
        content: extraContext
          ? [...content, { type: 'text' as const, text: extraContext }]
          : content,
      },
    ];

    // ── Final streaming call ───────────────────────────────────
    // Stream the response — Anthropic sends headers immediately with streaming,
    // which avoids Node's undici headersTimeout (300s) killing long Opus requests.
    // The SDK handles transient retries (429, 5xx, connection errors) internally.
    // Our wrapper only handles the Opus → Sonnet model fallback.
    const streamRequest = (
      model: string,
      maxTokens: number,
      effort: EffortLevel,
    ) =>
      anthropic.messages
        .stream({
          model,
          max_tokens: maxTokens,
          thinking: { type: 'adaptive' },
          output_config: { effort },
          system: systemParts,
          // Pass the full tool-augmented message history so the model sees
          // all previously fetched data when writing its final analysis.
          messages: toolMessages,
        } as unknown as Parameters<typeof anthropic.messages.stream>[0])
        .finalMessage();
    let data: Awaited<ReturnType<typeof streamRequest>>;
    let usedModel = 'claude-opus-4-7';
    try {
      data = await streamRequest('claude-opus-4-7', 128000, 'medium');
    } catch (error_) {
      // Only fall back on availability issues — request errors won't succeed on any model
      if (
        error_ instanceof Anthropic.BadRequestError ||
        error_ instanceof Anthropic.AuthenticationError ||
        error_ instanceof Anthropic.PermissionDeniedError
      ) {
        throw error_;
      }
      logger.info(
        { err: error_ },
        'Opus unavailable, falling back to Sonnet 4.6',
      );
      metrics.increment('analyze.opus_fallback');
      usedModel = 'claude-sonnet-4-6';
      data = await streamRequest('claude-sonnet-4-6', 64000, 'high');
    }
    // Log usage for cost monitoring
    if (data.usage) {
      const u = data.usage;
      logger.info(
        {
          model: usedModel,
          mode: String(mode),
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
        },
        'analyze usage',
      );
      // Alert on cache misses — helps catch silent invalidators
      if (
        u.cache_read_input_tokens === 0 &&
        (u.cache_creation_input_tokens ?? 0) > 0
      ) {
        logger.warn(
          { model: usedModel },
          'Cache miss on system prompt — prefix may have changed',
        );
      }
    }
    // Check stop reason before parsing
    if (data.stop_reason === 'refusal') {
      logger.warn({ model: usedModel }, 'Claude refused analysis request');
      done({ status: 422 });
      return res
        .status(422)
        .json({ error: 'Analysis request was refused by the model.' });
    }
    if (data.stop_reason === 'max_tokens') {
      logger.warn({ model: usedModel }, 'Response truncated at max_tokens');
    }
    // Filter to text blocks only — thinking blocks are excluded
    const text =
      data.content
        ?.filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('') ?? '';
    let analysis: AnalysisResponse | null = null;
    try {
      // Strip markdown code fences if Claude wraps output despite instructions
      const jsonStr = text.trim().startsWith('```')
        ? text
            .trim()
            .replace(/^```(?:json)?\s*\n?/, '')
            .replace(/\n?```\s*$/, '')
        : text.trim();
      const parsed = JSON.parse(jsonStr);
      const validated = analysisResponseSchema.safeParse(parsed);
      if (validated.success) {
        analysis = validated.data;
      } else {
        logger.warn(
          {
            issues: validated.error.issues.slice(0, 5),
            stopReason: data.stop_reason,
          },
          'Analysis response schema mismatch — using raw parsed output',
        );
        analysis = parsed as AnalysisResponse;
      }
    } catch {
      logger.error(
        { raw: text.slice(0, 500), stopReason: data.stop_reason },
        'Analysis response JSON parse failed',
      );
    }
    // Stream corruption: Claude said "end_turn" but the JSON is incomplete.
    // This happens when SSE content chunks are lost over long-running streams
    // (10+ min with adaptive thinking). Return 502 so the frontend retry
    // loop fires automatically instead of showing broken output.
    if (!analysis && text.length > 0) {
      metrics.increment('analyze.stream_corruption');
      logger.error(
        { stopReason: data.stop_reason, textLen: text.length },
        'Returning 502 — response text present but unparseable',
      );
      metrics.analyzeCall({
        model: usedModel,
        mode: String(mode),
        durationMs: Date.now() - analyzeStart,
        imageCount: images.length,
      });
      done({ status: 502 });
      res.write(
        JSON.stringify({
          error:
            'Analysis completed but the response was corrupted in transit. Retrying…',
        }) + '\n',
      );
      return res.end();
    }
    // Save to Postgres before responding (Vercel kills the function after res.json).
    // Retry the save up to 2 extra times — after a long Anthropic retry the first
    // Neon call can fail due to connection pressure / cold-start latency.
    if (analysis) {
      const DB_SAVE_ATTEMPTS = 3;
      let saved = false;
      for (let dbAttempt = 1; dbAttempt <= DB_SAVE_ATTEMPTS; dbAttempt++) {
        try {
          const db = getDb();
          const date =
            (context.selectedDate as string | undefined) ??
            getETDateStr(new Date());
          const entryTime =
            (context.entryTime as string | undefined) ?? 'unknown';
          const rows = await db`
            SELECT id FROM market_snapshots WHERE date = ${date} AND entry_time = ${entryTime}
          `;
          const snapshotId = rows.length > 0 ? (rows[0]!.id as number) : null;
          await saveAnalysis(
            context,
            analysis as Parameters<typeof saveAnalysis>[1],
            snapshotId,
            promptHash,
          );
          metrics.dbSave('analyses', true);
          saved = true;
          // Persist dark pool clusters alongside the analysis
          if (darkPoolClusters && darkPoolClusters.length > 0) {
            try {
              await saveDarkPoolSnapshot({
                date,
                timestamp: new Date().toISOString(),
                snapshotId,
                spxPrice: (context.spx as number) ?? null,
                clusters: darkPoolClusters,
              });
            } catch (error_) {
              logger.error({ err: error_ }, 'dark pool snapshot save failed');
            }
          }
          // Embed the analysis for historical retrieval (~500ms).
          // Awaited to ensure completion before Vercel kills the runtime.
          // Failures are logged but don't affect the response.
          try {
            const summary = buildAnalysisSummary({
              date,
              mode,
              vix: context.vix != null ? Number(context.vix) : null,
              vix1d: context.vix1d != null ? Number(context.vix1d) : null,
              spx: context.spx != null ? Number(context.spx) : null,
              structure: analysis!.structure,
              confidence: analysis!.confidence,
              suggestedDelta: analysis!.suggestedDelta ?? null,
              hedge: analysis!.hedge?.recommendation ?? null,
              vixTermShape: (context.vixTermSignal as string) ?? null,
              gexRegime: (context.regimeZone as string) ?? null,
              dayOfWeek: (context.dowLabel as string) ?? null,
            });
            const embedding = await generateEmbedding(summary);
            if (embedding) {
              await saveAnalysisEmbedding(date, entryTime, mode, embedding);
            }
          } catch (error_) {
            logger.error(
              { err: error_ },
              'analysis embedding generation failed',
            );
          }
          break;
        } catch (error_) {
          logger.error(
            { err: error_, attempt: dbAttempt },
            'analyze DB save failed',
          );
          if (dbAttempt < DB_SAVE_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 500 * dbAttempt));
          }
        }
      }
      if (!saved) {
        metrics.dbSave('analyses', false);
        logger.error('analyze DB save exhausted all retries');
      }
    }
    metrics.analyzeCall({
      model: usedModel,
      mode: String(mode),
      durationMs: Date.now() - analyzeStart,
      imageCount: images.length,
    });
    done({ status: 200 });
    res.write(JSON.stringify({ analysis, raw: text, model: usedModel }) + '\n');
    return res.end();
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'analyze unhandled error');
    // Map Anthropic SDK errors to client-friendly messages using typed exceptions
    let errorMsg = err instanceof Error ? err.message : 'Analysis failed';
    if (err instanceof Anthropic.RateLimitError) {
      errorMsg = 'Anthropic rate limit exceeded. Wait a moment and retry.';
    } else if (err instanceof Anthropic.AuthenticationError) {
      errorMsg = 'Anthropic API authentication error. Check API key.';
    } else if (err instanceof Anthropic.APIError) {
      errorMsg = `Analysis service error (${err.status}). Please retry.`;
    }
    res.write(JSON.stringify({ error: errorMsg }) + '\n');
    return res.end();
  } finally {
    clearInterval(keepalive);
  }
}
