/**
 * GET /api/cron/capture-opening-flow-signal
 *
 * Persists one row per (date, ticker) into `opening_flow_signals` so the
 * V4 Opening Flow Signal panel can render past trading days even after
 * the underlying `ws_option_trades` trades have aged out (RETENTION_DAYS
 * = 2 in cleanup-ws-option-trades).
 *
 * Runs once daily at 14:50 UTC weekdays. Fires AFTER the 09:30–09:40 ET
 * V4 slice 2 window has closed, year-round:
 *   - CDT (Mar–Nov): 14:50 UTC = 09:50 CT / 10:50 ET (70 min post-close)
 *   - CST (Nov–Mar): 14:50 UTC = 08:50 CT / 09:50 ET (10 min post-close)
 * An earlier 13:50 UTC option was rejected because in CST it would
 * fire at 07:50 CT / 08:50 ET — BEFORE the window ends — and the
 * evaluator would write a `windowStatus='before_open'` row that
 * never gets overwritten later in the day.
 *
 * Idempotent — ON CONFLICT (date, ticker) DO UPDATE means re-running
 * the cron at any later time overwrites with a fresher snapshot. This
 * is critical for the deploy-day backfill flow (Phase 6 of the spec)
 * where we re-fire the cron for yesterday before the trades age out.
 *
 * Phase 3 of docs/superpowers/specs/opening-flow-signal-historical-persistence-2026-05-19.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  evaluateOpeningFlow,
  InvalidTradingDateError,
  type PerTickerPayload,
} from '../_lib/opening-flow-evaluator.js';
import { Sentry } from '../_lib/sentry.js';
import { getETDateStr } from '../../src/utils/timezone.js';

/**
 * JSONB binding helper. The Neon driver serializes objects directly
 * when sent as parameters to a `::jsonb` cast, but historically the
 * codebase has standardized on `JSON.stringify(value)::jsonb` so the
 * wire format is explicit and the row-level cast is unambiguous.
 * Null payloads bind through as NULL (the column is nullable).
 */
function jsonbOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

export default withCronInstrumentation(
  'capture-opening-flow-signal',
  async (ctx): Promise<CronResult> => {
    // Today (ET trading day) — mirrors the same default the endpoint uses
    // when called without `?date=`. Using getETDateStr keeps the date
    // semantics aligned across cron, endpoint, and the table's DATE column.
    const date = getETDateStr(new Date());

    let evaluation;
    try {
      evaluation = await evaluateOpeningFlow(date);
    } catch (err) {
      if (err instanceof InvalidTradingDateError) {
        // Defensive — getETDateStr should never produce a malformed date,
        // but if some future change does, we want a Sentry breadcrumb
        // without crashing the daily run.
        Sentry.captureException(err);
        ctx.logger.warn(
          { err, date },
          'capture-opening-flow-signal: invalid trading date, skipping',
        );
        return {
          status: 'success',
          rows: 0,
          metadata: { reason: 'invalid_date', date },
        };
      }
      throw err;
    }

    const sql = getDb();
    const tickerEntries = Object.entries(evaluation.tickers) as [
      string,
      PerTickerPayload,
    ][];

    let written = 0;
    for (const [ticker, payload] of tickerEntries) {
      const slice1Json = jsonbOrNull(payload.slice1);
      const slice2Json = jsonbOrNull(payload.slice2);
      const signalJson = jsonbOrNull(payload.signal);

      await withDbRetry(
        () => sql`
          INSERT INTO opening_flow_signals (
            date, ticker, window_status,
            slice1, slice2, signal,
            as_of_utc, stop_pct, exit_minutes_from_entry,
            updated_at
          ) VALUES (
            ${date}::date, ${ticker}, ${evaluation.windowStatus},
            ${slice1Json}::jsonb, ${slice2Json}::jsonb, ${signalJson}::jsonb,
            ${evaluation.asOfUtc}::timestamptz,
            ${evaluation.stopPct}, ${evaluation.exitMinutesFromEntry},
            NOW()
          )
          ON CONFLICT (date, ticker) DO UPDATE SET
            window_status = EXCLUDED.window_status,
            slice1 = EXCLUDED.slice1,
            slice2 = EXCLUDED.slice2,
            signal = EXCLUDED.signal,
            as_of_utc = EXCLUDED.as_of_utc,
            stop_pct = EXCLUDED.stop_pct,
            exit_minutes_from_entry = EXCLUDED.exit_minutes_from_entry,
            updated_at = NOW()
        `,
        2,
        10_000,
      );
      written += 1;
    }

    ctx.logger.info(
      {
        date,
        windowStatus: evaluation.windowStatus,
        tickers: tickerEntries.map(([t]) => t),
        written,
      },
      'capture-opening-flow-signal completed',
    );

    return {
      status: 'success',
      rows: written,
      metadata: {
        date,
        windowStatus: evaluation.windowStatus,
        tickers: tickerEntries.map(([t]) => t),
      },
    };
  },
  // marketHours: false — runs at 14:50 UTC. In CDT that's 09:50 CT
  // (post-open, but cronGuard's default check still fits); in CST
  // that's 08:50 CT (BEFORE 09:30 CT open). The opt is set false
  // year-round so the gate behavior is DST-independent.
  // requireApiKey: false — this cron doesn't talk to UW; it only
  // reads from our own ws_option_trades table via the evaluator.
  { marketHours: false, requireApiKey: false },
);
