/**
 * GET /api/cron/fetch-market-internals
 *
 * Post-close settle of the four NYSE market internals ($TICK, $ADD, $VOLD,
 * $TRIN) into `market_internals`. Runs once a weekday after the close
 * (`30 22 * * 1-5` UTC: 17:30 ET in winter, 18:30 ET in summer) and upserts
 * Schwab's SETTLED 1-minute bars for the last SETTLE_SESSIONS sessions.
 *
 * It no longer captures anything in session. There is no trustworthy live
 * source for these symbols (`/quotes` answers $ADD and $VOLD with a zeroed
 * placeholder; live `/pricehistory` clamps $TICK's negatives to 0 and returns
 * $TRIN at the wrong scale), and the old `ON CONFLICT DO NOTHING` kept every
 * wrong first-seen row for good. The settled series is correct for all four.
 * So an in-session `/analyze` gets no internals block (the prompt handles
 * "NOT PROVIDED"), and an analysis of a past date reads the settled bars.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5).
 * The rules (session filter, all-zero bar, bar count, $TICK clamp signature)
 * and the upsert are in api/_lib/market-internals-settle.ts.
 *
 * How a run fails, and how that shows (R4):
 *   - Schwab 401/403/5xx or a network failure of a symbol -> that symbol's
 *     leg fails (`schwab_error`, Sentry exception). A lapsed login is
 *     `schwab_logged_out` (no exception: the error check-in is the alert).
 *   - An empty or malformed answer -> `empty_payload` / `malformed_payload`.
 *   - Any other throw from our own parse or plan code -> `unexpected` (Sentry
 *     exception), never filed as a Schwab failure.
 *   - A rejected write -> `db_write`, the symbol's rows of this run are not
 *     stored.
 *   - Every leg failed -> status `error`; some -> `partial`.
 *   - Status is also `partial`, with a Sentry **error** message, when a
 *     session came back unusable (incomplete bar count, an all-zero bar, the
 *     $TICK clamp signature) or when a symbol-session is stored all zero. A
 *     warning would email nobody (spec P0.1, the alert-routing note).
 *
 * `?force=1` skips the time gate (CRON_SECRET is still required), so a
 * weekend run settles the five sessions that ended the day before.
 *
 * Environment: CRON_SECRET (the Schwab token is managed internally)
 */

import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { schwabFetch } from '../_lib/schwab-fetch.js';
import { mapWithConcurrency } from '../_lib/uw-fetch.js';
import { isTradingDayET } from '../_lib/cron-helpers.js';
import { CRON_TICKER_DEFAULT_CONCURRENCY } from '../_lib/constants.js';
import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  SETTLE_SYMBOLS,
  SettleFailure,
  allZeroSessions,
  fetchWindow,
  parsePriceHistory,
  planSymbol,
  pricehistoryPath,
  sessionProblems,
  sessionRowCounts,
  settleSessions,
  upsertInternalBars,
  type SessionOutcome,
  type SessionProblem,
  type SessionRowCount,
  type SettleFailureKind,
  type SymbolPlan,
  type UpsertCounts,
} from '../_lib/market-internals-settle.js';
import type { InternalSymbol } from '../../src/types/market-internals.js';

const JOB = 'fetch-market-internals';

interface LegResult {
  symbol: InternalSymbol;
  /** Usable candles in the answer. */
  fetched: number;
  /** Candles dropped for a missing or non-finite field. */
  malformed: number;
  /** Candles outside every session of the window. */
  outOfSession: number;
  duplicates: number;
  /** All-zero bars rejected, over all sessions. */
  zeroBars: number;
  inserted: number;
  updated: number;
  unchanged: number;
  sessions: SessionOutcome[];
  problems: SessionProblem[];
  /** Set when the leg failed; `error` is the message (already redacted). */
  failure?: SettleFailureKind | 'db_write';
  error?: string;
}

function emptyLeg(symbol: InternalSymbol): LegResult {
  return {
    symbol,
    fetched: 0,
    malformed: 0,
    outOfSession: 0,
    duplicates: 0,
    zeroBars: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    sessions: [],
    problems: [],
  };
}

/** The leg after a failure: what was learned before it, plus the cause. */
function failedLeg(
  leg: LegResult,
  failure: SettleFailureKind | 'db_write',
  err: unknown,
): LegResult {
  const error = err instanceof Error ? err.message : String(err);
  if (failure !== 'schwab_logged_out') {
    logger.warn({ err, symbol: leg.symbol, failure }, `${JOB}: leg failed`);
    Sentry.captureException(err, {
      tags: { cron: JOB, stage: failure, symbol: leg.symbol },
    });
  }
  return { ...leg, failure, error };
}

