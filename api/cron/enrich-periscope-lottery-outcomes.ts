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

/** One row of the batched LATERAL read — joins a fire id to a single tick. */
interface BatchedTradeRow {
  fire_id: number;
  executed_at: DbTimestamp;
  price: DbNumeric;
}

/** Accumulated enrichment for one fire, staged for the batched UPDATE. */
interface EnrichUpdate {
  id: number;
  peakPx: number | null;
  peakPct: number | null;
  peakTime: string | null;
  eodClosePx: number | null;
  realizedRPeak: number;
  realizedREod: number;
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

    // Pre-pass: derive the per-fire windows (pure JS, no I/O — the
    // in-loop entry_px guard and the eodCtForTrigger DST math stay
    // per-fire, only the DB reads/writes are batched). Fires with a
    // NaN/≤0 entry_px are skipped here exactly as before (no DB write).
    interface FireWindow {
      id: number;
      expiry: string;
      strike: number;
      optionType: 'C' | 'P';
      entryPx: number;
      fireTime: Date;
      horizonEnd: Date;
      closeCutoff: Date;
    }
    const windows: FireWindow[] = [];
    let skipped = 0;
    for (const f of unenriched) {
      const fireTime = toDate(f.fire_time);
      const entryPx = toNum(f.entry_px);
      if (Number.isNaN(entryPx) || entryPx <= 0) {
        skipped += 1;
        continue;
      }
      const horizonEnd = new Date(
        fireTime.getTime() + holdMinutes(f.fire_type) * 60_000,
      );
      // 15:00 CT (DST-aware) — 20:00 UTC during CDT, 21:00 UTC during CST.
      const closeCutoff = eodCtForTrigger(fireTime);
      windows.push({
        id: f.id,
        expiry: f.expiry,
        strike: f.trade_strike,
        optionType: f.fire_type === 'call_lottery' ? 'C' : 'P',
        entryPx,
        fireTime,
        horizonEnd,
        closeCutoff,
      });
    }

    if (windows.length === 0) {
      ctx.logger.info(
        { candidates: unenriched.length, updated: 0, skipped },
        'enrich-periscope-lottery-outcomes completed',
      );
      return {
        status: 'success',
        rows: 0,
        metadata: { candidates: unenriched.length, updated: 0, skipped },
      };
    }

    // ONE batched read replacing the prior 2N per-fire SELECTs. unnest
    // the eligible fires into a virtual input table and JOIN LATERAL the
    // per-fire trade stream. The original ran two windowed reads per fire
    // (hold-window for peak, a wider close-cutoff window for the EOD
    // print). closeCutoff and horizonEnd are not ordered relative to each
    // other (a late fire's horizonEnd can exceed closeCutoff), so we read
    // the UNION of both windows — [fire_time, GREATEST(horizon_end,
    // close_cutoff)] — and partition in JS to reproduce each query's
    // semantics exactly. The fire's expiry/strike/option_type are folded
    // into the per-fire arrays so the table predicate stays identical to
    // the original (ticker='SPXW' is a constant). Same pattern as
    // evaluate-round-trip.ts:148.
    const ids = windows.map((w) => w.id);
    const expiries = windows.map((w) => w.expiry);
    const strikes = windows.map((w) => w.strike);
    const optionTypes = windows.map((w) => w.optionType);
    const fireTimes = windows.map((w) => w.fireTime.toISOString());
    const readEnds = windows.map((w) =>
      (w.horizonEnd > w.closeCutoff
        ? w.horizonEnd
        : w.closeCutoff
      ).toISOString(),
    );

    const tradeRows = (await withDbRetry(
      () => sql`
        SELECT u.id AS fire_id, t.executed_at, t.price::numeric AS price
          FROM unnest(
                 ${ids}::int[],
                 ${expiries}::text[],
                 ${strikes}::int[],
                 ${optionTypes}::text[],
                 ${fireTimes}::timestamptz[],
                 ${readEnds}::timestamptz[]
               ) AS u(id, expiry, strike, option_type, fire_time, read_end)
          JOIN LATERAL (
                 SELECT executed_at, price
                   FROM ws_option_trades
                  WHERE ticker = 'SPXW'
                    AND expiry = u.expiry
                    AND strike = u.strike
                    AND option_type = u.option_type
                    AND executed_at >= u.fire_time
                    AND executed_at <= u.read_end
                    AND canceled = FALSE
                    AND price > 0
                  ORDER BY executed_at ASC
               ) t ON TRUE
         ORDER BY u.id, t.executed_at
      `,
      2,
      30_000,
    )) as BatchedTradeRow[];

