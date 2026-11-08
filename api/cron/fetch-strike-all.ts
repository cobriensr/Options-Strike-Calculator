/**
 * GET /api/cron/fetch-strike-all
 *
 * Fetches per-strike Greek exposure for SPX across ALL expirations
 * from Unusual Whales API.
 *
 * This complements the 0DTE-only fetch-strike-exposure cron by providing
 * the aggregate gamma/charm landscape across all expirations. Useful for:
 *   - Identifying multi-day gamma walls that anchor price beyond 0DTE
 *   - Seeing where monthly/quarterly expiration gamma concentrates
 *   - Comparing 0DTE-specific walls against the all-expiry backdrop
 *
 * Stores in the same strike_exposures table with expiry = '1970-01-01' as a
 * sentinel value to distinguish from 0DTE rows (which have expiry = today's date).
 * This avoids PostgreSQL's NULL != NULL behavior in UNIQUE constraints.
 *
 * Stores strikes within ±200 pts of the live SPX spot.
 *
 * How a run goes (docs/superpowers/specs/live-data-integrity-2026-11-06.md,
 * F5 to F7, and Task R1 of docs/superpowers/plans/2026-10-23-uw-rest-fixes.md):
 *   1. Spot from UW's per-minute `/spot-exposures` (fetchUwSpot). No usable
 *      spot is a Sentry error and a 500: the run never guesses a window from
 *      a strike row, whose price is the thing UW freezes. A spot row from an
 *      earlier ET day is skipped (`stale_spot`).
 *   2. The strike ladder (fetchStrikeAllLadder, shared with the backfill) is
 *      requested with `min_strike`/`max_strike` = spot ± 200. Without a
 *      window UW serves its stale cache all day (F6), and the unwindowed
 *      ladder, ordered by strike with a 500-row page, was cut off before it
 *      reached spot (R1). It walks `page` while a page holds exactly 500
 *      rows, up to 10 pages; strike-all-fetch.ts cites UW's paging docs.
 *   3. The ladder goes through `judgeLadder`. One rule for every ladder that
 *      is not stored (api/_lib/ladder-skip.ts): `stale` (newest row from an
 *      earlier ET day, UW's 09:28 to 09:32 ET pre-rollover answer, F5),
 *      `all_zero` (F7, e21f0903), `empty` and `outside_window`. Each logs a
 *      warning, counts a metric, answers `success: false` and reports
 *      `skipped`; from 09:40 ET each is also a Sentry error.
 *   4. Stored `price` is the helper spot and `timestamp` is the newest row
 *      time floored to 5 minutes. A DB failure fails the run (R4).
 *
 * Total API calls per invocation: 2 (spot + one strike page; more only when
 * a page is full).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  roundTo5Min,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { reportLadderSkip } from '../_lib/ladder-skip.js';
import {
  STRIKE_ALL_ATM_RANGE,
  fetchStrikeAllLadder,
  type StrikeAllRow,
} from '../_lib/strike-all-fetch.js';
import {
  isBeforeEtDay,
  judgeLadder,
  type LadderSkipKind,
} from '../_lib/strike-ladder.js';
import { fetchUwSpot } from '../_lib/uw-spot.js';

const ALL_EXPIRY_SENTINEL = '1970-01-01';

// ── Store helper ────────────────────────────────────────────

/** Insert a ladder `judgeLadder` approved: in-range rows with gamma. */
async function storeStrikes(
  rows: StrikeAllRow[],
  today: string,
  spot: number,
  snapshotTime: string,
): Promise<{ stored: number; skipped: number }> {
  // Round timestamp to 5-min
  const timestamp = roundTo5Min(new Date(snapshotTime)).toISOString();

  const sql = getDb();

  // No catch here: a rejected transaction reaches the handler's catch, which
  // captures it once and answers 500. Returning stored: 0 used to report a
  // failed write as a success (R4).
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
          ${today}, ${timestamp}, 'SPX', ${ALL_EXPIRY_SENTINEL}, ${row.strike}, ${spot},
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
  return { stored, skipped: rows.length - stored };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-strike-all', async (req, res) => {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  /**
   * A ladder that is not stored (api/_lib/ladder-skip.ts): a warning, a
   * metric, a Sentry error from 09:40 ET, `skipped` in Axiom, and an answer
   * that is not a success. Not a 5xx: the Sentry check-in stays ok, the Sentry
   * error is the alert.
   */
  const skipRun = async (
    kind: LadderSkipKind,
    detail: Record<string, unknown> = {},
  ) => {
    reportLadderSkip({
      job: 'fetch-strike-all',
      kind,
      ticker: 'SPX',
      detail: { today, ...detail },
    });
    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-strike-all', {
      status: 'skipped',
      message: `ladder not stored: ${kind}`,
      kind,
      durationMs,
    });
    return res.status(200).json({
      job: 'fetch-strike-all',
      success: false,
      skipped: true,
      reason: kind,
      today,
      ...detail,
      durationMs,
    });
  };

  try {
    const spot = await withRetry(() => fetchUwSpot(apiKey, 'SPX'));
    if (spot === null) {
      metrics.increment('fetch_strike_all.spot_null');
      Sentry.setTag('cron.job', 'fetch-strike-all');
      Sentry.captureMessage(
        'fetch-strike-all: no usable SPX spot from UW /spot-exposures, nothing stored',
        'error',
      );
      logger.error({ date: today }, 'fetch-strike-all: no usable SPX spot');
      return res.status(500).json({ error: 'No usable SPX spot' });
    }

    // The window is centered on the spot, so a spot row from an earlier ET
    // day (UW serving yesterday's series at the rollover) would window and
    // price the ladder on yesterday's level.
    if (isBeforeEtDay(spot.time, today)) {
      return await skipRun('stale_spot', {
        spotTime: spot.time,
        dataEtDate: getETDateStr(new Date(spot.time)),
      });
    }

    const rows = await withRetry(() =>
      fetchStrikeAllLadder<StrikeAllRow>(apiKey, spot.price),
    );

    const verdict = judgeLadder(rows, {
      spot: spot.price,
      range: STRIKE_ALL_ATM_RANGE,
      day: today,
    });
    if (verdict.kind === 'malformed') {
      throw new Error(
        'fetch-strike-all: no strike row carries a parseable time',
      );
    }
    if (verdict.kind === 'stale') {
      // F5, ported from fetch-gex-0dte: before UW rolls over (09:28 to 09:32
      // ET) the first poll is the previous session's ladder. Stored under
      // today's date it would sit in the table as a snapshot of a day that
      // has not happened yet.
      return await skipRun('stale', {
        dataEtDate: verdict.dataEtDate,
        snapshotTime: verdict.snapshotTime,
      });
    }
    if (verdict.kind !== 'store') {
      return await skipRun(
        verdict.kind,
        verdict.kind === 'empty' ? {} : { rows: verdict.total },
      );
    }

    const result = await withRetry(() =>
      storeStrikes(verdict.rows, today, spot.price, verdict.snapshotTime),
    );

    logger.info(
      {
        totalStrikes: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        price: spot.price,
        date: today,
      },
      'fetch-strike-all completed',
    );

    // Data quality check: alert if all gamma values are null/zero
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0 OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM strike_exposures
        WHERE date = ${today} AND expiry = ${ALL_EXPIRY_SENTINEL}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-strike-all',
        table: 'strike_exposures',
        date: today,
        sourceFilter: 'expiry = 1970-01-01 (all-expiry)',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-strike-all', {
      status: 'ok',
      price: spot.price,
      totalStrikes: rows.length,
      stored: result.stored,
      skipped: result.skipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-strike-all',
      success: true,
      price: spot.price,
      totalStrikes: rows.length,
      ...result,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-all');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-all error');
    return res.status(500).json({ error: 'Internal error' });
  }
});
