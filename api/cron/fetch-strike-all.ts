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
 *      a strike row, whose price is the thing UW freezes.
 *   2. The strike ladder is requested with `min_strike`/`max_strike` = spot
 *      ± ATM_RANGE. Without a window UW serves its stale cache all day (F6),
 *      and the unwindowed ladder, ordered by strike with a 500-row page, was
 *      cut off before it reached spot (R1). A page of exactly 500 rows means
 *      there may be more, so the walk continues (page cap 10).
 *   3. A ladder whose newest row is from an earlier ET day is UW's pre-rollover
 *      answer (09:28 to 09:32 ET). It is skipped, not stored under today (F5).
 *   4. An all-zero gamma ladder is skipped (F7, e21f0903).
 *   5. Stored `price` is the helper spot and `timestamp` is the newest row
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
import {
  hasGammaSignal,
  isBeforeEtDay,
  keepWithinRange,
  newestRowTime,
  strikeWindow,
} from '../_lib/strike-ladder.js';
import { uwFetchPaged } from '../_lib/uw-fetch-paged.js';
import { fetchUwSpot } from '../_lib/uw-spot.js';

const ATM_RANGE = 200;
const ALL_EXPIRY_SENTINEL = '1970-01-01';
// UW's documented maximum `limit`. A page with exactly this many rows may be
// followed by more; a shorter page is the last.
const PAGE_SIZE = 500;
// Safety stop for the page walk. A ±ATM_RANGE window holds well under one
// page of strikes, so reaching the cap means UW is not honouring the window:
// fail the run rather than store a ladder cut off somewhere.
const MAX_PAGES = 10;

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  date: string;
  ticker: string;
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

// ── Fetch helper ────────────────────────────────────────────

/**
 * The whole windowed ladder: walks `page` while a page comes back full.
 * Throws if the walk is still going at MAX_PAGES.
 */
async function fetchStrikeAll(
  apiKey: string,
  spot: number,
): Promise<StrikeRow[]> {
  const { minStrike, maxStrike } = strikeWindow(spot, ATM_RANGE);
  const { rows, reachedPageCap } = await uwFetchPaged<StrikeRow>({
    apiKey,
    maxPages: MAX_PAGES,
    buildPath: (page) => {
      const params = new URLSearchParams({
        min_strike: String(minStrike),
        max_strike: String(maxStrike),
        limit: String(PAGE_SIZE),
        page: String(page),
      });
      return `/stock/SPX/spot-exposures/strike?${params}`;
    },
    onPage: (batch) => ({ done: batch.length < PAGE_SIZE }),
  });
  if (reachedPageCap) {
    throw new Error(
      `fetch-strike-all: ${MAX_PAGES} full pages of ${PAGE_SIZE} strikes, ladder may be cut off`,
    );
  }
  return rows;
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  rows: StrikeRow[],
  today: string,
  spot: number,
  snapshotTime: string,
): Promise<{ stored: number; skipped: number; rejected?: boolean }> {
  const filtered = keepWithinRange(rows, spot, ATM_RANGE);

  if (filtered.length === 0) return { stored: 0, skipped: 0 };

  // Reject a garbage snapshot: UW occasionally returns a full strike ladder
  // with every gamma field zero/null (seen at early-session runs). Persisting
  // it poisons the all-expiry backdrop with a flat-zero snapshot and trips the
  // data-quality alert. Drop the whole batch if no strike carries any gamma.
  if (!hasGammaSignal(filtered)) {
    logger.warn(
      { rows: filtered.length, date: today },
      'fetch-strike-all: rejecting all-zero gamma snapshot',
    );
    metrics.increment('fetch_strike_all.zero_snapshot_skip');
    return { stored: 0, skipped: filtered.length, rejected: true };
  }

  // Round timestamp to 5-min
  const timestamp = roundTo5Min(new Date(snapshotTime)).toISOString();

  const sql = getDb();

  // No catch here: a rejected transaction reaches the handler's catch, which
  // captures it once and answers 500. Returning stored: 0 used to report a
  // failed write as a success (R4).
  const results = await sql.transaction((txn) =>
    filtered.map(
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
  return { stored, skipped: filtered.length - stored };
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin('fetch-strike-all', async (req, res) => {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

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

    const rows = await withRetry(() => fetchStrikeAll(apiKey, spot.price));

    if (rows.length === 0) {
      return res.status(200).json({ stored: false, reason: 'No strike data' });
    }

    const snapshotTime = newestRowTime(rows);
    if (snapshotTime === null) {
      throw new Error(
        'fetch-strike-all: no strike row carries a parseable time',
      );
    }

    // Stale-cache guard (F5), ported from fetch-gex-0dte: before UW rolls
    // over (09:28 to 09:32 ET) the first poll is the previous session's
    // ladder. Stored under today's date it would sit in the table as a
    // snapshot of a day that has not happened yet, so skip it.
    if (isBeforeEtDay(snapshotTime, today)) {
      const dataEtDate = getETDateStr(new Date(snapshotTime));
      logger.warn(
        { dataEtDate, today, snapshotTime },
        'fetch-strike-all: stale UW cache (ladder from an earlier ET day), skipping store',
      );
      metrics.increment('fetch_strike_all.stale_cache_skip');
      await reportCronRun('fetch-strike-all', {
        status: 'skipped',
        message: 'stale UW cache (earlier ET day)',
        durationMs: Date.now() - startTime,
      });
      return res.status(200).json({
        job: 'fetch-strike-all',
        skipped: true,
        reason: 'stale_cache',
        dataEtDate,
        today,
      });
    }

    const result = await withRetry(() =>
      storeStrikes(rows, today, spot.price, snapshotTime),
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
