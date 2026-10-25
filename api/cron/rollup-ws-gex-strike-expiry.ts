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
 * Status (deriveCronStatus over the source tickers): 'success' only when
 * every ticker was copied. A failed ticker (already captured to Sentry by
 * the rollup, tagged with the ticker) or a deferred one makes the run
 * 'partial', or 'error' when none was copied (an error check-in: the
 * Sentry monitor goes red). No source rows at all is 'success' with 0
 * rows on a weekend or holiday; on a trading day it means uw-stream's GEX
 * capture was down, so it warns and reports 'error'.
 *
 * Auth: CRON_SECRET via withCronInstrumentation → cronGuard. No UW key —
 * DB-only. Time gate: `marketHours: false` — after-close run. The
 * wrapper's Sentry check-ins (monitor in cron-schedules.ts) make a
 * killed run a monitor timeout instead of silence.
 */

import { getDb } from '../_lib/db.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { rollupWsGexToStrikeExposures } from '../_lib/rollup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';
import { isTradingDay, parseIsoDate } from '../../src/data/marketHours.js';

const JOB = 'rollup-ws-gex-strike-expiry';

/**
 * Run budget against the 300 s maxDuration (vercel.json must match).
 * ctx.startTimeMs is taken before the wrapper's in_progress check-in POST,
 * so that POST counts against the budget:
 *   last ticker starts by                      240 s
 *   that ticker's statement                    must end by ~290 s
 *   completion check-in POST (5 s abort)       ~295 s, then the Axiom
 *                                              event and the response
 * Write time dominates, and per-ticker write time is unmeasured. The
 * evidence that a day fits: on 10-09 the old single statement wrote all
 * 3.12M rows, every ticker, inside the old 120 s limit. SPX runs first,
 * so the statement in flight at 240 s is never SPX. If the budget runs
 * out, the remaining tickers are deferred with a warning (re-run them
 * with ?date=); if a statement runs past the kill, the monitor's max
 * runtime (cron-schedules.ts) turns the missing completion into a
 * timeout.
 */
export const config = { maxDuration: 300 };
const RUN_BUDGET_MS = 240_000;

/** The ET date to roll up: `?date=` when given and valid, else today. */
function resolveDate(dateParam: unknown, today: string): string {
  if (dateParam === undefined) return today;
  // Any defined non-string (e.g. a repeated ?date= array) is invalid too.
  if (typeof dateParam !== 'string' || parseIsoDate(dateParam) == null) {
    throw new Error(`${JOB}: invalid date param`);
  }
  if (dateParam > today) {
    throw new Error(`${JOB}: date ${dateParam} is after today (${today})`);
  }
  return dateParam;
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
    const { tickers, failed, deferred, inserted } = result;
    const metadata = {
      date,
      tickerCount: tickers.length,
      failedTickers: failed,
      deferredTickers: deferred,
    };

    if (tickers.length === 0 && isTradingDay(date)) {
      // A trading day always has 0DTE GEX pushes; none means uw-stream's
      // gex_strike_expiry capture was down, and there is nothing to copy.
      ctx.logger.warn({ date }, `${JOB}: no source rows on a trading day`);
      Sentry.captureMessage(`${JOB}: no source rows on a trading day`, {
        level: 'warning',
        fingerprint: [JOB, 'empty-source'],
        tags: { 'cron.anomaly': 'ws-gex-rollup-empty-source' },
        extra: { date },
      });
      return {
        status: 'error',
        rows: 0,
        message: `no ws_gex_strike_expiry rows for trading day ${date}`,
        metadata,
      };
    }

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

    const status = deriveCronStatus(
      failed.length + deferred.length,
      tickers.length,
    );
    ctx.logger.info(
      {
        ...metadata,
        status,
        inserted,
        durationMs: result.durationMs,
      },
      'ws_gex_strike_expiry → strike_exposures rollup complete',
    );

    return { status, rows: inserted, metadata };
  },
  { marketHours: false, requireApiKey: false, passReq: true },
);
