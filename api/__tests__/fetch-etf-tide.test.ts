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
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

import handler from '../cron/fetch-etf-tide.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// 2026-03-24 is on EDT (UTC-4): 09:30 ET is 13:30Z, 16:00 ET is 20:00Z.
// Fixed "market hours" date: Tuesday 10:12 AM ET, a cron minute (:12). The
// 10:00-10:05 and 10:05-10:10 buckets have closed and settled; 10:10-10:15
// is open.
const MARKET_TIME = new Date('2026-03-24T14:12:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const MINUTE = 60_000;
const at = (hhmmZ: string, day = '2026-03-24'): Date =>
  new Date(`${day}T${hhmmZ}:00Z`);

/**
 * One minute row. The default is the last minute (14:04Z = 10:04 ET) of the
 * 10:00-10:05 bucket, which has closed and settled at MARKET_TIME.
 */
function makeEtfTideRow(overrides = {}) {
  return {
    net_call_premium: '1000000',
    net_put_premium: '-500000',
    net_volume: 12345,
    timestamp: '2026-03-24T14:04:00.000Z',
    ...overrides,
  };
}

/**
 * UW's prefilled session grid: one row per minute from `openZ` on `day`
 * (`minutes` of them: 390 is 09:30-15:59 ET). Minutes that start at or after
 * `filledUntil` have not happened yet, so UW sends them with null values. The
 * cumulative ncp is the minute-of-session, so a bucket's value names its last
 * minute.
 */
function sessionGrid(
  day: string,
  filledUntil: Date,
  { openZ = '13:30', minutes = 390 } = {},
) {
  const open = at(openZ, day).getTime();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < minutes; i++) {
    const start = new Date(open + i * MINUTE);
    rows.push(
      start < filledUntil
        ? makeEtfTideRow({
            timestamp: start.toISOString(),
            net_call_premium: String(1000 + i),
            net_put_premium: String(-500 - i),
            net_volume: 10 + i,
          })
        : {
            timestamp: start.toISOString(),
            net_call_premium: null,
            net_put_premium: null,
            net_volume: null,
          },
    );
  }
  return rows;
}

/** The grid with one minute's fields replaced. */
const withMinute = (
  rows: Array<Record<string, unknown>>,
  hhmmZ: string,
  overrides: Record<string, unknown>,
) =>
  rows.map((row) =>
    row.timestamp === `2026-03-24T${hhmmZ}:00.000Z`
      ? { ...row, ...overrides }
      : row,
  );

type Outcome = 'inserted' | 'updated' | 'unchanged';
const OUTCOME_ROWS: Record<Outcome, unknown[]> = {
  inserted: [{ inserted: true }],
  updated: [{ inserted: false }],
  unchanged: [],
};

/**
 * Replace the batch transaction with a recorder: each upsert's bound values
 * (date, timestamp, source, ncp, npp, net_volume) are pushed to the returned
 * object, per source, and each is answered with `outcome(values, index)`
 * (default: a new row).
 */
function recordInserts(
  outcome: (values: unknown[], index: number) => Outcome = () => 'inserted',
) {
  const bySource: Record<string, unknown[][]> = {};
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      const queries = fn((_strings: unknown, ...values: unknown[]) => {
        bound.push(values);
        return {};
      });
      for (const values of bound) {
        const source = String(values[2]);
        bySource[source] = [...(bySource[source] ?? []), values];
      }
      return queries.map((_q, i) => OUTCOME_ROWS[outcome(bound[i]!, i)]);
    },
  );
  return bySource;
}

function stubUw(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: payload }),
    }),
  );
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

