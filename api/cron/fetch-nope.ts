/**
 * GET /api/cron/fetch-nope
 *
 * Fetches UW NOPE (Net Options Pricing Effect) per-minute data for SPY and
 * upserts into nope_ticks. Runs every minute during market hours.
 *
 * Why SPY, not SPX: NOPE's denominator is underlying stock_vol. SPX has no
 * tradable shares, so SPX NOPE is not meaningful. SPY acts as the practical
 * proxy for 0DTE SPX hedging pressure since dealers hedge SPX options via
 * SPY (and ES), not the index itself.
 *
 * UW returns the full day each call and restates minutes as fills accumulate
 * and late prints settle. The upsert is idempotent on the primary key
 * (ticker, timestamp) and keeps the latest values. Every conflicting minute is
 * compared with the stored row: one whose values are all unchanged is left
 * alone (not rewritten, not logged), one with a changed value is updated, and
 * every inserted or changed minute is appended to nope_ticks_revisions with
 * the writer 'fetch-nope', in the same statement (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). Until P0.9 this
 * rewrote every column of every minute on every call, `ingested_at` included,
 * which erased both the first-seen value and the first-ingest time.
 * `ingested_at` is never written here: the column default sets it on insert.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { cronJitter, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getDb } from '../_lib/db.js';

export interface UwNopeRow {
  timestamp: string;
  call_vol: number;
  put_vol: number;
  stock_vol: number;
  call_delta: string;
  put_delta: string;
  call_fill_delta: string;
  put_fill_delta: string;
  nope: string;
  nope_fill: string;
}

const NOPE_TICKER = 'SPY';
const NOPE_PATH = `/stock/${NOPE_TICKER}/nope`;

export default withCronInstrumentation(
  'fetch-nope',
  async (ctx): Promise<CronResult> => {
    const { apiKey, logger: log } = ctx;

    await cronJitter();

    const rows = await withRetry(() => uwFetch<UwNopeRow>(apiKey, NOPE_PATH));

    if (rows.length === 0) {
      return {
        status: 'success',
        metadata: { fetched: 0, upserted: 0 },
      };
    }

    const db = getDb();

    // Filter out rows with invalid numerics (UW returns partial rows at
    // session edges occasionally) before building the upsert payload.
    const validRows: Array<{
      ticker: string;
      timestamp: string;
      call_vol: number;
      put_vol: number;
      stock_vol: number;
      call_delta: string;
      put_delta: string;
      call_fill_delta: string;
      put_fill_delta: string;
      nope: string;
      nope_fill: string;
    }> = [];
    let skipped = 0;
    for (const r of rows) {
      if (
        !Number.isFinite(Number.parseFloat(r.nope)) ||
        !Number.isFinite(r.stock_vol) ||
        r.stock_vol <= 0
      ) {
        skipped++;
        continue;
      }
      validRows.push({
        ticker: NOPE_TICKER,
        timestamp: r.timestamp,
        call_vol: r.call_vol,
        put_vol: r.put_vol,
        stock_vol: r.stock_vol,
        call_delta: r.call_delta,
        put_delta: r.put_delta,
        call_fill_delta: r.call_fill_delta,
        put_fill_delta: r.put_fill_delta,
        nope: r.nope,
        nope_fill: r.nope_fill,
      });
    }

    // `upserted` stays the number of rows sent (the legacy count); the
    // revision log adds the exact inserted / updated / unchanged counts.
    const { inserted, updated, unchanged } = await bulkUpsert({
      sql: db,
      table: 'nope_ticks',
      columns: [
        'ticker',
        'timestamp',
        'call_vol',
        'put_vol',
        'stock_vol',
        'call_delta',
        'put_delta',
        'call_fill_delta',
        'put_fill_delta',
        'nope',
        'nope_fill',
      ],
      rows: validRows,
      conflictTarget: '(ticker, timestamp)',
      revisionLog: { table: 'nope_ticks_revisions', writer: 'fetch-nope' },
    });
    const upserted = validRows.length;

    if (skipped > 0) {
      log.warn(
        { skipped, fetched: rows.length },
        'fetch-nope skipped rows with invalid stock_vol or nope',
      );
    }

    log.info(
      { fetched: rows.length, upserted, inserted, updated, unchanged, skipped },
      'fetch-nope completed',
    );

    return {
      status: 'success',
      metadata: {
        fetched: rows.length,
        upserted,
        inserted,
        updated,
        unchanged,
        skipped,
      },
    };
  },
  {
    // Pre-wrapper code emitted `{ job, error: <err.message> }` on 500.
    // The wrapper default is `{ job, error: 'Internal error' }` -
    // override to keep the original message surfaced to monitoring.
    errorPayload: (err) => ({
      job: 'fetch-nope',
      error: err instanceof Error ? err.message : String(err),
    }),
  },
);
