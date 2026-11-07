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
    schwabCall: vi.fn(() => () => {}),
    tokenRefresh: vi.fn(),
    rateLimited: vi.fn(),
    uwRateLimit: vi.fn(),
    uwBudget: vi.fn(),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/fetch-strike-exposure.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// Fixed market-hours time: Tuesday 10:00 AM ET (2026-03-24).
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

// 4 (ticker, expiry) tasks per cron invocation:
//   SPX × 2 (today + tomorrow), SPY × 1, QQQ × 1
const EXPECTED_TASKS = 4;

// Every ticker's spot is the same number in these fixtures, so one strike row
// (strike 5810, price 5800.5) sits inside all three windows.
const SPOT = 5800.5;

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    date: '2026-03-24',
    expiry: '2026-03-24',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_ask: '200000',
    call_gamma_bid: '150000',
    put_gamma_ask: '-100000',
    put_gamma_bid: '-80000',
    call_charm_oi: '50000',
    put_charm_oi: '-40000',
    call_charm_ask: '20000',
    call_charm_bid: '15000',
    put_charm_ask: '-10000',
    put_charm_bid: '-8000',
    call_delta_oi: '100000',
    put_delta_oi: '-75000',
    call_vanna_oi: '25000',
    put_vanna_oi: '-15000',
    ...overrides,
  };
}

/** One /spot-exposures minute row. */
function makeSpotRow(overrides = {}) {
  return { price: String(SPOT), time: '2026-03-24T14:29:00Z', ...overrides };
}

const ZERO_GAMMA = {
  call_gamma_oi: '0',
  put_gamma_oi: '0',
  call_gamma_ask: '0',
  call_gamma_bid: '0',
  put_gamma_ask: '0',
  put_gamma_bid: '0',
};

const uwOk = (data: unknown[]) => ({ ok: true, json: async () => ({ data }) });
const uwError = (status: number) => ({
  ok: false,
  status,
  text: async () => 'upstream error',
});

type Answer = unknown[] | ReturnType<typeof uwError>;

/**
 * Route the global fetch by UW path. `spot(ticker)` answers
 * /stock/{T}/spot-exposures; `strikes(ticker, expiry)` answers
 * /stock/{T}/spot-exposures/expiry-strike. Either may return a ready-made
 * error response, or throw to simulate a network failure.
 */
function stubUw({
  spot = () => [makeSpotRow()],
  strikes = () => [makeStrikeRow()],
}: {
  spot?: (ticker: string) => Answer;
  strikes?: (ticker: string, expiry: string) => Answer;
} = {}) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    const ticker = url.pathname.split('/')[3]!;
    let answer: Answer;
    if (url.pathname.endsWith('/spot-exposures/expiry-strike')) {
      answer = strikes(ticker, url.searchParams.get('expirations[]')!);
    } else if (url.pathname.endsWith('/spot-exposures')) {
      answer = spot(ticker);
    } else {
      throw new Error(`unexpected UW url ${input}`);
    }
    return Array.isArray(answer) ? uwOk(answer) : answer;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calledUrls(fetchMock: ReturnType<typeof stubUw>): URL[] {
  return (fetchMock.mock.calls as unknown[][]).map(
    (c) => new URL(String(c[0])),
  );
}

function strikeCalls(fetchMock: ReturnType<typeof stubUw>): URL[] {
  return calledUrls(fetchMock).filter((u) =>
    u.pathname.endsWith('/spot-exposures/expiry-strike'),
  );
}

function spotCalls(fetchMock: ReturnType<typeof stubUw>): URL[] {
  return calledUrls(fetchMock).filter((u) =>
    u.pathname.endsWith('/spot-exposures'),
  );
}

type Json = {
  success?: boolean;
  status?: string;
  skipped?: boolean;
  totalStored: number;
  totalSkipped: number;
  failedTasks: number;
  staleSkips: number;
  zeroSkips: number;
  perTicker: Record<
    string,
    {
      price: number | null;
      totalStored: number;
      expiries: Record<
        string,
        { stored: number; rejected?: string; failed?: boolean }
      >;
    }
  >;
};

function cronRequest() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/** Rows of every INSERT the handler submitted, as the template's values. */
let insertedRows: unknown[][] = [];

