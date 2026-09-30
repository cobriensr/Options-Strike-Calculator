/**
 * GET /api/cron/enrich-periscope-lottery-outcomes
 *
 * Backfills the realized-outcome columns on periscope_lottery_fires rows
 * where outcome_locked = FALSE. Scheduled once daily at 21:50 UTC Mon-Fri
 * (vercel.json `50 21 * * 1-5`). That is a FIXED UTC time: 16:50 CT
 * during CDT, 15:50 CT during CST — after the 15:00 CT 0DTE close either
 * way. Same post-close slot as enrich-lottery-outcomes (21:40 UTC) and
 * enrich-silent-boom-outcomes (21:45 UTC).
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
 * A fire is left UNLOCKED (retried next run, or recovered by
 * scripts/backfill_periscope_lottery_outcomes.py) when:
 *   - its window has not settled yet (prints can still land), or
 *   - it has ticks but none parse (R would be fabricated), or
 *   - every settled fire in a run of >= ALL_EMPTY_MIN_FIRES came back with
 *     zero ticks — the tape is missing (e.g. uw-stream down), so the run
 *     alerts (Sentry warning) and returns status 'error' instead.
 *
 * Idempotent — re-running the cron won't double-process a locked row.
 * Per-user direction (open question #3): we track BOTH peak and EOD R
 * because peak is the user-preferred display metric but EOD is the
 * realistic-exit estimator.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { eodCtForTrigger } from '../_lib/flow-inversion.js';
import { Sentry } from '../_lib/sentry.js';

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

/**
 * 15:00 CT on the contract's expiry date. SPXW stops trading then, so no
 * print can land later (the fires are 0DTE, making this the fire-day
 * close). 17:00 UTC is on the expiry's CT calendar day in CDT and CST.
 */
function expiryClose(expiry: string): Date {
  return eodCtForTrigger(new Date(`${expiry}T17:00:00Z`));
}

/**
 * Minimum settled fires in one run for "every fire has zero ticks" to be
 * read as a missing tape (uw-stream down, ws_option_trades not ingesting)
 * rather than options that genuinely never printed. With 1-2 fires an
 * all-empty read is plausible for far-OTM lottery strikes, so those keep
 * the per-strategy lock at R = -1.
 */
const ALL_EMPTY_MIN_FIRES = 3;

