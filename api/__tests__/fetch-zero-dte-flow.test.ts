// @vitest-environment node

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

import handler from '../cron/fetch-zero-dte-flow.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { reportCronRun } from '../_lib/axiom.js';

// 2026-03-24 is on EDT (UTC-4): 09:30 ET is 13:30Z, 16:00 ET is 20:00Z.
// Fixed "market hours" date: Tuesday 10:14 AM ET, a cron minute (:14). The
// 10:00-10:05 and 10:05-10:10 buckets have closed; 10:10-10:15 is open.
const MARKET_TIME = new Date('2026-03-24T14:14:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const MINUTE = 60_000;
const at = (hhmmZ: string, day = '2026-03-24'): Date =>
  new Date(`${day}T${hhmmZ}:00Z`);

/**
 * One minute tick. The default is the last minute (14:04Z = 10:04 ET) of the
 * 10:00-10:05 bucket, which is closed at MARKET_TIME.
 */
function makeFlowTick(overrides = {}) {
  return {
    timestamp: '2026-03-24T14:04:00Z',
    date: '2026-03-24',
    net_call_premium: '5000000',
    net_put_premium: '-3000000',
    net_volume: '120000',
    underlying_price: '5800.5',
    ...overrides,
  };
}

/**
 * UW's prefilled session grid for `day`: one tick per minute from the 09:30
 * ET open to the 16:00 ET close. Minutes that start at or after `filledUntil`
 * have not happened yet, so UW sends them with null values. The cumulative
 * ncp is the minute-of-session, so a bucket's value names its last minute.
 */
function tickGrid(day: string, filledUntil: Date) {
  const open = at('13:30', day).getTime();
  const ticks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 390; i++) {
    const start = new Date(open + i * MINUTE);
    ticks.push(
      start < filledUntil
        ? makeFlowTick({
            timestamp: start.toISOString(),
            date: day,
            net_call_premium: String(1000 + i),
            net_put_premium: String(-500 - i),
            net_volume: String(10 + i),
          })
        : {
            timestamp: start.toISOString(),
            date: day,
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
            underlying_price: null,
          },
    );
  }
  return ticks;
}

/** Stub fetch with the doubly-nested UW net-flow/expiry response structure */
function stubFetch(ticks: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ data: ticks }] }),
    }),
  );
}

/** Stub fetch with empty outer data array */
function stubFetchEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }),
  );
}

/**
 * Replace the batch transaction with a recorder: each INSERT's bound values
 * (date, timestamp, source, ncp, npp, net_volume) are pushed to the returned
 * array. Every INSERT reports a stored row.
 */
