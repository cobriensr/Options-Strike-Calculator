/**
 * Per-day "kept-tickers" DB table for the Lottery feed's MONOTONIC Q1/Q2
 * inversion-quintile suppression.
 *
 * ── WHY ────────────────────────────────────────────────────────────────
 * /api/lottery-finder suppresses chains whose ticker sits in inversion
 * quintile 1-2 (`lottery_ticker_stats.inversion_quintile`). That quintile
 * is recomputed by the detect-lottery-fires cron and can FLIP mid-session,
 * so a ticker that was shown earlier (quintile > 2) can suddenly be
 * suppressed — its chains vanish from the server feed.
 *
 * The invariant we want: once a ticker has been SHOWN (quintile > 2) at any
 * point today, it stays shown for the rest of the day even if its quintile
 * later flips into Q1/Q2. We accumulate every ever-shown ticker into the
 * `lottery_kept_tickers` table (trade_date, underlying_symbol); the
 * suppression predicate then also keeps any ticker found there.
 *
 * ── DESIGN ─────────────────────────────────────────────────────────────
 * Backed by `lottery_kept_tickers(trade_date, underlying_symbol)` created
 * in migration #187. The composite PRIMARY KEY is both the uniqueness
 * constraint (dedups concurrent writers) and the lookup index. Date-scoped
 * rows replace the prior Redis set (lf:kept:<date>) so records survive
 * Redis eviction and can be read page-independently by both the feed and
 * ticker-counts endpoints. The writer (lottery-finder.ts, Phase 3) derives
 * the ever-shown set from the full ranked CTE (no LIMIT), closing the
 * page-0-only gap.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────
 * Both helpers swallow ALL errors (DB unavailable / timeout): a dead DB
 * must degrade to today's pure-live suppression, never crash the request.
 * When the read returns `[]`, the predicate's `= ANY('{}'::text[])` term
 * matches nothing → exact pre-existing behavior. Errors surface as a
 * `db.error` metric only, mirroring last-good-cache.ts / schwab.ts.
 */

import { getDb } from './db.js';
import { metrics } from './sentry.js';

/**
 * Read the set of tickers shown at least once today (`date`).
 *
 * @returns the underlying_symbol array on success, or `[]` on an empty
 *          result OR on any error (DB unavailable, timeout). Never throws.
 */
export async function readKeptTickers(date: string): Promise<string[]> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT underlying_symbol
      FROM lottery_kept_tickers
      WHERE trade_date = ${date}
    `) as { underlying_symbol: string }[];
    return rows.map((r) => r.underlying_symbol);
  } catch {
    metrics.increment('db.error');
    return [];
  }
}

/**
 * Persist `tickers` into the kept-set for `date`.
 *
 * No-op on empty input (avoids a needless round-trip). Deduplicates input
 * via Set before building the INSERT. Issues a SINGLE batched multi-row
 * INSERT ... ON CONFLICT DO NOTHING so concurrent cron calls and page
 * re-renders are idempotent. Swallows all errors — accumulation is
 * best-effort and must never throw into the request path.
 */
export async function addKeptTickers(
  date: string,
  tickers: string[],
): Promise<void> {
  const unique = [...new Set(tickers)];
  if (unique.length === 0) return;
  try {
    const sql = getDb();
    // Build a single multi-row INSERT using sql.query() — one round-trip
    // regardless of how many tickers we're adding (batched-insert convention,
    // see feedback_batched_inserts.md). Each ticker contributes two params:
    // the date and the symbol.
    const params: string[] = [];
    const tuples: string[] = [];
    for (const ticker of unique) {
      const base = params.length;
      params.push(date, ticker);
      tuples.push(`($${base + 1}, $${base + 2})`);
    }
    const stmt = `
      INSERT INTO lottery_kept_tickers (trade_date, underlying_symbol)
      VALUES ${tuples.join(', ')}
      ON CONFLICT DO NOTHING
    `;
    await sql.query(stmt, params);
  } catch {
    metrics.increment('db.error');
  }
}
