/**
 * GET /api/cron/backfill-gamma-setup-outcomes
 *
 * Runs once daily at 20:30 UTC (15:30 CT) — 30 min after the cash close.
 * For every `ws_gamma_setup_fires` row inserted in the last 2 trading
 * days whose `ret_30m` is still NULL, this fills in:
 *
 *   - ret_15m: direction-adjusted SPX return from fired_at to +15m
 *   - ret_30m: …to +30m
 *   - ret_60m: …to +60m
 *   - ret_eod: …to the last RTH bar of the same trading day
 *
 * "Direction-adjusted" means the sign reflects the trade thesis, not raw
 * price motion:
 *
 *   - long_call_e1: positive = price went UP from bar_close (good)
 *   - long_put_e5:  positive = price went DOWN from bar_close (good)
 *   - pcs_monday:   positive = price went UP from bar_close (good for
 *                              short put — short strike is BELOW spot)
 *
 * This convention matches the brainstorm CSVs so the live ledger can be
 * concatenated to the backtest without re-signing.
 *
 * Idempotent — only updates rows where ret_30m IS NULL, and the
 * forward-return lookups are deterministic from the SPX 1-min table.
 *
 * Spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import type { SignalType } from '../_lib/gamma-detector.js';

const BACKFILL_LOOKBACK_DAYS = 2;
const HORIZONS = [
  { col: 'ret_15m', minutes: 15 },
  { col: 'ret_30m', minutes: 30 },
  { col: 'ret_60m', minutes: 60 },
] as const;

interface PendingFireRow {
  id: number;
  fired_at: string | Date;
  signal_type: SignalType;
  bar_close: string | number;
}

interface BarLookupRow {
  close: string | number;
}

/** Returns a NUMERIC SPX close at-or-just-after `targetTs` on the same
 *  RTH session, or null when no bar matches. */
async function lookupCloseAtOrAfter(
  sql: ReturnType<typeof getDb>,
  targetTs: Date,
): Promise<number | null> {
  // ON 0DTE this only needs the same-day session, but using a +90m window
  // around target keeps it robust to clock drift between cron fire-time
  // and the candle timestamp granularity.
  const rows = (await withDbRetry(
    () => sql`
      SELECT close
      FROM index_candles_1m
      WHERE symbol = 'SPX'
        AND market_time = 'r'
        AND timestamp >= ${targetTs.toISOString()}::timestamptz
        AND timestamp <= ${targetTs.toISOString()}::timestamptz + INTERVAL '90 minutes'
      ORDER BY timestamp ASC
      LIMIT 1
    `,
    2,
    10_000,
  )) as BarLookupRow[];
  const first = rows.at(0);
  if (first == null) return null;
  return Number(first.close);
}

/** Same-session EOD close — last RTH bar on the same date. */
async function lookupEodClose(
  sql: ReturnType<typeof getDb>,
  firedAt: Date,
): Promise<number | null> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT (array_agg(close ORDER BY timestamp DESC))[1] AS close
      FROM index_candles_1m
      WHERE symbol = 'SPX'
        AND market_time = 'r'
        AND date = (${firedAt.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date
        AND timestamp >= ${firedAt.toISOString()}::timestamptz
    `,
    2,
    10_000,
  )) as BarLookupRow[];
  const closeVal = rows.at(0)?.close;
  if (closeVal == null) return null;
  return Number(closeVal);
}

/** Direction-adjusted forward return.
 *  - e1_long_call: end - entry (long delta-1 on price)
 *  - e5_long_put:  entry - end (short delta-1 on price)
 *  - pcs_monday:   end - entry (price up = trade safe for short put) */
function signedReturn(
  signal: SignalType,
  entryClose: number,
  endClose: number,
): number {
  if (signal === 'e5_long_put') return entryClose - endClose;
  return endClose - entryClose;
}

export default withCronInstrumentation(
  'backfill-gamma-setup-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    // Pull every fire from the last N days where ret_30m is still NULL.
    // Using ret_30m as the sentinel (instead of inserted_at + a flag) so
    // partial fills from earlier crashed runs get retried automatically.
    const pending = (await withDbRetry(
      () => sql`
        SELECT id, fired_at, signal_type, bar_close
        FROM ws_gamma_setup_fires
        WHERE ret_30m IS NULL
          AND fired_at >= NOW() - (${BACKFILL_LOOKBACK_DAYS}::int * INTERVAL '1 day')
        ORDER BY fired_at ASC
      `,
      2,
      10_000,
    )) as PendingFireRow[];

    let updated = 0;
    for (const row of pending) {
      const firedAt =
        row.fired_at instanceof Date
          ? row.fired_at
          : new Date(row.fired_at as string);
      const entryClose = Number(row.bar_close);

      // Compute each horizon's signed return. We swallow per-fire errors
      // so a single broken row doesn't kill the whole backfill — Sentry
      // sees the exception via the captured warning below.
      const horizonValues: Record<string, number | null> = {};
      for (const h of HORIZONS) {
        const targetTs = new Date(firedAt.getTime() + h.minutes * 60_000);
        const endClose = await lookupCloseAtOrAfter(sql, targetTs);
        horizonValues[h.col] =
          endClose == null
            ? null
            : signedReturn(row.signal_type, entryClose, endClose);
      }
      const eodClose = await lookupEodClose(sql, firedAt);
      const retEod =
        eodClose == null
          ? null
          : signedReturn(row.signal_type, entryClose, eodClose);

      // Only write the row when at least one horizon resolved — leaves
      // partial-data fires for the next cron tick. Avoids the case where
      // a 15:00 CT fire's +60m bar (16:00 CT) isn't in the DB until
      // after-hours backfill closes.
      const anyResolved =
        horizonValues.ret_15m != null ||
        horizonValues.ret_30m != null ||
        horizonValues.ret_60m != null ||
        retEod != null;
      if (!anyResolved) continue;

      await withDbRetry(
        () => sql`
          UPDATE ws_gamma_setup_fires
          SET
            ret_15m = ${horizonValues.ret_15m},
            ret_30m = ${horizonValues.ret_30m},
            ret_60m = ${horizonValues.ret_60m},
            ret_eod = ${retEod}
          WHERE id = ${row.id}
        `,
        2,
        10_000,
      );
      updated += 1;
    }

    ctx.logger.info(
      { pending: pending.length, updated },
      'backfill-gamma-setup-outcomes: complete',
    );

    return {
      status: 'success',
      rows: updated,
      metadata: {
        pending: pending.length,
        lookback_days: BACKFILL_LOOKBACK_DAYS,
      },
    };
  },
  // After-hours run — relax both the market-hours gate and the UW key
  // (we don't call UW at all from this handler).
  { marketHours: false, requireApiKey: false },
);