function recordInserts() {
  const inserts: unknown[][] = [];
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const queries = fn((_strings: unknown, ...values: unknown[]) => {
        inserts.push(values);
        return {};
      });
      return queries.map(() => [{ id: 1 }]);
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

describe('fetch-zero-dte-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([{ id: 1 }]);
    mockSql.transaction = mockTransaction;
    // Default: every row insert returns a row (stored), mirroring the
    // ON CONFLICT DO NOTHING RETURNING id contract on a fresh insert.
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ id: 1 }]);
      },
    );
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

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = await runCron();
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches ticks, stores the closed bucket under its end time, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([makeFlowTick()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 1,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // The 10:00-10:05 bucket's last minute is stored at 10:05 (14:05Z), as
    // numbers, under today's date.
    expect(inserts).toEqual([
      [
        '2026-03-24',
        '2026-03-24T14:05:00.000Z',
        'zero_dte_index',
        5000000,
        -3000000,
        120000,
      ],
    ]);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'ok', stored: 1 }),
    );
  });

  it('handles empty outer data array (no ticks)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchEmpty();

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 0,
      stored: 0,
      skipped: 0,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('handles empty inner data array', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ ticks: 0, stored: 0, skipped: 0 });
  });

  // ── 5-min sampling ────────────────────────────────────────

  it("keeps the bucket's last minute when several ticks share a window", async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        net_call_premium: '300',
      }),
      makeFlowTick({
        timestamp: '2026-03-24T14:03:00Z',
        net_call_premium: '200',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    // Both ticks fall in 14:00-14:05, so one insert (in 1 transaction), and
    // it carries the 14:04 tick whichever order UW sent them in.
    expect(res._json).toMatchObject({ ticks: 2, stored: 1, skipped: 0 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[3]).toBe(300);
  });

  it('ticks in different 5-min windows produce separate inserts', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeFlowTick({ timestamp: '2026-03-24T14:09:00Z' }),
      makeFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    // 14:04 closes the 14:00 window, 14:09 the 14:05 one: 2 inserts in 1
    // transaction, oldest first, at the window ends.
    expect(res._json).toMatchObject({ ticks: 2, stored: 2, skipped: 0 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts.map((v) => v[1])).toEqual([
      '2026-03-24T14:05:00.000Z',
      '2026-03-24T14:10:00.000Z',
    ]);
  });

  // ── Duplicate handling ────────────────────────────────────

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Empty result per query = ON CONFLICT DO NOTHING (duplicate)
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );
    stubFetch([makeFlowTick()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  // ── All-zero/null snapshot rejection ──────────────────────

  const zeroTicks = () => [
    makeFlowTick({
      timestamp: '2026-03-24T14:04:00Z',
      net_call_premium: '0',
      net_put_premium: '0',
    }),
    makeFlowTick({
      timestamp: '2026-03-24T14:09:00Z',
      net_call_premium: '0',
      net_put_premium: '0',
    }),
  ];

  it('rejects a snapshot where every closed bucket has zero premium', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(zeroTicks());

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, rejected: true });
    // Nothing persisted — the degenerate snapshot is dropped before insert.
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('captures a Sentry message when a degenerate snapshot is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(zeroTicks());

    const res = await runCron();

    expect(res._json).toMatchObject({ rejected: true });
    // A recurring UW degenerate feed must be observable, not a silent gap.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('all-zero/null premium snapshot'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'fetch-zero-dte-flow',
          stage: 'degenerate_snapshot',
        }),
      }),
    );
  });

  it('does not capture a Sentry message when a snapshot has signal', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeFlowTick()]);

    const res = await runCron();

    expect(res._json).not.toMatchObject({ rejected: true });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('rejects and reports a snapshot whose closed buckets all have null or blank premium', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        net_call_premium: '',
        net_put_premium: '',
      }),
      makeFlowTick({
        timestamp: '2026-03-24T14:09:00Z',
        net_call_premium: null,
        net_put_premium: null,
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      unusable: 2,
      rejected: true,
    });
    // Neither a 0 nor a NULL row is written for them.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('stores when at least one closed bucket carries net premium', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeFlowTick({
        timestamp: '2026-03-24T14:04:00Z',
        net_call_premium: '0',
        net_put_premium: '0',
      }),
      makeFlowTick({
        timestamp: '2026-03-24T14:09:00Z',
        net_call_premium: '5000000',
        net_put_premium: '0',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 2 });
    expect(res._json).not.toMatchObject({ rejected: true });
    // 2 inserts batched into 1 transaction round-trip.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  // ── Frozen grid and pre-open session (F3) ─────────────────

  it("09:27 ET: a payload of yesterday's rows stores nothing, logs and counts it, and is not an error (R-day)", async () => {
    vi.setSystemTime(at('13:27'));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-23', at('20:00', '2026-03-23')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 390,
      stored: 0,
      skipped: 0,
      reason: 'no_rows_today',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_zero_dte_flow.no_rows_today',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ payloadRows: 390 }),
      expect.stringContaining('no rows for today'),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('09:32 ET: the prefilled grid with null future minutes stores nothing and counts no bad candle (F3)', async () => {
    vi.setSystemTime(at('13:32'));
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-24', at('13:32')));

    const res = await runCron();

    expect(res._status).toBe(200);
    // 390 ticks, 388 of them null future minutes: before the fix this was
    // 78 rows with NULL premiums per day, kept for good by DO NOTHING.
    expect(res._json).toMatchObject({
      ticks: 390,
      stored: 0,
      skipped: 0,
      unusable: 0,
    });
    expect(res._json).not.toMatchObject({ rejected: true });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('10:04 ET: stores only the closed, non-null buckets, at bucket-end labels (R-closed, label rule)', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('14:04')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 6, skipped: 0, unusable: 0 });
    // 09:30-09:35 is stored at 09:35 (13:35Z) ... 09:55-10:00 at 10:00 (14:00Z).
    // The value of each is its last minute's: 13:34 is minute 4 of the session.
    expect(inserts).toEqual([
      [
        '2026-03-24',
        '2026-03-24T13:35:00.000Z',
        'zero_dte_index',
        1004,
        -504,
        14,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:40:00.000Z',
        'zero_dte_index',
        1009,
        -509,
        19,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:45:00.000Z',
        'zero_dte_index',
        1014,
        -514,
        24,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:50:00.000Z',
        'zero_dte_index',
        1019,
        -519,
        29,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:55:00.000Z',
        'zero_dte_index',
        1024,
        -524,
        34,
      ],
      [
        '2026-03-24',
        '2026-03-24T14:00:00.000Z',
        'zero_dte_index',
        1029,
        -529,
        39,
      ],
    ]);
    // The 10:00-10:05 bucket is still open (its last minute is null): it is
    // neither stored nor counted as bad.
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('leaves out a closed bucket whose last minute is null and counts it (R-null)', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    const grid = tickGrid('2026-03-24', at('14:04')).map((tick) =>
      tick.timestamp === '2026-03-24T13:44:00.000Z'
        ? {
            ...tick,
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
          }
        : tick,
    );
    stubFetch(grid);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 5, unusable: 1 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T13:45:00.000Z');
    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_zero_dte_flow.invalid_candle',
    );
  });

  it('never stores a NaN premium in a past minute as 0 or NULL (R-null)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeFlowTick({
        timestamp: '2026-03-24T14:09:00Z',
        net_call_premium: 'not-a-number',
      }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 1, unusable: 1 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]).toBe('2026-03-24T14:05:00.000Z');
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_zero_dte_flow.invalid_candle',
    );
  });

  it('16:04 ET: stores the last bucket of the day (15:55-16:00) at 16:00 on the first run after it closes', async () => {
    vi.setSystemTime(at('20:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    mockSql.mockResolvedValue([{ total: 78, nonzero: 78 }]);
    stubFetch(tickGrid('2026-03-24', at('20:00')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 78, skipped: 0 });
    expect(inserts.at(-1)).toEqual([
      '2026-03-24',
      '2026-03-24T20:00:00.000Z',
      'zero_dte_index',
      // The last minute, 15:59 ET, is minute 389 of the session.
      1389,
      -889,
      399,
    ]);
  });

  it('15:59 ET: the last bucket is still open and is not stored yet', async () => {
    vi.setSystemTime(at('19:59'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    mockSql.mockResolvedValue([{ total: 77, nonzero: 77 }]);
    stubFetch(tickGrid('2026-03-24', at('19:59')));

    await runCron();

    expect(inserts).toHaveLength(77);
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T19:55:00.000Z');
  });

  // ── Data quality check ────────────────────────────────────

  it("counts only today's session rows in the data quality query, so yesterday's rows cannot mask a dead day (R-quality)", async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The check runs when more than 10 buckets are stored in one run.
    vi.setSystemTime(at('14:34'));
    mockSql.mockResolvedValue([{ total: 12, nonzero: 12 }]);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    await runCron();

    // 14:34 closes 09:30-10:30 = 12 buckets, all stored: one SELECT.
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
    expect(values).toContain('zero_dte_index');
  });

  it('alerts when more than 10 stored rows are all zero', async () => {
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 12, nonzero: 0 }]);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    await runCron();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails (non-ok response)', async () => {
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
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when fetch throws (network error)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and captures once when the payload is not a list of ticks', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ data: { not: 'a list' } }] }),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('a rejected batch insert is a failed run, captured once and reported as error, never success (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValue(dbError);
    stubFetch([
      makeFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeFlowTick({ timestamp: '2026-03-24T14:09:00Z' }),
    ]);

    const res = await runCron();

    // A 5xx makes withCronCheckin send the error check-in; it used to answer
    // 200 `{ stored: 0, skipped: 2 }` and report ok.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      dbError,
      expect.objectContaining({
        tags: expect.objectContaining({
          cron: 'fetch-zero-dte-flow',
          stage: 'batch_insert',
        }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('a rejected data quality query is a failed run too', async () => {
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockRejectedValue(new Error('DB connection lost'));
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'quality_check' }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('calls the correct UW API endpoint with expiration and tide_type params', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeFlowTick()]);

    await runCron();

    const fetchCall = vi.mocked(fetch).mock.calls[0]!;
    expect(fetchCall[0]).toContain('/net-flow/expiry');
    expect(fetchCall[0]).toContain('expiration=zero_dte');
    expect(fetchCall[0]).toContain('tide_type=index_only');
  });
});
