/**
 * Day-features backend for historical-analog retrieval (Phase C).
 *
 * Parallel to `day-embeddings.ts` but uses a 60-dim numeric feature
 * vector computed on the sidecar (first-hour minute-close percent-
 * changes) instead of an OpenAI text embedding. Scale-free and
 * cosine-friendly, directly captures morning path shape.
 *
 * Why a second backend rather than replacing day-embeddings.ts:
 * we want to A/B-compare cohort quality on real analyze calls before
 * committing to one method. The two modules share almost nothing at
 * runtime — different tables, different dimensions, different
 * providers — so keeping them separate avoids a leaky abstraction.
 *
 * Policy mirrors day-embeddings.ts: nullable/empty on failure, never
 * throw, warn-log only (not Sentry) on individual failures.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { metrics } from './sentry.js';

export const DAY_FEATURES_DIM = 60;
export const DAY_FEATURES_SET = 'first_hour_pct_change_v1';
const MAX_K = 50;

export interface SimilarDayByFeatures {
  date: string;
  symbol: string;
  distance: number;
}

function validVector(v: number[]): boolean {
  return v.length === DAY_FEATURES_DIM && v.every((x) => Number.isFinite(x));
}

/**
 * Insert or replace a day's feature vector. Used by backfill + cron.
 */
export async function upsertDayFeatures(params: {
  date: string;
  symbol: string;
  features: number[];
}): Promise<boolean> {
  const { date, symbol, features } = params;

  if (!validVector(features)) {
    logger.error(
      { date, gotDim: features.length },
      'Refusing to upsert day features with wrong shape',
    );
    return false;
  }

  const sql = getDb();
  const vectorLiteral = `[${features.join(',')}]`;

  try {
    await sql`
      INSERT INTO day_features
        (date, symbol, features, feature_set)
      VALUES (
        ${date}::date,
        ${symbol},
        ${vectorLiteral}::vector,
        ${DAY_FEATURES_SET}
      )
      ON CONFLICT (date) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        features = EXCLUDED.features,
        feature_set = EXCLUDED.feature_set,
        created_at = NOW()
    `;
    return true;
  } catch (err) {
    logger.error({ err, date }, 'upsertDayFeatures failed');
    metrics.increment('day_features.upsert_error');
    return false;
  }
}

/**
 * Retrieve top-k days whose feature vectors are cosine-nearest to
 * `features`, excluding `excludeDate` from the results. Returns [] on
 * any error so callers can treat analogs as additive context.
 */
export async function findSimilarDaysByFeatures(
  features: number[],
  k: number,
  excludeDate: string,
): Promise<SimilarDayByFeatures[]> {
  if (!validVector(features)) {
    logger.warn(
      { gotDim: features.length },
      'findSimilarDaysByFeatures: ignoring malformed vector',
    );
    return [];
  }

  const safeK = Math.min(Math.max(1, Math.floor(k)), MAX_K);
  const sql = getDb();
  const vectorLiteral = `[${features.join(',')}]`;

  try {
    const rows = await sql`
      SELECT date, symbol,
             features <=> ${vectorLiteral}::vector AS distance
      FROM day_features
      WHERE date <> ${excludeDate}::date
      ORDER BY features <=> ${vectorLiteral}::vector
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
        distance: Number(row.distance),
      };
    });
  } catch (err) {
    logger.error({ err }, 'findSimilarDaysByFeatures query failed');
    metrics.increment('day_features.query_error');
    return [];
  }
}
