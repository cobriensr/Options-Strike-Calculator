/**
 * Fixtures for the real-SQL (pglite) tests of the flow repair: the cron's
 * api/__tests__/fire-flow-repair-pglite.test.ts and the two scripts,
 * scripts/_lib/ticker-flow-backfill-pglite.test.ts and
 * scripts/_lib/fire-flow-correction-pglite.test.ts. The fire tables and the
 * weights store are built from the REAL migrations, one row per helper call,
 * and the two net-flow tables the series is read from.
 *
 * This file lives in api/__tests__/ and not in scripts/: Vercel's build
 * type-checks all of api/ (tsconfig.api.json), and .vercelignore strips
 * scripts/, so a test under api/ may not import from scripts/.
 */

import type { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

/**
 * In order: lottery_finder_fires (#110) and the columns the score and the flow
 * need (#124, #126, #154, #158, #167, #168, #177, #178), silent_boom_alerts
 * (#134), the flow tables (#121 WS, #122 history), then the weights store
 * (#208, which adds `score_version`) and #209 (which rebuilds `combined_score`
 * and the view #177 made, as production has them).
 */
const FIRE_MIGRATIONS = [
  110, 121, 122, 124, 126, 134, 154, 158, 167, 168, 177, 178, 208, 209,
];

export async function buildFireTables(pg: PGlite): Promise<void> {
  for (const id of FIRE_MIGRATIONS) await applyMigration(pg, id);
}

/** The store as migration #208 leaves it: the seed row, both pointers on it. */
export async function resetWeightsStore(pg: PGlite): Promise<void> {
  await pg.exec(`
    DELETE FROM lottery_fire_value_snapshots;
    DELETE FROM lottery_score_pointers;
    DELETE FROM lottery_score_versions;
  `);
  await applyMigration(pg, 208);
}

export async function clearFireData(pg: PGlite): Promise<void> {
  await pg.exec(`
    DELETE FROM lottery_finder_fires;
    DELETE FROM silent_boom_alerts;
    DELETE FROM ws_net_flow_per_ticker;
    DELETE FROM net_flow_per_ticker_history;
  `);
}

type StoredFlow = number | string | null;

export interface LotterySeed {
  id: number;
  date: string;
  /** ISO instant of the fire (`trigger_time_ct`). */
  at: string;
  ticker?: string;
  tod?: string;
  dte?: number;
  optionType?: 'C' | 'P';
  score?: number | null;
  scoreVersion?: string | null;
  /** NULL when omitted or null; a stored decimal as a string or number. */
  ncp?: StoredFlow;
  npp?: StoredFlow;
  volOi?: number;
  gamma?: number | null;
  askPct?: number;
}

/** One fire, with every NOT NULL column and the columns the scorer reads. */
export async function seedLotteryFire(
  pg: PGlite,
  s: LotterySeed,
): Promise<void> {
  await pg.query(
    `INSERT INTO lottery_finder_fires (
       id, date, trigger_time_ct, entry_time_ct, option_chain_id,
       underlying_symbol, option_type, strike, expiry, dte,
       trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
       trigger_delta, trigger_ask_pct, trigger_window_size,
       trigger_window_prints, entry_price, open_interest, spot_at_first,
       alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
       score, cum_ncp_at_fire, cum_npp_at_fire, gamma_at_trigger,
       score_version)
     VALUES ($1, $2::date, $3::timestamptz, $3::timestamptz + INTERVAL '1 minute',
             $4, $5, $6, 100, '2026-12-31', $7,
             $8, 1, 0.3, 0.3, $9, 10, 3, 1.5, 100, 99,
             1, 'call_ask', $10, 'A_intraday_0DTE', false, false,
             $11, $12, $13, $14, $15)`,
    [
      s.id,
      s.date,
      s.at,
      `CHAIN${s.id}`,
      s.ticker ?? 'META',
      s.optionType ?? 'C',
      s.dte ?? 0,
      s.volOi ?? 0.4,
      s.askPct ?? 0.8,
      s.tod ?? 'MID',
      s.score ?? null,
      s.ncp ?? null,
      s.npp ?? null,
      s.gamma === undefined ? 0.03 : s.gamma,
      s.scoreVersion ?? null,
    ],
  );
}

export interface SilentBoomSeed {
  id: number;
  date: string;
  /** ISO instant of the bucket (`bucket_ct`). */
  at: string;
  ticker?: string;
  ncp?: StoredFlow;
  npp?: StoredFlow;
}

export async function seedSilentBoom(
  pg: PGlite,
  s: SilentBoomSeed,
): Promise<void> {
  await pg.query(
    `INSERT INTO silent_boom_alerts (
       id, date, bucket_ct, option_chain_id, underlying_symbol, option_type,
       strike, expiry, dte, spike_volume, baseline_volume, spike_ratio,
       ask_pct, vol_oi, entry_price, open_interest,
       cum_ncp_at_fire, cum_npp_at_fire)
     VALUES ($1, $2::date, $3::timestamptz, $4, $5, 'C',
             100, '2026-12-31', 0, 50, 5, 10,
             0.8, 0.4, 1.5, 100,
             $6, $7)`,
    [
      s.id,
      s.date,
      s.at,
      `SBCHAIN${s.id}`,
      s.ticker ?? 'META',
      s.ncp ?? null,
      s.npp ?? null,
    ],
  );
}

/** One WS tick: a per-tick delta, `ts` with milliseconds. */
export async function insertWsTick(
  pg: PGlite,
  ticker: string,
  ts: string,
  ncp: number,
  npp: number,
): Promise<void> {
  await pg.query(
    `INSERT INTO ws_net_flow_per_ticker
       (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol, raw_payload)
     VALUES ($1, $2::timestamptz, $3, 1, $4, 1, '{}'::jsonb)`,
    [ticker, ts, ncp, npp],
  );
}

/** One history minute: the whole minute starting at `ts`. */
export async function insertHistoryMinute(
  pg: PGlite,
  ticker: string,
  ts: string,
  ncp: number,
  npp: number,
  source = 'rest',
): Promise<void> {
  await pg.query(
    `INSERT INTO net_flow_per_ticker_history
       (ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
        call_volume, call_volume_ask_side, call_volume_bid_side,
        put_volume, put_volume_ask_side, put_volume_bid_side, source)
     VALUES ($1, $2::timestamptz, $3, 1, $4, 1, 0, 0, 0, 0, 0, 0, $5)`,
    [ticker, ts, ncp, npp, source],
  );
}
