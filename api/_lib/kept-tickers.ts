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
 * in migration #188. The composite PRIMARY KEY is both the uniqueness
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

import { getDb, safeDb, safeDbVoid } from './db.js';

/**
 * Read the set of tickers shown at least once today (`date`).
 *
 * @returns the underlying_symbol array on success, or `[]` on an empty
 *          result OR on any error (DB unavailable, timeout). Never throws.
 */
export async function readKeptTickers(date: string): Promise<string[]> {
  return safeDb(async () => {
    const sql = getDb();
    const rows = (await sql`
      SELECT underlying_symbol
      FROM lottery_kept_tickers
      WHERE trade_date = ${date}::date
    `) as { underlying_symbol: string }[];
    return rows.map((r) => r.underlying_symbol);
  }, []);
}

/**
 * Persist `tickers` into the kept-set for `date`.
 *
 * No-op on empty input (avoids a needless round-trip). Issues a SINGLE
 * batched multi-row INSERT ... ON CONFLICT DO NOTHING via `unnest` so
 * concurrent cron calls and page re-renders are idempotent. Swallows all
 * errors — accumulation is best-effort and must never throw into the
 * request path.
 *
 * The caller passes the set-difference of `array_agg(DISTINCT …)` (already
 * distinct), and ON CONFLICT DO NOTHING absorbs any residual duplicates, so
 * no client-side dedup is needed.
 */
export async function addKeptTickers(
  date: string,
  tickers: string[],
): Promise<void> {
  if (tickers.length === 0) return;
  await safeDbVoid(async () => {
    const sql = getDb();
    // Single round-trip via `unnest`: binds ONE text[] param for the whole
    // batch (no per-row $N tuples, no 65535-param ceiling). Neon sends the
    // JS string array as a Postgres text[] — same pattern as path-shape.ts.
    await sql`
      INSERT INTO lottery_kept_tickers (trade_date, underlying_symbol)
      SELECT ${date}::date, t FROM unnest(${tickers}::text[]) AS t
      ON CONFLICT DO NOTHING
    `;
  });
}
