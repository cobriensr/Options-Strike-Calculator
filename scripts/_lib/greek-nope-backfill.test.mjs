// @vitest-environment node

/**
 * Unit tests for scripts/_lib/greek-nope-backfill.mjs, the writes the three
 * backfill scripts make into vega_flow_etf and nope_ticks (spec P0.9,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). The statements run
 * for real in greek-nope-backfill-pglite.test.mjs, and the scripts run end to
 * end in greek-nope-backfill.cli.test.mjs; here: the statement text, the
 * parameters, the counts, and what a failure looks like to the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NOPE_COLUMNS,
  VEGA_FLOW_COLUMNS,
  storeNopeRows,
  storeVegaFlowTicks,
} from './greek-nope-backfill.mjs';

afterEach(() => vi.restoreAllMocks());

const DATE = '2026-03-24';

const tick = (hhmm, flow = '1') => ({
  timestamp: `${DATE}T${hhmm}:00Z`,
  dir_vega_flow: flow,
  otm_dir_vega_flow: flow,
  total_vega_flow: flow,
  otm_total_vega_flow: flow,
  dir_delta_flow: flow,
  otm_dir_delta_flow: flow,
  total_delta_flow: flow,
  otm_total_delta_flow: flow,
  transactions: 7,
  volume: 9,
});

const nopeRow = (hhmm, overrides = {}) => ({
  timestamp: `${DATE}T${hhmm}:00Z`,
  call_vol: 10,
  put_vol: 20,
  stock_vol: 1000,
  call_delta: '1.5',
  put_delta: '-2.5',
  call_fill_delta: '3.5',
  put_fill_delta: '-4.5',
  nope: '-0.000648',
  nope_fill: '-0.000434',
  ...overrides,
});

/** A neon handle whose query resolves `rows` (what the log insert returns). */
const fakeSql = (rows = []) => ({ query: vi.fn(async () => rows) });
const failingSql = (message) => ({
  query: vi.fn(async () => Promise.reject(new Error(message))),
});
const flat = (stmt) => stmt.replaceAll(/\s+/g, ' ');

describe('storeVegaFlowTicks', () => {
  const write = (sql, overrides = {}) =>
    storeVegaFlowTicks(sql, {
      ticker: 'SPY',
      date: DATE,
      expiry: null,
      ticks: [tick('13:35'), tick('13:36')],
      writer: 'backfill-greek-flow-etf',
      ...overrides,
    });

  it('writes the day as ONE statement that logs to vega_flow_etf_revisions, with the writer as the last parameter', async () => {
    const sql = fakeSql();

    await write(sql);

    expect(sql.query).toHaveBeenCalledTimes(1);
    const [stmt, params] = sql.query.mock.calls[0];
    const text = flat(stmt);
    expect(text).toContain('INSERT INTO vega_flow_etf (');
    expect(text).toContain('INSERT INTO vega_flow_etf_revisions');
    // The all-expiries script used ON CONFLICT (ticker, timestamp), a
    // constraint migration #129 dropped: it failed on every row.
    expect(text).toContain('ON CONFLICT (ticker, timestamp, expiry)');
    expect(text).toContain('IS DISTINCT FROM');
    // `date` belongs to the key's meaning and is never restated.
    expect(text).not.toContain('date = EXCLUDED.date');
    // 14 columns for each of the two ticks, then the writer.
    expect(params).toHaveLength(VEGA_FLOW_COLUMNS.length * 2 + 1);
    expect(params.at(-1)).toBe('backfill-greek-flow-etf');
  });

  it('puts ticker, date, timestamp and expiry on every row: expiry null for the all-expiries feed, the date for 0DTE', async () => {
    const all = fakeSql();
    const zeroDte = fakeSql();

    await write(all);
    await write(zeroDte, {
      expiry: DATE,
      writer: 'backfill-greek-flow-etf-0dte',
    });

    const first = (sql) => sql.query.mock.calls[0][1].slice(0, 4);
    expect(first(all)).toEqual(['SPY', DATE, `${DATE}T13:35:00Z`, null]);
    expect(first(zeroDte)).toEqual(['SPY', DATE, `${DATE}T13:35:00Z`, DATE]);
    expect(zeroDte.query.mock.calls[0][1].at(-1)).toBe(
      'backfill-greek-flow-etf-0dte',
    );
  });

  it('counts inserted, updated and unchanged from the rows the log insert returned', async () => {
    const sql = fakeSql([{ inserted: true }]);

    const result = await write(sql);

    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 1,
      failed: 0,
    });
  });

  it('writes nothing for no ticks', async () => {
    const sql = fakeSql();

    const result = await write(sql, { ticks: [] });

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('warns with the error and reports every tick of the day as failed instead of throwing, so the script can exit non-zero (R4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = failingSql('relation "vega_flow_etf_revisions" does not exist');

    const result = await write(sql);

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      failed: 2,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Upsert error (SPY 2026-03-24): relation "vega_flow_etf_revisions" does not exist',
      ),
    );
  });

  it('names the expiry in the failure line of a 0DTE day', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await write(failingSql('boom'), { expiry: DATE });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Upsert error (SPY 2026-03-24 expiry 2026-03-24)',
      ),
    );
  });
});

describe('storeNopeRows', () => {
  const write = (sql, rows) => storeNopeRows(sql, rows, 'backfill-nope');

  it('writes the day as ONE statement that logs to nope_ticks_revisions and never writes ingested_at', async () => {
    const sql = fakeSql();

    await write(sql, [nopeRow('13:35'), nopeRow('13:36')]);

    expect(sql.query).toHaveBeenCalledTimes(1);
    const [stmt, params] = sql.query.mock.calls[0];
    const text = flat(stmt);
    expect(text).toContain('INSERT INTO nope_ticks (');
    expect(text).toContain('INSERT INTO nope_ticks_revisions');
    expect(text).toContain('ON CONFLICT (ticker, timestamp)');
    expect(text).toContain('IS DISTINCT FROM');
    // The old script set ingested_at = now() on every conflict.
    expect(text).not.toContain('ingested_at');
    expect(params).toHaveLength(NOPE_COLUMNS.length * 2 + 1);
    expect(params.at(-1)).toBe('backfill-nope');
    expect(params.slice(0, 2)).toEqual(['SPY', `${DATE}T13:35:00Z`]);
  });

  it('skips rows with an invalid nope or a zero stock_vol, as the cron does, and counts them', async () => {
    const sql = fakeSql([{ inserted: true }]);

    const result = await write(sql, [
      nopeRow('13:35'),
      nopeRow('13:36', { stock_vol: 0 }),
      nopeRow('13:37', { nope: 'NaN' }),
      nopeRow('13:38', { stock_vol: Number.NaN }),
    ]);

    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      skipped: 3,
      failed: 0,
    });
    expect(sql.query.mock.calls[0][1]).toHaveLength(NOPE_COLUMNS.length + 1);
  });

  it('writes nothing when every row is skipped', async () => {
    const sql = fakeSql();

    const result = await write(sql, [nopeRow('13:35', { stock_vol: 0 })]);

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      failed: 0,
    });
    expect(sql.query).not.toHaveBeenCalled();
  });

  it('warns and reports the valid rows as failed instead of throwing (R4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = failingSql('relation "nope_ticks_revisions" does not exist');

    const result = await write(sql, [
      nopeRow('13:35'),
      nopeRow('13:36'),
      nopeRow('13:37', { stock_vol: 0 }),
    ]);

    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      failed: 2,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Insert error: relation "nope_ticks_revisions" does not exist',
      ),
    );
  });
});
