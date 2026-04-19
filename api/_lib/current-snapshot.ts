/**
 * Materialized live-day snapshot — `current_day_snapshot` table access.
 *
 * A Vercel cron runs every 5 min during market hours to refresh this
 * table from the sidecar's DuckDB-backed archive endpoints. The
 * analyze endpoint then reads from this table instead of calling the
 * sidecar on the hot path. Two wins:
 *
 *   - Analyze latency: sidecar round-trip (500-5000 ms on a cold
 *     DuckDB query) becomes a single Neon SELECT (5-15 ms).
 *   - Sidecar contention: backfill jobs and analyze requests don't
 *     fight over the same CPU on the Railway container.
 *
 * Staleness: the snapshot is at most 5 min old during market hours.
 * Analyze calls don't need sub-minute precision on archive summary
 * data — the summary is a bird's-eye description, not a trade signal.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import { metrics } from './sentry.js';

export interface CurrentDaySnapshot {
  date: string;
  symbol: string;
  summary: string;
  features: number[];
  computedAt: Date;
  ageMs: number;
}

/**
 * Upsert a live-day snapshot. Called by the /api/cron/refresh-current-snapshot
 * handler after it pulls fresh summary + features from the sidecar.
 */
export async function upsertCurrentSnapshot(params: {
  date: string;
  symbol: string;
  summary: string;
  features: number[];
}): Promise<boolean> {
  const { date, symbol, summary, features } = params;
  if (features.length !== 60 || !features.every((v) => Number.isFinite(v))) {
    logger.error(
      { date, gotDim: features.length },
      'Refusing to upsert current_day_snapshot with malformed features',
    );
    return false;
  }

  const sql = getDb();
  const vectorLiteral = `[${features.join(',')}]`;

  try {
    await sql`
      INSERT INTO current_day_snapshot
        (date, symbol, summary, features, computed_at)
      VALUES (
        ${date}::date,
        ${symbol},
        ${summary},
        ${vectorLiteral}::vector,
        NOW()
      )
      ON CONFLICT (date) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        summary = EXCLUDED.summary,
        features = EXCLUDED.features,
        computed_at = NOW()
    `;
    return true;
  } catch (err) {
    logger.error({ err, date }, 'upsertCurrentSnapshot failed');
    metrics.increment('current_snapshot.upsert_error');
    return false;
  }
}

/**
 * Fetch the snapshot for `date`. Returns null when no snapshot exists
 * (cron hasn't run yet for this date, or the sidecar returned no data)
 * or when the row is older than `maxAgeMs`.
 *
 * `maxAgeMs` default is 30 minutes so analyze calls outside of market
 * hours still get yesterday's snapshot rather than falling through to
 * a live sidecar call. During market hours the cron runs every 5 min
 * so the row is typically <5 min old.
 */
export async function fetchCurrentSnapshot(
  date: string,
  maxAgeMs: number = 30 * 60 * 1000,
): Promise<CurrentDaySnapshot | null> {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT date, symbol, summary, features::text AS features_text, computed_at
      FROM current_day_snapshot
      WHERE date = ${date}::date
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as {
      date: Date | string;
      symbol: string;
      summary: string;
      features_text: string;
      computed_at: Date;
    };
    const ageMs = Date.now() - row.computed_at.getTime();
    if (ageMs > maxAgeMs) {
      logger.debug(
        { date, ageMs },
        'Current snapshot is stale; returning null',
      );
      return null;
    }
    // pgvector renders vectors as '[v1,v2,...]' when cast to text.
    const features = parseVectorText(row.features_text);
    if (!features || features.length !== 60) {
      logger.warn(
        { date, parsedLen: features?.length ?? 0 },
        'Current snapshot vector parse failed',
      );
      return null;
    }
    return {
      date: isoDate(row.date),
      symbol: row.symbol,
      summary: row.summary,
      features,
      computedAt: row.computed_at,
      ageMs,
    };
  } catch (err) {
    logger.error({ err, date }, 'fetchCurrentSnapshot failed');
    metrics.increment('current_snapshot.fetch_error');
    return null;
  }
}

function parseVectorText(s: string): number[] | null {
  if (!s || !s.startsWith('[') || !s.endsWith(']')) return null;
  const inside = s.slice(1, -1);
  if (!inside) return [];
  const parts = inside.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function isoDate(v: Date | string): string {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
}
