/**
 * GET /api/cron/rollup-ws-gex-strike-expiry[?date=YYYY-MM-DD]
 *
 * Daily EOD rollup: copies today's `ws_gex_strike_expiry` rows into
 * the `strike_exposures` archive with per-minute `ts_minute` values
 * preserved. Gives the Greek Heatmap's historical view a LIVE scrubber
 * for every lottery ticker the WS captured, rather than the single
 * EOD-snapshot row that the one-shot REST backfill writes.
 *
 * Spec: docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md
 *       docs/superpowers/specs/ws-gex-rollup-chunking-2026-10-25.md
 *
 * Schedule: `30 22 * * 1-5` (22:30 UTC = 6:30 PM EDT / 5:30 PM EST).
 *   - AFTER the cash close (20:00 UTC EDT / 21:00 UTC EST) so all
 *     intraday WS pushes for the day are landed.
 *   - AFTER the 22:00 UTC restatement-reconcile crons so we don't
 *     compete for DB write locks.
 *   - BEFORE the next-day 12:00 UTC `cleanup-ws-gex-strike-expiry`
 *     retention sweep so the WS source rows still exist.
 *
 * Manual re-run: `GET ...?date=2026-10-23` with the CRON_SECRET bearer
 * copies that ET date instead of today, while the source still holds it
 * (the cleanup sweep above purges it). `date` must be a real YYYY-MM-DD
 * calendar date, not after today (ET); anything else (including a
 * repeated param) throws before the DB is touched, and the wrapper
 * answers 500. Re-running a date is safe: the copy is idempotent.
 *
 * Status: 'success' only when every ticker was copied. A failed ticker
 * (already captured to Sentry by the rollup, tagged with the ticker) or
 * a deferred one makes the run 'partial', or 'error' when no ticker was
 * copied at all (an error check-in: the Sentry monitor goes red). A day
 * with no source rows (a holiday) is 'success' with 0 rows.
 *
 * Auth: CRON_SECRET via withCronInstrumentation → cronGuard. No UW key —
 * DB-only. Time gate: `marketHours: false` — after-close run. The
 * wrapper's Sentry check-ins (monitor in cron-schedules.ts) make a
 * killed run a monitor timeout instead of silence.
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
  type CronStatus,
} from '../_lib/cron-instrumentation.js';
import { rollupWsGexToStrikeExposures } from '../_lib/rollup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';

const JOB = 'rollup-ws-gex-strike-expiry';

/**
 * Run budget against the 300 s maxDuration (vercel.json must match).
 * ctx.startTimeMs is taken before the wrapper's in_progress check-in POST,
 * so that POST counts against the budget:
 *   last ticker starts by                      240 s
 *   that ticker's statement                    must end by ~290 s
 *   completion check-in POST (5 s abort)       ~295 s, then the Axiom
 *                                              event and the response
 * The largest ticker (SPX, ~146K rows on 10-23) read in 0.93 s on
 * production, so a statement has ~50 s of headroom before the kill. One
 * run of the ~85 tickers fits well inside 240 s; a deferral warns.
 * If a statement does run past the kill, the monitor's max runtime
 * (cron-schedules.ts) turns the missing completion into a timeout.
 */
export const config = { maxDuration: 300 };
const RUN_BUDGET_MS = 240_000;

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `d` is a real calendar date, not just YYYY-MM-DD shaped. */
function isRealDate(d: string): boolean {
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(d);
}

/** The ET date to roll up: `?date=` when given and valid, else today. */
function resolveDate(dateParam: unknown, today: string): string {
  if (dateParam === undefined) return today;
  // Any defined non-string (e.g. a repeated ?date= array) is invalid too.
  if (
    typeof dateParam !== 'string' ||
    !DATE_PARAM_RE.test(dateParam) ||
    !isRealDate(dateParam)
  ) {
    throw new Error(`${JOB}: invalid date param`);
  }
  if (dateParam > today) {
    throw new Error(`${JOB}: date ${dateParam} is after today (${today})`);
  }
  return dateParam;
}

/** 'success' only if every ticker was copied; 'error' if none was. */
function runStatus(
  tickers: number,
  copied: number,
  incomplete: number,
): CronStatus {
  if (tickers === 0 || incomplete === 0) return 'success';
  return copied === 0 ? 'error' : 'partial';
}

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const date = resolveDate(ctx.req?.query.date, ctx.today);
    const db = getDb();

    const result = await rollupWsGexToStrikeExposures(
      db,
      date,
      ctx.startTimeMs + RUN_BUDGET_MS,
    );
    const { tickers, copied, failed, deferred, inserted } = result;

    if (deferred.length > 0) {
      // No later run picks these up: they are lost once the 12:00 UTC
      // cleanup purges the source, unless re-run with ?date=.
      const detail = {
        date,
        tickerCount: tickers.length,
        deferredTickers: deferred,
        budgetMs: RUN_BUDGET_MS,
      };
      ctx.logger.warn(
        detail,
        `${JOB}: run budget spent; deferring the remaining tickers`,
      );
      Sentry.captureMessage(`${JOB}: run budget spent; tickers deferred`, {
        level: 'warning',
        fingerprint: [JOB, 'deferred'],
        tags: { 'cron.anomaly': 'ws-gex-rollup-deferred' },
        extra: detail,
      });
    }

    const status = runStatus(
      tickers.length,
      copied.length,
      failed.length + deferred.length,
    );
    ctx.logger.info(
      {
        date,
        status,
        tickerCount: tickers.length,
        inserted,
        failedTickers: failed,
        deferredTickers: deferred,
        durationMs: result.durationMs,
      },
      'ws_gex_strike_expiry → strike_exposures rollup complete',
    );

    return {
      status,
      rows: inserted,
      metadata: {
        date,
        tickerCount: tickers.length,
        failedTickers: failed,
        deferredTickers: deferred,
      },
    };
  },
  { marketHours: false, requireApiKey: false, passReq: true },
);
