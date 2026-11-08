// @vitest-environment node

/**
 * fetch-greek-flow stores UW's SPX 0DTE greek flow as 5-minute flow_data rows
 * under the same rules as the ETF tide and zero-DTE crons (spec P0.2, F4,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md): only today's
 * session (R-day), a missing or unparseable value is never stored as 0
 * (R-null), a bucket only once it closed and settled (R-closed), stamped at its
 * end (label rule), upserted so a revised value is healed, and a failed write
 * fails the run (R4).
 *
 * 2026-03-24 is on EDT (UTC-4): 09:30 ET is 13:30Z, 16:00 ET is 20:00Z.
 * 2026-11-27 is a half day on EST (UTC-5): 09:30 ET is 14:30Z, 13:00 ET is 18:00Z.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/fetch-greek-flow.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  OUTCOME_ROWS,
  SOURCE,
  at,
  bucketValues,
  makeGreekFlowTick,
  stubFetch,
  tickGrid,
  uwFetchCalls,
  withMinute,
  type Outcome,
} from './spx-greek-flow-fixtures';

// Fixed "market hours" date: Tuesday 10:08 AM ET, a cron minute (:08). The
// 09:30-10:00 and 10:00-10:05 buckets have closed and settled; 10:05-10:10 is
// open.
const MARKET_TIME = new Date('2026-03-24T14:08:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

/** The SQL text of each upsert the last `recordInserts` recorder saw. */
let upsertTexts: string[] = [];

/** The writer name each upsert of the last `recordInserts` recorder logged under. */
let upsertWriters: string[] = [];

/**
 * Replace the batch transaction with a recorder: each upsert's bound values
 * (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp) are
 * pushed to the returned array and its SQL text to `upsertTexts`, and each is
 * answered with `outcome(values, index)` (default: a new row). The last bound
 * value is the writer the revision log records; it goes to `upsertWriters`,
 * not to the row values.
 */
function recordInserts(
  outcome: (values: unknown[], index: number) => Outcome = () => 'inserted',
) {
  const inserts: unknown[][] = [];
  const texts: string[] = [];
  upsertTexts = texts;
  upsertWriters = [];
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      const queries = fn((strings: unknown, ...values: unknown[]) => {
        texts.push((strings as string[]).join('?'));
        upsertWriters.push(String(values.at(-1)));
        bound.push(values.slice(0, -1));
        return {};
      });
      inserts.push(...bound);
      return queries.map((_q, i) => OUTCOME_ROWS[outcome(bound[i]!, i)]);
    },
  );
  return inserts;
}

async function runCron() {
  const req = mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
  const res = mockResponse();
  await handler(req, res);
  return res;
}

