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
// 10:00-10:05 and 10:05-10:10 buckets have closed and settled; 10:10-10:15
// is open.
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
 * 10:00-10:05 bucket, which has closed and settled at MARKET_TIME.
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
 * UW's prefilled session grid for `day`: one tick per minute from `openZ`
 * (`minutes` of them: 390 is 09:30-15:59 ET). Minutes that start at or after
 * `filledUntil` have not happened yet, so UW sends them with null values. The
 * cumulative ncp is the minute-of-session, so a bucket's value names its last
 * minute.
 */
function tickGrid(
  day: string,
  filledUntil: Date,
  { openZ = '13:30', minutes = 390 } = {},
) {
  const open = at(openZ, day).getTime();
  const ticks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < minutes; i++) {
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

/** The grid with one minute's fields replaced. */
const withMinute = (
  ticks: Array<Record<string, unknown>>,
  hhmmZ: string,
  overrides: Record<string, unknown>,
) =>
  ticks.map((tick) =>
    tick.timestamp === `2026-03-24T${hhmmZ}:00.000Z`
      ? { ...tick, ...overrides }
      : tick,
  );

/** Stub fetch with the doubly-nested UW net-flow/expiry response structure */
function stubFetch(ticks: unknown = []) {
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

type Outcome = 'inserted' | 'updated' | 'unchanged';
const OUTCOME_ROWS: Record<Outcome, unknown[]> = {
  inserted: [{ inserted: true }],
  updated: [{ inserted: false }],
  unchanged: [],
};

/**
 * Replace the batch transaction with a recorder: each upsert's bound values
 * (date, timestamp, source, ncp, npp, net_volume) are pushed to the returned
 * array, and each is answered with `outcome(values, index)` (default: a new
 * row).
 */
function recordInserts(
  outcome: (values: unknown[], index: number) => Outcome = () => 'inserted',
) {
  const inserts: unknown[][] = [];
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      const queries = fn((_strings: unknown, ...values: unknown[]) => {
        bound.push(values);
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

describe('fetch-zero-dte-flow handler', () => {
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
    ['09:29 ET, the first run', '13:29', false],
    ['16:09 ET, the second attempt at the last bucket', '20:09', false],
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
      inserted: 1,
      updated: 0,
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
      expect.objectContaining({ status: 'ok', stored: 1, inserted: 1 }),
    );
  });

  it('stores NULL when UW sends no net_volume for the last minute', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([makeFlowTick({ net_volume: null })]);

    await runCron();

    expect(inserts[0]?.[5]).toBeNull();
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

  // ── Upsert: finality by self-heal ─────────────────────────

  it('reports inserted and updated rows separately, and unchanged ones as skipped', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(
      (_values, i) => (['inserted', 'updated', 'unchanged'] as const)[i % 3]!,
    );
    stubFetch([
      makeFlowTick({ timestamp: '2026-03-24T13:34:00Z' }),
      makeFlowTick({ timestamp: '2026-03-24T13:39:00Z' }),
      makeFlowTick({ timestamp: '2026-03-24T13:44:00Z' }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({
      stored: 2,
      inserted: 1,
      updated: 1,
      skipped: 1,
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ inserted: 1, updated: 1, skipped: 1 }),
    );
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
    stubFetch([makeFlowTick()]);

    await runCron();

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(
      'ON CONFLICT (date, timestamp, source) DO UPDATE',
    );
    expect(texts[0]).toContain('IS DISTINCT FROM');
    expect(texts[0]).toContain('RETURNING (xmax = 0) AS inserted');
    expect(texts[0]).not.toContain('DO NOTHING');
    expect(texts[0]).not.toContain('created_at');
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Empty result per query = the row already holds these values
    recordInserts(() => 'unchanged');
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

  it('rejects and reports a snapshot whose only closed buckets are stuck with null or blank premium', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The 09:50-09:55 and 09:55-10:00 buckets ended 19 and 14 minutes ago.
    stubFetch([
      makeFlowTick({
        timestamp: '2026-03-24T13:54:00Z',
        net_call_premium: '',
        net_put_premium: '',
      }),
      makeFlowTick({
        timestamp: '2026-03-24T13:59:00Z',
        net_call_premium: null,
        net_put_premium: null,
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      stuck: 2,
      rejected: true,
    });
    // Neither a 0 nor a NULL row is written for them.
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
    // The 10:05-10:10 bucket ended 4 minutes ago and its last minute is null.
    stubFetch([
      makeFlowTick({
        timestamp: '2026-03-24T14:09:00Z',
        net_call_premium: null,
        net_put_premium: null,
      }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, pending: 1, stuck: 0 });
    expect(res._json).not.toMatchObject({ rejected: true });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
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
    // Normal before 09:40 ET: no alert.
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
      pending: 0,
      stuck: 0,
    });
    expect(res._json).not.toMatchObject({ rejected: true });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('10:04 ET: stores only the closed, settled, non-null buckets, at bucket-end labels (R-closed, label rule)', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('14:04')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 6,
      skipped: 0,
      pending: 0,
      stuck: 0,
    });
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

  it('waits for a bucket that ended less than 90 s ago, even though its last minute has a value', async () => {
    vi.setSystemTime(new Date('2026-03-24T14:00:30.000Z'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('14:01')));

    await runCron();

    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T13:55:00.000Z');
  });

  // ── Bad minutes: pending, stuck, never stored as 0 ────────

  it('counts a closed bucket whose last minute is null and that ended 10 minutes ago or more as stuck, with one warning naming the oldest (R-null)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    // The 09:55-10:00 bucket ended 14 minutes before MARKET_TIME; the 09:40
    // one 29 minutes before.
    let grid = withMinute(tickGrid('2026-03-24', MARKET_TIME), '13:59', {
      net_call_premium: null,
      net_put_premium: null,
      net_volume: null,
    });
    grid = withMinute(grid, '13:44', { net_call_premium: 'garbage' });
    stubFetch(grid);

    const res = await runCron();

    expect(res._json).toMatchObject({ stuck: 2, pending: 0 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T13:45:00.000Z');
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T14:00:00.000Z');
    expect(metrics.increment).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_zero_dte_flow.invalid_candle',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'fetch-zero-dte-flow',
          stage: 'stuck_bucket',
        }),
        extra: expect.objectContaining({
          stuck: 2,
          oldest: '2026-03-24T13:45:00.000Z',
        }),
      }),
    );
  });

  it('never stores a NaN premium in a past minute as 0 or NULL; a bucket UW is only minutes late with is pending, not counted (R-null)', async () => {
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

    expect(res._json).toMatchObject({ stored: 1, pending: 1, stuck: 0 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]).toBe('2026-03-24T14:05:00.000Z');
    expect(metrics.increment).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('never stores a NaN premium in a stuck bucket either', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch([
      makeFlowTick({ timestamp: '2026-03-24T14:04:00Z' }),
      makeFlowTick({
        timestamp: '2026-03-24T13:59:00Z',
        net_put_premium: 'not-a-number',
      }),
    ]);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 1, stuck: 1 });
    expect(inserts.map((v) => v[1])).toEqual(['2026-03-24T14:05:00.000Z']);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_zero_dte_flow.invalid_candle',
    );
  });

  // ── Last bucket of the day, and the window around it ──────

  it('16:04 ET: stores the last bucket of the day (15:55-16:00) at 16:00 on the first run after it settles', async () => {
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

  it('16:09 ET: the second attempt re-sends the day and rewrites nothing that is unchanged', async () => {
    vi.setSystemTime(at('20:09'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubFetch(tickGrid('2026-03-24', at('20:00')));

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, skipped: 78 });
    // Nothing was written, so the quality query is not run.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('15:59 ET: the last bucket is still open and is not stored yet', async () => {
    vi.setSystemTime(at('19:59'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(tickGrid('2026-03-24', at('19:59')));

    await runCron();

    // The 15:55-16:00 bucket ends at 20:00; the 15:50-15:55 one settled at
    // 19:56:30, so 77 buckets (labels 09:35 to 15:55) are stored.
    expect(inserts).toHaveLength(77);
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T19:55:00.000Z');
  });

  it('13:04 ET on an early-close day: stores the 12:55-13:00 bucket at 13:00 on the first run', async () => {
    // 2026-11-27 is a half day on EST (UTC-5): 09:30 ET is 14:30Z, 13:00 ET
    // is 18:00Z. UW sends 12:59 as its last session minute; the ticks after
    // it are stray and must not open a 13:00-13:05 bucket.
    vi.setSystemTime(at('18:04', '2026-11-27'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(
      tickGrid('2026-11-27', at('18:05', '2026-11-27'), {
        openZ: '14:30',
        minutes: 215,
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 42 });
    expect(inserts.at(-1)?.[1]).toBe('2026-11-27T18:00:00.000Z');
    expect(inserts.map((v) => v[0])).toEqual(Array(42).fill('2026-11-27'));
  });

  it('13:09 ET on an early-close day: ticks stamped after the 13:00 close do not open a bucket', async () => {
    // The 13:00-13:05 bucket has ended and settled by 13:09, and UW's stray
    // ticks in it carry values: it would be stored if the close were not the
    // end of the session.
    vi.setSystemTime(at('18:09', '2026-11-27'));
    process.env.UW_API_KEY = 'uwkey';
    const inserts = recordInserts();
    stubFetch(
      tickGrid('2026-11-27', at('18:05', '2026-11-27'), {
        openZ: '14:30',
        minutes: 215,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 42 });
    expect(inserts.map((v) => v[1])).not.toContain('2026-11-27T18:05:00.000Z');
  });

  it('13:09 ET on an early-close day: still inside the window; 13:11 ET is not', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    vi.setSystemTime(at('18:09', '2026-11-27'));
    const inside = await runCron();
    // `skipped` is also this cron's count of unchanged rows: 0 here, not true.
    expect(inside._json).not.toMatchObject({ skipped: true });

    vi.setSystemTime(at('18:11', '2026-11-27'));
    const outside = await runCron();
    expect(outside._json).toMatchObject({ skipped: true });
  });

  // ── Feed stalled (item 4) ─────────────────────────────────

  it('10:14 ET: an empty payload is surfaced as a stalled feed', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetchEmpty();

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, reason: 'no_rows_today' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no rows for today'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'fetch-zero-dte-flow',
          stage: 'feed_stalled',
        }),
      }),
    );
  });

  it("10:14 ET: a grid holding only yesterday's session is surfaced as a stalled feed", async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch(tickGrid('2026-03-23', at('20:00', '2026-03-23')));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 0, reason: 'no_rows_today' });
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
    ['09:34 ET, UW may still be rolling over', '13:34', 0],
    ['09:39 ET', '13:39', 0],
    ['09:44 ET', '13:44', 1],
  ])('an empty payload at %s: %i alert(s)', async (_label, hhmmZ, alerts) => {
    vi.setSystemTime(at(hhmmZ));
    process.env.UW_API_KEY = 'uwkey';
    stubFetchEmpty();

    await runCron();

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(alerts);
  });

  // ── Data quality check (R-quality) ────────────────────────

  it('runs the data quality check after a write even when only one bucket is new (steady state)', async () => {
    // 10:34 ET: 12 buckets (09:30-10:30) have closed and settled. 11 were
    // stored by earlier runs; this run adds the newest one.
    vi.setSystemTime(at('14:34'));
    process.env.UW_API_KEY = 'uwkey';
    recordInserts((values) =>
      values[1] === '2026-03-24T14:30:00.000Z' ? 'inserted' : 'unchanged',
    );
    mockSql.mockResolvedValue([{ total: 12, nonzero: 0 }]);
    stubFetch(tickGrid('2026-03-24', at('14:34')));

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 1, inserted: 1, skipped: 11 });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
  });

  it('runs the data quality check when a revised value was written', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'updated');
    mockSql.mockResolvedValue([{ total: 12, nonzero: 12 }]);
    stubFetch([makeFlowTick()]);

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not alert on 10 stored rows or fewer, however zero they are', async () => {
    vi.setSystemTime(at('14:04'));
    process.env.UW_API_KEY = 'uwkey';
    mockSql.mockResolvedValue([{ total: 6, nonzero: 0 }]);
    stubFetch(tickGrid('2026-03-24', at('14:04')));

    await runCron();

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('skips the data quality check when the run wrote nothing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    recordInserts(() => 'unchanged');
    stubFetch([makeFlowTick()]);

    await runCron();

    expect(mockSql).not.toHaveBeenCalled();
  });

  it("counts only today's session rows in the data quality query, so yesterday's rows cannot mask a dead day (R-quality)", async () => {
    process.env.UW_API_KEY = 'uwkey';
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

  it('returns 500 and captures once when a 2xx response does not parse as JSON (R4)', async () => {
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
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SyntaxError' }),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'fetch' }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-zero-dte-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
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

  it('a rejected batch upsert is a failed run, captured once and reported as error, never success (R4)', async () => {
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