    // Group ticks by fire id (already ordered executed_at ASC per id).
    const ticksById = new Map<number, BatchedTradeRow[]>();
    for (const row of tradeRows) {
      const arr = ticksById.get(row.fire_id);
      if (arr) arr.push(row);
      else ticksById.set(row.fire_id, [row]);
    }

    const updates: EnrichUpdate[] = [];
    for (const w of windows) {
      const ticks = ticksById.get(w.id) ?? [];

      // Peak metrics over the hold window (executed_at <= horizonEnd). If
      // no trades observed, leave outcome NULL but still lock the row (the
      // option died with no print — realized R = -1 per the strategy
      // assumption of expiry-worthless).
      let peakPx: number | null = null;
      let peakTime: Date | null = null;
      let peakPct: number | null = null;
      // EOD print = the LAST trade at or before closeCutoff (the original
      // ordered DESC LIMIT 1; here we take the latest in-window tick).
      let eodClosePx: number | null = null;
      for (const t of ticks) {
        const p = toNum(t.price);
        if (Number.isNaN(p)) continue;
        const execAt = toDate(t.executed_at);
        if (execAt <= w.horizonEnd && (peakPx === null || p > peakPx)) {
          peakPx = p;
          peakTime = execAt;
        }
        if (execAt <= w.closeCutoff) {
          // Ticks are ASC by executed_at, so the last assignment wins —
          // equivalent to the original ORDER BY executed_at DESC LIMIT 1.
          eodClosePx = p;
        }
      }

      // Both branches assign — definite assignment, no `= null`
      // initializer needed (sonarjs/no-useless-assignment).
      let realizedRPeak: number;
      if (peakPx !== null) {
        peakPct = peakPx / w.entryPx;
        realizedRPeak = (peakPx - w.entryPx) / w.entryPx;
      } else {
        // No trades in window — assume worthless expiry
        realizedRPeak = -1;
      }

      const realizedREod =
        eodClosePx !== null && !Number.isNaN(eodClosePx)
          ? (eodClosePx - w.entryPx) / w.entryPx
          : -1; // No EOD print = expired OTM

      updates.push({
        id: w.id,
        peakPx,
        peakPct,
        peakTime: peakTime ? peakTime.toISOString() : null,
        eodClosePx,
        realizedRPeak,
        realizedREod,
      });
    }

    // ONE batched UPDATE replacing the prior N per-fire writes. unnest the
    // staged rows (NULL-preserving typed arrays for the nullable columns)
    // and join on id. Every processed fire — tick or no-tick — gets the
    // same column set and outcome_locked = TRUE, exactly as the original
    // per-fire UPDATE did (skipped/zero-entry fires are absent here).
    const updated = updates.length;
    if (updated > 0) {
      const uIds = updates.map((u) => u.id);
      const uPeakPx = updates.map((u) => u.peakPx);
      const uPeakPct = updates.map((u) => u.peakPct);
      const uPeakTime = updates.map((u) => u.peakTime);
      const uEodPx = updates.map((u) => u.eodClosePx);
      const uRPeak = updates.map((u) => u.realizedRPeak);
      const uREod = updates.map((u) => u.realizedREod);
      await withDbRetry(
        () => sql`
          UPDATE periscope_lottery_fires AS p SET
            peak_px = u.peak_px,
            peak_pct = u.peak_pct,
            peak_time = u.peak_time,
            eod_close_px = u.eod_close_px,
            realized_r_peak = u.realized_r_peak,
            realized_r_eod = u.realized_r_eod,
            outcome_locked = TRUE
          FROM unnest(
                 ${uIds}::int[],
                 ${uPeakPx}::numeric[],
                 ${uPeakPct}::numeric[],
                 ${uPeakTime}::timestamptz[],
                 ${uEodPx}::numeric[],
                 ${uRPeak}::numeric[],
                 ${uREod}::numeric[]
               ) AS u(id, peak_px, peak_pct, peak_time, eod_close_px,
                      realized_r_peak, realized_r_eod)
          WHERE p.id = u.id
        `,
        2,
        30_000,
      );
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
