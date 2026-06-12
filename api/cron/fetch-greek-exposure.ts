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

import { getDb, withDbRetry } from '../_lib/db.js';
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

async function storeAggregate(
  row: AggregateRow,
  runTs: string,
): Promise<boolean> {
  const sql = getDb();
  const result = await withDbRetry(
    () => sql`
      INSERT INTO greek_exposure (
        date, ticker, expiry, dte, timestamp,
        call_gamma, put_gamma, call_charm, put_charm,
        call_delta, put_delta, call_vanna, put_vanna
      )
      VALUES (
        ${row.date}, 'SPX', ${row.date}, -1, ${runTs},
        ${row.call_gamma}, ${row.put_gamma},
        ${row.call_charm}, ${row.put_charm},
        ${row.call_delta}, ${row.put_delta},
        ${row.call_vanna}, ${row.put_vanna}
      )
      ON CONFLICT (date, ticker, expiry, dte, timestamp) DO NOTHING
      RETURNING id
    `,
    2,
    10_000,
  );
  return result.length > 0;
}

async function storeExpiryRows(
  rows: ExpiryRow[],
  runTs: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  try {
    // One transaction = one Neon round-trip. The per-row RETURNING id
    // results are preserved in order, so the conflict-skip split
    // (DO NOTHING → empty result = duplicate) still counts exactly.
    //
    // Behavior change vs. the prior per-row try/catch: the transaction is
    // all-or-nothing. A single bad row aborts the whole batch → stored:0 /
    // skipped:all (matching the fetch-spx-candles-1m gold standard). Rows
    // are pre-validated upstream, so transaction-level error handling is
    // acceptable.
    const results = await sql.transaction((txn) =>
      rows.map(
        (row) => txn`
          INSERT INTO greek_exposure (
            date, ticker, expiry, dte, timestamp,
            call_gamma, put_gamma, call_charm, put_charm,
            call_delta, put_delta, call_vanna, put_vanna
          )
          VALUES (
            ${row.date}, 'SPX', ${row.expiry}, ${row.dte}, ${runTs},
            ${row.call_gamma}, ${row.put_gamma},
            ${row.call_charm}, ${row.put_charm},
            ${row.call_delta}, ${row.put_delta},
            ${row.call_vanna}, ${row.put_vanna}
          )
          ON CONFLICT (date, ticker, expiry, dte, timestamp) DO NOTHING
          RETURNING id
        `,
      ),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return { stored, skipped: rows.length - stored };
  } catch (err) {
    Sentry.captureException(err);
    log.warn({ err }, 'Batch greek_exposure insert failed');
    return { stored: 0, skipped: rows.length };
  }
}

// Handler

export default withCronInstrumentation(
  'fetch-greek-exposure',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger: log } = ctx;

    // One run timestamp shared by every row written this invocation, so all
    // snapshots from a single cron run land at the same instant (append model:
    // we retain intraday history instead of overwriting in place).
    const runTs = new Date().toISOString();

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
      aggStored = await withRetry(() => storeAggregate(latest, runTs));

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
        ? await withRetry(() => storeExpiryRows(expiryRows, runTs, log))
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
    const qcSql = getDb();
    const qcRows = await withDbRetry(
      () => qcSql`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE (call_gamma::numeric IS NOT NULL AND call_gamma::numeric != 0)
                    OR (put_gamma::numeric IS NOT NULL AND put_gamma::numeric != 0)
               ) AS nonzero
        FROM greek_exposure
        WHERE date = ${today} AND ticker = 'SPX'
      `,
      2,
      10_000,
    );
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
