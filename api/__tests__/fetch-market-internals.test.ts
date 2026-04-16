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
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: vi.fn(),
  cronGuard: vi.fn(),
  checkDataQuality: vi.fn(),
  withRetry: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/fetch-market-internals.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import {
  schwabFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';

// Fixed "market hours" time: Tuesday 10:00 AM ET = 14:00 UTC
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const TODAY = '2026-03-24';

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

function makeCandle(overrides: Partial<SchwabCandle> = {}): SchwabCandle {
  return {
    open: 250,
    high: 350,
    low: 100,
    close: 280,
    volume: 0,
    // 14:30 UTC = 9:30 AM ET (start of regular session on 2026-03-24)
    datetime: Date.parse('2026-03-24T14:30:00.000Z'),
    ...overrides,
  };
}

function schwabOk(candles: SchwabCandle[]) {
  return {
    ok: true as const,
    data: { symbol: '$TICK', empty: candles.length === 0, candles },
  };
}

function quotesOk(addPrice: number, voldPrice: number) {
  return {
    ok: true as const,
    data: {
      '$ADD': { quote: { lastPrice: addPrice } },
      '$VOLD': { quote: { lastPrice: voldPrice } },
    },
  };
}

function quotesError(status = 401, error = 'Unauthorized') {
  return { ok: false as const, status, error };
}

/**
 * Route-aware schwabFetch mock: inspects the URL to return the correct
 * response shape for pricehistory vs quotes endpoints.
 */
function mockSchwabFetchHappy(
  candles: SchwabCandle[],
  addPrice = 1200,
  voldPrice = 150_000_000,
) {
  vi.mocked(schwabFetch).mockImplementation((url: string) => {
    if (url.includes('pricehistory')) {
      return Promise.resolve(schwabOk(candles));
    }
    if (url.includes('quotes')) {
      return Promise.resolve(quotesOk(addPrice, voldPrice));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

describe('fetch-market-internals handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
    // Default: transaction returns one RETURNING row per insert (all stored)
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ ts: 'x' }]);
      },
    );
    process.env = { ...originalEnv };
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';

    vi.mocked(withRetry).mockImplementation((fn: () => Promise<unknown>) =>
      fn(),
    );
    vi.mocked(cronGuard).mockReturnValue({ apiKey: '', today: TODAY });
    // Default mock: pricehistory returns empty candles, quotes return prices
    mockSchwabFetchHappy([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is missing', async () => {
    vi.mocked(cronGuard).mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET is wrong', async () => {
    vi.mocked(cronGuard).mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer wrong' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  // ── Happy path ─────────────────────────────────────────────

  it('fetches pricehistory for $TICK/$TRIN and quotes for $ADD/$VOLD, stores bars, and returns 200', async () => {
    mockSchwabFetchHappy([makeCandle()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);

    // 2 pricehistory calls + 1 quotes call = 3 total
    expect(schwabFetch).toHaveBeenCalledTimes(3);

    const calledUrls = vi
      .mocked(schwabFetch)
      .mock.calls.map((c) => c[0] as string);

    // Two pricehistory URLs containing $TICK and $TRIN
    const pricehistoryUrls = calledUrls.filter((u) =>
      u.includes('pricehistory'),
    );
    expect(pricehistoryUrls).toHaveLength(2);
    expect(
      pricehistoryUrls.some((u) => u.includes('%24TICK')),
    ).toBe(true);
    expect(
      pricehistoryUrls.some((u) => u.includes('%24TRIN')),
    ).toBe(true);

    // One quotes URL containing both $ADD and $VOLD
    const quotesUrls = calledUrls.filter((u) => u.includes('quotes'));
    expect(quotesUrls).toHaveLength(1);
    expect(quotesUrls[0]).toContain('%24ADD');
    expect(quotesUrls[0]).toContain('%24VOLD');

    const body = res._json as Record<string, unknown>;
    expect(body).toMatchObject({
      job: 'fetch-market-internals',
      success: true,
      // $TICK: 1 candle fetched, $TRIN: 1 candle fetched,
      // $ADD: 1 (quote snapshot), $VOLD: 1 (quote snapshot) = 4
      fetched: 4,
      stored: 4,
      skipped: 0,
      failureCount: 0,
      successCount: 4,
    });
  });

  // ── Partial failure: quotes endpoint fails ─────────────────

  it('records partial success when quotes call fails ($ADD/$VOLD error, $TICK/$TRIN succeed)', async () => {
    vi.mocked(schwabFetch).mockImplementation((url: string) => {
      if (url.includes('pricehistory')) {
        return Promise.resolve(schwabOk([makeCandle()]));
      }
      if (url.includes('quotes')) {
        return Promise.resolve(quotesError(500, 'Schwab timeout'));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body).toMatchObject({
      job: 'fetch-market-internals',
      success: true,
      successCount: 2,
      failureCount: 2,
    });
  });

  // ── Partial failure: one pricehistory symbol throws ────────

  it('records partial success when one pricehistory symbol fails', async () => {
    let tickCallCount = 0;
    vi.mocked(schwabFetch).mockImplementation((url: string) => {
      if (url.includes('pricehistory')) {
        tickCallCount++;
        // First pricehistory call ($TICK) succeeds, second ($TRIN) fails
        if (tickCallCount === 1) {
          return Promise.resolve(schwabOk([makeCandle()]));
        }
        return Promise.reject(new Error('Schwab timeout'));
      }
      if (url.includes('quotes')) {
        return Promise.resolve(quotesOk(1200, 150_000_000));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body).toMatchObject({
      job: 'fetch-market-internals',
      success: true,
      successCount: 3,
      failureCount: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── Extended-hours filter ──────────────────────────────────

  it('drops pricehistory bars outside 9:30-16:00 ET before insert', async () => {
    // Three bars per pricehistory symbol: pre-market (09:25 ET), regular
    // (10:00 ET), and post-market (16:05 ET). Only the middle one should
    // be stored for $TICK and $TRIN. $ADD/$VOLD come from quotes (no filter).
    const preMarketMs = Date.parse('2026-03-24T13:25:00.000Z'); // 09:25 ET
    const regularMs = Date.parse('2026-03-24T14:00:00.000Z'); // 10:00 ET
    const postMarketMs = Date.parse('2026-03-24T20:05:00.000Z'); // 16:05 ET

    mockSchwabFetchHappy([
      makeCandle({ datetime: preMarketMs }),
      makeCandle({ datetime: regularMs }),
      makeCandle({ datetime: postMarketMs }),
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    // Pricehistory: 3 bars × 2 symbols = 6 fetched, 2 filtered each = 4 dropped,
    // 1 kept per symbol = 2 stored from pricehistory
    // Quotes: 1 fetched each × 2 symbols = 2 fetched, 0 filtered, 2 stored
    // Totals: fetched=8, filtered=4, stored=4
    expect(body.fetched).toBe(8);
    expect(body.filtered).toBe(4);
    expect(body.stored).toBe(4);
  });

  it('accepts bars at the exact session boundaries (9:30 and 16:00 ET)', async () => {
    const open930 = Date.parse('2026-03-24T13:30:00.000Z'); // 09:30 ET
    const close1600 = Date.parse('2026-03-24T20:00:00.000Z'); // 16:00 ET

    mockSchwabFetchHappy([
      makeCandle({ datetime: open930 }),
      makeCandle({ datetime: close1600 }),
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    // Pricehistory: 2 bars × 2 symbols = 4 fetched, 0 filtered, 4 stored
    // Quotes: 1 each × 2 symbols = 2 fetched, 0 filtered, 2 stored
    // Totals: fetched=6, filtered=0, stored=6
    expect(body.fetched).toBe(6);
    expect(body.filtered).toBe(0);
    expect(body.stored).toBe(6);
  });

  // ── Synthesized flat bars from quotes ──────────────────────

  it('synthesizes flat bars from quotes for $ADD and $VOLD', async () => {
    const addPrice = 1200;
    const voldPrice = 150_000_000;
    mockSchwabFetchHappy([], addPrice, voldPrice);

    // Override transaction mock to capture calls
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ ts: 'x' }]);
      },
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
    const body = res._json as Record<string, unknown>;
    const results = body.results as Array<{
      symbol: string;
      stored: number;
      fetched: number;
    }>;

    // Find $ADD and $VOLD results
    const addResult = results.find((r) => r.symbol === '$ADD');
    const voldResult = results.find((r) => r.symbol === '$VOLD');
    expect(addResult).toBeDefined();
    expect(voldResult).toBeDefined();
    expect(addResult!.stored).toBe(1);
    expect(addResult!.fetched).toBe(1);
    expect(voldResult!.stored).toBe(1);
    expect(voldResult!.fetched).toBe(1);

    // Verify the quotes call was made (the handler builds flat bars internally)
    const calledUrls = vi
      .mocked(schwabFetch)
      .mock.calls.map((c) => c[0] as string);
    const quotesUrl = calledUrls.find((u) => u.includes('quotes'));
    expect(quotesUrl).toBeDefined();
    expect(quotesUrl).toContain('%24ADD');
    expect(quotesUrl).toContain('%24VOLD');

    // Verify flat bar shape by checking the transaction was called for each
    // quote symbol — storeBars receives rows where open=high=low=close=price.
    // We verify indirectly: 2 transaction calls (one per quote symbol), each
    // with 1 row. The handler's storeBars passes a single-element array.
    // Since pricehistory returned [] (no candles), the only transactions
    // are for the quote symbols.
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  // ── DB transaction failure ─────────────────────────────────

  it('degrades gracefully when transaction fails for every symbol', async () => {
    mockSchwabFetchHappy([makeCandle()]);
    mockTransaction.mockRejectedValue(new Error('DB batch insert failed'));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    // Fetched 4, stored 0, all 4 symbols reported as failure
    expect(body).toMatchObject({
      stored: 0,
      successCount: 0,
      failureCount: 4,
    });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // ── Idempotence: ON CONFLICT ───────────────────────────────

  it('counts duplicates as skipped (RETURNING empty rows)', async () => {
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []); // no RETURNING → duplicate
      },
    );
    mockSchwabFetchHappy([makeCandle()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.stored).toBe(0);
    expect(body.skipped).toBe(4);
  });

  // ── Data quality check ─────────────────────────────────────

  it('runs checkDataQuality when stored > 10', async () => {
    // Need >10 stored total. 6 candles per pricehistory symbol × 2 = 12,
    // plus 2 from quotes = 14 stored total (>10).
    const candles = Array.from({ length: 6 }, (_, i) =>
      makeCandle({
        datetime: Date.parse('2026-03-24T14:30:00.000Z') + i * 60_000,
      }),
    );
    mockSchwabFetchHappy(candles);

    // Direct sql call for the QC SELECT returns counts
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join('');
      if (q.includes('SELECT COUNT')) {
        return Promise.resolve([{ total: 14, nonzero: 14 }]);
      }
      return Promise.resolve([]);
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(vi.mocked(checkDataQuality)).toHaveBeenCalledWith(
      expect.objectContaining({
        job: 'fetch-market-internals',
        table: 'market_internals',
        date: TODAY,
      }),
    );
  });

  it('skips checkDataQuality when stored <= 10', async () => {
    mockSchwabFetchHappy([makeCandle()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(vi.mocked(checkDataQuality)).not.toHaveBeenCalled();
  });

  // ── Empty response ─────────────────────────────────────────

  it('returns 200 with zero counts when Schwab returns no candles and no valid quotes', async () => {
    // Pricehistory returns empty candles; quotes return prices though,
    // so $ADD/$VOLD will still produce 1 bar each.
    // To get truly zero, we need quotes to also return no valid price.
    vi.mocked(schwabFetch).mockImplementation((url: string) => {
      if (url.includes('pricehistory')) {
        return Promise.resolve(schwabOk([]));
      }
      if (url.includes('quotes')) {
        return Promise.resolve({
          ok: true,
          data: {
            '$ADD': { quote: {} },
            '$VOLD': { quote: {} },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    // $TICK/$TRIN: fetched=0 each. $ADD/$VOLD: fetched=1 each but no valid
    // price → error result with stored=0. failureCount=2 for the quotes.
    expect(body.stored).toBe(0);
    expect(body.skipped).toBe(0);
    // No transaction calls because pricehistory had no bars and quotes
    // had no valid prices
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Schwab fetch params ────────────────────────────────────

  it('sends needExtendedHoursData=false and the 90-minute window for pricehistory', async () => {
    mockSchwabFetchHappy([]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);

    const calledUrls = vi
      .mocked(schwabFetch)
      .mock.calls.map((c) => c[0] as string);
    const pricehistoryUrl = calledUrls.find((u) =>
      u.includes('pricehistory'),
    )!;

    expect(pricehistoryUrl).toContain('needExtendedHoursData=false');
    expect(pricehistoryUrl).toContain('periodType=day');
    expect(pricehistoryUrl).toContain('frequencyType=minute');
    expect(pricehistoryUrl).toContain('frequency=1');

    // Parse startDate/endDate and check the delta is 90 minutes
    const url = new URL(`https://example.com/${pricehistoryUrl}`);
    const startDate = Number.parseInt(
      url.searchParams.get('startDate') ?? '0',
      10,
    );
    const endDate = Number.parseInt(
      url.searchParams.get('endDate') ?? '0',
      10,
    );
    expect(endDate - startDate).toBe(90 * 60 * 1000);
  });
});
