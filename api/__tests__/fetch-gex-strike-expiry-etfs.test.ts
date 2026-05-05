// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockQuery = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
  query: typeof mockQuery;
};
mockSql.transaction = mockTransaction;
mockSql.query = mockQuery;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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
    increment: vi.fn(),
  },
}));

import handler from '../cron/fetch-gex-strike-expiry-etfs.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET (14:00 UTC)
const MARKET_TIME = new Date('2026-05-06T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET (10:00 UTC)
const OFF_HOURS_TIME = new Date('2026-05-06T10:00:00.000Z');

// today in ET for MARKET_TIME: 2026-05-06 (Tuesday)
const TODAY = '2026-05-06';

function makeStrikeRow(
  overrides: Partial<{
    strike: string;
    price: string;
    time: string;
  }> = {},
) {
  return {
    strike: '590',
    price: '590.5',
    time: '2026-05-06T14:30:00Z',
    call_gamma_oi: '100000',
    put_gamma_oi: '-80000',
    call_gamma_vol: '50000',
    put_gamma_vol: '-40000',
    call_gamma_ask: '60000',
    call_gamma_bid: '45000',
    put_gamma_ask: '-30000',
    put_gamma_bid: '-25000',
    call_charm_oi: '5000',
    put_charm_oi: '-4000',
    call_charm_vol: '2500',
    put_charm_vol: '-2000',
    call_charm_ask: '3000',
    call_charm_bid: '2200',
    put_charm_ask: '-1500',
    put_charm_bid: '-1200',
    call_vanna_oi: '2000',
    put_vanna_oi: '-1500',
    call_vanna_vol: '1000',
    put_vanna_vol: '-800',
    call_vanna_ask: '1200',
    call_vanna_bid: '900',
    put_vanna_ask: '-600',
    put_vanna_bid: '-500',
    ...overrides,
  };
}

/**
 * Build a per-URL dispatch fetch mock. Given a map of URL-substring →
 * response factory, returns a mock that routes each call to the matching
 * factory. Falls back to empty data for unmatched calls.
 *
 * This is necessary because Promise.allSettled launches all 3 ticker
 * tasks concurrently, so the preflight calls for SPY/QQQ/NDX are all
 * dispatched before any main call — the actual call order is
 * [SPY-pre, QQQ-pre, NDX-pre, SPY-main, QQQ-main, NDX-main] due to
 * microtask interleaving. Sequential mockResolvedValueOnce cannot model
 * that reliably.
 */
function makeRoutedFetchMock(
  routes: Record<
    string,
    () => Promise<{
      ok: boolean;
      json?: () => Promise<unknown>;
      status?: number;
      text?: () => Promise<string>;
    }>
  >,
) {
  return vi.fn().mockImplementation((url: string) => {
    for (const [key, factory] of Object.entries(routes)) {
      if (url.includes(key)) return factory();
    }
    // Default: empty data
    return Promise.resolve({
      ok: true,
      json: async () => ({ data: [] }),
    });
  });
}

/**
 * Default mock query implementation: every submitted row is treated as a
 * fresh insert (was_insert = true). Interprets params as 30-column rows.
 */
function defaultQueryMock(
  _text: string,
  params: unknown[] = [],
): Promise<{ was_insert: boolean }[]> {
  const COLUMNS_PER_ROW = 30;
  const rowCount = Math.floor(params.length / COLUMNS_PER_ROW);
  return Promise.resolve(
    Array.from({ length: rowCount }, () => ({ was_insert: true })),
  );
}

describe('fetch-gex-strike-expiry-etfs handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockSql.transaction = mockTransaction;
    mockSql.query = mockQuery;
    mockQuery.mockImplementation(defaultQueryMock);
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
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  // ── Market hours gate ────────────────────────────────────

  it('returns 200 skipped when outside market hours', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── Missing API key ──────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path: all tickers succeed ─────────────────────

  it('fetches SPY, QQQ, NDX and returns 200 success with 3 stored rows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [makeStrikeRow({ price: '590.5' })] }),
        }),
        '/QQQ/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '480.2' }] }),
        }),
        '/QQQ/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({
            data: [makeStrikeRow({ strike: '480', price: '480.2' })],
          }),
        }),
        '/NDX/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '20500' }] }),
        }),
        '/NDX/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({
            data: [makeStrikeRow({ strike: '20500', price: '20500' })],
          }),
        }),
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-gex-strike-expiry-etfs',
      status: 'success',
      rows: 3,
    });
    // withCronInstrumentation spreads metadata as top-level keys
    const body = res._json as {
      tickers: Array<{ ticker: string; stored: number }>;
      failureCount: number;
    };
    expect(body.failureCount).toBe(0);
    expect(body.tickers).toHaveLength(3);
    for (const t of body.tickers) {
      expect(t.stored).toBe(1);
    }
    // 3 INSERT calls — one per ticker
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  // ── Promise.allSettled fault isolation ───────────────────

  it('returns partial when one ticker fails and others succeed', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: false as const,
          status: 500,
          text: async () => 'Internal server error',
        }),
        '/QQQ/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '480.2' }] }),
        }),
        '/QQQ/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({
            data: [makeStrikeRow({ strike: '480', price: '480.2' })],
          }),
        }),
        '/NDX/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '20500' }] }),
        }),
        '/NDX/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({
            data: [makeStrikeRow({ strike: '20500', price: '20500' })],
          }),
        }),
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'partial' });
    // withCronInstrumentation spreads metadata as top-level keys
    const body = res._json as {
      tickers: Array<{ ticker: string; stored: number; error?: string }>;
      failureCount: number;
      totalStored: number;
    };
    expect(body.failureCount).toBe(1);
    expect(body.totalStored).toBe(2);

    const spyResult = body.tickers.find((t) => t.ticker === 'SPY');
    expect(spyResult).toBeDefined();
    expect(spyResult!.error).toBeDefined();

    const qqqResult = body.tickers.find((t) => t.ticker === 'QQQ');
    expect(qqqResult?.stored).toBe(1);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns error status when all tickers fail', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: false as const,
        status: 500,
        text: async () => 'Internal server error',
      })),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // withCronInstrumentation spreads metadata as top-level keys
    expect(res._json).toMatchObject({ status: 'error' });
    const body = res._json as { failureCount: number };
    expect(body.failureCount).toBe(3);
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
  });

  // ── Empty UW response ────────────────────────────────────

  it('returns success with 0 stored when UW returns empty data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── UPSERT shape verification ────────────────────────────

  it('uses correct 30-column UPSERT with field rename and ts_minute truncation', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeStrikeRow({
      strike: '590',
      price: '590.5',
      time: '2026-05-06T14:32:47Z',
    });

    // SPY has data; QQQ and NDX return empty so we get exactly 1 INSERT
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [row] }),
        }),
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Exactly one INSERT call (SPY only — QQQ and NDX returned empty)
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [text, params] = mockQuery.mock.calls[0]!;
    expect(typeof text).toBe('string');
    expect(text).toMatch(/INSERT INTO ws_gex_strike_expiry/);
    expect(text).toMatch(
      /ON CONFLICT \(ticker, expiry, strike, ts_minute\) DO UPDATE/,
    );
    // 30 columns per row: 5 key fields + 12 OI/vol + 12 ask/bid-vol + raw_payload
    expect(Array.isArray(params)).toBe(true);
    expect((params as unknown[]).length).toBe(30);

    const p = params as unknown[];
    // Col 1: ticker
    expect(p[0]).toBe('SPY');
    // Col 2: expiry (today for SPY)
    expect(p[1]).toBe(TODAY);
    // Col 3: strike
    expect(p[2]).toBe(row.strike);
    // Col 4: ts_minute — truncated to minute (14:32:00Z from 14:32:47Z)
    expect(p[3]).toBe('2026-05-06T14:32:00.000Z');
    // Col 5: price
    expect(p[4]).toBe(row.price);
    // Cols 6–17: OI and vol greeks (in schema order)
    expect(p[5]).toBe(row.call_gamma_oi);
    expect(p[6]).toBe(row.put_gamma_oi);
    expect(p[7]).toBe(row.call_charm_oi);
    expect(p[8]).toBe(row.put_charm_oi);
    expect(p[9]).toBe(row.call_vanna_oi);
    expect(p[10]).toBe(row.put_vanna_oi);
    expect(p[11]).toBe(row.call_gamma_vol);
    expect(p[12]).toBe(row.put_gamma_vol);
    expect(p[13]).toBe(row.call_charm_vol);
    expect(p[14]).toBe(row.put_charm_vol);
    expect(p[15]).toBe(row.call_vanna_vol);
    expect(p[16]).toBe(row.put_vanna_vol);
    // Cols 18–29: ask/bid vol — REST field name (no _vol) → DB column (_vol suffix)
    expect(p[17]).toBe(row.call_gamma_ask); // call_gamma_ask_vol
    expect(p[18]).toBe(row.call_gamma_bid); // call_gamma_bid_vol
    expect(p[19]).toBe(row.put_gamma_ask); // put_gamma_ask_vol
    expect(p[20]).toBe(row.put_gamma_bid); // put_gamma_bid_vol
    expect(p[21]).toBe(row.call_charm_ask); // call_charm_ask_vol
    expect(p[22]).toBe(row.call_charm_bid); // call_charm_bid_vol
    expect(p[23]).toBe(row.put_charm_ask); // put_charm_ask_vol
    expect(p[24]).toBe(row.put_charm_bid); // put_charm_bid_vol
    expect(p[25]).toBe(row.call_vanna_ask); // call_vanna_ask_vol
    expect(p[26]).toBe(row.call_vanna_bid); // call_vanna_bid_vol
    expect(p[27]).toBe(row.put_vanna_ask); // put_vanna_ask_vol
    expect(p[28]).toBe(row.put_vanna_bid); // put_vanna_bid_vol
    // Col 30 (index 29): raw_payload — stringified JSON of the original REST row
    expect(typeof p[29]).toBe('string');
    const rawParsed = JSON.parse(p[29] as string) as typeof row;
    expect(rawParsed.strike).toBe(row.strike);
  });

  // ── ATM filter ───────────────────────────────────────────

  it('filters strikes outside the ATM window before inserting', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // SPY spot = 590.5, ATM_RANGE = 20 → window [570.5, 610.5]
    // Strike 590 is inside, strike 620 is outside
    const inWindow = makeStrikeRow({ strike: '590', price: '590.5' });
    const outOfWindow = makeStrikeRow({ strike: '620', price: '590.5' });

    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [inWindow, outOfWindow] }),
        }),
      }),
    );

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Exactly one INSERT for SPY, and only the in-window strike (30 params = 1 row)
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0]!;
    expect((params as unknown[]).length).toBe(30);
    // The inserted strike should be 590, not 620
    expect((params as unknown[])[2]).toBe('590');
  });

  // ── NDX expiry policy ────────────────────────────────────

  it('uses front monthly expiry for NDX (not today)', async () => {
    // 2026-05-06 is a Tuesday. The 3rd Friday of May 2026 is 2026-05-15.
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      mockResponse(),
    );

    // Find the NDX expiry-strike main call
    const ndxMainCalls = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/NDX/') &&
        (call[0] as string).includes('expiry-strike'),
    );
    expect(ndxMainCalls.length).toBeGreaterThan(0);
    const ndxUrl = ndxMainCalls[0]![0] as string;
    // Should reference the 3rd Friday of May 2026, not TODAY
    expect(ndxUrl).toContain('2026-05-15');
    expect(ndxUrl).not.toContain(TODAY);
  });

  // ── Preflight fallback ────────────────────────────────────

  it('falls back to unbounded call when spot preflight returns empty', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [] }), // empty — no spot price
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({
            data: [makeStrikeRow({ price: '590.5' })],
          }),
        }),
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // The SPY main call should not have min_strike/max_strike
    const spyMainCalls = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/SPY/spot-exposures/expiry-strike'),
    );
    expect(spyMainCalls.length).toBeGreaterThan(0);
    const spyMainUrl = spyMainCalls[0]![0] as string;
    expect(spyMainUrl).not.toContain('min_strike');
    expect(spyMainUrl).not.toContain('max_strike');
  });

  // ── DB batch error ────────────────────────────────────────

  it('returns stored=0 for a ticker when its batch insert throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [makeStrikeRow({ price: '590.5' })] }),
        }),
      }),
    );

    // SPY INSERT fails
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    // storeStrikes catches the error and returns {stored: 0, skipped: N}
    // so the ticker doesn't throw — the handler still returns 200 success
    expect(res._status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), ticker: 'SPY' }),
      'fetch-gex-strike-expiry-etfs: batch insert failed',
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    // withCronInstrumentation spreads metadata as top-level keys
    expect(res._json).toMatchObject({ rows: 0, status: 'success' });
  });

  // ── Min strike / max strike in UW call ──────────────────

  it('includes min_strike and max_strike in the SPY main UW call when spot is known', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/SPY/spot-exposures/strike')) {
        return { ok: true, json: async () => ({ data: [{ price: '590.5' }] }) };
      }
      // everything else: empty
      return { ok: true, json: async () => ({ data: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      mockResponse(),
    );

    // Find the SPY expiry-strike main call
    const spyMainCalls = fetchMock.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/SPY/spot-exposures/expiry-strike'),
    );
    expect(spyMainCalls.length).toBeGreaterThan(0);
    const spyMainUrl = spyMainCalls[0]![0] as string;
    // spot=590.5, ATM_RANGE=20 → min=floor(570.5)=570, max=ceil(610.5)=611
    expect(spyMainUrl).toContain('min_strike=570');
    expect(spyMainUrl).toContain('max_strike=611');
  });

  // ── Deadlock retry ───────────────────────────────────────

  it('retries once on Postgres 40P01 deadlock and succeeds', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [makeStrikeRow({ price: '590.5' })] }),
        }),
      }),
    );

    // First call: simulate a Neon deadlock; second call: success.
    const deadlockErr = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    mockQuery
      .mockRejectedValueOnce(deadlockErr)
      .mockImplementationOnce(defaultQueryMock);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // SPY retried (2 calls), QQQ + NDX returned no data → no insert.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'SPY', code: '40P01', attempt: 1 }),
      'fetch-gex-strike-expiry-etfs: lock conflict, retrying',
    );
    // The retry succeeded, so no Sentry capture.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('captures and skips when deadlock persists across retries', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: [makeStrikeRow({ price: '590.5' })] }),
        }),
      }),
    );

    const deadlockErr = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    mockQuery
      .mockRejectedValueOnce(deadlockErr)
      .mockRejectedValueOnce(deadlockErr);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(deadlockErr);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  // ── Deterministic strike ordering ─────────────────────────

  it('sorts strikes ascending by numeric value before INSERT', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // UW returns strikes out of order; the cron must sort them so it
    // and the uw-stream daemon acquire row locks in the same sequence.
    const rows = [
      makeStrikeRow({ strike: '600', price: '590.5' }),
      makeStrikeRow({ strike: '585', price: '590.5' }),
      makeStrikeRow({ strike: '595', price: '590.5' }),
    ];
    vi.stubGlobal(
      'fetch',
      makeRoutedFetchMock({
        '/SPY/spot-exposures/strike': async () => ({
          ok: true,
          json: async () => ({ data: [{ price: '590.5' }] }),
        }),
        '/SPY/spot-exposures/expiry-strike': async () => ({
          ok: true,
          json: async () => ({ data: rows }),
        }),
      }),
    );

    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      mockResponse(),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // 30 columns per row, strike is column index 2 within each row.
    const strikes = [p[2], p[2 + 30], p[2 + 60]];
    expect(strikes).toEqual(['585', '595', '600']);
  });
});