describe('fetch-greek-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // The data-quality COUNT always answers one row.
    mockSql.mockResolvedValue([{ total: 0, nonzero: 0 }]);
    mockSql.transaction = mockTransaction;
    // Default: every upsert in the batch inserts a new row.
    recordInserts();
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is set and header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    stubFetch();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours (early morning)', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = await runCron();
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = await runCron();
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  it.each([
    ['09:24 ET, before the 09:25 buffer', '13:24', true],
    ['09:28 ET, the first run', '13:28', false],
    ['16:03 ET, the first attempt at the last bucket', '20:03', false],
    ['16:08 ET, the second attempt at the last bucket', '20:08', false],
    ['16:10 ET, the last minute of the window', '20:10', false],
    ['16:11 ET, after the window', '20:11', true],
  ])('window: %s', async (_label, hhmmZ, skipped) => {
    vi.setSystemTime(at(hhmmZ));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);
    const res = await runCron();
    expect(res._status).toBe(200);
    expect(Boolean((res._json as { skipped?: boolean }).skipped)).toBe(skipped);
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = await runCron();
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path and value mapping ──────────────────────────

  it('stores a closed bucket under its END time with the mapped values, as numbers', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([makeGreekFlowTick()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-greek-flow',
      status: 'success',
      ticks: 1,
      stored: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      pending: 0,
      stuck: 0,
    });
    // One transaction = one Neon round-trip. The 10:00-10:05 bucket's last
    // minute (10:04) is stored at 10:05 (14:05Z): ncp = total_delta_flow,
    // npp = dir_delta_flow, net_volume = volume, otm_ncp = otm_total_delta_flow
    // and otm_npp = otm_dir_delta_flow.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([
      [
        '2026-03-24',
        '2026-03-24T14:05:00.000Z',
        SOURCE,
        5000000,
        -3000000,
        120000,
        3000000,
        -1500000,
      ],
    ]);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'success', stored: 1, inserted: 1 }),
    );
  });

  it('writes the OTM wings with the upsert, and compares them (ENH-FIX-001 stays fixed)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeGreekFlowTick({
        otm_total_delta_flow: '2500000',
        otm_dir_delta_flow: '-1800000',
      }),
    ]);

    await runCron();

    expect(upsertTexts).toHaveLength(1);
    const text = upsertTexts[0]!;
    expect(text).toContain('otm_ncp');
    expect(text).toContain('otm_npp');
    expect(text).toContain('ON CONFLICT (date, timestamp, source) DO UPDATE');
    expect(text).toContain('IS DISTINCT FROM');
    // The same statement appends the row to the revision log (P0.7).
    expect(text).toContain('INSERT INTO flow_data_revisions');
    expect(text).toContain('(xmax = 0) AS is_first');
    expect(text).toContain('RETURNING is_first AS inserted');
    expect(text).not.toContain('DO NOTHING');
    expect(text).not.toContain('created_at');
    expect(inserts[0]?.slice(-2)).toEqual([2500000, -1800000]);
  });

  it('logs every write to the revision log under the job name', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts();
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T13:59:00Z' }),
    ]);

    await runCron();

    expect(upsertWriters).toEqual(['fetch-greek-flow', 'fetch-greek-flow']);
  });

  it('stores NULL when UW sends no volume for the last minute', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([makeGreekFlowTick({ volume: null })]);

    await runCron();

    expect(inserts[0]?.[5]).toBeNull();
  });

  it('stores a real zero, which is a value and not a missing one', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeGreekFlowTick({
        total_delta_flow: '0',
        dir_delta_flow: '5',
        otm_total_delta_flow: 0,
        otm_dir_delta_flow: '0.00',
        volume: 0,
      }),
    ]);

    await runCron();

    expect(inserts[0]?.slice(3)).toEqual([0, 5, 0, 0, 0]);
  });

  it('handles empty data (no ticks) as a payload with no rows for today', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      ticks: 0,
      stored: 0,
      skipped: 0,
      reason: 'no_rows_today',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Five-minute buckets ───────────────────────────────────

  it("keeps the bucket's last minute when several ticks share a window, whatever order UW sent them in", async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeGreekFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        total_delta_flow: '300',
      }),
      makeGreekFlowTick({
        timestamp: '2026-03-24T14:03:00Z',
        total_delta_flow: '200',
      }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ ticks: 2, stored: 1, skipped: 0 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[3]).toBe(300);
  });

  it('ticks in different 5-min windows produce separate inserts at their window ends, oldest first', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T13:59:00Z' }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ ticks: 2, stored: 2 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts.map((v) => v[1])).toEqual([
      '2026-03-24T14:00:00.000Z',
      '2026-03-24T14:05:00.000Z',
    ]);
  });

  it('10:04 ET: stores only the closed buckets at bucket-end labels, not the open 10:00-10:05 one (R-closed, label rule)', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // The open bucket's early minutes have values; its last minute is still null.
    stubFetch(tickGrid('2026-03-24', at('14:02')));

    const res = await runCron();

    expect(res._json).toMatchObject({
      stored: 6,
      skipped: 0,
      pending: 0,
      stuck: 0,
    });
    // 09:30-09:35 is stored at 09:35 (13:35Z) ... 09:55-10:00 at 10:00 (14:00Z).
    expect(inserts).toEqual([0, 1, 2, 3, 4, 5].map((k) => bucketValues(k)));
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('stores the same buckets when UW leaves the future minutes out instead of sending nulls', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('14:02'), { prefilled: false }));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 6, pending: 0, stuck: 0 });
    expect(inserts).toEqual([0, 1, 2, 3, 4, 5].map((k) => bucketValues(k)));
  });

  it('waits for a bucket that ended less than 90 s ago, even though its last minute has a value (R-closed, FINAL_LAG)', async () => {
    vi.setSystemTime(new Date('2026-03-24T14:00:30.000Z'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('14:01')));

    await runCron();

    // 13:55-14:00 ended 30 s ago: not yet. 13:50-13:55 is the newest stored, at 13:55.
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T13:55:00.000Z');
  });

  // ── Pre-open previous session, frozen grid (F4) ───────────

  it("09:28 ET: a payload of yesterday's trades (1DTE flow) stores nothing, logs and counts it, and is not an error (R-day)", async () => {
    vi.setSystemTime(at('13:28'));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-23', at('20:15', '2026-03-23')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      ticks: 405,
      stored: 0,
      skipped: 0,
      reason: 'no_rows_today',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_greek_flow.no_rows_today',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ payloadRows: 405 }),
      expect.stringContaining('no rows for today'),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
    // Normal before 09:40 ET: no alert.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('09:32 ET: the prefilled grid with null future minutes stores nothing and counts no bad candle', async () => {
    vi.setSystemTime(at('13:32'));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-24', at('13:32')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 405,
      stored: 0,
      skipped: 0,
      pending: 0,
      stuck: 0,
    });
    expect(res._json).not.toMatchObject({ rejected: true });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Revised values are healed (upsert) ────────────────────

  it('reports inserted and updated rows separately, and unchanged ones as skipped', async () => {
    vi.setSystemTime(at('14:20'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(
      (_values, i) => (['inserted', 'updated', 'unchanged'] as const)[i % 3]!,
    );
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T13:34:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T13:39:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T13:44:00Z' }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({
      stored: 2,
      inserted: 1,
      updated: 1,
      skipped: 1,
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ inserted: 1, updated: 1, skipped: 1 }),
    );
  });

  it('a value UW revised after the first write updates the row on the next run', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 12, nonzero: 12 }]);
    const inserts = recordInserts(() => 'updated');
    stubFetch([makeGreekFlowTick({ total_delta_flow: '5400000' })]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 1, inserted: 0, updated: 1 });
    // The revised value is what is sent; the SQL rewrites a changed row.
    expect(inserts[0]?.[3]).toBe(5400000);
    expect(upsertTexts[0]).toContain('DO UPDATE');
    // A write happened, so the quality query ran.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('counts a bucket that already holds these values as skipped and does not run the quality query', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubFetch([makeGreekFlowTick()]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, skipped: 1 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Bad minutes: pending, stuck, never stored as 0 ────────

  it('leaves a closed bucket whose last minute has a null wing out as pending while UW may still be late: no metric, no alert (R-null)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // 10:00-10:05 ended 3 minutes before MARKET_TIME.
    stubFetch(
      withMinute(tickGrid('2026-03-24', MARKET_TIME), '14:04', {
        otm_dir_delta_flow: null,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 6, pending: 1, stuck: 0 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T14:05:00.000Z');
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('counts closed buckets that ended 10 minutes ago or more with no usable last minute as stuck, with one warning naming the oldest', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // 09:55-10:00 ended 8 min before MARKET_TIME (pending); 09:40-09:45 and
    // 09:30-09:35 ended 23 and 33 min before: stuck.
    let grid = withMinute(tickGrid('2026-03-24', MARKET_TIME), '13:44', {
      total_delta_flow: null,
    });
    grid = withMinute(grid, '13:34', { dir_delta_flow: 'garbage' });
    grid = withMinute(grid, '13:59', { volume: 'n/a' });
    stubFetch(grid);

    const res = await runCron();

    expect(res._json).toMatchObject({ stuck: 2, pending: 1 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T13:35:00.000Z');
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T13:45:00.000Z');
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_greek_flow.invalid_candle',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'fetch-greek-flow',
          stage: 'stuck_bucket',
        }),
        extra: expect.objectContaining({
          stuck: 2,
          oldest: '2026-03-24T13:35:00.000Z',
        }),
      }),
    );
  });

  it.each([
    ['total_delta_flow', 'null', null],
    ['total_delta_flow', 'garbled', 'not-a-number'],
    ['dir_delta_flow', 'null', null],
    ['dir_delta_flow', 'blank', ''],
    ['otm_total_delta_flow', 'null', null],
    ['otm_total_delta_flow', 'garbled', 'garbage'],
    ['otm_dir_delta_flow', 'null', null],
    ['otm_dir_delta_flow', 'out of range for DECIMAL(14,2)', '1e13'],
  ])(
    'never stores a past minute with %s %s as 0 or NULL (R-null)',
    async (field, _kind, bad) => {
      process.env.UW_API_KEY = 'uwkey';
      const inserts = recordInserts();
      // 13:44 is the last minute of the 09:40-09:45 bucket, 23 minutes old.
      stubFetch(
        withMinute(tickGrid('2026-03-24', MARKET_TIME), '13:44', {
          [field]: bad,
        }),
      );

      const res = await runCron();

      expect(res._json).toMatchObject({ stuck: 1 });
      const labels = inserts.map((v) => v[1]);
      expect(labels).not.toContain('2026-03-24T13:45:00.000Z');
      expect(labels).toContain('2026-03-24T13:40:00.000Z');
      expect(labels).toContain('2026-03-24T13:50:00.000Z');
      // No stored value is a 0 or a NULL that stands in for the missing one.
      for (const row of inserts) {
        expect(row.slice(3, 5).every((v) => typeof v === 'number')).toBe(true);
        expect(row.slice(6).every((v) => typeof v === 'number')).toBe(true);
      }
      expect(metrics.increment).toHaveBeenCalledWith(
        'fetch_greek_flow.invalid_candle',
      );
    },
  );

  // ── All-zero / all-stuck snapshots ────────────────────────

  it('rejects a snapshot whose every closed bucket has zero total and directional delta flow, and raises a Sentry error', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        total_delta_flow: '0',
        dir_delta_flow: '0',
      }),
      makeGreekFlowTick({
        timestamp: '2026-03-24T13:59:00Z',
        total_delta_flow: '0',
        dir_delta_flow: '0',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    // The Sentry error below is the alert; the run status stays `success`, as
    // for the ETF tide and zero-DTE crons (spec P0.1 design).
    expect(res._json).toMatchObject({
      status: 'success',
      message: 'Rejected an all-zero/unusable greek flow snapshot',
      stored: 0,
      rejected: true,
    });
    // Nothing persisted: the degenerate snapshot is dropped before the write.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'fetch-greek-flow',
          stage: 'degenerate_snapshot',
        }),
      }),
    );
  });

  it('rejects and reports a snapshot whose only closed buckets are stuck, and writes neither a 0 nor a NULL row', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 09:40-09:45 and 09:45-09:50 ended 23 and 18 minutes before MARKET_TIME.
    stubFetch([
      makeGreekFlowTick({
        timestamp: '2026-03-24T13:44:00Z',
        total_delta_flow: '',
      }),
      makeGreekFlowTick({
        timestamp: '2026-03-24T13:49:00Z',
        otm_total_delta_flow: null,
      }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, stuck: 2, rejected: true });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ stage: 'degenerate_snapshot' }),
      }),
    );
  });

  it('does not reject a snapshot whose only unusable bucket is pending (UW a few minutes late)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        otm_dir_delta_flow: null,
      }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, pending: 1, stuck: 0 });
    expect(res._json).not.toMatchObject({ rejected: true });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('stores when at least one closed bucket carries delta flow', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeGreekFlowTick({
        timestamp: '2026-03-24T13:59:00Z',
        total_delta_flow: '0',
        dir_delta_flow: '0',
      }),
      makeGreekFlowTick(),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 2 });
    expect(res._json).not.toMatchObject({ rejected: true });
  });

  // ── Last bucket of the day, and the window around it ──────

  it('16:03 ET: stores the last bucket of the day (15:55-16:00) at 16:00 on the first run after it settles, and ignores the minutes after the close', async () => {
    vi.setSystemTime(at('20:03'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    mockSql.mockResolvedValue([{ total: 78, nonzero: 78 }]);
    // SPX options print until 16:15: the payload also holds 16:00-16:02.
    stubFetch(tickGrid('2026-03-24', at('20:03')));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 78, skipped: 0 });
    expect(inserts).toHaveLength(78);
    // The last minute, 15:59 ET, is minute 389 of the session.
    expect(inserts.at(-1)).toEqual(bucketValues(77));
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T20:00:00.000Z');
  });

  it('16:08 ET: the second attempt re-sends the day and rewrites nothing that is unchanged', async () => {
    vi.setSystemTime(at('20:08'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubFetch(tickGrid('2026-03-24', at('20:08')));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, skipped: 78 });
    // Nothing was written, so the quality query is not run.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('16:08 ET: a final bucket whose last minute never arrived is reported stuck, not lost in silence', async () => {
    vi.setSystemTime(at('20:08'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(
      withMinute(tickGrid('2026-03-24', at('20:08')), '19:59', {
        otm_total_delta_flow: null,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 77, stuck: 1, pending: 0 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T20:00:00.000Z');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          stuck: 1,
          oldest: '2026-03-24T20:00:00.000Z',
        }),
      }),
    );
  });

  it('16:03 ET: the same final bucket is only pending at the first attempt', async () => {
    vi.setSystemTime(at('20:03'));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(
      withMinute(tickGrid('2026-03-24', at('20:03')), '19:59', {
        otm_total_delta_flow: null,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({ pending: 1, stuck: 0 });
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('15:59 ET: the last bucket is still open and is not stored yet', async () => {
    vi.setSystemTime(at('19:59'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('19:59')));

    await runCron();

    // 15:55-16:00 ends at 20:00; 15:50-15:55 settled at 19:56:30, so 77
    // buckets (labels 09:35 to 15:55) are stored.
    expect(inserts).toHaveLength(77);
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T19:55:00.000Z');
  });

  it('13:03 ET on an early-close day: stores the 12:55-13:00 bucket at 13:00 on the first run, and the ticks after the close do not open one', async () => {
    // 2026-11-27 is a half day on EST (UTC-5): 09:30 ET is 14:30Z, 13:00 ET
    // is 18:00Z. SPX options print after it: the payload holds 13:00-13:02.
    vi.setSystemTime(at('18:03', '2026-11-27'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(
      tickGrid('2026-11-27', at('18:03', '2026-11-27'), {
        openZ: '14:30',
        minutes: 218,
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 42 });
    expect(inserts.at(-1)).toEqual(bucketValues(41, '2026-11-27', '14:30'));
    expect(inserts.at(-1)?.[1]).toBe('2026-11-27T18:00:00.000Z');
    expect(inserts.map((v) => v[0])).toEqual(Array(42).fill('2026-11-27'));
  });

  // ── Feed stalled ──────────────────────────────────────────

  it('10:08 ET: an empty payload is surfaced as a stalled feed, an error', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, reason: 'no_rows_today' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'fetch-greek-flow',
          stage: 'feed_stalled',
        }),
      }),
    );
  });

  it("10:08 ET: a payload holding only yesterday's session is surfaced as a stalled feed", async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-23', at('20:15', '2026-03-23')));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, reason: 'no_rows_today' });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ stage: 'feed_stalled' }),
      }),
    );
  });

  it.each([
    ['09:28 ET, UW may still be rolling over', '13:28', 0],
    ['09:38 ET', '13:38', 0],
    ['09:43 ET', '13:43', 1],
  ])('an empty payload at %s: %i alert(s)', async (_label, hhmmZ, alerts) => {
    vi.setSystemTime(at(hhmmZ));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    await runCron();

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(alerts);
  });

  // ── Data quality check (R-quality) ────────────────────────

  it("runs the data quality check after a write and alerts when every one of the day's rows is zero", async () => {
    // 10:34 ET: 12 buckets (09:30-10:30) have closed and settled.
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 12, nonzero: 0 }]);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
  });

  it("counts only today's session rows in the data quality query, so yesterday's rows cannot mask a dead day (R-quality)", async () => {
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 12, nonzero: 12 }]);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockSql.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const text = strings.join('?');
    expect(text).toMatch(/timestamp >= \?::timestamptz/);
    expect(text).toMatch(/timestamp <= \?::timestamptz/);
    expect(values).toContain('2026-03-24T13:30:00.000Z');
    expect(values).toContain('2026-03-24T20:00:00.000Z');
    expect(values).toContain('2026-03-24');
    expect(values).toContain(SOURCE);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Error handling (R4): each failure is surfaced by name ──

  it('returns 500 and reports error when UW answers non-ok, never success', async () => {
    // The mocked 500 is retried by withRetry (1 s + 2 s backoff). Fake
    // setTimeout so the retries don't burn wall time; Date is faked too so
    // the market-hours clock can be re-pinned on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(MARKET_TIME);
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-greek-flow',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 500'),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 500 and captures the error when fetch throws (network error)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const networkError = new Error('Network error');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(networkError);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'error', message: 'Network error' }),
    );
  });

  it('returns 500 and captures once when a 2xx response does not parse as JSON', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SyntaxError' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an object instead of a list', { not: 'a list' }],
    ['a string', 'oops'],
    ['null', null],
  ])(
    'returns 500 and names the malformed payload when `data` is %s, storing nothing',
    async (_label, data) => {
      process.env.UW_API_KEY = 'uwkey';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }),
      );

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'Internal error' });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('is not a list'),
        }),
      );
      expect(reportCronRun).toHaveBeenCalledWith(
        'fetch-greek-flow',
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it('returns 500 and names the malformed payload when the response has no `data` at all', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('is not a list'),
      }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('a rejected batch upsert is a failed run, captured by name and reported as error, never success (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValue(dbError);
    stubFetch([
      makeGreekFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeGreekFlowTick({ timestamp: '2026-03-24T13:59:00Z' }),
    ]);

    const res = await runCron();

    // It used to swallow the error and answer 200 `{ stored: 0, skipped: 2 }`
    // as a success. A 5xx makes the wrapper send the error check-in.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-greek-flow',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({
        status: 'error',
        message: 'DB batch insert failed',
      }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({ status: 'success' }),
    );
    // The old failure path counted a metric and logged a warning, and the
    // run still reported success.
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'fetch_greek_flow.store_error',
    );
  });

  it('a rejected data quality query is a failed run too', async () => {
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB connection lost');
    mockSql.mockRejectedValue(dbError);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-greek-flow',
      expect.objectContaining({
        status: 'error',
        message: 'DB connection lost',
      }),
    );
  });

  // ── Correct API endpoint ──────────────────────────────────

  it('calls the greek-flow endpoint with today as the expiry and no ?date= (the undated live URL)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeGreekFlowTick()]);

    await runCron();

    expect(uwFetchCalls()).toHaveLength(1);
    // Anchored at the end: appending `?date=` (as the reconcile does for a
    // finished session) must fail this.
    expect(String(uwFetchCalls()[0]![0])).toMatch(
      /\/stock\/SPX\/greek-flow\/2026-03-24$/,
    );
  });
});
