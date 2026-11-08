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

import handler from '../cron/fetch-strike-all.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// EDT (UTC-4): the last second before, and the first second of, 09:40 ET.
const BEFORE_0940_ET = new Date('2026-03-24T13:39:59.000Z');
const AT_0940_ET = new Date('2026-03-24T13:40:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

// The live spot the helper reads from /spot-exposures. Every strike fixture
// below sits around it.
const SPOT = 5800.5;
// Window the cron must ask UW for: floor(5800.5 - 200), ceil(5800.5 + 200).
const MIN_STRIKE = '5600';
const MAX_STRIKE = '6001';

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    date: '2026-03-24',
    ticker: 'SPX',
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

const uwOk = (data: unknown[]) => ({ ok: true, json: async () => ({ data }) });
const uwError = (status: number) => ({
  ok: false,
  status,
  text: async () => 'upstream error',
});

/**
 * Route the global fetch by UW path. `spot` answers /spot-exposures, `pages`
 * answers /spot-exposures/strike by its `page` query param (an empty page past
 * the end). A page entry may be a ready-made response to simulate a UW error.
 */
function stubUw({
  spot = [makeSpotRow()],
  pages = [[makeStrikeRow()]],
}: {
  spot?: unknown[] | ReturnType<typeof uwError>;
  pages?: Array<unknown[] | ReturnType<typeof uwError>>;
} = {}) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/spot-exposures/strike')) {
      const page = pages[Number(url.searchParams.get('page') ?? '0')] ?? [];
      return Array.isArray(page) ? uwOk(page) : page;
    }
    if (url.pathname.endsWith('/spot-exposures')) {
      return Array.isArray(spot) ? uwOk(spot) : spot;
    }
    throw new Error(`unexpected UW url ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** URLs of every UW call the stub saw, parsed. */
function calledUrls(fetchMock: ReturnType<typeof stubUw>): URL[] {
  return (fetchMock.mock.calls as unknown[][]).map(
    (c) => new URL(String(c[0])),
  );
}

function strikeCalls(fetchMock: ReturnType<typeof stubUw>): URL[] {
  return calledUrls(fetchMock).filter((u) =>
    u.pathname.endsWith('/spot-exposures/strike'),
  );
}

/** `n` distinct strikes spread across (5600.5, 6000.5), all inside the window. */
function ladder(n: number, overrides = {}) {
  return Array.from({ length: n }, (_, i) =>
    makeStrikeRow({
      strike: (5601 + (i * 398) / n).toFixed(2),
      ...overrides,
    }),
  );
}

/** Rows of every INSERT the handler submitted, as the template's values. */
let insertedRows: unknown[][] = [];

function cronRequest() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('fetch-strike-all handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-attach transaction after resetAllMocks clears mock state
    mockSql.transaction = mockTransaction;
    // The post-insert data-quality SELECT (stored > 10) reads { total, nonzero }.
    mockSql.mockResolvedValue([{ total: 1, nonzero: 1 }]);
    insertedRows = [];
    // Default: all rows inserted (returns [{id:1}] per query). The template tag
    // records each INSERT's bound values: [date, timestamp, expiry, strike,
    // price, ...].
    mockTransaction.mockImplementation(
      async (
        fn: (
          txn: (s: TemplateStringsArray, ...v: unknown[]) => unknown,
        ) => unknown[],
      ) => {
        const queries = fn((_s, ...values) => values) as unknown[][];
        insertedRows = queries;
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

  it('fetches strikes, filters to ATM range, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({ pages: [[makeStrikeRow()]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      price: 5800.5,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Override: all rows conflict (DO NOTHING returns empty)
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const queries = fn(() => ({}));
        return queries.map(() => []);
      },
    );
    stubUw({ pages: [[makeStrikeRow()]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  it('filters out strikes beyond ±200 pts from ATM', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const nearStrike = makeStrikeRow({ strike: '5800' });
    const farStrike = makeStrikeRow({ strike: '6100' });
    stubUw({ pages: [[nearStrike, farStrike]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    // Only the near strike (5800) should be stored; 6100 is >200 pts away
    expect(res._json).toMatchObject({
      success: true,
      totalStrikes: 2,
      stored: 1,
      skipped: 0,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('calls the all-expiry strike endpoint (no expiry filter)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw();

    await handler(cronRequest(), mockResponse());

    const [strikeUrl] = strikeCalls(fetchMock);
    expect(strikeUrl!.pathname).toBe('/api/stock/SPX/spot-exposures/strike');
    expect(strikeUrl!.search).not.toContain('expir');
  });

  // ── Spot, window and paging (F6; plan R1) ─────────────────

  it('asks UW for min_strike/max_strike around the helper spot, page 0, limit 500', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw();

    await handler(cronRequest(), mockResponse());

    const urls = calledUrls(fetchMock);
    // Spot first, from the per-minute endpoint with no date.
    expect(urls[0]!.pathname).toBe('/api/stock/SPX/spot-exposures');
    expect(urls[0]!.search).toBe('');
    const [strikeUrl] = strikeCalls(fetchMock);
    expect(strikeUrl!.searchParams.get('min_strike')).toBe(MIN_STRIKE);
    expect(strikeUrl!.searchParams.get('max_strike')).toBe(MAX_STRIKE);
    expect(strikeUrl!.searchParams.get('limit')).toBe('500');
    expect(strikeUrl!.searchParams.get('page')).toBe('0');
  });

  it('walks to the next page when a page holds exactly 500 rows (500 then 38)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const all = ladder(538);
    const fetchMock = stubUw({ pages: [all.slice(0, 500), all.slice(500)] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    const pages = strikeCalls(fetchMock).map((u) => u.searchParams.get('page'));
    expect(pages).toEqual(['0', '1']);
    expect(res._json).toMatchObject({
      success: true,
      totalStrikes: 538,
      stored: 538,
    });
    // Both sides of spot made it into the INSERT, not only the low strikes
    // the old single page held.
    const strikes = insertedRows.map((v) => Number.parseFloat(String(v[3])));
    expect(Math.min(...strikes)).toBeLessThan(SPOT);
    expect(Math.max(...strikes)).toBeGreaterThan(SPOT);
  });

  it('asks for one more page after exactly 500 rows and stops on the empty one', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({ pages: [ladder(500), []] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(strikeCalls(fetchMock)).toHaveLength(2);
    expect(res._json).toMatchObject({ success: true, stored: 500 });
  });

  it('does not ask for a second page after a short page', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({ pages: [ladder(499), ladder(5)] });

    await handler(cronRequest(), mockResponse());

    expect(strikeCalls(fetchMock)).toHaveLength(1);
  });

  it('fails the run instead of storing a ladder cut off by the 10-page cap', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fullPage = ladder(500);
    const fetchMock = stubUw({
      pages: Array.from({ length: 12 }, () => fullPage),
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(strikeCalls(fetchMock)).toHaveLength(10);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('10 full pages'),
      }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('stores the helper spot as price, not the strike rows own price', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The rows carry a frozen price; the helper spot is the live one.
    stubUw({ pages: [[makeStrikeRow({ price: '5123.25' })]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._json).toMatchObject({ success: true, price: SPOT });
    expect(Number(insertedRows[0]![4])).toBe(SPOT);
  });

  it('stamps the snapshot with the newest row time, not the first row', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({
      pages: [
        [
          makeStrikeRow({ strike: '5800', time: '2026-03-24T14:21:00Z' }),
          makeStrikeRow({ strike: '5805', time: '2026-03-24T14:34:00Z' }),
          makeStrikeRow({ strike: '5810', time: '2026-03-24T14:29:00Z' }),
        ],
      ],
    });

    await handler(cronRequest(), mockResponse());

    // 14:34 floors to the 14:30 bucket; the first row would have given 14:20.
    expect(insertedRows).toHaveLength(3);
    expect(insertedRows.every((v) => v[1] === '2026-03-24T14:30:00.000Z')).toBe(
      true,
    );
  });

  // ── Stale cache (F5) ──────────────────────────────────────

  it('stores nothing when UW serves yesterdays ladder, and names it (F5 replay)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The 09:28 ET poll on 2026-03-24 gets Monday 03-23 15:55 ET.
    stubUw({
      pages: [ladder(20, { time: '2026-03-23T19:55:00Z' })],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      skipped: true,
      reason: 'stale',
      dataEtDate: '2026-03-23',
      today: '2026-03-24',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dataEtDate: '2026-03-23',
        today: '2026-03-24',
      }),
      expect.stringContaining('stale UW cache'),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_all.stale_cache_skip',
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-strike-all',
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  // ── One rule for every ladder that is not stored (R4) ─────

  // Each kind, the UW answer that produces it, and the metric it counts.
  const SKIP_KINDS: Array<{
    kind: string;
    metric: string;
    uw: Parameters<typeof stubUw>[0];
  }> = [
    {
      kind: 'stale',
      metric: 'stale_cache_skip',
      uw: { pages: [ladder(5, { time: '2026-03-23T19:55:00Z' })] },
    },
    {
      kind: 'stale_spot',
      metric: 'stale_spot_skip',
      uw: { spot: [makeSpotRow({ time: '2026-03-23T19:55:00Z' })] },
    },
    {
      kind: 'all_zero',
      metric: 'zero_snapshot_skip',
      uw: {
        pages: [ladder(5, { call_gamma_oi: '0', put_gamma_oi: '0' })],
      },
    },
    { kind: 'empty', metric: 'empty_ladder_skip', uw: { pages: [[]] } },
    {
      kind: 'outside_window',
      metric: 'outside_window_skip',
      uw: { pages: [[makeStrikeRow({ strike: '4000' })]] },
    },
  ];

  it.each(SKIP_KINDS)(
    '$kind: stores nothing, answers success false, skipped, and reports skipped',
    async ({ kind, metric, uw }) => {
      process.env.UW_API_KEY = 'uwkey';
      stubUw(uw);

      const res = mockResponse();
      await handler(cronRequest(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        job: 'fetch-strike-all',
        success: false,
        skipped: true,
        reason: kind,
      });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind, ticker: 'SPX' }),
        expect.stringContaining('skipping store'),
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        `fetch_strike_all.${metric}`,
      );
      expect(reportCronRun).toHaveBeenCalledWith(
        'fetch-strike-all',
        expect.objectContaining({ status: 'skipped', kind }),
      );
      expect(reportCronRun).not.toHaveBeenCalledWith(
        'fetch-strike-all',
        expect.objectContaining({ status: 'ok' }),
      );
    },
  );

  it.each(SKIP_KINDS)(
    '$kind: sends a Sentry error naming the kind from 09:40 ET',
    async ({ kind, uw }) => {
      process.env.UW_API_KEY = 'uwkey';
      vi.setSystemTime(AT_0940_ET);
      stubUw(uw);

      await handler(cronRequest(), mockResponse());

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`fetch-strike-all: ${kind} ladder for SPX`),
        ),
        'error',
      );
    },
  );

  it.each(SKIP_KINDS)(
    '$kind: stays quiet in Sentry before 09:40 ET (the rollover), still warns and counts',
    async ({ kind, metric, uw }) => {
      process.env.UW_API_KEY = 'uwkey';
      vi.setSystemTime(BEFORE_0940_ET);
      stubUw(uw);

      const res = mockResponse();
      await handler(cronRequest(), res);

      expect(res._json).toMatchObject({ success: false, reason: kind });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        `fetch_strike_all.${metric}`,
      );
    },
  );

  it('stale_spot: does not even ask UW for the ladder', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubUw({
      spot: [makeSpotRow({ time: '2026-03-23T19:55:00Z' })],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._json).toMatchObject({
      reason: 'stale_spot',
      spotTime: '2026-03-23T19:55:00Z',
      dataEtDate: '2026-03-23',
    });
    expect(strikeCalls(fetchMock)).toHaveLength(0);
  });

  // ── Spot unavailable ──────────────────────────────────────

  it.each([
    ['no rows', [] as unknown[]],
    ['a NaN price', [makeSpotRow({ price: 'not-a-number' })]],
    ['a zero price', [makeSpotRow({ price: '0' })]],
  ])(
    'is a 500 with a Sentry message and no insert when the spot has %s',
    async (_n, spot) => {
      process.env.UW_API_KEY = 'uwkey';
      const fetchMock = stubUw({ spot });

      const res = mockResponse();
      await handler(cronRequest(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'No usable SPX spot' });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no usable SPX spot'),
        'error',
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        'fetch_strike_all.spot_null',
      );
      // It never guessed a window from a strike row.
      expect(strikeCalls(fetchMock)).toHaveLength(0);
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails (non-ok response)', async () => {
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
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 500'),
      }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 500 when fetch throws (network error)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Network error' }),
    );
  });

  it.each(['spot', 'strike'])(
    'is a 500 with the parse error captured when UW answers 2xx but the %s body is not JSON',
    async (which) => {
      process.env.UW_API_KEY = 'uwkey';
      const parseError = new SyntaxError('Unexpected token < in JSON');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const isStrike = new URL(input).pathname.endsWith('/strike');
          if ((which === 'strike') === isStrike) {
            return { ok: true, json: () => Promise.reject(parseError) };
          }
          return uwOk(isStrike ? [makeStrikeRow()] : [makeSpotRow()]);
        }),
      );

      const res = mockResponse();
      await handler(cronRequest(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'Internal error' });
      expect(Sentry.captureException).toHaveBeenCalledWith(parseError);
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it('is a 500 with nothing stored when page 1 fails after page 0 succeeded', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 422 is not retried, so the walk dies on page 1 straight away.
    stubUw({ pages: [ladder(500), uwError(422)] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(res._json).not.toMatchObject({ success: true });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 422'),
      }),
    );
    // Page 0 alone is never written as if it were the whole ladder.
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('is a 500, not a success, when the batch insert is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValueOnce(dbError);
    stubUw({ pages: [[makeStrikeRow()]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(res._json).not.toMatchObject({ success: true });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-strike-all',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('is a 500 naming the payload when no strike row has a parseable time', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubUw({ pages: [[makeStrikeRow({ time: 'garbage' })]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('parseable time'),
      }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Data quality check conditional ────────────────────────

  it('skips data quality check when stored <= 10', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // 1 strike stored → stored (1) <= 10 → no quality SELECT
    stubUw({ pages: [[makeStrikeRow()]] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 1 });
    // Only the transaction call — no additional mockSql call for quality check
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('runs data quality check when stored > 10', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Generate 11 strikes within ATM range to trigger quality check
    const strikes = Array.from({ length: 11 }, (_, i) =>
      makeStrikeRow({ strike: String(5750 + i * 5) }),
    );
    stubUw({ pages: [strikes] });

    // Quality check SELECT needs a return value
    mockSql.mockResolvedValueOnce([{ total: 11, nonzero: 10 }]);

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 11 });
    // mockSql should have been called once for the data quality SELECT
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── All-zero snapshot rejection (F7) ──────────────────────

  it('rejects an all-zero gamma snapshot without storing, with a warning and a metric', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // 11 in-range strikes, every gamma field zero — the garbage snapshot
    // signature UW returns at early-session runs.
    const zeroFields = {
      call_gamma_oi: '0',
      put_gamma_oi: '0',
      call_gamma_ask: '0',
      call_gamma_bid: '0',
      put_gamma_ask: '0',
      put_gamma_bid: '0',
    };
    const strikes = Array.from({ length: 11 }, (_, i) =>
      makeStrikeRow({ strike: String(5750 + i * 5), ...zeroFields }),
    );
    stubUw({ pages: [strikes] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      skipped: true,
      reason: 'all_zero',
      rows: 11,
    });
    // Neither the insert transaction nor the data-quality SELECT should run.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'all_zero', rows: 11 }),
      'fetch-strike-all: rejecting all-zero gamma snapshot, skipping store',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_all.zero_snapshot_skip',
    );
  });

  it('treats null/empty gamma fields as zero when rejecting', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const blankFields = {
      call_gamma_oi: '',
      put_gamma_oi: '',
      call_gamma_ask: '',
      call_gamma_bid: '',
      put_gamma_ask: '',
      put_gamma_bid: '',
    };
    const strikes = Array.from({ length: 11 }, (_, i) =>
      makeStrikeRow({ strike: String(5750 + i * 5), ...blankFields }),
    );
    stubUw({ pages: [strikes] });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      skipped: true,
      reason: 'all_zero',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('stores normally when at least one strike carries gamma', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Ten zero strikes plus one with real gamma → snapshot has signal.
    const zeroStrikes = Array.from({ length: 10 }, (_, i) =>
      makeStrikeRow({
        strike: String(5750 + i * 5),
        call_gamma_oi: '0',
        put_gamma_oi: '0',
      }),
    );
    const liveStrike = makeStrikeRow({ strike: '5805' });
    stubUw({ pages: [[...zeroStrikes, liveStrike]] });

    mockSql.mockResolvedValueOnce([{ total: 11, nonzero: 1 }]);

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 11 });
    expect(res._json).not.toMatchObject({ skipped: true });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  // ── ATM range filtering edge cases ────────────────────────

  it('includes strikes exactly at spot ± 200 boundary', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Spot = 5800, so range is [5600, 6000]
    stubUw({
      spot: [makeSpotRow({ price: '5800' })],
      pages: [
        [makeStrikeRow({ strike: '5600' }), makeStrikeRow({ strike: '6000' })],
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    // Both boundary strikes should be included (>= and <=)
    expect(res._json).toMatchObject({
      success: true,
      totalStrikes: 2,
      stored: 2,
      skipped: 0,
    });
  });

  it('excludes strikes just beyond spot ± 200 boundary', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Spot = 5800, so range is [5600, 6000]
    stubUw({
      spot: [makeSpotRow({ price: '5800' })],
      pages: [
        [makeStrikeRow({ strike: '5599' }), makeStrikeRow({ strike: '6001' })],
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    // Both strikes are outside the range: not stored, and not a success
    expect(res._json).toMatchObject({
      success: false,
      skipped: true,
      reason: 'outside_window',
      rows: 2,
    });
    // No transaction should be called when all strikes are filtered out
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('is skipped, not a success, when every strike is far outside the range', async () => {
    process.env.UW_API_KEY = 'uwkey';

    stubUw({
      spot: [makeSpotRow({ price: '5800' })],
      pages: [
        [
          makeStrikeRow({ strike: '4000' }),
          makeStrikeRow({ strike: '7000' }),
          makeStrikeRow({ strike: '3500' }),
        ],
      ],
    });

    const res = mockResponse();
    await handler(cronRequest(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: false,
      skipped: true,
      reason: 'outside_window',
      rows: 3,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_strike_all.outside_window_skip',
    );
  });
});
