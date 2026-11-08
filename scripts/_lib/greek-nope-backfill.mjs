/**
 * The writes the three backfill scripts make into vega_flow_etf and nope_ticks:
 * backfill-greek-flow-etf.mjs, backfill-greek-flow-etf-0dte.mjs and
 * backfill-nope.mjs. They run on import, so the writes live here to be tested.
 *
 * Spec P0.9, docs/superpowers/specs/live-data-integrity-2026-11-06.md. Each
 * day is ONE statement through bulkUpsert's revision log: the upsert, a guard
 * that rewrites a row only when a value differs, and an INSERT of every
 * inserted or changed row into vega_flow_etf_revisions / nope_ticks_revisions
 * under the script's name, so a backfill that restates a value leaves both the
 * old and the new one on record. (They used to write one row at a time, with no
 * log; the all-expiries script conflicted on (ticker, timestamp), a constraint
 * migration #129 dropped, so it failed on every row and still exited 0; and the
 * nope script set ingested_at = now() on every conflict.)
 *
 * A failed day is warned about and counted in `failed`, not thrown, so one bad
 * day does not stop the run; the scripts exit non-zero when anything failed.
 */

import { bulkUpsert } from '../../api/_lib/bulk-upsert.ts';

/** Every vega_flow_etf column a backfill writes (all but id and inserted_at). */
export const VEGA_FLOW_COLUMNS = [
  'ticker',
  'date',
  'timestamp',
  'expiry',
  'dir_vega_flow',
  'otm_dir_vega_flow',
  'total_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'otm_dir_delta_flow',
  'total_delta_flow',
  'otm_total_delta_flow',
  'transactions',
  'volume',
];

/**
 * The columns UW restates. ticker, timestamp and expiry are the key; `date` is
 * the trading day the caller asked for and is never rewritten.
 */
const VEGA_RESTATED_COLUMNS = VEGA_FLOW_COLUMNS.filter(
  (c) => !['ticker', 'date', 'timestamp', 'expiry'].includes(c),
);

/** Every nope_ticks column a backfill writes (all but ingested_at). */
export const NOPE_COLUMNS = [
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
];

const NOPE_TICKER = 'SPY';

/**
 * Store one (ticker, day, scope) of greek-flow ticks. `expiry` is null for the
 * all-expiries feed and the date for the 0DTE feed.
 *
 * @returns {Promise<{inserted: number, updated: number, unchanged: number, failed: number}>}
 */
export async function storeVegaFlowTicks(
  sql,
  { ticker, date, expiry, ticks, writer },
) {
  if (ticks.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0, failed: 0 };
  }
  const rows = ticks.map((t) => ({
    ticker,
    date,
    timestamp: t.timestamp,
    expiry,
    dir_vega_flow: t.dir_vega_flow,
    otm_dir_vega_flow: t.otm_dir_vega_flow,
    total_vega_flow: t.total_vega_flow,
    otm_total_vega_flow: t.otm_total_vega_flow,
    dir_delta_flow: t.dir_delta_flow,
    otm_dir_delta_flow: t.otm_dir_delta_flow,
    total_delta_flow: t.total_delta_flow,
    otm_total_delta_flow: t.otm_total_delta_flow,
    transactions: t.transactions,
    volume: t.volume,
  }));
  try {
    const { inserted, updated, unchanged } = await bulkUpsert({
      sql,
      table: 'vega_flow_etf',
      columns: VEGA_FLOW_COLUMNS,
      rows,
      conflictTarget: '(ticker, timestamp, expiry)',
      conflictUpdateColumns: VEGA_RESTATED_COLUMNS,
      revisionLog: { table: 'vega_flow_etf_revisions', writer },
    });
    return { inserted, updated, unchanged, failed: 0 };
  } catch (err) {
    const scope = expiry
      ? `${ticker} ${date} expiry ${expiry}`
      : `${ticker} ${date}`;
    console.warn(`  Upsert error (${scope}): ${err.message}`);
    return { inserted: 0, updated: 0, unchanged: 0, failed: ticks.length };
  }
}

/**
 * Store one day of SPY NOPE rows. Rows with an invalid nope or a non-positive
 * stock_vol are skipped, as the cron skips them.
 *
 * @returns {Promise<{inserted: number, updated: number, unchanged: number, skipped: number, failed: number}>}
 */
export async function storeNopeRows(sql, rows, writer) {
  const valid = [];
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
    valid.push({
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
  if (valid.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0, skipped, failed: 0 };
  }
  try {
    const { inserted, updated, unchanged } = await bulkUpsert({
      sql,
      table: 'nope_ticks',
      columns: NOPE_COLUMNS,
      rows: valid,
      conflictTarget: '(ticker, timestamp)',
      revisionLog: { table: 'nope_ticks_revisions', writer },
    });
    return { inserted, updated, unchanged, skipped, failed: 0 };
  } catch (err) {
    console.warn(`  Insert error: ${err.message}`);
    return {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped,
      failed: valid.length,
    };
  }
}
