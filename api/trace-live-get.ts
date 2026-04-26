/**
 * GET /api/trace-live-get?id=N
 *
 * Fetch a single TRACE Live analysis row including the full TraceAnalysis
 * JSON and the Vercel Blob image_urls for rendering historical heatmaps.
 *
 * Authorization: owner cookie + BotID via guardOwnerEndpoint. Rate limited
 * to 120/min — historical browsing can fire several requests as the user
 * clicks through the timestamp dropdown, and the frontend caches the
 * response client-side so the practical hit rate is much lower.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerEndpoint,
  rejectIfRateLimited,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import type { TraceAnalysis } from './_lib/trace-live-types.js';
import type { TraceLiveImageUrls } from './_lib/trace-live-blob.js';

interface TraceLiveDetailRow {
  id: number;
  capturedAt: string;
  spot: number;
  stabilityPct: number | null;
  regime: string | null;
  predictedClose: number | null;
  confidence: string | null;
  overrideApplied: boolean | null;
  headline: string | null;
  imageUrls: TraceLiveImageUrls;
  analysis: TraceAnalysis | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}

function parseJsonbField<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function parseDetailRow(r: Record<string, unknown>): TraceLiveDetailRow {
  return {
    id: Number(r.id),
    capturedAt: r.captured_at as string,
    spot: Number(r.spot),
    stabilityPct: r.stability_pct == null ? null : Number(r.stability_pct),
    regime: (r.regime as string | null) ?? null,
    predictedClose:
      r.predicted_close == null ? null : Number(r.predicted_close),
    confidence: (r.confidence as string | null) ?? null,
    overrideApplied: (r.override_applied as boolean | null) ?? null,
    headline: (r.headline as string | null) ?? null,
    imageUrls: parseJsonbField<TraceLiveImageUrls>(r.image_urls) ?? {},
    analysis: parseJsonbField<TraceAnalysis>(r.full_response),
    model: (r.model as string | null) ?? null,
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    cacheReadTokens:
      r.cache_read_tokens == null ? null : Number(r.cache_read_tokens),
    cacheWriteTokens:
      r.cache_write_tokens == null ? null : Number(r.cache_write_tokens),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    createdAt: r.created_at as string,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/trace-live-get');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-get',
    120,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const sql = getDb();
    setCacheHeaders(res, 60, 120);

    const { id } = req.query;
    const idStr = typeof id === 'string' ? id : null;
    // BIGSERIAL — accept positive integer strings only.
    if (!idStr || !/^\d+$/.test(idStr)) {
      done({ status: 400 });
      return res.status(400).json({ error: 'Provide ?id=N (integer)' });
    }

    const rows = await sql`
      SELECT id, captured_at, spot, stability_pct, regime, predicted_close,
             confidence, override_applied, headline, image_urls,
             full_response, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, duration_ms, created_at
      FROM trace_live_analyses
      WHERE id = ${idStr}
      LIMIT 1
    `;

    if (rows.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Analysis not found' });
    }

    done({ status: 200 });
    return res.status(200).json(parseDetailRow(rows[0]!));
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-get endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
