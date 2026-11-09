/**
 * GET /api/cron/fetch-strike-exposure
 *
 * Fetches per-strike Greek exposure for the cross-asset zero-gamma tickers
 * (SPX, SPY, QQQ) from the Unusual Whales spot-exposures endpoint. Results
 * land in `strike_exposures` keyed by (date, timestamp, ticker, strike,
 * expiry). Downstream consumers — compute-zero-gamma, build-features-gex —
 * filter by `ticker` and `expiry`.
 *
 * Per-ticker expiry policy:
 *   - SPX: today (0DTE) + the next trading day (1DTE). The 1DTE pull is
 *     preserved for the Periscope view and the build-features-gex 1DTE column.
 *   - SPY/QQQ: today (0DTE). Both have daily expirations.
 *
 * Per-ticker ATM window (the stored range AND the requested
 * `min_strike`/`max_strike`, so nothing is fetched that is then dropped):
 *   - SPX  ±200 pts (~80 strikes at $5). Same range as fetch-gex-0dte.
 *   - SPY  ±20 pts (~3% of ~600)
 *   - QQQ  ±20 pts (~3% of ~500)
 * A window never holds 500 strikes (SPX at $1 spacing is 401), so one
 * `limit=500` page is the whole ladder. UW's `/expiry-strike` doc says a page
 * with fewer than `limit` rows is the last; a page of 500 or more would mean
 * the window was not honoured, so that task fails instead of storing a ladder
 * that may be cut off.
 *
 * NDX was dropped 2026-05-16: UW only publishes NDX monthlies and the
 * front-month roll has near-zero OI on every monthly-expiry morning, so
 * compute-zero-gamma rejected the snapshot ~daily. See
 * `zero-gamma-tickers.ts` for the full rationale.
 *
 * What keeps a wrong ladder out of `strike_exposures`
 * (docs/superpowers/specs/live-data-integrity-2026-11-06.md, F5 to F7):
 *   - Spot first, per ticker, from UW's per-minute `/spot-exposures`
 *     (fetchUwSpot). A ticker with no usable spot is a Sentry error and its
 *     tasks fail; the cron never guesses a window from a strike row. A spot
 *     row from an earlier ET day is skipped (`stale_spot`). The helper spot is
 *     also what is stored as `price`: UW documents that each strike row's
 *     `price` is from that strike's own last recalculation and can lag by
 *     hours, and compute-zero-gamma reads one row's price as the spot.
 *   - The ladder is requested with `min_strike`/`max_strike` around that
 *     spot. Without a window UW serves a stale cache that freezes the
 *     ladder for the whole day (F6); the window routes the call through
 *     UW's live path, the workaround fetch-gex-0dte has used since
 *     2026-04-23.
 *   - The ladder goes through `judgeLadder`. One rule for every ladder that
 *     is not stored (api/_lib/ladder-skip.ts): `stale` (newest row from an
 *     earlier ET day, UW's 09:28 to 09:32 ET pre-rollover answer, F5),
 *     `all_zero` (F7), `empty` and `outside_window`. The task is skipped,
 *     with a warning and a metric; from 09:40 ET it is also a Sentry error.
 *     A run that stored nothing only because of skips reports `skipped`.
 *   - A failed task (UW error, no spot, unparseable payload, a full page, DB
 *     reject) is counted. Every task failing is a 500; some failing is
 *     `partial` and `success: false`. A failure is never reported as a
 *     success (R4).
 *
 * Total UW calls per invocation: 7 (3 spot reads, then SPX × 2 plus 1 each
 * for SPY, QQQ). These spot reads exist only because the ladder is polled
 * over REST; they retire with this cron when the `gex_strike_expiry:` and
 * `gex:` websocket writers replace it (spec Follow-ups). Each phase fans out
 * under mapWithConcurrency with per-task fault isolation — one ticker hiccup
 * does not block the others.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import {
  deriveCronStatus,
  withCronCheckin,
} from '../_lib/cron-instrumentation.js';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  roundTo5Min,
  cronGuard,
  checkDataQuality,
  withRetry,
  mapWithConcurrency,
} from '../_lib/api-helpers.js';
import { CRON_TICKER_DEFAULT_CONCURRENCY } from '../_lib/constants.js';
import { reportCronRun } from '../_lib/axiom.js';
import { isTradingDay } from '../../src/data/marketHours.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { reportLadderSkip } from '../_lib/ladder-skip.js';
import {
  isBeforeEtDay,
  judgeLadder,
  strikeWindow,
  UW_STRIKE_PAGE_LIMIT,
  type LadderSkipKind,
} from '../_lib/strike-ladder.js';
import { fetchUwSpot } from '../_lib/uw-spot.js';
import {
  ZERO_GAMMA_TICKERS,
  getPrimaryExpiry,
} from '../_lib/zero-gamma-tickers.js';

// ── Ticker config ───────────────────────────────────────────

// Narrowed to the runtime iteration set so dropping a ticker from
// `ZERO_GAMMA_TICKERS` without removing its `ATM_RANGE_BY_TICKER` entry —
// or adding one back without an entry — is a compile error. `ZeroGammaTicker`
// stays the wider type for `getPrimaryExpiry` callers in other modules.
type Ticker = (typeof ZERO_GAMMA_TICKERS)[number];

const ATM_RANGE_BY_TICKER: Record<Ticker, number> = {
  SPX: 200,
  SPY: 20,
  QQQ: 20,
};

// ── Helpers ─────────────────────────────────────────────────

/**
 * The next trading day after `today` in YYYY-MM-DD format, skipping weekends
 * and NYSE holidays: UW lists no expiry on a closed day, so asking for one
 * (the Friday before a Monday holiday) would be an empty ladder every poll.
 */
