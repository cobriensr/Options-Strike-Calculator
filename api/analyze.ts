/**
 * POST /api/analyze
 *
 * Chart analysis powered by Claude Opus 4.6 with adaptive thinking.
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

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  checkBot,
} from './_lib/api-helpers.js';
import { saveAnalysis, saveDarkPoolSnapshot, getDb } from './_lib/db.js';
import {
  analyzeBodySchema,
  analysisResponseSchema,
  type AnalysisResponse,
} from './_lib/validation.js';
import logger from './_lib/logger.js';
import {
  type EffortLevel,
  SYSTEM_PROMPT_PART1,
  SYSTEM_PROMPT_PART2,
} from './_lib/analyze-prompts.js';
import { getCalibrationExample } from './_lib/analyze-calibration.js';
import { buildAnalysisContext } from './_lib/analyze-context.js';

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
  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    return res.status(403).json({ error: 'Access denied' });
  }
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) {
    done({ status: 401 });
    return ownerCheck;
  }
  // Rate limit: max 3 analyses per minute (each call hits Claude Opus with images)
  const rateLimited = await rejectIfRateLimited(req, res, 'analyze', 3);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    done({ status: 500, error: 'missing_api_key' });
    return res.status(500).json({ error: 'Server configuration error' });
  }
  const parsed = analyzeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    done({ status: 400 });
    return res.status(400).json({
      error: firstError?.message ?? 'Invalid request body',
    });
  }
  const { images, context } = parsed.data;

  // Build analysis context (fetches flow, GEX, candles, dark pool, etc.)
  const { content, mode, lessonsBlock, darkPoolClusters } =
    await buildAnalysisContext(images, context);

  // Stable system prompt (cached 1h) — lessons appended outside cache boundary
  // Calibration example is mode-specific (entry/midday/review) so each mode
  // gets its own cache entry. Placed between rules and output format so the
  // model reads rules → sees what correct output looks like → sees output schema.
  const calibration = getCalibrationExample(mode);
  const stableSystemText =
    SYSTEM_PROMPT_PART1 + '\n' + calibration + '\n' + SYSTEM_PROMPT_PART2;
  const analyzeStart = Date.now();
  try {
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
          system: [
            {
              type: 'text' as const,
              text: stableSystemText,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
            // Lessons change more frequently — kept outside cache boundary
            ...(lessonsBlock
              ? [{ type: 'text' as const, text: lessonsBlock }]
              : []),
          ],
          messages: [{ role: 'user' as const, content }],
        } as unknown as Parameters<typeof anthropic.messages.stream>[0])
        .finalMessage();
    let data: Awaited<ReturnType<typeof streamRequest>>;
    let usedModel = 'claude-opus-4-6';
    try {
      data = await streamRequest('claude-opus-4-6', 128000, 'high');
    } catch (opusErr) {
      // Only fall back on availability issues — request errors won't succeed on any model
      if (
        opusErr instanceof Anthropic.BadRequestError ||
        opusErr instanceof Anthropic.AuthenticationError ||
        opusErr instanceof Anthropic.PermissionDeniedError
      ) {
        throw opusErr;
      }
      logger.info(
        { err: opusErr },
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
            new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/New_York',
            });
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
            } catch (dpSaveErr) {
              logger.error(
                { err: dpSaveErr },
                'dark pool snapshot save failed',
              );
            }
          }
          break;
        } catch (dbErr) {
          logger.error(
            { err: dbErr, attempt: dbAttempt },
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
    return res.status(200).json({
      analysis,
      raw: text,
      model: usedModel,
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'analyze unhandled error');
    // Map Anthropic SDK errors to client-friendly messages using typed exceptions
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(502).json({
        error: 'Anthropic rate limit exceeded. Wait a moment and retry.',
      });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res
        .status(502)
        .json({ error: 'Anthropic API authentication error. Check API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({
        error: `Analysis service error (${err.status}). Please retry.`,
      });
    }
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Analysis failed',
    });
  }
}
