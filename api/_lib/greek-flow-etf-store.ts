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
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const tick of ticks) {
    try {
      const result = (await sql`
        INSERT INTO vega_flow_etf (
          ticker, date, timestamp, expiry,
          dir_vega_flow, otm_dir_vega_flow, total_vega_flow, otm_total_vega_flow,
          dir_delta_flow, otm_dir_delta_flow, total_delta_flow, otm_total_delta_flow,
          transactions, volume
        )
        VALUES (
          ${ticker}, ${date}, ${tick.timestamp}, ${expiry},
          ${tick.dir_vega_flow}, ${tick.otm_dir_vega_flow}, ${tick.total_vega_flow}, ${tick.otm_total_vega_flow},
          ${tick.dir_delta_flow}, ${tick.otm_dir_delta_flow}, ${tick.total_delta_flow}, ${tick.otm_total_delta_flow},
          ${tick.transactions}, ${tick.volume}
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
      if (result[0]?.was_insert) inserted++;
      else updated++;
    } catch (err) {
      logger.warn(
        { err, ticker, expiry, ts: tick.timestamp },
        'greek-flow-etf upsert failed',
      );
      metrics.increment('greek_flow_etf.store_error');
      failed++;
    }
  }

  return { inserted, updated, failed };
}
