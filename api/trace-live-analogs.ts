/**
 * GET /api/trace-live-analogs?id=N&k=10
 *
 * Return the K nearest-neighbor historical TRACE Live captures for a given
 * row by cosine distance over the analysis_embedding column. Each analog
 * carries the prior capture's market state plus its post-close outcome
 * (where known) so the dashboard can show the actual outcome distribution
 * next to the model's point prediction — not just the prediction in
 * isolation.
 *
 * Pattern mirrors api/_lib/embeddings.ts:findSimilarAnalyses() — same
 * <=> operator over the HNSW-indexed vector column, projecting the
 * cosine distance back as `distance` for downstream display.
 *
 * Authorization: owner cookie + BotID via guardOwnerOrGuestEndpoint. Rate limited
 * to 60/min; the embedding is stable so we can cache aggressively
 * (Cache-Control: private, max-age=300 — five minutes).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from './_lib/api-helpers.js';
import { getDb } from './_lib/db.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';

interface TraceLiveAnalog {
  id: number;
  capturedAt: string;
  spot: number;
  regime: string | null;
  predictedClose: number | null;
  actualClose: number | null;
  confidence: string | null;
  headline: string | null;
  distance: number;
  /** actualClose - predictedClose, or null if either side is missing. */
  error: number | null;
}

function parseAnalogRow(r: Record<string, unknown>): TraceLiveAnalog {
  const predictedClose =
    r.predicted_close == null ? null : Number(r.predicted_close);
  const actualClose = r.actual_close == null ? null : Number(r.actual_close);
  const error =
    actualClose != null && predictedClose != null
      ? actualClose - predictedClose
      : null;

  return {
    id: Number(r.id),
    capturedAt: r.captured_at as string,
    spot: Number(r.spot),
    regime: (r.regime as string | null) ?? null,
    predictedClose,
    actualClose,
    confidence: (r.confidence as string | null) ?? null,
    headline: (r.headline as string | null) ?? null,
    distance: Number(r.distance),
    error,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/trace-live-analogs');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const rateLimited = await rejectIfRateLimited(
    req,
    res,
    'trace-live-analogs',
    60,
  );
  if (rateLimited) {
    done({ status: 429 });
    return;
  }

  try {
    const { id, k } = req.query;

    // BIGSERIAL — accept positive integer strings only.
    const idStr = typeof id === 'string' ? id : null;
    if (!idStr || !/^\d+$/.test(idStr)) {
      done({ status: 400 });
      return res.status(400).json({ error: 'Provide ?id=N (integer)' });
    }

    // k: 1..50, default 10.
    let kNum = 10;
    if (typeof k === 'string' && k.length > 0) {
      if (!/^\d+$/.test(k)) {
        done({ status: 400 });
        return res
          .status(400)
          .json({ error: 'Provide ?k as a positive integer' });
      }
      kNum = Number.parseInt(k, 10);
      if (kNum < 1 || kNum > 50) {
        done({ status: 400 });
        return res.status(400).json({ error: 'k must be between 1 and 50' });
      }
    }

    const sql = getDb();

    // Fetch the seed embedding once and bind it as a vector literal in the
    // KNN. The earlier shape that referenced `(SELECT analysis_embedding ...)`
    // twice (in the projection AND in ORDER BY) executed the subquery
    // multiple times — Postgres doesn't reliably cache subquery results, so
    // it's cheaper to fetch once in TS and bind a single literal. Mirrors
    // the pattern in api/_lib/embeddings.ts (findSimilarAnalyses).
    const seed = await sql`
      SELECT analysis_embedding::text AS embedding_text
      FROM trace_live_analyses
      WHERE id = ${idStr}
      LIMIT 1
    `;

    if (seed.length === 0) {
      done({ status: 404 });
      return res.status(404).json({ error: 'Analysis not found' });
    }
    const embeddingText = seed[0]?.embedding_text as string | null | undefined;
    if (!embeddingText) {
      done({ status: 404 });
      return res
        .status(404)
        .json({ error: 'Analysis has no embedding (cannot compute analogs)' });
    }

    const rows = await sql`
      SELECT id,
             captured_at,
             spot,
             regime,
             predicted_close,
             actual_close,
             confidence,
             headline,
             analysis_embedding <=> ${embeddingText}::vector AS distance
      FROM trace_live_analyses
      WHERE id != ${idStr}
        AND analysis_embedding IS NOT NULL
      ORDER BY analysis_embedding <=> ${embeddingText}::vector
      LIMIT ${kNum}
    `;

    // Embedding is stable, so cache aggressively client-side.
    res.setHeader('Cache-Control', 'private, max-age=300');

    done({ status: 200 });
    return res.status(200).json({
      id: Number(idStr),
      k: kNum,
      analogs: rows.map(parseAnalogRow),
    });
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'trace-live-analogs endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