/** Fetch, check and plan one symbol, then write it. Never rejects. */
async function settleSymbol(
  symbol: InternalSymbol,
  sessions: string[],
  startMs: number,
  endMs: number,
): Promise<LegResult> {
  let leg = emptyLeg(symbol);
  let plan: SymbolPlan;
  let result: Awaited<ReturnType<typeof schwabFetch<unknown>>>;
  try {
    // schwabFetch retries 5xx and network errors itself; a 4xx is final. It
    // can still reject (the token store, a body that is not JSON): that is a
    // Schwab-side failure.
    result = await schwabFetch<unknown>(
      pricehistoryPath(symbol, startMs, endMs),
    );
  } catch (err) {
    return failedLeg(leg, 'schwab_error', err);
  }
  try {
    if (!result.ok) {
      throw new SettleFailure(
        result.code === 'SCHWAB_TOKEN_EXPIRED'
          ? 'schwab_logged_out'
          : 'schwab_error',
        `Schwab pricehistory ${result.status}: ${result.error}`,
      );
    }
    const parsed = parsePriceHistory(result.data);
    plan = planSymbol(symbol, parsed.candles, sessions);
    leg = {
      ...leg,
      fetched: parsed.candles.length,
      malformed: parsed.malformed,
      outOfSession: plan.outOfSession,
      duplicates: plan.duplicates,
      zeroBars: plan.sessions.reduce((n, s) => n + s.zeroBars, 0),
      sessions: plan.sessions,
      problems: sessionProblems(plan),
    };
  } catch (err) {
    // A SettleFailure names itself. Anything else thrown here came out of our
    // own parse or plan code, so it is `unexpected`, not a Schwab outage.
    return failedLeg(
      leg,
      err instanceof SettleFailure ? err.kind : 'unexpected',
      err,
    );
  }

  let counts: UpsertCounts;
  try {
    ({ counts } = await upsertInternalBars(plan.rows));
  } catch (err) {
    return failedLeg(leg, 'db_write', err);
  }
  return { ...leg, ...counts };
}

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    // One clock read: which sessions are over is decided once for the run.
    const sessions = settleSessions(new Date(ctx.startTimeMs));
    const { startMs, endMs } = fetchWindow(sessions);

    // Capped fan-out, so a longer symbol list cannot 429 Schwab's per-app
    // concurrency budget.
    const legs = await mapWithConcurrency(
      SETTLE_SYMBOLS,
      CRON_TICKER_DEFAULT_CONCURRENCY,
      (symbol) => settleSymbol(symbol, [...sessions], startMs, endMs),
    );

    const failedLegs = legs.filter((l) => l.failure !== undefined);
    const problems = legs.flatMap((l) => l.problems);

    // A session Schwab sent unusable, or sent short: say so once per run,
    // naming every symbol-session. Error level: a warning emails nobody.
    if (problems.length > 0) {
      logger.warn(
        { problems },
        `${JOB}: settled series unusable for session(s)`,
      );
      Sentry.captureMessage(`${JOB}: settled series unusable for session(s)`, {
        level: 'error',
        tags: { cron: JOB, stage: 'session_problem' },
        extra: { problems, sessions },
      });
    }

    // Per-symbol check of what is STORED for the window's sessions: any
    // symbol-session with more than 10 rows, all zero, is a dead feed. It is
    // per symbol on purpose: pooled over the four symbols, a healthy $TICK
    // hid $ADD and $VOLD stored all zero for seven months (F9).
    let allZero: SessionRowCount[] = [];
    let qualityCheckFailed = false;
    try {
      allZero = allZeroSessions(await sessionRowCounts(sessions));
    } catch (err) {
      qualityCheckFailed = true;
      logger.warn({ err }, `${JOB}: quality check failed`);
      Sentry.captureException(err, {
        tags: { cron: JOB, stage: 'quality_check' },
      });
    }
    if (allZero.length > 0) {
      logger.warn({ allZero }, `${JOB}: stored session is all zero`);
      Sentry.captureMessage(`${JOB}: stored session is all zero`, {
        level: 'error',
        tags: { cron: JOB, stage: 'symbol_all_zero' },
        extra: { sessions: allZero },
      });
    }

    const noisy =
      problems.length > 0 ||
      allZero.length > 0 ||
      qualityCheckFailed ||
      legs.some((l) => l.malformed > 0);
    const derived = deriveCronStatus(failedLegs.length, legs.length);
    const status = derived === 'success' && noisy ? 'partial' : derived;

    const loggedOut =
      failedLegs.length === legs.length &&
      failedLegs.every((l) => l.failure === 'schwab_logged_out');

    const total = (pick: (l: LegResult) => number): number =>
      legs.reduce((n, l) => n + pick(l), 0);
    const inserted = total((l) => l.inserted);
    const updated = total((l) => l.updated);
    const unchanged = total((l) => l.unchanged);

    ctx.logger.info(
      {
        date: ctx.today,
        sessions,
        status,
        inserted,
        updated,
        unchanged,
        failed: failedLegs.map((l) => ({
          symbol: l.symbol,
          failure: l.failure,
        })),
      },
      `${JOB} completed`,
    );

    return {
      status,
      ...(loggedOut
        ? { message: 'Schwab logged out — re-auth at /api/auth/init' }
        : {}),
      metadata: {
        ...(loggedOut ? { reason: 'schwab_logged_out' } : {}),
        sessions,
        inserted,
        updated,
        unchanged,
        zeroBars: total((l) => l.zeroBars),
        failureCount: failedLegs.length,
        problems,
        allZero,
        qualityCheckFailed,
        results: legs,
      },
    };
  },
  // Not the market-hours gate: this runs after the close, on a trading day.
  // `isTradingDayET` is false on a weekend or holiday, so those skip without
  // `?force=1`; the 22:30 UTC schedule is past the close in both DST regimes.
  { requireApiKey: false, timeCheck: isTradingDayET },
);
