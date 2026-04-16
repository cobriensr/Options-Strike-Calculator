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
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([]));
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

  it('fetches all 4 symbols in parallel, stores bars, and returns 200', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([makeCandle()]));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(schwabFetch).toHaveBeenCalledTimes(4);

    // Verify each of the four symbols was requested
    const calledUrls = vi
      .mocked(schwabFetch)
      .mock.calls.map((c) => c[0] as string);
    for (const sym of ['%24TICK', '%24ADD', '%24VOLD', '%24TRIN']) {
      expect(calledUrls.some((u) => u.includes(`symbol=${sym}`))).toBe(true);
    }

    const body = res._json as Record<string, unknown>;
    expect(body).toMatchObject({
      job: 'fetch-market-internals',
      success: true,
      fetched: 4,
      stored: 4,
      skipped: 0,
      failureCount: 0,
      successCount: 4,
    });
  });

  // ── Per-symbol failure ─────────────────────────────────────

  it('records partial success when one symbol fails (other 3 succeed)', async () => {
    vi.mocked(schwabFetch)
      .mockResolvedValueOnce(schwabOk([makeCandle()])) // $TICK
      .mockResolvedValueOnce(schwabOk([makeCandle()])) // $ADD
      .mockRejectedValueOnce(new Error('Schwab timeout')) // $VOLD
      .mockResolvedValueOnce(schwabOk([makeCandle()])); // $TRIN

    // withRetry should actually throw through for the failing one;
    // default implementation (fn => fn()) will surface the rejection
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
      fetched: 3,
      stored: 3,
      successCount: 3,
      failureCount: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── Extended-hours filter ──────────────────────────────────

  it('drops bars outside 9:30-16:00 ET before insert', async () => {
    // Three bars per symbol: pre-market (09:25 ET), regular (10:00 ET),
    // and post-market (16:05 ET). Only the middle one should be stored.
    const preMarketMs = Date.parse('2026-03-24T13:25:00.000Z'); // 09:25 ET
    const regularMs = Date.parse('2026-03-24T14:00:00.000Z'); // 10:00 ET
    const postMarketMs = Date.parse('2026-03-24T20:05:00.000Z'); // 16:05 ET

    vi.mocked(schwabFetch).mockResolvedValue(
      schwabOk([
        makeCandle({ datetime: preMarketMs }),
        makeCandle({ datetime: regularMs }),
        makeCandle({ datetime: postMarketMs }),
      ]),
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
    // 3 bars per symbol × 4 symbols = 12 fetched, 2 filtered each = 8 dropped,
    // 1 kept per symbol = 4 stored
    expect(body.fetched).toBe(12);
    expect(body.filtered).toBe(8);
    expect(body.stored).toBe(4);
  });

  it('accepts bars at the exact session boundaries (9:30 and 16:00 ET)', async () => {
    const open930 = Date.parse('2026-03-24T13:30:00.000Z'); // 09:30 ET
    const close1600 = Date.parse('2026-03-24T20:00:00.000Z'); // 16:00 ET

    vi.mocked(schwabFetch).mockResolvedValue(
      schwabOk([
        makeCandle({ datetime: open930 }),
        makeCandle({ datetime: close1600 }),
      ]),
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
    // 2 bars × 4 symbols = 8 fetched, 0 filtered, 8 stored
    expect(body.fetched).toBe(8);
    expect(body.filtered).toBe(0);
    expect(body.stored).toBe(8);
  });

  // ── DB transaction failure ─────────────────────────────────

  it('degrades gracefully when transaction fails for every symbol', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([makeCandle()]));
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
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([makeCandle()]));

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
    // 3 candles per symbol × 4 symbols = 12 stored
    vi.mocked(schwabFetch).mockResolvedValue(
      schwabOk([
        makeCandle({ datetime: Date.parse('2026-03-24T14:30:00.000Z') }),
        makeCandle({ datetime: Date.parse('2026-03-24T14:31:00.000Z') }),
        makeCandle({ datetime: Date.parse('2026-03-24T14:32:00.000Z') }),
      ]),
    );

    // Direct sql call for the QC SELECT returns counts
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join('');
      if (q.includes('SELECT COUNT')) {
        return Promise.resolve([{ total: 12, nonzero: 12 }]);
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
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([makeCandle()]));

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

  it('returns 200 with zero counts when Schwab returns no candles', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([]));

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
      fetched: 0,
      filtered: 0,
      stored: 0,
      skipped: 0,
      failureCount: 0,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Schwab fetch params ────────────────────────────────────

  it('sends needExtendedHoursData=false and the 90-minute window', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(schwabOk([]));

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const firstUrl = vi.mocked(schwabFetch).mock.calls[0]![0] as string;
    expect(firstUrl).toContain('needExtendedHoursData=false');
    expect(firstUrl).toContain('periodType=day');
    expect(firstUrl).toContain('frequencyType=minute');
    expect(firstUrl).toContain('frequency=1');

    // Parse startDate/endDate and check the delta is 90 minutes
    const url = new URL(`https://example.com/${firstUrl}`);
    const startDate = Number.parseInt(
      url.searchParams.get('startDate') ?? '0',
      10,
    );
    const endDate = Number.parseInt(url.searchParams.get('endDate') ?? '0', 10);
    expect(endDate - startDate).toBe(90 * 60 * 1000);
  });
});
