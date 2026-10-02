/**
 * Day-level embeddings for historical-analog retrieval in the analyze
 * endpoint. Sibling of `embeddings.ts` (which handles analysis-level
 * embeddings); intentionally separate module because the domain,
 * table, and text format are different.
 *
 * Flow:
 *   1. Sidecar produces a deterministic `summary` string for a date
 *      (`fetchDaySummary` → `/archive/day-summary`).
 *   2. OpenAI `text-embedding-3-large` truncated to 2000 dims produces
 *      the vector — same model/dims as `embeddings.ts` so Neon's
 *      HNSW 2000-dim index cap is respected.
 *   3. `upsertDayEmbedding` writes to the `day_embeddings` table.
 *   4. `findSimilarDays` does a pgvector cosine search.
 *
 * Policy:
 *   - All functions return nullable/empty on failure. A broken
 *     embedding call must not break the analyze endpoint.
 *   - `embedding_model` is stored per row so a model migration can
 *     A/B coexist without rewriting the table.
 */

import type { VixBucket } from './analog-range-forecast.js';
import { generateEmbedding } from './embeddings.js';
import { getDb } from './db.js';
import logger from './logger.js';
import { metrics } from './sentry.js';

export const DAY_EMBEDDING_MODEL = 'text-embedding-3-large';
export const DAY_EMBEDDING_DIMS = 2000;
const MAX_K = 50;

export interface SimilarDay {
  date: string;
  symbol: string;
  summary: string;
  distance: number;
}

/**
 * Insert or replace a day's embedding. Used by the backfill script and
 * the nightly cron. Returns true on success.
 *
 * `vixBucket` tags the row for the range forecast's regime-matched
 * cohort. A null bucket never erases one already stored.
 */
export async function upsertDayEmbedding(params: {
  date: string;
  symbol: string;
  summary: string;
  embedding: number[];
  vixBucket?: VixBucket | null;
}): Promise<boolean> {
  const { date, symbol, summary, embedding } = params;
  const vixBucket = params.vixBucket ?? null;

  if (embedding.length !== DAY_EMBEDDING_DIMS) {
    logger.error(
      { date, gotDims: embedding.length, expected: DAY_EMBEDDING_DIMS },
      'Refusing to upsert day embedding with wrong dimension',
    );
    return false;
  }
  if (!embedding.every((v) => Number.isFinite(v))) {
    logger.error({ date }, 'Refusing to upsert non-finite embedding values');
    return false;
  }

  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  try {
    await sql`
      INSERT INTO day_embeddings
        (date, symbol, summary, embedding, embedding_model, vix_bucket)
      VALUES (
        ${date}::date,
        ${symbol},
        ${summary},
        ${vectorLiteral}::vector,
        ${DAY_EMBEDDING_MODEL},
        ${vixBucket}
      )
      ON CONFLICT (date) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        summary = EXCLUDED.summary,
        embedding = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        vix_bucket = COALESCE(EXCLUDED.vix_bucket, day_embeddings.vix_bucket),
        created_at = NOW()
    `;
    return true;
  } catch (err) {
    logger.error({ err, date }, 'upsertDayEmbedding failed');
    metrics.increment('day_embeddings.upsert_error');
    return false;
  }
}

/**
 * Retrieve the top-k days whose embeddings are cosine-nearest to
 * `embedding`, drawn only from days strictly before `beforeDate`. A
 * backtest dated in the past must not retrieve days that came after it
 * (`date <> d` used to let it).
 *
 * Returns `[]` on any error rather than throwing — the analyze endpoint
 * treats analog context as additive.
 */
export async function findSimilarDays(
  embedding: number[],
  k: number,
  beforeDate: string,
): Promise<SimilarDay[]> {
  if (embedding.length !== DAY_EMBEDDING_DIMS) {
    logger.warn(
      { gotDims: embedding.length, expected: DAY_EMBEDDING_DIMS },
      'findSimilarDays: ignoring query vector with wrong dimension',
    );
    return [];
  }
  if (!embedding.every((v) => Number.isFinite(v))) {
    logger.warn({}, 'findSimilarDays: ignoring non-finite query vector');
    return [];
  }

  const safeK = Math.min(Math.max(1, Math.floor(k)), MAX_K);
  const sql = getDb();
  const vectorLiteral = `[${embedding.join(',')}]`;

  try {
    const rows = await sql`
      SELECT date, symbol, summary,
             embedding <=> ${vectorLiteral}::vector AS distance
      FROM day_embeddings
      WHERE date < ${beforeDate}::date
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${safeK}
    `;
    return rows.map((row) => {
      const rawDate = row.date;
      const dateStr =
        rawDate instanceof Date
          ? rawDate.toISOString().slice(0, 10)
          : String(rawDate).slice(0, 10);
      return {
        date: dateStr,
        symbol: row.symbol as string,
        summary: row.summary as string,
        distance: Number(row.distance),
      };
    });
  } catch (err) {
    logger.error({ err }, 'findSimilarDays query failed');
    metrics.increment('day_embeddings.query_error');
    return [];
  }
}

/**
 * Convenience: embed a summary and return similar days in one call.
 * Returns `[]` when embedding generation fails so the caller doesn't
 * need to null-check twice.
 */
export async function findSimilarDaysForSummary(
  summary: string,
  k: number,
  beforeDate: string,
): Promise<SimilarDay[]> {
  const embedding = await generateEmbedding(summary);
  if (!embedding) return [];
  return findSimilarDays(embedding, k, beforeDate);
}
