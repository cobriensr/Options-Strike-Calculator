/**
 * Rolls one trading day's `ws_gex_strike_expiry` rows into the
 * persistent `strike_exposures` archive. Preserves per-minute
 * `ts_minute` values so the Greek Heatmap's historical view can render
 * the LIVE scrubber for every lottery ticker the WS captured.
 *
 * Spec: docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md
 *
 * Idempotent via the `(date, timestamp, ticker, strike, expiry)`
 * UNIQUE constraint on `strike_exposures` — re-running for the same
 * date is a no-op for rows already present.
 *
 * 0DTE-only filter: copies rows where `expiry =
 * date(ts_minute AT TIME ZONE 'America/New_York')`. Future-expiry
 * rows still in `ws_gex_strike_expiry` (the daemon's 0DTE filter
 * hasn't fully purged them) are skipped — the heatmap is 0DTE-only.
 *
 * Delta: WS payload has no `call_delta_oi` / `put_delta_oi`, so
 * rolled-up rows have NULL delta. REST-backfilled rows retain delta;
 * the heatmap does not read delta.
 *
 * SPX → SPXW remap: UW pushes 0DTE chain data with `ticker='SPX'` on
 * both `gex_strike_expiry:SPX` and `gex_strike_expiry:SPXW`
 * subscriptions (the chains have been unified since 2022 — all
 * dailies, including 0DTE, live on the SPXW symbol). The Greek
 * Heatmap dropdown only allows SPXW, and the lottery REST backfill
 * writes SPXW. We remap on copy so `strike_exposures` is uniformly
 * SPXW-labeled and the heatmap query path doesn't need a read-side
 * alias. Mirrors `resolveStoredTicker` in `db-gex-strike-expiry.ts`.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface RollupResult {
  inserted: number;
  durationMs: number;
}

const INSERT_SELECT_SQL = `
  INSERT INTO strike_exposures (
    date, timestamp, ticker, expiry, strike, price,
    call_gamma_oi, put_gamma_oi,
    call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
    call_charm_oi, put_charm_oi,
    call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
    call_delta_oi, put_delta_oi,
    call_vanna_oi, put_vanna_oi
  )
  SELECT
    (ts_minute AT TIME ZONE 'America/New_York')::date AS date,
    ts_minute AS timestamp,
    CASE WHEN ticker = 'SPX' THEN 'SPXW' ELSE ticker END AS ticker,
    expiry,
    strike,
    price,
    call_gamma_oi,
    put_gamma_oi,
    call_gamma_ask_vol  AS call_gamma_ask,
    call_gamma_bid_vol  AS call_gamma_bid,
    put_gamma_ask_vol   AS put_gamma_ask,
    put_gamma_bid_vol   AS put_gamma_bid,
    call_charm_oi,
    put_charm_oi,
    call_charm_ask_vol  AS call_charm_ask,
    call_charm_bid_vol  AS call_charm_bid,
    put_charm_ask_vol   AS put_charm_ask,
    put_charm_bid_vol   AS put_charm_bid,
    NULL::numeric AS call_delta_oi,
    NULL::numeric AS put_delta_oi,
    call_vanna_oi,
    put_vanna_oi
  FROM ws_gex_strike_expiry
  WHERE expiry = $1::date
    AND (ts_minute AT TIME ZONE 'America/New_York')::date = $1::date
  ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
  RETURNING id
`;

type DbHandle = NeonQueryFunction<false, false> & {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * Roll all 0DTE rows for the given ET date from `ws_gex_strike_expiry`
 * into `strike_exposures`. Runs as a single INSERT...SELECT — Postgres
 * does the scan + write internally, no client-side row shuffling.
 *
 * @param db   Neon SQL handle (must support `.query(text, params)`).
 * @param date YYYY-MM-DD ET date string.
 */
export async function rollupWsGexToStrikeExposures(
  db: DbHandle,
  date: string,
): Promise<RollupResult> {
  const startedAt = Date.now();
  const result = (await db.query(INSERT_SELECT_SQL, [date])) as {
    id: number;
  }[];
  return {
    inserted: result.length,
    durationMs: Date.now() - startedAt,
  };
}
