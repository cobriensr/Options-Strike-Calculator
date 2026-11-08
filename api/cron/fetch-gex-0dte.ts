/**
 * GET /api/cron/fetch-gex-0dte
 *
 * Fetches per-strike Greek exposure for SPX 0DTE from Unusual Whales API
 * and stores it in the gex_strike_0dte table at the original timestamp
 * (no rounding — preserves minute precision from UW API).
 *
 * This powers the "0DTE GEX Per Strike" dashboard widget, storing:
 *   - OI-based gamma, charm, delta, vanna per strike
 *   - Volume-based gamma, charm, vanna (for vol vs OI reinforcement)
 *   - Directionalized gamma (bid/ask breakdown)
 *
 * Runs every minute during market hours (13-21 UTC, Mon-Fri) to power
 * the GEX migration component (5-min Δ and 20-min trend per strike).
 * ON CONFLICT DO NOTHING protects against duplicate writes if UW returns
 * the same snapshot timestamp on consecutive fetches.
 *
 * Total API calls per invocation: 2 (spot + 0DTE strikes)
 *
 * UW workaround (2026-04-23, "spot greeks delayed thread"): the main
 * /spot-exposures/expiry-strike endpoint serves stale cached data unless
 * the request carries a narrow min_strike/max_strike window, so the main
 * call is bounded to spot ± ATM_RANGE to route through UW's live path.
 *
 * Spot, the window and what is not stored (docs/superpowers/specs/
 * live-data-integrity-2026-11-06.md, P0.4; the helpers are P0.3's):
 *   - Spot is fetchUwSpot (the per-minute /spot-exposures series). It used to
 *     be the first strike row of /spot-exposures/strike?limit=1, and a spot
 *     that failed to load fell back to an UNBOUNDED request, i.e. the frozen
 *     cache. Now no usable spot is a Sentry error, a metric and an `error`
 *     run, and no strike request is made. A spot row from an earlier ET day
 *     is skipped (`stale_spot`).
 *   - The ladder goes through `judgeLadder`: one rule for every ladder that
 *     is not stored (api/_lib/ladder-skip.ts): `stale` (newest row from an
 *     earlier ET day; this was a wall-clock CT-date check, 099171ab, and is
 *     now ET like the other strike crons), `all_zero` (F7, no gamma OI on any
 *     in-range strike), `empty` and `outside_window`. Each logs a warning,
 *     counts a metric, reports `skipped`; from 09:40 ET each is also a Sentry
 *     error.
 *   - `timestamp` is UW's own row time (the newest row's `time`), not the run
 *     time, so ON CONFLICT (date, timestamp, strike) DO NOTHING keys each
 *     snapshot by its source.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronJitter,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import {
  loadSnapshotHistory,
  writeFeatureRows,
  type WriteFeatureRowsResult,
} from '../_lib/gex-target-features.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { reportLadderSkip } from '../_lib/ladder-skip.js';
import {
  isBeforeEtDay,
  judgeLadder,
  strikeWindow,
  type LadderSkipKind,
} from '../_lib/strike-ladder.js';
import { fetchUwSpot } from '../_lib/uw-spot.js';

// Snapshot window required for multi-horizon feature extraction: the
// 60-minute horizon needs 60 prior snapshots plus the current one.
const FEATURE_HISTORY_SIZE = 61;

const ATM_RANGE = 200; // ±200 pts from ATM

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_vol: string;
  put_gamma_vol: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_vol: string;
  put_charm_vol: string;
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
  call_vanna_vol: string;
  put_vanna_vol: string;
}

// ── Fetch helper ────────────────────────────────────────────

/**
 * The 0DTE ladder, always bounded to spot ± ATM_RANGE: omitting
 * min/max_strike returns UW's frozen pre-market cache. See the file-level
 * JSDoc for the full story. There is no unbounded fallback.
 */
