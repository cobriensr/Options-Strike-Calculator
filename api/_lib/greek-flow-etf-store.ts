/**
 * Shared UPSERT helper for SPY/QQQ Greek Flow ticks.
 *
 * Used by:
 *   - api/cron/fetch-greek-flow-etf.ts (every minute, intraday)
 *   - api/cron/reconcile-greek-flow-etf.ts (post-close, T+0 reconciliation)
 *   - scripts/backfill-greek-flow-etf-0dte.mjs (per-expiry backfill)
 *
 * UW restates per-minute aggregates as late prints / cancellations resolve,
 * so we always UPSERT (overwrite existing rows) rather than skip duplicates.
 * The previous ON CONFLICT DO NOTHING strategy left preliminary live-day
 * values in place permanently, which diverged from UW's reconciled web
 * values by 5–40× on May 2026 sessions.
 *
 * Migration #129 added a nullable `expiry` column so per-expiry (0DTE)
 * rows coexist with all-expiries (NULL) rows under one constraint
 * (`UNIQUE NULLS NOT DISTINCT (ticker, timestamp, expiry)`). Callers
 * pass `expiry = null` for the all-DTE feed and `expiry = '<date>'` for
 * the per-expiry feed.
 *
 * Persistence is a single multi-row INSERT…SELECT FROM UNNEST(...)…
 * RETURNING (xmax = 0) AS was_insert. Per-row INSERT in a loop was
 * 50–100× slower at this row count (up to ~390 minute-bars per ticker
 * per scope per backfill run) — the cron now does one round-trip per
 * ticker per scope regardless of tick count.
 */

import { getDb } from './db.js';
import { metrics } from './sentry.js';
import logger from './logger.js';

export interface GreekFlowTick {
  timestamp: string;
  ticker: string;
  total_delta_flow: string;
  dir_delta_flow: string;
  total_vega_flow: string;
  dir_vega_flow: string;
  otm_total_delta_flow: string;
  otm_dir_delta_flow: string;
  otm_total_vega_flow: string;
  otm_dir_vega_flow: string;
  transactions: number;
  volume: number;
  /**
   * Present on per-expiry responses (`/stock/{ticker}/greek-flow/{expiry}`),
   * absent on the all-expiries variant. Not read by `upsertGreekFlowTicks` —
   * the caller passes `expiry` as an explicit parameter so the same tick
   * shape works for both feeds. Surfaced here for type-safety in callers
   * that want to validate the response.
   */
  expiry?: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  failed: number;
}

export async function upsertGreekFlowTicks(
  ticker: string,
  ticks: GreekFlowTick[],
  date: string,
  expiry: string | null,
): Promise<UpsertResult> {
  if (ticks.length === 0) return { inserted: 0, updated: 0, failed: 0 };

  const sql = getDb();

  const timestamps = ticks.map((t) => t.timestamp);
  const dirVega = ticks.map((t) => t.dir_vega_flow);
  const otmDirVega = ticks.map((t) => t.otm_dir_vega_flow);
  const totalVega = ticks.map((t) => t.total_vega_flow);
  const otmTotalVega = ticks.map((t) => t.otm_total_vega_flow);
  const dirDelta = ticks.map((t) => t.dir_delta_flow);
  const otmDirDelta = ticks.map((t) => t.otm_dir_delta_flow);
  const totalDelta = ticks.map((t) => t.total_delta_flow);
  const otmTotalDelta = ticks.map((t) => t.otm_total_delta_flow);
  const transactions = ticks.map((t) => t.transactions);
  const volume = ticks.map((t) => t.volume);

  try {
    const rows = (await sql`
      INSERT INTO vega_flow_etf (
        ticker, date, timestamp, expiry,
        dir_vega_flow, otm_dir_vega_flow, total_vega_flow, otm_total_vega_flow,
        dir_delta_flow, otm_dir_delta_flow, total_delta_flow, otm_total_delta_flow,
        transactions, volume
      )
      SELECT ${ticker}, ${date}::date, t.timestamp::timestamptz, ${expiry}::date,
             t.dir_vega_flow, t.otm_dir_vega_flow, t.total_vega_flow, t.otm_total_vega_flow,
             t.dir_delta_flow, t.otm_dir_delta_flow, t.total_delta_flow, t.otm_total_delta_flow,
             t.transactions, t.volume
      FROM unnest(
        ${timestamps}::text[],
        ${dirVega}::numeric[],
        ${otmDirVega}::numeric[],
        ${totalVega}::numeric[],
        ${otmTotalVega}::numeric[],
        ${dirDelta}::numeric[],
        ${otmDirDelta}::numeric[],
        ${totalDelta}::numeric[],
        ${otmTotalDelta}::numeric[],
        ${transactions}::int[],
        ${volume}::int[]
      ) AS t(
        timestamp,
        dir_vega_flow, otm_dir_vega_flow, total_vega_flow, otm_total_vega_flow,
        dir_delta_flow, otm_dir_delta_flow, total_delta_flow, otm_total_delta_flow,
        transactions, volume
      )
      ON CONFLICT (ticker, timestamp, expiry) DO UPDATE SET
        dir_vega_flow        = EXCLUDED.dir_vega_flow,
        otm_dir_vega_flow    = EXCLUDED.otm_dir_vega_flow,
        total_vega_flow      = EXCLUDED.total_vega_flow,
        otm_total_vega_flow  = EXCLUDED.otm_total_vega_flow,
        dir_delta_flow       = EXCLUDED.dir_delta_flow,
        otm_dir_delta_flow   = EXCLUDED.otm_dir_delta_flow,
        total_delta_flow     = EXCLUDED.total_delta_flow,
        otm_total_delta_flow = EXCLUDED.otm_total_delta_flow,
        transactions         = EXCLUDED.transactions,
        volume               = EXCLUDED.volume
      RETURNING (xmax = 0) AS was_insert
    `) as { was_insert: boolean }[];

    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      if (r.was_insert) inserted++;
      else updated++;
    }
    return { inserted, updated, failed: 0 };
  } catch (err) {
    logger.warn(
      { err, ticker, expiry, count: ticks.length },
      'greek-flow-etf batched upsert failed',
    );
    metrics.increment('greek_flow_etf.store_error');
    return { inserted: 0, updated: 0, failed: ticks.length };
  }
}