function getNextTradingDay(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  // A run of non-trading days is at most four long; ten steps bounds a bad calendar.
  for (let step = 0; step < 10; step++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso)) return iso;
  }
  throw new Error(
    `getNextTradingDay: no trading day within 10 days of ${today}`,
  );
}

/**
 * Per-ticker expiry list. SPX keeps the dual-expiry (0DTE + 1DTE) pull
 * because Periscope and build-features-gex still depend on the 1DTE rows.
 * Other tickers fetch only their primary (zero-gamma) expiry.
 */
function getExpiriesToFetch(ticker: Ticker, today: string): string[] {
  if (ticker === 'SPX') {
    return [today, getNextTradingDay(today)];
  }
  return [getPrimaryExpiry(ticker, today)];
}

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  date: string;
  expiry?: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_ask: string;
  call_charm_bid: string;
  put_charm_ask: string;
  put_charm_bid: string;
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
}

interface ExpiryResult {
  total: number;
  stored: number;
  skipped: number;
  /** The whole ladder was left out, and why (api/_lib/ladder-skip.ts). */
  rejected?: LadderSkipKind;
  /** The task failed and stored nothing (the failure is in Sentry). */
  failed?: true;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchStrikeExposure(
  apiKey: string,
  ticker: Ticker,
  expiry: string,
  spot: number,
): Promise<StrikeRow[]> {
  const { minStrike, maxStrike } = strikeWindow(
    spot,
    ATM_RANGE_BY_TICKER[ticker],
  );
  const params = new URLSearchParams({
    'expirations[]': expiry,
    min_strike: String(minStrike),
    max_strike: String(maxStrike),
    limit: String(UW_STRIKE_PAGE_LIMIT),
  });

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/${ticker}/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ────────────────────────────────────────────

/**
 * Insert a ladder `judgeLadder` approved. `price` is the helper spot, not the
 * row's own: UW's per-strike `price` is from that strike's last recalculation
 * and can lag by hours (compute-zero-gamma reads one row's price as spot).
 */
async function storeStrikes(
  rows: StrikeRow[],
  total: number,
  today: string,
  ticker: Ticker,
  expiry: string,
  spot: number,
  snapshotTime: string,
): Promise<ExpiryResult> {
  const timestamp = roundTo5Min(new Date(snapshotTime)).toISOString();
  const sql = getDb();

  // No catch here: a rejected transaction fails the task, which the handler
  // captures once and counts. Returning stored: 0 used to report a failed
  // write as a success (R4).
  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO strike_exposures (
          date, timestamp, ticker, expiry, strike, price,
          call_gamma_oi, put_gamma_oi,
          call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
          call_charm_oi, put_charm_oi,
          call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
          call_delta_oi, put_delta_oi,
          call_vanna_oi, put_vanna_oi
        )
        VALUES (
          ${today}, ${timestamp}, ${ticker}, ${expiry}, ${row.strike}, ${spot},
          ${row.call_gamma_oi}, ${row.put_gamma_oi},
          ${row.call_gamma_ask}, ${row.call_gamma_bid},
          ${row.put_gamma_ask}, ${row.put_gamma_bid},
          ${row.call_charm_oi}, ${row.put_charm_oi},
          ${row.call_charm_ask}, ${row.call_charm_bid},
          ${row.put_charm_ask}, ${row.put_charm_bid},
          ${row.call_delta_oi}, ${row.put_delta_oi},
          ${row.call_vanna_oi}, ${row.put_vanna_oi}
        )
        ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
        RETURNING id
      `,
    ),
  );

  let stored = 0;
  for (const result of results) {
    if (result.length > 0) stored++;
  }
  return { total, stored, skipped: rows.length - stored };
}

// ── Per-task runner ─────────────────────────────────────────

interface TaskOutcome {
  ticker: Ticker;
  expiry: string;
  result: ExpiryResult;
  price: number | null;
}

async function runOne(
  apiKey: string,
  today: string,
  ticker: Ticker,
  expiry: string,
  spot: number,
): Promise<TaskOutcome> {
  const rows = await withRetry(() =>
    fetchStrikeExposure(apiKey, ticker, expiry, spot),
  );
  if (rows.length >= UW_STRIKE_PAGE_LIMIT) {
    throw new Error(
      `fetch-strike-exposure: ${ticker} ${expiry} returned a full page of ${rows.length} rows inside a ±${ATM_RANGE_BY_TICKER[ticker]} window, ladder may be cut off`,
    );
  }

  const verdict = judgeLadder(rows, {
    spot,
    range: ATM_RANGE_BY_TICKER[ticker],
    day: today,
  });
  if (verdict.kind === 'malformed') {
    throw new Error(
      `fetch-strike-exposure: ${ticker} ${expiry} no strike row carries a parseable time`,
    );
  }
  if (verdict.kind !== 'store') {
    // Stale (F5, ported from fetch-gex-0dte: before UW rolls over, 09:28 to
    // 09:32 ET, the first poll is the previous session's ladder), all-zero
    // (F7), empty or outside the window: one rule, never stored.
    reportLadderSkip({
      job: 'fetch-strike-exposure',
      kind: verdict.kind,
      ticker,
      expiry,
      detail:
        verdict.kind === 'stale'
          ? {
              today,
              dataEtDate: verdict.dataEtDate,
              snapshotTime: verdict.snapshotTime,
            }
          : verdict.kind === 'empty'
            ? { today }
            : { today, rows: verdict.total },
    });
    return {
      ticker,
      expiry,
      result: {
        total: rows.length,
        stored: 0,
        skipped: 0,
        rejected: verdict.kind,
      },
      price: spot,
    };
  }

  const result = await withRetry(() =>
    storeStrikes(
      verdict.rows,
      rows.length,
      today,
      ticker,
      expiry,
      spot,
      verdict.snapshotTime,
    ),
  );
  return { ticker, expiry, result, price: spot };
}

// ── Spot phase ──────────────────────────────────────────────

type SpotResult =
  | { kind: 'ok'; spot: number }
  | { kind: 'stale_spot' }
  | { kind: 'failed'; failure: unknown };

/**
 * Read each ticker's spot once (SPX serves two expiries). A ticker whose
 * spot is rejected or unusable is reported to Sentry here, once, and its
 * tasks fail without a strike request. A spot row from an earlier ET day
 * (UW serving yesterday's series at the rollover) is a `stale_spot` skip,
 * also reported here once: the window would be centered on yesterday's level.
 */
async function fetchSpots(
  apiKey: string,
  today: string,
): Promise<Map<Ticker, SpotResult>> {
  const runs = await mapWithConcurrency(
    ZERO_GAMMA_TICKERS,
    CRON_TICKER_DEFAULT_CONCURRENCY,
    async (ticker): Promise<[Ticker, SpotResult]> => {
      try {
        const spot = await withRetry(() => fetchUwSpot(apiKey, ticker));
        if (spot !== null && isBeforeEtDay(spot.time, today)) {
          reportLadderSkip({
            job: 'fetch-strike-exposure',
            kind: 'stale_spot',
            ticker,
            detail: {
              today,
              spotTime: spot.time,
              dataEtDate: getETDateStr(new Date(spot.time)),
            },
          });
          return [ticker, { kind: 'stale_spot' }];
        }
        if (spot !== null) return [ticker, { kind: 'ok', spot: spot.price }];
        metrics.increment('fetch_strike_exposure.spot_null');
        Sentry.setTag('cron.job', 'fetch-strike-exposure');
        Sentry.setTag('ticker', ticker);
        const message = `fetch-strike-exposure: no usable ${ticker} spot from UW /spot-exposures, nothing stored for it`;
        Sentry.captureMessage(message, 'error');
        logger.error({ ticker }, message);
        return [ticker, { kind: 'failed', failure: new Error(message) }];
      } catch (failure) {
        Sentry.setTag('cron.job', 'fetch-strike-exposure');
        Sentry.setTag('ticker', ticker);
        Sentry.captureException(failure);
        logger.error(
          { err: failure, ticker },
          'fetch-strike-exposure: spot request failed',
        );
        return [ticker, { kind: 'failed', failure }];
      }
    },
  );
  return new Map(runs);
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-strike-exposure', async (req, res) => {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  // Build the (ticker, expiry) task list
  const tasks: Array<{ ticker: Ticker; expiry: string }> = [];
  for (const ticker of ZERO_GAMMA_TICKERS) {
    for (const expiry of getExpiriesToFetch(ticker, today)) {
      tasks.push({ ticker, expiry });
    }
  }

  try {
    const spots = await fetchSpots(apiKey, today);

    // Run all tasks in parallel; isolate failures so one ticker hiccup
    // does not block the rest. mapWithConcurrency caps in-flight requests
    // at CRON_TICKER_DEFAULT_CONCURRENCY so the 4-task fan-out never blows
    // past UW's per-app concurrency cap. The runner mirrors Promise.allSettled
    // shape so the existing aggregation loop is unchanged. A task whose
    // ticker has no spot is rejected up front and marked `reported`: its
    // failure already reached Sentry in fetchSpots. A task whose spot is
    // stale is skipped up front; fetchSpots already reported that too.
    type SettledRun =
      | { status: 'fulfilled'; value: TaskOutcome }
      | { status: 'rejected'; reason: unknown; reported: boolean };
    const settled: SettledRun[] = await mapWithConcurrency(
      tasks,
      CRON_TICKER_DEFAULT_CONCURRENCY,
      async (t): Promise<SettledRun> => {
        const spot = spots.get(t.ticker)!;
        if (spot.kind === 'failed') {
          return { status: 'rejected', reason: spot.failure, reported: true };
        }
        if (spot.kind === 'stale_spot') {
          return {
            status: 'fulfilled',
            value: {
              ticker: t.ticker,
              expiry: t.expiry,
              result: {
                total: 0,
                stored: 0,
                skipped: 0,
                rejected: 'stale_spot',
              },
              price: null,
            },
          };
        }
        try {
          const value = await runOne(
            apiKey,
            today,
            t.ticker,
            t.expiry,
            spot.spot,
          );
          return { status: 'fulfilled', value };
        } catch (reason) {
          return { status: 'rejected', reason, reported: false };
        }
      },
    );

    // Per-ticker aggregation
    const perTicker: Record<
      string,
      {
        price: number | null;
        expiries: Record<string, ExpiryResult>;
        totalStored: number;
        totalSkipped: number;
      }
    > = {};

    for (const ticker of ZERO_GAMMA_TICKERS) {
      perTicker[ticker] = {
        price: null,
        expiries: {},
        totalStored: 0,
        totalSkipped: 0,
      };
    }

    let failedTasks = 0;
    let skippedTasks = 0;
    const skips: Partial<Record<LadderSkipKind, number>> = {};
    settled.forEach((s, i) => {
      const task = tasks[i]!;
      const bucket = perTicker[task.ticker]!;

      if (s.status === 'fulfilled') {
        bucket.expiries[task.expiry] = s.value.result;
        bucket.totalStored += s.value.result.stored;
        bucket.totalSkipped += s.value.result.skipped;
        if (s.value.price != null) bucket.price = s.value.price;
        const kind = s.value.result.rejected;
        if (kind !== undefined) {
          skippedTasks++;
          skips[kind] = (skips[kind] ?? 0) + 1;
        }
      } else {
        failedTasks++;
        if (!s.reported) {
          Sentry.setTag('cron.job', 'fetch-strike-exposure');
          Sentry.setTag('ticker', task.ticker);
          Sentry.captureException(s.reason);
          logger.error(
            { err: s.reason, ticker: task.ticker, expiry: task.expiry },
            'fetch-strike-exposure: per-task failure',
          );
        }
        bucket.expiries[task.expiry] = {
          total: 0,
          stored: 0,
          skipped: 0,
          failed: true,
        };
      }
    });

    const outcome = deriveCronStatus(failedTasks, tasks.length);
    if (outcome === 'error') {
      logger.error('fetch-strike-exposure: all tasks failed');
      await reportCronRun('fetch-strike-exposure', {
        status: 'error',
        failedTasks,
        durationMs: Date.now() - startTime,
      });
      return res.status(500).json({ error: 'All ticker fetches failed' });
    }

    // Data quality check on the primary expiry per ticker (skip if no rows
    // were stored — avoids spurious "all-zero" alerts on first run of day).
    for (const ticker of ZERO_GAMMA_TICKERS) {
      const primary = getPrimaryExpiry(ticker, today);
      const stored = perTicker[ticker]!.expiries[primary]?.stored ?? 0;
      if (stored < 10) continue;

      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0 OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM strike_exposures
        WHERE date = ${today}
          AND ticker = ${ticker}
          AND expiry = ${primary}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-strike-exposure',
        table: 'strike_exposures',
        date: today,
        sourceFilter: `ticker=${ticker} expiry=${primary}`,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const totalStored = Object.values(perTicker).reduce(
      (a, b) => a + b.totalStored,
      0,
    );
    const totalSkipped = Object.values(perTicker).reduce(
      (a, b) => a + b.totalSkipped,
      0,
    );
    const durationMs = Date.now() - startTime;

    // 'ok' keeps the status the Axiom dashboards already filter on. A run that
    // stored nothing only because every ladder was skipped (stale, all-zero,
    // empty, outside the window, stale spot) is 'skipped', never a success:
    // the warnings, the metrics and, from 09:40 ET, the Sentry errors name why.
    const status =
      outcome === 'partial'
        ? 'partial'
        : totalStored === 0 && skippedTasks > 0
          ? 'skipped'
          : 'ok';

    logger.info(
      {
        perTicker,
        totalStored,
        totalSkipped,
        failedTasks,
        skippedTasks,
        skips,
        date: today,
        durationMs,
      },
      'fetch-strike-exposure completed',
    );

    await reportCronRun('fetch-strike-exposure', {
      status,
      perTicker,
      totalStored,
      totalSkipped,
      failedTasks,
      skippedTasks,
      skips,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-strike-exposure',
      success: status === 'ok',
      status,
      perTicker,
      totalStored,
      totalSkipped,
      failedTasks,
      skippedTasks,
      skips,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-exposure');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-exposure error');
    return res.status(500).json({ error: 'Internal error' });
  }
});