async function fetchStrike0dte(
  apiKey: string,
  expiry: string,
  spotPrice: number,
): Promise<StrikeRow[]> {
  const { minStrike, maxStrike } = strikeWindow(spotPrice, ATM_RANGE);
  const params = new URLSearchParams({
    'expirations[]': expiry,
    min_strike: String(minStrike),
    max_strike: String(maxStrike),
    limit: '500',
  });

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/SPX/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ────────────────────────────────────────────

/**
 * Insert a ladder `judgeLadder` approved: the in-range rows, at UW's newest
 * row time (no rounding — minute precision).
 */
async function storeStrikes(
  filtered: StrikeRow[],
  today: string,
  snapshotTime: string,
): Promise<{ stored: number; skipped: number }> {
  const timestamp = snapshotTime;

  // Dedupe by strike (last-write-wins). The conflict target is
  // (date, timestamp, strike) but date and timestamp are constants
  // for the whole batch, so duplicates inside one INSERT collapse to
  // matching strikes. UW occasionally restates a strike across paging
  // boundaries — Postgres raises cardinality_violation
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time")
  // if we let those through. See api/_lib/bulk-upsert.ts contract.
  const byStrike = new Map<string, (typeof filtered)[number]>();
  for (const r of filtered) byStrike.set(r.strike, r);
  const deduped = [...byStrike.values()];
  const duplicates = filtered.length - deduped.length;
  if (duplicates > 0) {
    // Surface so UW pagination regressions don't silently absorb rows.
    logger.info(
      { duplicates, kept: deduped.length },
      'fetch-gex-0dte: dropped duplicate strikes pre-INSERT',
    );
    metrics.increment('fetch_gex_0dte.dedup_removed');
  }

  const sql = getDb();

  // Single multi-row INSERT: one HTTP round-trip instead of one-per-row.
  // Builds a parameterized statement of the form:
  //   INSERT INTO ... VALUES ($1,$2,...,$22),($23,$24,...,$44),...
  // with a flat params array aligned to COLUMNS_PER_ROW.
  const COLUMNS_PER_ROW = 22;
  const params: unknown[] = [];
  const valuesClauses: string[] = [];

  for (const row of deduped) {
    const base = params.length;
    const placeholders: string[] = [];
    for (let i = 1; i <= COLUMNS_PER_ROW; i++) {
      placeholders.push(`$${base + i}`);
    }
    valuesClauses.push(`(${placeholders.join(',')})`);
    params.push(
      today,
      timestamp,
      row.strike,
      row.price,
      row.call_gamma_oi,
      row.put_gamma_oi,
      row.call_gamma_vol,
      row.put_gamma_vol,
      row.call_gamma_ask,
      row.call_gamma_bid,
      row.put_gamma_ask,
      row.put_gamma_bid,
      row.call_charm_oi,
      row.put_charm_oi,
      row.call_charm_vol,
      row.put_charm_vol,
      row.call_delta_oi,
      row.put_delta_oi,
      row.call_vanna_oi,
      row.put_vanna_oi,
      row.call_vanna_vol,
      row.put_vanna_vol,
    );
  }

  const insertSql = `
    INSERT INTO gex_strike_0dte (
      date, timestamp, strike, price,
      call_gamma_oi, put_gamma_oi,
      call_gamma_vol, put_gamma_vol,
      call_gamma_ask, call_gamma_bid,
      put_gamma_ask, put_gamma_bid,
      call_charm_oi, put_charm_oi,
      call_charm_vol, put_charm_vol,
      call_delta_oi, put_delta_oi,
      call_vanna_oi, put_vanna_oi,
      call_vanna_vol, put_vanna_vol
    )
    VALUES ${valuesClauses.join(',')}
    ON CONFLICT (date, timestamp, strike) DO NOTHING
    RETURNING id
  `;

  try {
    const result = (await sql.query(insertSql, params)) as Array<{
      id: number;
    }>;
    const stored = result.length;
    return { stored, skipped: deduped.length - stored };
  } catch (err) {
    // Rethrow so the cron wrapper reports an error run and captures it to
    // Sentry once; returning stored: 0 here used to report success (R4).
    logger.warn({ err }, 'Batch gex_strike_0dte insert failed');
    metrics.increment('fetch_gex_0dte.batch_insert_error');
    throw err;
  }
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-gex-0dte',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    await cronJitter();

    /**
     * A ladder that is not stored (api/_lib/ladder-skip.ts): a warning, a
     * metric, a Sentry error from 09:40 ET, and a run that is `skipped`,
     * never a success.
     */
    const skipRun = (
      kind: LadderSkipKind,
      detail: Record<string, unknown> = {},
    ): CronResult => {
      reportLadderSkip({
        job: 'fetch-gex-0dte',
        kind,
        ticker: 'SPX',
        expiry: today,
        detail: { today, ...detail },
      });
      return {
        status: 'skipped',
        message: `ladder not stored: ${kind}`,
        metadata: { stored: false, reason: kind, ...detail },
      };
    };

    // Spot first, from the per-minute series. No usable spot is an `error`
    // run with no strike request: the window cannot be placed, and an
    // unbounded request is the frozen cache.
    const spot = await withRetry(() => fetchUwSpot(apiKey, 'SPX'));
    if (spot === null) {
      const message =
        'fetch-gex-0dte: no usable SPX spot from UW /spot-exposures, nothing stored';
      metrics.increment('fetch_gex_0dte.spot_null');
      Sentry.captureMessage(message, 'error');
      logger.error({ date: today }, message);
      return {
        status: 'error',
        message,
        metadata: { stored: false, reason: 'spot_null' },
      };
    }
    // A spot row from an earlier ET day would center the window, and price
    // the filter, on yesterday's level.
    if (isBeforeEtDay(spot.time, today)) {
      return skipRun('stale_spot', {
        spotTime: spot.time,
        dataEtDate: getETDateStr(new Date(spot.time)),
      });
    }

    const rows = await withRetry(() =>
      fetchStrike0dte(apiKey, today, spot.price),
    );

    const verdict = judgeLadder(rows, {
      spot: spot.price,
      range: ATM_RANGE,
      day: today,
    });
    if (verdict.kind === 'malformed') {
      throw new Error('fetch-gex-0dte: no strike row carries a parseable time');
    }
    if (verdict.kind === 'stale') {
      // Stale-cache guard (root cause of mis-dated "stray" rows, 099171ab):
      // UW occasionally serves a FROZEN prior-session cache (see file
      // JSDoc). Stored under the current `date` it is a prior-evening
      // snapshot mis-stamped into the next trading day. Judged on the ET day
      // the row would be stored under (was a wall-clock CT date).
      return skipRun('stale', {
        dataEtDate: verdict.dataEtDate,
        snapshotTime: verdict.snapshotTime,
      });
    }
    if (verdict.kind !== 'store') {
      return skipRun(
        verdict.kind,
        verdict.kind === 'empty' ? {} : { rows: verdict.total },
      );
    }

    const price = spot.price;
    const result = await withRetry(() =>
      storeStrikes(verdict.rows, today, verdict.snapshotTime),
    );

    logger.info(
      {
        total: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        price,
        date: today,
      },
      'fetch-gex-0dte completed',
    );

    // Data quality check
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0
                    OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM gex_strike_0dte
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-gex-0dte',
        table: 'gex_strike_0dte',
        date: today,
        sourceFilter: '0DTE only',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    // ── GexTarget features (Phase 4A) ────────────────────────
    //
    // Feature writes are non-blocking: any failure here is logged to
    // Sentry and the cron still returns 200 with the raw snapshot
    // counts populated. We deliberately do NOT short-circuit on feature
    // errors — the raw data pipeline must remain resilient to scoring
    // bugs.
    let featureStatus: WriteFeatureRowsResult | { error: true } | null = null;
    if (result.stored > 0) {
      const timestamp = verdict.snapshotTime;
      try {
        const snapshots = await loadSnapshotHistory(
          today,
          timestamp,
          FEATURE_HISTORY_SIZE,
        );
        if (snapshots.length < 2) {
          logger.info(
            { snapshots: snapshots.length, date: today, timestamp },
            'fetch-gex-0dte: skipping feature writes (history < 2 snapshots)',
          );
        } else {
          const featureResult = await writeFeatureRows(
            snapshots,
            today,
            timestamp,
          );
          featureStatus = featureResult;
          logger.info(
            {
              date: today,
              timestamp,
              historyCount: snapshots.length,
              featuresWritten: featureResult.written,
              featuresSkipped: featureResult.skipped,
              modes: featureResult.modes,
            },
            'fetch-gex-0dte: gex_target_features written',
          );
        }
      } catch (featureErr) {
        featureStatus = { error: true };
        Sentry.setTag('feature.phase', 'write');
        Sentry.captureException(featureErr);
        logger.error(
          { err: featureErr, date: today, timestamp },
          'fetch-gex-0dte: feature write threw unexpectedly',
        );
      }
    }

    const featureJson =
      featureStatus === null
        ? null
        : 'error' in featureStatus
          ? { error: true }
          : {
              written: featureStatus.written,
              skipped: featureStatus.skipped,
              modes: featureStatus.modes,
            };

    return {
      status: 'success',
      metadata: {
        success: true,
        price,
        stored: result.stored,
        skipped: result.skipped,
        features: featureJson,
        durationMs: Date.now() - startTimeMs,
      },
    };
  },
);