describe('fetch-strike-exposure handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
    insertedRows = [];
    // Default: every queued INSERT returns [{id:1}] (one stored row each). The
    // template tag records each INSERT's bound values: [date, timestamp,
    // ticker, expiry, strike, price, ...].
    mockTransaction.mockImplementation(
      async (
        fn: (
          txn: (s: TemplateStringsArray, ...v: unknown[]) => unknown,
        ) => unknown[],
      ) => {
        const queries = fn((_s, ...values) => values) as unknown[][];
        insertedRows.push(...queries);
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
    stubUw();
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
    const res = mockResponse();
    await handler(cronRequest(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(cronRequest(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(cronRequest(), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches all 3 tickers, stores per-ticker rows, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw();

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      status: 'ok',
      totalStored: EXPECTED_TASKS,
      totalSkipped: 0,
      failedTasks: 0,
    });
    // 4 transactions: SPX × 2, SPY × 1, QQQ × 1
    expect(mockTransaction).toHaveBeenCalledTimes(EXPECTED_TASKS);

    // Per-ticker bucket sanity
    const json = res._json as Json;
    expect(json.perTicker.SPX).toMatchObject({ totalStored: 2, price: SPOT });
    expect(json.perTicker.SPY).toMatchObject({ totalStored: 1 });
    expect(json.perTicker.QQQ).toMatchObject({ totalStored: 1 });
    expect(json.perTicker.NDX).toBeUndefined();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-strike-exposure',
      expect.objectContaining({ status: 'ok', totalStored: EXPECTED_TASKS }),
    );
  });

  it('fans out to per-ticker UW URLs, one spot read per ticker', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw();

    await handler(cronRequest(), mockResponse());

    const spotPaths = spotCalls(fetchMock).map((u) => u.pathname);
    // SPX is read once even though it has two expiries.
    expect([...spotPaths].sort()).toEqual([
      '/api/stock/QQQ/spot-exposures',
      '/api/stock/SPX/spot-exposures',
      '/api/stock/SPY/spot-exposures',
    ]);
    const strikePaths = strikeCalls(fetchMock).map((u) => u.pathname);
    expect(strikePaths.filter((p) => p.includes('/SPX/'))).toHaveLength(2);
    expect(strikePaths.filter((p) => p.includes('/SPY/'))).toHaveLength(1);
    expect(strikePaths.filter((p) => p.includes('/QQQ/'))).toHaveLength(1);
    // NDX was dropped 2026-05-16; no UW call should hit /stock/NDX.
    expect(
      calledUrls(fetchMock).some((u) => u.pathname.includes('/stock/NDX/')),
    ).toBe(false);
  });

  it('returns success with zero rows when API returns empty data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({ strikes: () => [] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      totalStored: 0,
      totalSkipped: 0,
    });
    // No transactions (empty rows short-circuit before storeStrikes hits the txn)
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly across all tasks', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // All 4 transactions return empty arrays (ON CONFLICT DO NOTHING fired).
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const queries = fn(() => ({}));
        return queries.map(() => []);
      },
    );
    stubUw();

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      totalStored: 0,
      totalSkipped: EXPECTED_TASKS,
    });
  });

  it('respects per-ticker ATM windows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // At spot=5800.5 the active windows are SPX ±200 (5600.5–6000.5),
    // SPY ±20 (5780.5–5820.5), QQQ ±20 (5780.5–5820.5).
    //   - 5810 → in all three.
    //   - 5900 → in SPX only.
    //   - 6100 → outside every active window.
    stubUw({
      strikes: () => [
        makeStrikeRow({ strike: '5810' }),
        makeStrikeRow({ strike: '5900' }),
        makeStrikeRow({ strike: '6100' }),
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    const json = res._json as Json;
    // SPX × 2 expiries × 2 strikes (5810, 5900; 6100 rejected) = 4
    expect(json.perTicker.SPX!.totalStored).toBe(4);
    // SPY × 1 expiry × 1 strike (only 5810) = 1
    expect(json.perTicker.SPY!.totalStored).toBe(1);
    // QQQ × 1 expiry × 1 strike = 1
    expect(json.perTicker.QQQ!.totalStored).toBe(1);
  });

  // ── Window and snapshot stamp (F6) ────────────────────────

  it('asks UW for min_strike/max_strike around each tickers helper spot', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({
      spot: (ticker) => [
        makeSpotRow({ price: ticker === 'SPX' ? '5800.5' : '612.34' }),
      ],
      strikes: () => [],
    });

    await handler(cronRequest(), mockResponse());

    const windows = Object.fromEntries(
      strikeCalls(fetchMock).map((u) => [
        `${u.pathname.split('/')[3]} ${u.searchParams.get('expirations[]')}`,
        [
          u.searchParams.get('min_strike'),
          u.searchParams.get('max_strike'),
          u.searchParams.get('limit'),
        ],
      ]),
    );
    // SPX ±200 around 5800.5; SPY and QQQ ±20 around 612.34 (floor / ceil).
    expect(windows).toEqual({
      'SPX 2026-03-24': ['5600', '6001', '500'],
      'SPX 2026-03-25': ['5600', '6001', '500'],
      'SPY 2026-03-24': ['592', '633', '500'],
      'QQQ 2026-03-24': ['592', '633', '500'],
    });
  });

  it('stamps the snapshot with the newest row time, floored to 5 minutes', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      strikes: (ticker, expiry) =>
        ticker === 'SPY' && expiry === '2026-03-24'
          ? [
              makeStrikeRow({ strike: '5800', time: '2026-03-24T14:21:00Z' }),
              makeStrikeRow({ strike: '5805', time: '2026-03-24T14:34:00Z' }),
              makeStrikeRow({ strike: '5810', time: '2026-03-24T14:29:00Z' }),
            ]
          : [],
    });

    await handler(cronRequest(), mockResponse());

    // 14:34 floors to the 14:30 bucket; the first row would have given 14:20.
    expect(insertedRows).toHaveLength(3);
    expect(insertedRows.every((v) => v[1] === '2026-03-24T14:30:00.000Z')).toBe(
      true,
    );
  });

  // ── Stale cache (F5) ──────────────────────────────────────

  it('stores nothing when UW serves yesterdays ladders, and names each (F5 replay)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The 09:28 ET poll gets Monday 03-23 15:55 ET for every ticker.
    stubUw({
      strikes: () => [makeStrikeRow({ time: '2026-03-23T19:55:00Z' })],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    expect(json).toMatchObject({
      success: true,
      totalStored: 0,
      staleSkips: EXPECTED_TASKS,
    });
    expect(json.perTicker.SPX!.expiries['2026-03-24']).toMatchObject({
      stored: 0,
      rejected: 'stale_cache',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        ticker: 'SPY',
        expiry: '2026-03-24',
        dataEtDate: '2026-03-23',
        today: '2026-03-24',
      }),
      expect.stringContaining('stale UW cache'),
    );
    expect(metrics.increment).toHaveBeenCalledTimes(EXPECTED_TASKS);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_exposure.stale_cache_skip',
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-strike-exposure',
      expect.objectContaining({
        status: 'skipped',
        staleSkips: EXPECTED_TASKS,
      }),
    );
  });

  it('skips only the stale ladder and stores the fresh ones', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      strikes: (ticker) => [
        makeStrikeRow({
          time:
            ticker === 'QQQ' ? '2026-03-23T19:55:00Z' : '2026-03-24T14:30:00Z',
        }),
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    const json = res._json as Json;
    expect(json).toMatchObject({
      success: true,
      totalStored: 3,
      staleSkips: 1,
    });
    expect(json.perTicker.QQQ!.expiries['2026-03-24']).toMatchObject({
      rejected: 'stale_cache',
    });
    expect(mockTransaction).toHaveBeenCalledTimes(3);
  });

  // ── All-zero ladder (F7) ──────────────────────────────────

  it('skips an all-zero ladder with a warning and a metric (F7)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      strikes: (ticker, expiry) => [
        makeStrikeRow(
          ticker === 'SPX' && expiry === '2026-03-24' ? ZERO_GAMMA : {},
        ),
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    expect(json).toMatchObject({ success: true, zeroSkips: 1, totalStored: 3 });
    expect(json.perTicker.SPX!.expiries['2026-03-24']).toMatchObject({
      stored: 0,
      rejected: 'all_zero',
    });
    expect(json.perTicker.SPX!.expiries['2026-03-25']).toMatchObject({
      stored: 1,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'SPX', expiry: '2026-03-24' }),
      'fetch-strike-exposure: rejecting all-zero gamma snapshot',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_exposure.zero_snapshot_skip',
    );
  });

  it('treats blank gamma fields as zero and stores a ladder with one live strike', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      strikes: (ticker) =>
        ticker === 'SPY'
          ? [
              makeStrikeRow({
                strike: '5790',
                call_gamma_oi: '',
                put_gamma_oi: '',
              }),
              makeStrikeRow({
                strike: '5805',
                call_gamma_oi: '0',
                put_gamma_oi: '-12',
              }),
            ]
          : [],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    const json = res._json as Json;
    expect(json.zeroSkips).toBe(0);
    expect(json.perTicker.SPY!.totalStored).toBe(2);
  });

  // ── Spot unavailable ──────────────────────────────────────

  it('fails that tickers tasks and stores nothing for it when its spot is null', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({
      spot: (ticker) => (ticker === 'SPY' ? [] : [makeSpotRow()]),
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    // Not a success: SPY's one task failed.
    expect(json).toMatchObject({
      success: false,
      status: 'partial',
      failedTasks: 1,
      totalStored: 3,
    });
    expect(json.perTicker.SPY!.expiries['2026-03-24']).toMatchObject({
      stored: 0,
      failed: true,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no usable SPY spot'),
      'error',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_exposure.spot_null',
    );
    // It never asked UW for SPY strikes, and never guessed a window.
    expect(
      strikeCalls(fetchMock).some((u) => u.pathname.includes('/SPY/')),
    ).toBe(false);
    expect(insertedRows.some((v) => v[2] === 'SPY')).toBe(false);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-strike-exposure',
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('is a 500 and stores nothing when no ticker has a usable spot', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({ spot: () => [makeSpotRow({ price: 'NaN' })] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'All ticker fetches failed' });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(3);
    expect(strikeCalls(fetchMock)).toHaveLength(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-strike-exposure',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('fails that tickers tasks, captured once, when its spot request is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 422 is not retried.
    stubUw({
      spot: (ticker) => (ticker === 'SPX' ? uwError(422) : [makeSpotRow()]),
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    expect(json).toMatchObject({
      success: false,
      status: 'partial',
      failedTasks: 2,
      totalStored: 2,
    });
    expect(json.perTicker.SPX!.totalStored).toBe(0);
    const captured = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([e]) => String((e as Error).message));
    expect(captured).toEqual([expect.stringContaining('UW API 422')]);
    expect(insertedRows.some((v) => v[2] === 'SPX')).toBe(false);
  });

  // ── Error handling ────────────────────────────────────────

  it('isolates a rejected strike request — surviving tasks still complete, run is partial', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      strikes: (ticker, expiry) =>
        ticker === 'SPX' && expiry === '2026-03-24'
          ? uwError(422)
          : [makeStrikeRow()],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      status: 'partial',
      failedTasks: 1,
      totalStored: EXPECTED_TASKS - 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 422'),
      }),
    );
  });

  it('returns 500 when ALL ticker fetches fail', async () => {
    // The mocked 500 is retried by withRetry (1 s + 2 s backoff). Fake
    // setTimeout so the retries don't burn wall time; Date is faked too so
    // the market-hours clock can be re-pinned on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(MARKET_TIME);
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uwError(500)));

    const res = mockResponse();
    const run = handler(cronRequest(), res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'All ticker fetches failed' });
    // Each ticker's spot failure is captured once, not once per expiry.
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('is a 500 naming the payload when no strike row has a parseable time', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({ strikes: () => [makeStrikeRow({ time: 'garbage' })] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'All ticker fetches failed' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('parseable time'),
      }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('is a 500, not a success, when every batch insert is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValue(dbError);
    stubUw();

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'All ticker fetches failed' });
    expect(res._json).not.toMatchObject({ success: true });
    expect(Sentry.captureException).toHaveBeenCalledTimes(EXPECTED_TASKS);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-strike-exposure',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('is partial, not a success, when one batch insert is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValueOnce(dbError);
    stubUw();

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      status: 'partial',
      failedTasks: 1,
      totalStored: EXPECTED_TASKS - 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });
});
