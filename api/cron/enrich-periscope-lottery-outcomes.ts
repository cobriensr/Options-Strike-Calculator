/**
 * GET /api/cron/enrich-periscope-lottery-outcomes
 *
 * Backfills the realized-outcome columns on periscope_lottery_fires rows
 * where outcome_locked = FALSE. Runs once daily at 21:30 UTC (30 min
 * after the 0DTE SPX cash close at 15:00 CT — DST-anchored, NOT a
 * hardcoded UTC hour). Same schedule as enrich-lottery-outcomes /
 * enrich-silent-boom-outcomes.
 *
 * For each unenriched fire:
 *   1. Pull ws_option_trades for the trade_strike within the hold horizon
 *      (120 min for call_lottery, 180 min for put_lottery).
 *   2. Compute peak_px (MAX price), peak_time, peak_pct (peak / entry).
 *   3. Pull EOD close price (last trade ≤ 15:00 CT — via eodCtForTrigger
 *      DST-aware helper).
 *   4. Compute realized_r_peak + realized_r_eod.
 *      - realized_r_peak: (peak - entry) / entry. Falls back to -1 only
 *        when no trades were observed in the hold window.
 *      - realized_r_eod: (eod_close - entry) / entry. Falls back to -1
 *        when no EOD print exists (assumes worthless expiry).
 *   5. UPDATE the row + set outcome_locked = TRUE.
 *
 * Idempotent — re-running the cron won't double-process a locked row.
 * Per-user direction (open question #3): we track BOTH peak and EOD R
 * because peak is the user-preferred display metric but EOD is the
 * realistic-exit estimator.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { eodCtForTrigger } from '../_lib/flow-inversion.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface UnenrichedFire {
  id: number;
  fire_type: 'call_lottery' | 'put_lottery';
  fire_time: DbTimestamp;
  expiry: string;
  trade_strike: number;
  entry_px: DbNumeric | null;
}

interface TradeRow {
  executed_at: DbTimestamp;
  price: DbNumeric;
}

const toNum = (v: DbNumeric | null | undefined): number =>
  v == null ? Number.NaN : typeof v === 'number' ? v : Number(v);

const toDate = (v: DbTimestamp): Date => (v instanceof Date ? v : new Date(v));

/** Hold horizon per filter — must match periscope-lottery-types.ts. */
function holdMinutes(fireType: 'call_lottery' | 'put_lottery'): number {
  return fireType === 'call_lottery' ? 120 : 180;
}

export default withCronInstrumentation(
  'enrich-periscope-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    // Only enrich fires where the hold window has FULLY elapsed. The
    // call horizon is 120m and the put horizon is 180m; running at
    // 20:30 UTC ensures every fire from this morning is settled.
    const unenriched = (await withDbRetry(
      () => sql`
        SELECT id, fire_type, fire_time, expiry::text AS expiry,
               trade_strike, entry_px
        FROM periscope_lottery_fires
        WHERE outcome_locked = FALSE
          AND entry_px IS NOT NULL
        ORDER BY fire_time ASC
        LIMIT 500
      `,
      2,
      10_000,
    )) as UnenrichedFire[];

    if (unenriched.length === 0) {
      return {
        status: 'success',
        rows: 0,
        metadata: { unenrichedCount: 0 },
      };
    }

    let updated = 0;
    let skipped = 0;
    for (const f of unenriched) {
      const fireTime = toDate(f.fire_time);
      const entryPx = toNum(f.entry_px);
      if (Number.isNaN(entryPx) || entryPx <= 0) {
        skipped += 1;
        continue;
      }

      const optionType = f.fire_type === 'call_lottery' ? 'C' : 'P';
      const horizonEnd = new Date(
        fireTime.getTime() + holdMinutes(f.fire_type) * 60_000,
      );
      // 15:00 CT (DST-aware) — 20:00 UTC during CDT, 21:00 UTC during CST.
      const closeCutoff = eodCtForTrigger(fireTime);

      // All trades in the hold window
      const holdTrades = (await withDbRetry(
        () => sql`
          SELECT executed_at, price::numeric AS price
          FROM ws_option_trades
          WHERE ticker = 'SPXW'
            AND expiry = ${f.expiry}
            AND strike = ${f.trade_strike}
            AND option_type = ${optionType}
            AND executed_at >= ${fireTime}
            AND executed_at <= ${horizonEnd}
            AND canceled = FALSE
            AND price > 0
          ORDER BY executed_at ASC
        `,
        2,
        10_000,
      )) as TradeRow[];

      // EOD trades at or before 20:00 UTC on the fire's date
      const eodTrades = (await withDbRetry(
        () => sql`
          SELECT price::numeric AS price
          FROM ws_option_trades
          WHERE ticker = 'SPXW'
            AND expiry = ${f.expiry}
            AND strike = ${f.trade_strike}
            AND option_type = ${optionType}
            AND executed_at >= ${fireTime}
            AND executed_at <= ${closeCutoff}
            AND canceled = FALSE
            AND price > 0
          ORDER BY executed_at DESC
          LIMIT 1
        `,
        2,
        10_000,
      )) as { price: DbNumeric }[];

      // Compute peak metrics. If no trades observed, leave outcome NULL
      // but still lock the row (the option died with no print — realized
      // R = -1 per the strategy assumption of expiry-worthless).
      let peakPx: number | null = null;
      let peakTime: Date | null = null;
      let peakPct: number | null = null;
      for (const t of holdTrades) {
        const p = toNum(t.price);
        if (Number.isNaN(p)) continue;
        if (peakPx === null || p > peakPx) {
          peakPx = p;
          peakTime = toDate(t.executed_at);
        }
      }
      // Both branches assign — definite assignment, no `= null`
      // initializer needed (sonarjs/no-useless-assignment).
      let realizedRPeak: number;
      if (peakPx !== null) {
        peakPct = peakPx / entryPx;
        realizedRPeak = (peakPx - entryPx) / entryPx;
      } else {
        // No trades in window — assume worthless expiry
        realizedRPeak = -1;
      }

      const eodClosePx =
        eodTrades.length > 0 ? toNum(eodTrades[0]!.price) : null;
      const realizedREod =
        eodClosePx !== null && !Number.isNaN(eodClosePx)
          ? (eodClosePx - entryPx) / entryPx
          : -1; // No EOD print = expired OTM

      await withDbRetry(
        () => sql`
          UPDATE periscope_lottery_fires SET
            peak_px = ${peakPx},
            peak_pct = ${peakPct},
            peak_time = ${peakTime ? peakTime.toISOString() : null},
            eod_close_px = ${eodClosePx},
            realized_r_peak = ${realizedRPeak},
            realized_r_eod = ${realizedREod},
            outcome_locked = TRUE
          WHERE id = ${f.id}
        `,
        2,
        10_000,
      );
      updated += 1;
    }

    ctx.logger.info(
      { candidates: unenriched.length, updated, skipped },
      'enrich-periscope-lottery-outcomes completed',
    );

    return {
      status: 'success',
      rows: updated,
      metadata: {
        candidates: unenriched.length,
        updated,
        skipped,
      },
    };
  },
  // marketHours: false is REQUIRED — this cron runs at 21:30 UTC which
  // is after the close (cronGuard defaults to marketHours: true and
  // would reject the request).
  { marketHours: false, requireApiKey: false },
);