describe('fetch-etf-tide handler', () => {
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
    stubUw([]);
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
    ['09:25 ET, the first run', '13:25', false],
    ['16:07 ET, the second attempt at the last bucket', '20:07', false],
    ['16:10 ET, the last minute of the window', '20:10', false],
    ['16:11 ET, after the window', '20:11', true],
  ])('window: %s', async (_label, hhmmZ, skipped) => {
    vi.setSystemTime(at(hhmmZ));
    process.env.UW_API_KEY = 'uwkey';
    stubUw([]);
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

  // ── Happy path ────────────────────────────────────────────

  it('stores the latest candle from each ticker and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([makeEtfTideRow()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      results: {
        spy_etf_tide: { stored: 1, inserted: 1, updated: 0, skipped: 0 },
        qqq_etf_tide: { stored: 1, inserted: 1, updated: 0, skipped: 0 },
      },
    });
    // Two upsert batches (one transaction per ticker)
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it('stores a closed bucket whose values are real zeros (net_volume 0)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw([
      makeEtfTideRow({
        net_call_premium: '0',
        net_put_premium: '0',
        net_volume: 0,
      }),
      // A second bucket with signal keeps the snapshot from being degenerate.
      makeEtfTideRow({ timestamp: '2026-03-24T14:09:00.000Z' }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(inserts.spy_etf_tide?.[0]).toEqual([
      '2026-03-24',
      '2026-03-24T14:05:00.000Z',
      'spy_etf_tide',
      0,
      0,
      0,
    ]);
  });

  it('stores NULL when UW sends no net_volume for the last minute', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw([makeEtfTideRow({ net_volume: null })]);

    await runCron();

    expect(inserts.spy_etf_tide).toEqual([
      [
        '2026-03-24',
        '2026-03-24T14:05:00.000Z',
        'spy_etf_tide',
        1000000,
        -500000,
        null,
      ],
    ]);
  });

  it('keeps only the last minute of a bucket, whichever order UW sends them in', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // Three minutes of the 10:00-10:05 bucket, out of order. The 14:04 row is
    // the bucket's last minute, so its values are the ones stored.
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T14:04:00.000Z',
        net_call_premium: '300',
      }),
      makeEtfTideRow({
        timestamp: '2026-03-24T14:01:00.000Z',
        net_call_premium: '100',
      }),
      makeEtfTideRow({
        timestamp: '2026-03-24T14:03:00.000Z',
        net_call_premium: '200',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: { spy_etf_tide: { candles: 1 }, qqq_etf_tide: { candles: 1 } },
    });
    expect(inserts.spy_etf_tide).toHaveLength(1);
    expect(inserts.spy_etf_tide?.[0]?.[3]).toBe(300);
  });

  it('stores one row per closed bucket, oldest first, under the bucket end', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // 14:09 closes the 10:05-10:10 bucket, 14:04 the 10:00-10:05 one.
    stubUw([
      makeEtfTideRow({ timestamp: '2026-03-24T14:09:00.000Z' }),
      makeEtfTideRow({ timestamp: '2026-03-24T14:04:00.000Z' }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 2, candles: 2 },
        qqq_etf_tide: { stored: 2, candles: 2 },
      },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).toEqual([
      '2026-03-24T14:05:00.000Z',
      '2026-03-24T14:10:00.000Z',
    ]);
  });

  // ── Upsert: finality by self-heal ─────────────────────────

  it('reports inserted and updated rows separately, and unchanged ones as skipped', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(
      (_values, i) => (['inserted', 'updated', 'unchanged'] as const)[i % 3]!,
    );
    stubUw([
      makeEtfTideRow({ timestamp: '2026-03-24T13:34:00.000Z' }),
      makeEtfTideRow({ timestamp: '2026-03-24T13:39:00.000Z' }),
      makeEtfTideRow({ timestamp: '2026-03-24T13:44:00.000Z' }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: {
          stored: 2,
          inserted: 1,
          updated: 1,
          skipped: 1,
          candles: 3,
        },
      },
    });
  });

  it('writes with an upsert that only rewrites a changed row, never DO NOTHING', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const texts: string[] = [];
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const queries = fn((strings: unknown) => {
          texts.push((strings as string[]).join('?'));
          return {};
        });
        return queries.map(() => OUTCOME_ROWS.inserted);
      },
    );
    stubUw([makeEtfTideRow()]);

    await runCron();

    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain('ON CONFLICT (date, timestamp, source) DO UPDATE');
      expect(text).toContain('IS DISTINCT FROM');
      expect(text).toContain('RETURNING (xmax = 0) AS inserted');
      expect(text).not.toContain('DO NOTHING');
      expect(text).not.toContain('created_at');
    }
  });

  it('counts skipped candles when the rows already hold the values', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubUw([makeEtfTideRow()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      results: {
        spy_etf_tide: { stored: 0, skipped: 1 },
        qqq_etf_tide: { stored: 0, skipped: 1 },
      },
    });
  });

  // ── Last bucket of the day, and the window around it ──────

  it('16:02 ET: stores the last bucket of the day (15:55-16:00) at 16:00 on the first run after it settles', async () => {
    vi.setSystemTime(at('20:02'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(sessionGrid('2026-03-24', at('20:00')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 78, candles: 78 },
        qqq_etf_tide: { stored: 78, candles: 78 },
      },
    });
    expect(inserts.spy_etf_tide?.at(-1)).toEqual([
      '2026-03-24',
      '2026-03-24T20:00:00.000Z',
      'spy_etf_tide',
      // The last minute, 15:59 ET, is minute 389 of the session.
      1389,
      -889,
      399,
    ]);
  });

  it('16:07 ET: the second attempt re-sends the day and rewrites nothing that is unchanged', async () => {
    vi.setSystemTime(at('20:07'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubUw(sessionGrid('2026-03-24', at('20:00')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 0, skipped: 78, candles: 78 },
      },
    });
    // Nothing was written, so the quality query is not run.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('15:57 ET: the last bucket is still open and is not stored yet', async () => {
    vi.setSystemTime(at('19:57'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(sessionGrid('2026-03-24', at('19:57')));

    await runCron();

    // The 15:55-16:00 bucket ends at 20:00. The 15:50-15:55 one settled at
    // 19:56:30, so 77 buckets (labels 09:35 to 15:55) are stored.
    expect(inserts.spy_etf_tide).toHaveLength(77);
    expect(inserts.spy_etf_tide?.at(-1)?.[1]).toBe('2026-03-24T19:55:00.000Z');
  });

  it('13:02 ET on an early-close day: stores the 12:55-13:00 bucket at 13:00 on the first run', async () => {
    // 2026-11-27 is a half day on EST (UTC-5): 09:30 ET is 14:30Z, 13:00 ET
    // is 18:00Z. UW sends 12:59 as its last session minute; the rows after
    // it are stray and must not open a 13:00-13:05 bucket.
    vi.setSystemTime(at('18:02', '2026-11-27'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    const half = sessionGrid('2026-11-27', at('18:05', '2026-11-27'), {
      openZ: '14:30',
      minutes: 215,
    });
    stubUw(half);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: { spy_etf_tide: { stored: 42, candles: 42 } },
    });
    expect(inserts.spy_etf_tide?.at(-1)?.[1]).toBe('2026-11-27T18:00:00.000Z');
    expect(inserts.spy_etf_tide?.map((v) => v[0])).toEqual(
      Array(42).fill('2026-11-27'),
    );
  });

  it('13:07 ET on an early-close day: rows stamped after the 13:00 close do not open a bucket', async () => {
    // The 13:00-13:05 bucket has ended and settled by 13:07, and UW's stray
    // rows in it carry values: it would be stored if the close were not the
    // end of the session.
    vi.setSystemTime(at('18:07', '2026-11-27'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(
      sessionGrid('2026-11-27', at('18:05', '2026-11-27'), {
        openZ: '14:30',
        minutes: 215,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: { spy_etf_tide: { stored: 42, candles: 42 } },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).not.toContain(
      '2026-11-27T18:05:00.000Z',
    );
  });

  it('13:07 ET on an early-close day: still inside the window; 13:11 ET is not', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([]);

    vi.setSystemTime(at('18:07', '2026-11-27'));
    const inside = await runCron();
    expect((inside._json as { skipped?: boolean }).skipped).toBeUndefined();

    vi.setSystemTime(at('18:11', '2026-11-27'));
    const outside = await runCron();
    expect(outside._json).toMatchObject({ skipped: true });
  });

  // ── Frozen grid and pre-open session (F1, F2) ─────────────

  it("09:27 ET: a payload of yesterday's rows stores nothing, logs and counts it, and is not an error (R-day)", async () => {
    vi.setSystemTime(at('13:27'));
    process.env.UW_API_KEY = 'uwkey';
    stubUw(sessionGrid('2026-03-23', at('20:00', '2026-03-23')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      failureCount: 0,
      results: {
        spy_etf_tide: { stored: 0, candles: 0, reason: 'no_rows_today' },
        qqq_etf_tide: { stored: 0, candles: 0, reason: 'no_rows_today' },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.no_rows_today',
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'spy_etf_tide', payloadRows: 390 }),
      expect.stringContaining('no rows for today'),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
    // Normal before 09:40 ET: no alert.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('09:32 ET: the prefilled grid with null future minutes stores nothing and counts no bad candle (F1)', async () => {
    vi.setSystemTime(at('13:32'));
    process.env.UW_API_KEY = 'uwkey';
    stubUw(sessionGrid('2026-03-24', at('13:32')));

    const res = await runCron();

    expect(res._status).toBe(200);
    // 390 rows, 388 of them null future minutes: before the fix this was
    // 78 buckets stored as 0 and 78 invalid_candle hits per ticker.
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 0, candles: 0, pending: 0, stuck: 0 },
        qqq_etf_tide: { stored: 0, candles: 0, pending: 0, stuck: 0 },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('10:02 ET: stores only the closed, settled, non-null buckets, at bucket-end labels (R-closed, label rule)', async () => {
    vi.setSystemTime(at('14:02'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(sessionGrid('2026-03-24', at('14:02')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      results: {
        spy_etf_tide: { stored: 6, candles: 6, pending: 0, stuck: 0 },
        qqq_etf_tide: { stored: 6, candles: 6, pending: 0, stuck: 0 },
      },
    });
    // 09:30-09:35 is stored at 09:35 (13:35Z) ... 09:55-10:00 at 10:00 (14:00Z).
    // The value of each is its last minute's: 13:34 is minute 4 of the session.
    expect(inserts.spy_etf_tide).toEqual([
      [
        '2026-03-24',
        '2026-03-24T13:35:00.000Z',
        'spy_etf_tide',
        1004,
        -504,
        14,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:40:00.000Z',
        'spy_etf_tide',
        1009,
        -509,
        19,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:45:00.000Z',
        'spy_etf_tide',
        1014,
        -514,
        24,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:50:00.000Z',
        'spy_etf_tide',
        1019,
        -519,
        29,
      ],
      [
        '2026-03-24',
        '2026-03-24T13:55:00.000Z',
        'spy_etf_tide',
        1024,
        -524,
        34,
      ],
      [
        '2026-03-24',
        '2026-03-24T14:00:00.000Z',
        'spy_etf_tide',
        1029,
        -529,
        39,
      ],
    ]);
    // The open 10:00-10:05 bucket has values for 14:00 and 14:01 but a null
    // last minute: it waits for a later run and is not counted as bad.
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('waits for a bucket that ended less than 90 s ago, even though its last minute has a value', async () => {
    // 14:00:30Z: the 09:55-10:00 bucket ended 30 s ago. Its last minute
    // already holds a (possibly provisional) value; it is stored on a later run.
    vi.setSystemTime(new Date('2026-03-24T14:00:30.000Z'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubUw(sessionGrid('2026-03-24', at('14:01')));

    await runCron();

    expect(inserts.spy_etf_tide?.at(-1)?.[1]).toBe('2026-03-24T13:55:00.000Z');
  });

  // ── Bad minutes: pending, stuck, never stored as 0 ────────

  it('never stores a NaN premium in a past minute as 0 (R-null); a bucket UW is only minutes late with is pending, not counted', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // 14:04 closes the 10:00-10:05 bucket, 7 minutes before MARKET_TIME.
    stubUw([
      makeEtfTideRow({
        net_call_premium: 'not-a-number',
        net_put_premium: 'also-bad',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 0, candles: 0, pending: 1, stuck: 0 },
        qqq_etf_tide: { stored: 0, candles: 0, pending: 1, stuck: 0 },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(inserts).toEqual({});
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('counts a closed bucket stuck for 10 minutes or more: one metric per leg, one warning per run naming the oldest', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The 09:55-10:00 bucket (last minute 13:59) ended 12 minutes before
    // MARKET_TIME and its last minute is null. The 09:40 one is also stuck.
    let grid = withMinute(sessionGrid('2026-03-24', MARKET_TIME), '13:59', {
      net_call_premium: null,
      net_put_premium: null,
      net_volume: null,
    });
    grid = withMinute(grid, '13:44', { net_put_premium: 'garbage' });
    const inserts = recordInserts();
    stubUw(grid);

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stuck: 2, pending: 0 },
        qqq_etf_tide: { stuck: 2, pending: 0 },
      },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).not.toContain(
      '2026-03-24T13:45:00.000Z',
    );
    expect(inserts.spy_etf_tide?.map((v) => v[1])).not.toContain(
      '2026-03-24T14:00:00.000Z',
    );
    // Two stuck buckets per leg, two legs.
    expect(metrics.increment).toHaveBeenCalledTimes(4);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.invalid_candle',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'fetch-etf-tide',
          stage: 'stuck_bucket',
        }),
        extra: expect.objectContaining({
          bySource: {
            spy_etf_tide: { stuck: 2, oldest: '2026-03-24T13:45:00.000Z' },
            qqq_etf_tide: { stuck: 2, oldest: '2026-03-24T13:45:00.000Z' },
          },
        }),
      }),
    );
  });

  it('leaves out a pending bucket (null last minute, ended 2 minutes ago): no metric, no message', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // The 10:05-10:10 bucket ended at 14:10Z, 2 minutes before MARKET_TIME,
    // and has settled (90 s), but UW has not filled its last minute (14:09).
    stubUw(
      withMinute(sessionGrid('2026-03-24', MARKET_TIME), '14:09', {
        net_call_premium: null,
        net_put_premium: null,
        net_volume: null,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 7, candles: 7, pending: 1, stuck: 0 },
      },
    });
    expect(inserts.spy_etf_tide?.map((v) => v[1])).not.toContain(
      '2026-03-24T14:10:00.000Z',
    );
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Feed stalled (item 4) ─────────────────────────────────

  it('10:12 ET: an empty payload is surfaced as a stalled feed, once per run', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      results: {
        spy_etf_tide: { stored: 0, reason: 'no_rows_today' },
        qqq_etf_tide: { stored: 0, reason: 'no_rows_today' },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'fetch-etf-tide',
          stage: 'feed_stalled',
        }),
        extra: expect.objectContaining({
          sources: expect.arrayContaining(['spy_etf_tide', 'qqq_etf_tide']),
        }),
      }),
    );
  });

  it('10:12 ET: a response without a data field is surfaced as a stalled feed too', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 0, reason: 'no_rows_today' },
        qqq_etf_tide: { stored: 0, reason: 'no_rows_today' },
      },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'feed_stalled' }),
      }),
    );
  });

  it("10:12 ET: a grid holding only yesterday's session is surfaced as a stalled feed", async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw(sessionGrid('2026-03-23', at('20:00', '2026-03-23')));

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: { spy_etf_tide: { reason: 'no_rows_today' } },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ stage: 'feed_stalled' }),
      }),
    );
  });

  it.each([
    ['09:37 ET, UW may still be rolling over', '13:37', 0],
    ['09:42 ET', '13:42', 1],
  ])('an empty payload at %s: %i alert(s)', async (_label, hhmmZ, alerts) => {
    vi.setSystemTime(at(hhmmZ));
    process.env.UW_API_KEY = 'uwkey';
    stubUw([]);

    await runCron();

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(alerts);
  });

  // ── Degenerate snapshot ───────────────────────────────────

  it('rejects a snapshot where every closed bucket has zero premium, and says so', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T14:04:00.000Z',
        net_call_premium: '0',
        net_put_premium: '0',
      }),
      makeEtfTideRow({
        timestamp: '2026-03-24T14:09:00.000Z',
        net_call_premium: '0',
        net_put_premium: '0',
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 0, candles: 2, reason: 'degenerate' },
        qqq_etf_tide: { stored: 0, candles: 2, reason: 'degenerate' },
      },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'fetch-etf-tide',
          stage: 'degenerate_snapshot',
        }),
      }),
    );
  });

  it('rejects a snapshot whose only closed buckets are stuck, but not one that is merely pending', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Stuck: the 09:55-10:00 bucket ended 12 minutes ago and is unusable.
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T13:59:00.000Z',
        net_call_premium: null,
        net_put_premium: null,
      }),
    ]);
    const stuck = await runCron();
    expect(stuck._json).toMatchObject({
      results: { spy_etf_tide: { reason: 'degenerate', stuck: 1 } },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({ level: 'error' }),
    );

    vi.mocked(Sentry.captureMessage).mockClear();
    // Pending: the 10:05-10:10 bucket ended 2 minutes ago and is unusable.
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T14:09:00.000Z',
        net_call_premium: null,
        net_put_premium: null,
      }),
    ]);
    const pending = await runCron();
    expect(pending._json).toMatchObject({
      results: { spy_etf_tide: { pending: 1, stuck: 0 } },
    });
    expect(pending._json).not.toMatchObject({
      results: { spy_etf_tide: { reason: 'degenerate' } },
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('stores when at least one closed bucket carries net premium', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([
      makeEtfTideRow({
        timestamp: '2026-03-24T14:04:00.000Z',
        net_call_premium: '0',
        net_put_premium: '0',
      }),
      makeEtfTideRow({ timestamp: '2026-03-24T14:09:00.000Z' }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: { spy_etf_tide: { stored: 2, candles: 2 } },
    });
    expect(res._json).not.toMatchObject({
      results: { spy_etf_tide: { reason: 'degenerate' } },
    });
  });

  // ── Error handling ────────────────────────────────────────

  it('partial: one ticker fails → status partial, healthy ticker still stored (BE-CRON-H4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeEtfTideRow();
    // QQQ succeeds; default mockTransaction inserts → stored.
    // SPY 500s on EVERY attempt: withRetry retries a one-off 500, so the
    // failure must persist through the retries to demote the run. Fake
    // setTimeout so the 1 s + 2 s backoff doesn't burn wall time; Date is
    // faked too so the market-hours clock can be re-pinned on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(MARKET_TIME);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/market/SPY/')) {
        return { ok: false, status: 500, text: async () => 'Server error' };
      }
      return { ok: true, json: async () => ({ data: [row] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-tide',
      // Demoted to partial because SPY failed...
      status: 'partial',
      failureCount: 1,
      results: {
        // ...but QQQ's healthy data still landed.
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 1 },
      },
    });
    // The healthy QQQ leg still wrote one row.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalled();
    // SPY: initial attempt + 2 withRetry retries; QQQ: one clean fetch.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('error: all tickers fail → status error (not success), no green monitor', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const res = await runCron();

    // Per-ticker failures are caught (HTTP stays 200), but the cron status
    // is now 'error' instead of an unconditional 'success' so the monitor
    // no longer stays green on a full UW outage.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      failureCount: 2,
      results: {
        spy_etf_tide: { stored: 0 },
        qqq_etf_tide: { stored: 0 },
      },
    });
  });

  it('error: a 2xx response whose JSON does not parse fails both legs by name (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SyntaxError' }),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.fetch_error',
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('error: a payload whose data is not a list fails both legs by name, nothing stored (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({ not: 'a list' });

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_tide.fetch_error',
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('partial: one ticker batch upsert rejects → status partial, captured once, not success (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([makeEtfTideRow()]);

    // Reject the batch for one source only. The txn stub records the bound
    // values so the failing leg is chosen by its `source`, not by call order
    // (the two tickers run concurrently).
    const dbError = new Error('connection lost');
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const bound: unknown[][] = [];
        const queries = fn((_strings: unknown, ...values: unknown[]) => {
          bound.push(values);
          return {};
        });
        if (bound.some((values) => values.includes('spy_etf_tide')))
          throw dbError;
        return queries.map(() => OUTCOME_ROWS.inserted);
      },
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      results: {
        spy_etf_tide: { stored: 0 },
        // The healthy QQQ leg still landed its row.
        qqq_etf_tide: { stored: 1 },
      },
    });
    // One capture for the one failed write, not two.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('error: every ticker batch upsert rejects → status error, one capture each (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([makeEtfTideRow()]);
    const dbError = new Error('connection lost');
    mockTransaction.mockRejectedValue(dbError);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('success: all tickers succeed → status success', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw([makeEtfTideRow()]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      failureCount: 0,
    });
  });

  // ── Data quality check (R-quality) ────────────────────────

  it('runs the data quality check after a write even when only one bucket is new (steady state)', async () => {
    // 10:32 ET: 12 buckets (09:30-10:30) have closed and settled. 11 were
    // stored by earlier runs; this run adds the newest one.
    vi.setSystemTime(at('14:32'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts((values) =>
      values[1] === '2026-03-24T14:30:00.000Z' ? 'inserted' : 'unchanged',
    );
    mockSql.mockResolvedValue([{ total: 12, nonzero: 0 }]);
    stubUw(sessionGrid('2026-03-24', at('14:32')));

    const res = await runCron();

    expect(res._json).toMatchObject({
      results: {
        spy_etf_tide: { stored: 1, inserted: 1, skipped: 11, candles: 12 },
        qqq_etf_tide: { stored: 1, inserted: 1, skipped: 11, candles: 12 },
      },
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('runs the data quality check when a revised value was written', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'updated');
    mockSql.mockResolvedValue([{ total: 12, nonzero: 12 }]);
    stubUw([makeEtfTideRow()]);

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not alert on 10 stored rows or fewer, however zero they are', async () => {
    vi.setSystemTime(at('14:02'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 6, nonzero: 0 }]);
    stubUw(sessionGrid('2026-03-24', at('14:02')));

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('skips the data quality check when the run wrote nothing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubUw([makeEtfTideRow()]);

    await runCron();

    expect(mockSql).not.toHaveBeenCalled();
  });

  it("counts only today's session rows in the data quality query, so yesterday's rows cannot mask a dead day (R-quality)", async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));
    mockSql.mockResolvedValue([{ total: 11, nonzero: 11 }]);
    stubUw(sessionGrid('2026-03-24', at('14:27')));

    await runCron();

    // One SELECT per ticker. Its text bounds `timestamp` and binds the
    // 09:30 ET open and 16:00 ET close of today (EDT: 13:30Z and 20:00Z).
    expect(mockSql).toHaveBeenCalledTimes(2);
    for (const call of mockSql.mock.calls) {
      const [strings, ...values] = call as [string[], ...unknown[]];
      const text = strings.join('?');
      expect(text).toMatch(/timestamp >= \?::timestamptz/);
      expect(text).toMatch(/timestamp <= \?::timestamptz/);
      expect(values).toContain('2026-03-24T13:30:00.000Z');
      expect(values).toContain('2026-03-24T20:00:00.000Z');
      expect(values).toContain('2026-03-24');
    }
  });

  // ── Outer catch block ─────────────────────────────────────

  it('returns 500 when data quality check throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(at('14:27'));

    // The upserts succeed via the batched transaction, but the SELECT COUNT
    // data-quality query (the only direct mockSql call) throws, landing in
    // the handler's outer catch block.
    mockSql.mockRejectedValue(new Error('DB connection lost'));
    stubUw(sessionGrid('2026-03-24', at('14:27')));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
