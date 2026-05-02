/**
 * GET /api/cron/fetch-flow
 *
 * Fetches Market Tide data from Unusual Whales API and stores in Postgres.
 * Designed to run every 5 minutes during market hours via Vercel Cron.
 *
 * Fetches both all-in and OTM-only Market Tide data in a single invocation.
 * Each call stores the latest 5-minute candle (avoids duplicates via UPSERT).
 *
 * Environment: UW_API_KEY, CRON_SECRET (for Vercel cron auth)
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import {
  uwFetch,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// Per-source status (BE-CRON-007)
//
// Explicit response shape for each data source so external monitoring
// can distinguish a real fetch/store failure from a legitimate
// zero-row success. Emitted under `sources.marketTide` and
// `sources.marketTideOtm` on BOTH 200 (partial or full success) and
// 500 (total failure) responses, so callers always get the structured
// shape regardless of HTTP status.
//
// Naming note: `storedRows` is a row count (0 or 1 per fetch), while
// the top-level response field `stored` is a boolean ("did anything
// land at all"). They live two nesting levels apart and mean different
// things - do not conflate them.

type SourceStatus =
  | { succeeded: true; fetched: number; storedRows: number }
  | { succeeded: false; stage: 'fetch' | 'store'; reason: string };

// Sentinel: signals "all sources failed - return the legacy 500 body
// with the structured `sources` field intact". Distinct from a thrown
// error (rendered as { job, error: 'Internal error' } by the wrapper).
class AllSourcesFailedError extends Error {
  constructor(
    public readonly responseBody: {
      stored: boolean;
      partial: boolean;
      market_tide: { stored: boolean; timestamp?: string } | null;
      market_tide_otm: { stored: boolean; timestamp?: string } | null;
      sources: { marketTide: SourceStatus; marketTideOtm: SourceStatus };
    },
  ) {
    super('All sources failed');
    this.name = 'AllSourcesFailedError';
  }
}

// Fetch helper

interface MarketTideRow {
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
  timestamp: string;
}

async function fetchMarketTide(
  apiKey: string,
  otmOnly: boolean,
): Promise<MarketTideRow[]> {
  const qs = otmOnly
    ? '/market/market-tide?interval_5m=true&otm_only=true'
    : '/market/market-tide?interval_5m=true';
  return uwFetch<MarketTideRow>(apiKey, qs);
}

// Store helper

async function storeLatestCandle(
  rows: MarketTideRow[],
  source: string,
): Promise<{ stored: boolean; timestamp?: string }> {
  if (rows.length === 0) return { stored: false };

  // Get the most recent candle
  const latest = rows.at(-1)!;
  const sql = getDb();

  await sql`
    INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
    VALUES (
      ${latest.date},
      ${latest.timestamp},
      ${source},
      ${latest.net_call_premium},
      ${latest.net_put_premium},
      ${latest.net_volume}
    )
    ON CONFLICT (date, timestamp, source) DO NOTHING
  `;

  return { stored: true, timestamp: latest.timestamp };
}

// Handler

export default withCronInstrumentation(
  'fetch-flow',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger: log } = ctx;

    // Fetch both all-in and OTM Market Tide in parallel; partial failures are tolerated
    const [allInFetch, otmFetch] = await Promise.allSettled([
      withRetry(() => fetchMarketTide(apiKey, false)),
      withRetry(() => fetchMarketTide(apiKey, true)),
    ]);

    if (allInFetch.status === 'rejected') {
      log.warn({ err: allInFetch.reason }, 'fetch-flow: all-in fetch failed');
      Sentry.captureException(allInFetch.reason);
    }
    if (otmFetch.status === 'rejected') {
      log.warn({ err: otmFetch.reason }, 'fetch-flow: OTM fetch failed');
      Sentry.captureException(otmFetch.reason);
    }

    // Store whichever fetches succeeded
    const allInRows =
      allInFetch.status === 'fulfilled' ? allInFetch.value : null;
    const otmRows = otmFetch.status === 'fulfilled' ? otmFetch.value : null;

    const [allInStore, otmStore] = await Promise.allSettled([
      allInRows !== null
        ? withRetry(() => storeLatestCandle(allInRows, 'market_tide'))
        : Promise.reject(new Error('fetch skipped')),
      otmRows !== null
        ? withRetry(() => storeLatestCandle(otmRows, 'market_tide_otm'))
        : Promise.reject(new Error('fetch skipped')),
    ]);

    if (allInStore.status === 'rejected') {
      log.warn({ err: allInStore.reason }, 'fetch-flow: all-in store failed');
      Sentry.captureException(allInStore.reason);
    }
    if (otmStore.status === 'rejected') {
      log.warn({ err: otmStore.reason }, 'fetch-flow: OTM store failed');
      Sentry.captureException(otmStore.reason);
    }

    const allInResult =
      allInStore.status === 'fulfilled' ? allInStore.value : null;
    const otmResult = otmStore.status === 'fulfilled' ? otmStore.value : null;
    const anyStored = allInResult !== null || otmResult !== null;
    const partial =
      allInFetch.status === 'rejected' ||
      allInStore.status === 'rejected' ||
      otmFetch.status === 'rejected' ||
      otmStore.status === 'rejected';

    // Build per-source status (BE-CRON-007): fetch failure dominates,
    // then store failure, else success with fetched/stored row counts.
    const buildStatus = (
      fetchResult: PromiseSettledResult<MarketTideRow[]>,
      storeResult: PromiseSettledResult<{
        stored: boolean;
        timestamp?: string;
      }>,
    ): SourceStatus => {
      if (fetchResult.status === 'rejected') {
        return {
          succeeded: false,
          stage: 'fetch',
          reason: String(fetchResult.reason),
        };
      }
      if (storeResult.status === 'rejected') {
        return {
          succeeded: false,
          stage: 'store',
          reason: String(storeResult.reason),
        };
      }
      return {
        succeeded: true,
        fetched: fetchResult.value.length,
        storedRows: storeResult.value.stored ? 1 : 0,
      };
    };

    const marketTideStatus = buildStatus(allInFetch, allInStore);
    const marketTideOtmStatus = buildStatus(otmFetch, otmStore);

    // Data quality check: alert if all values are zero
    for (const source of ['market_tide', 'market_tide_otm'] as const) {
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
        FROM flow_data
        WHERE date = ${today} AND source = ${source}
      `;
      const { total, nonzero } = rows[0]!;
      await checkDataQuality({
        job: 'fetch-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: source,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    log.info(
      {
        allIn: allInResult,
        otm: otmResult,
        allInRows: allInRows?.length ?? 0,
        otmRows: otmRows?.length ?? 0,
        partial,
      },
      'fetch-flow completed',
    );

    // BE-CRON-007: return 500 only on TOTAL failure (no source landed
    // anything). This preserves the Vercel cron dashboard failed-run
    // signal for the worst case while letting partial failures report
    // 200 with the structured `sources` field so monitoring can still
    // tell a zero-row success from a fetch error.
    const responseBody = {
      stored: anyStored,
      partial,
      market_tide: allInResult,
      market_tide_otm: otmResult,
      // BE-CRON-007: explicit per-source status for external monitoring.
      // Included in both 200 and 500 responses.
      sources: {
        marketTide: marketTideStatus,
        marketTideOtm: marketTideOtmStatus,
      },
    };

    if (!anyStored) {
      // Pre-wrapper: res.status(500).json({ error: 'All sources failed', ...responseBody }).
      // The sentinel carries the responseBody so the wrapper's errorPayload
      // can re-emit it verbatim alongside the legacy `error` key.
      throw new AllSourcesFailedError(responseBody);
    }

    return {
      status: 'success',
      metadata: {
        stored: anyStored,
        partial,
        allInRows: allInRows?.length ?? 0,
        otmRows: otmRows?.length ?? 0,
        market_tide: allInResult,
        market_tide_otm: otmResult,
        sources: {
          marketTide: marketTideStatus,
          marketTideOtm: marketTideOtmStatus,
        },
      },
    };
  },
  {
    errorPayload: (err) =>
      err instanceof AllSourcesFailedError
        ? { error: 'All sources failed', ...err.responseBody }
        : {},
  },
);