export default withCronInstrumentation(
  'enrich-periscope-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    // Retention window: cleanup-ws-option-trades prunes trades older than
    // WS_OPTION_TRADES_RETENTION_DAYS (its cutoff is ET midnight N days
    // back, which is at or before NOW() - N days, so this bound never
    // reaches pruned data). A fire older than that has had its trades
    // deleted, and the no-trades branch below would falsely lock it at
    // realized R = -1. So only retained fires are candidates, newest
    // first so today's fires are never starved by the LIMIT. The older
    // unlocked backlog is recovered from the parquet tape by
    // scripts/backfill_periscope_lottery_outcomes.py, not by this cron.
    // Whether a candidate's window has settled is checked per fire below.
    const unenriched = (await withDbRetry(
      () => sql`
        SELECT id, fire_type, fire_time, expiry::text AS expiry,
               trade_strike, entry_px
        FROM periscope_lottery_fires
        WHERE outcome_locked = FALSE
          AND entry_px IS NOT NULL
          AND fire_time >= NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
        ORDER BY fire_time DESC
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
      /** End of the batched read: GREATEST(horizonEnd, closeCutoff). */
      readEnd: Date;
    }
    const nowMs = Date.now();
    const windows: FireWindow[] = [];
    let skipped = 0;
    let inFlight = 0;
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
      const readEnd = horizonEnd > closeCutoff ? horizonEnd : closeCutoff;
      // Settled = no more prints can land in [fireTime, readEnd]: the
      // window has passed, or the contract has expired (a late fire's
      // horizon can run past the 15:00 CT 0DTE close, where trading
      // stops). Nothing else enforces this — marketHours: false leaves the
      // run time ungated, so a manual mid-session run would otherwise lock
      // today's fires (first, given newest-first order) on a partial
      // peak/EOD.
      const contractClose = expiryClose(f.expiry);
      const settledAt = readEnd < contractClose ? readEnd : contractClose;
      if (settledAt.getTime() > nowMs) {
        inFlight += 1;
        continue;
      }
      windows.push({
        id: f.id,
        expiry: f.expiry,
        strike: f.trade_strike,
        optionType: f.fire_type === 'call_lottery' ? 'C' : 'P',
        entryPx,
        fireTime,
        horizonEnd,
        closeCutoff,
        readEnd,
      });
    }

    if (windows.length === 0) {
      ctx.logger.info(
        { candidates: unenriched.length, updated: 0, skipped, inFlight },
        'enrich-periscope-lottery-outcomes completed',
      );
      return {
        status: 'success',
        rows: 0,
        metadata: {
          candidates: unenriched.length,
          updated: 0,
          skipped,
          inFlight,
        },
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
    const readEnds = windows.map((w) => w.readEnd.toISOString());

    const tradeRows = (await withDbRetry(
      () => sql`
        SELECT u.id AS fire_id, t.executed_at, t.price::numeric AS price
          FROM unnest(
                 ${ids}::int[],
                 ${expiries}::date[],
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

    // All-empty guard: every settled fire came back with zero ticks. With
    // >= ALL_EMPTY_MIN_FIRES fires that means the tape is missing (e.g.
    // uw-stream down), not that every option died untraded — locking them
    // all at R = -1 would silently corrupt the outcomes. Leave them
    // unlocked for the next run (or the parquet backfill) and alert.
    if (tradeRows.length === 0 && windows.length >= ALL_EMPTY_MIN_FIRES) {
      const message =
        'enrich-periscope-lottery-outcomes: no ws_option_trades ticks for ' +
        `any of ${windows.length} settled fires — tape likely missing; ` +
        'left unlocked';
      const detail = {
        candidates: unenriched.length,
        emptyFires: windows.length,
        skipped,
        inFlight,
      };
      ctx.logger.warn(detail, message);
      Sentry.captureMessage(message, {
        level: 'warning',
        fingerprint: ['enrich-periscope-lottery-outcomes', 'all-windows-empty'],
        tags: { 'cron.anomaly': 'periscope-lottery-empty-tape' },
        extra: detail,
      });
      return {
        status: 'error',
        rows: 0,
        message,
        metadata: { ...detail, updated: 0 },
      };
    }

    // Group ticks by fire id (already ordered executed_at ASC per id).
    const ticksById = new Map<number, BatchedTradeRow[]>();
    for (const row of tradeRows) {
      const arr = ticksById.get(row.fire_id);
      if (arr) arr.push(row);
      else ticksById.set(row.fire_id, [row]);
    }

    const updates: EnrichUpdate[] = [];
    // A tick whose price or timestamp does not parse is dropped (it cannot
    // be placed in the peak/EOD windows). A fire whose ticks ALL fail to
    // parse is left unlocked: the "no trades → R = -1" assumption does not
    // hold when prints exist but are unreadable.
    let malformedTicks = 0;
    const unreadableFireIds: number[] = [];
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
      let validTicks = 0;
      for (const t of ticks) {
        const p = toNum(t.price);
        const execAt = toDate(t.executed_at);
        if (Number.isNaN(p) || Number.isNaN(execAt.getTime())) {
          malformedTicks += 1;
          continue;
        }
        validTicks += 1;
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
      if (ticks.length > 0 && validTicks === 0) {
        unreadableFireIds.push(w.id);
        continue;
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
    // per-fire UPDATE did (skipped/zero-entry, in-flight and unreadable
    // fires are absent here).
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

    const summary = {
      candidates: unenriched.length,
      updated,
      skipped,
      inFlight,
      unreadable: unreadableFireIds.length,
      malformedTicks,
    };
    if (malformedTicks > 0) {
      ctx.logger.warn(
        { ...summary, unreadableFireIds },
        'enrich-periscope-lottery-outcomes: dropped malformed ticks',
      );
    }
    ctx.logger.info(summary, 'enrich-periscope-lottery-outcomes completed');

    return {
      status: malformedTicks > 0 ? 'partial' : 'success',
      rows: updated,
      metadata: summary,
    };
  },
  // marketHours: false is REQUIRED — this cron runs at 21:50 UTC, after
  // the close (cronGuard defaults to marketHours: true and would reject
  // the request).
  { marketHours: false, requireApiKey: false },
);
