/**
 * GET /api/cron/fetch-greek-exposure
 *
 * Fetches Greek Exposure for SPX from Unusual Whales API.
 * Two calls per invocation:
 *   1. Aggregate endpoint -> OI Net Gamma (Rule 16), charm, delta, vanna
 *   2. By-expiry endpoint -> charm/delta/vanna breakdown per expiration (gamma is null on basic tier)
 *
 * The aggregate row is stored with expiry=date and dte=-1.
 * The 0DTE by-expiry row is stored with expiry=date and dte=0.
 * The UNIQUE constraint on (date, ticker, expiry, dte) allows both to coexist.
 *
 * Data is OI-based (changes once per day), so duplicate cron runs are skipped.
 *
 * Total API calls per invocation: 2
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { uwFetch, checkDataQuality, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// Types

interface AggregateRow {
  date: string;
  call_gamma: string;
  put_gamma: string;
  call_charm: string;
  put_charm: string;
  call_delta: string;
  put_delta: string;
  call_vanna: string;
  put_vanna: string;
}

interface ExpiryRow {
  date: string;
  expiry: string;
  dte: number;
  call_gamma: string | null;
  put_gamma: string | null;
  call_charm: string;
  put_charm: string;
  call_delta: string;
  put_delta: string;
  call_vanna: string;
  put_vanna: string;
}

// Sentinel: signals "all sources failed - return 500 with the legacy
// { error: 'All sources failed' } body". Distinct from a thrown error
// (which the wrapper renders as { job, error: 'Internal error' }).
class AllSourcesFailedError extends Error {
  constructor() {
    super('All sources failed');
    this.name = 'AllSourcesFailedError';
  }
}

// Fetch helpers

async function fetchAggregate(apiKey: string): Promise<AggregateRow[]> {
  return uwFetch<AggregateRow>(apiKey, '/stock/SPX/greek-exposure');
}

async function fetchByExpiry(apiKey: string): Promise<ExpiryRow[]> {
  return uwFetch<ExpiryRow>(apiKey, '/stock/SPX/greek-exposure/expiry');
}

// Store helpers

async function storeAggregate(row: AggregateRow): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    INSERT INTO greek_exposure (
      date, ticker, expiry, dte,
      call_gamma, put_gamma, call_charm, put_charm,
      call_delta, put_delta, call_vanna, put_vanna
    )
    VALUES (
      ${row.date}, 'SPX', ${row.date}, -1,
      ${row.call_gamma}, ${row.put_gamma},
      ${row.call_charm}, ${row.put_charm},
      ${row.call_delta}, ${row.put_delta},
      ${row.call_vanna}, ${row.put_vanna}
    )
    ON CONFLICT (date, ticker, expiry, dte) DO UPDATE SET
      call_gamma = EXCLUDED.call_gamma,
      put_gamma = EXCLUDED.put_gamma
    RETURNING id
  `;
  return result.length > 0;
}

async function storeExpiryRows(
  rows: ExpiryRow[],
  log: { warn: (obj: object, msg: string) => void },
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await sql`
        INSERT INTO greek_exposure (
          date, ticker, expiry, dte,
          call_gamma, put_gamma, call_charm, put_charm,
          call_delta, put_delta, call_vanna, put_vanna
        )
        VALUES (
          ${row.date}, 'SPX', ${row.expiry}, ${row.dte},
          ${row.call_gamma}, ${row.put_gamma},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_vanna}, ${row.put_vanna}
        )
        ON CONFLICT (date, ticker, expiry, dte) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      log.warn({ err, expiry: row.expiry }, 'Greek exposure insert failed');
      skipped++;
    }
  }

  return { stored, skipped };
}

// Handler

export default withCronInstrumentation(
  'fetch-greek-exposure',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger: log } = ctx;

    // Fetch aggregate and by-expiry in parallel; tolerate partial failures
    const [aggFetch, expiryFetch] = await Promise.allSettled([
      withRetry(() => fetchAggregate(apiKey)),
      withRetry(() => fetchByExpiry(apiKey)),
    ]);

    if (aggFetch.status === 'rejected') {
      log.warn(
        { err: aggFetch.reason },
        'fetch-greek-exposure: aggregate fetch failed',
      );
      Sentry.captureException(aggFetch.reason);
    }
    if (expiryFetch.status === 'rejected') {
      log.warn(
        { err: expiryFetch.reason },
        'fetch-greek-exposure: expiry fetch failed',
      );
      Sentry.captureException(expiryFetch.reason);
    }

    const aggRows = aggFetch.status === 'fulfilled' ? aggFetch.value : null;
    const expiryRows =
      expiryFetch.status === 'fulfilled' ? expiryFetch.value : null;

    let aggStored = false;
    if (aggRows !== null && aggRows.length > 0) {
      const latest = aggRows.at(-1)!;
      aggStored = await withRetry(() => storeAggregate(latest));

      const netGamma =
        Number.parseFloat(latest.call_gamma) +
        Number.parseFloat(latest.put_gamma);
      log.info(
        {
          date: latest.date,
          netGamma: Math.round(netGamma),
          stored: aggStored,
        },
        'Aggregate GEX stored',
      );
    }

    const expiryResult =
      expiryRows !== null
        ? await withRetry(() => storeExpiryRows(expiryRows, log))
        : { stored: 0, skipped: 0 };

    const partial =
      aggFetch.status === 'rejected' || expiryFetch.status === 'rejected';
    const anyStored = aggStored || expiryResult.stored > 0;

    log.info(
      {
        aggregate: aggStored,
        expiries: expiryRows?.length ?? 0,
        expiryStored: expiryResult.stored,
        expirySkipped: expiryResult.skipped,
        partial,
      },
      'fetch-greek-exposure completed',
    );

    // Data quality check: alert if all gamma values are null/zero
    const qcRows = await getDb()`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (
               WHERE (call_gamma::numeric IS NOT NULL AND call_gamma::numeric != 0)
                  OR (put_gamma::numeric IS NOT NULL AND put_gamma::numeric != 0)
             ) AS nonzero
      FROM greek_exposure
      WHERE date = ${today} AND ticker = 'SPX'
    `;
    const { total: qcTotal, nonzero: qcNonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-greek-exposure',
      table: 'greek_exposure',
      date: today,
      total: Number(qcTotal),
      nonzero: Number(qcNonzero),
      minRows: 0,
    });

    if (!anyStored && partial) {
      // Pre-wrapper code returned res.status(500).json({ error: 'All
      // sources failed' }). Throw a sentinel so the wrapper's
      // errorPayload preserves that exact body.
      throw new AllSourcesFailedError();
    }

    return {
      status: partial ? 'partial' : 'success',
      metadata: {
        aggregateStored: aggStored,
        expiries: expiryRows?.length ?? 0,
        partial,
        stored: expiryResult.stored,
        skipped: expiryResult.skipped,
        aggFailed: aggFetch.status === 'rejected',
        expiryFailed: expiryFetch.status === 'rejected',
      },
    };
  },
  {
    errorPayload: (err) =>
      err instanceof AllSourcesFailedError
        ? { error: 'All sources failed' }
        : {},
  },
);
