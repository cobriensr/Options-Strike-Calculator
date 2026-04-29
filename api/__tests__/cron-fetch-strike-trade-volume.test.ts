// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
  transaction: vi.fn(),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  mapWithConcurrency: vi.fn(
    async <T, R>(
      items: readonly T[],
      _limit: number,
      worker: (item: T, idx: number) => Promise<R>,
    ) => Promise.all(items.map((it, i) => worker(it, i))),
  ),
  cronGuard: vi.fn((req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'GET only' });
      return null;
    }
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    if (!process.env.UW_API_KEY) {
      res.status(500).json({ error: 'UW_API_KEY missing' });
      return null;
    }
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const isMarketHours =
      utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour <= 21;
    if (!isMarketHours) {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    }
    return {
      apiKey: process.env.UW_API_KEY,
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

import handler from '../cron/fetch-strike-trade-volume.js';
import { uwFetch } from '../_lib/api-helpers.js';

const MARKET_TIME = new Date('2026-04-24T14:30:00.000Z');
const OFF_HOURS_TIME = new Date('2026-04-24T11:00:00.000Z');

interface UwRow {
  ticker: string;
  strike: string;
  timestamp: string;
  call_volume: string;
  call_volume_ask_side: string;
  call_volume_bid_side: string;
  put_volume: string;
  put_volume_ask_side: string;
  put_volume_bid_side: string;
}

function makeRow(over: Partial<UwRow> = {}): UwRow {
  return {
    ticker: 'SPX',
    strike: '7100',
    timestamp: '2026-04-24T14:30:00Z',
    call_volume: '100',
    call_volume_ask_side: '60',
    call_volume_bid_side: '40',
    put_volume: '50',
    put_volume_ask_side: '20',
    put_volume_bid_side: '30',
    ...over,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('fetch-strike-trade-volume handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    process.env.UW_API_KEY = 'test-uw-key';
    mockSql.transaction.mockImplementation(
      async (cb: (txn: typeof mockSql) => Promise<unknown[]>[]) => {
        const txn = Object.assign(vi.fn().mockResolvedValue([{ id: 1 }]), {
          transaction: vi.fn(),
        });
        const promises = cb(txn);
        return Promise.all(promises);
      },
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(uwFetch).not.toHaveBeenCalled();
  });

  it('skips outside market hours without calling UW', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(uwFetch).not.toHaveBeenCalled();
  });

  it('inserts split call/put rows for the latest minute per strike', async () => {
    const mocked = vi.mocked(uwFetch);
    mocked.mockReset();
    // 14 tickers — first one (SPXW → SPX) gets a real response, the rest empty
    mocked.mockResolvedValueOnce([
      makeRow({ strike: '7100', timestamp: '2026-04-24T14:29:00Z' }),
      makeRow({
        strike: '7100',
        timestamp: '2026-04-24T14:30:00Z',
        call_volume: '200',
        call_volume_ask_side: '150',
        call_volume_bid_side: '50',
        put_volume: '0',
        put_volume_ask_side: '0',
        put_volume_bid_side: '0',
      }),
    ]);
    for (let i = 0; i < 13; i += 1) mocked.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{ ticker: string; rowsInserted: number }>;
    };
    // Latest minute for strike 7100 has call_volume=200, put_volume=0 → 1 call row
    expect(body.totalInserted).toBe(1);
    const spxw = body.results.find((r) => r.ticker === 'SPXW');
    expect(spxw?.rowsInserted).toBe(1);
  });

  it('continues when one ticker errors', async () => {
    const mocked = vi.mocked(uwFetch);
    mocked.mockReset();
    mocked.mockRejectedValueOnce(new Error('UW timeout'));
    for (let i = 0; i < 13; i += 1) mocked.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      results: Array<{ ticker: string; skipped: boolean; reason?: string }>;
    };
    const spxw = body.results.find((r) => r.ticker === 'SPXW');
    expect(spxw).toMatchObject({ skipped: true, reason: 'exception' });
    // Other 13 tickers got empty arrays → empty_flow skip
    const skipped = body.results.filter((r) => r.skipped);
    expect(skipped).toHaveLength(14);
  });

  it('returns empty-flow when UW returns []', async () => {
    const mocked = vi.mocked(uwFetch);
    mocked.mockReset();
    for (let i = 0; i < 14; i += 1) mocked.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      totalInserted: number;
      results: Array<{ ticker: string; reason?: string }>;
    };
    expect(body.totalInserted).toBe(0);
    expect(body.results.every((r) => r.reason === 'empty_flow')).toBe(true);
  });

  it('skips strikes with zero call AND zero put volume', async () => {
    const mocked = vi.mocked(uwFetch);
    mocked.mockReset();
    mocked.mockResolvedValueOnce([
      makeRow({
        strike: '7000',
        call_volume: '0',
        call_volume_ask_side: '0',
        call_volume_bid_side: '0',
        put_volume: '0',
        put_volume_ask_side: '0',
        put_volume_bid_side: '0',
      }),
    ]);
    for (let i = 0; i < 13; i += 1) mocked.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    const body = res._json as { totalInserted: number };
    expect(body.totalInserted).toBe(0);
  });

  it('inserts both call and put rows when both have non-zero volume', async () => {
    const mocked = vi.mocked(uwFetch);
    mocked.mockReset();
    mocked.mockResolvedValueOnce([
      makeRow({ strike: '7100' }), // both call_volume=100 and put_volume=50
    ]);
    for (let i = 0; i < 13; i += 1) mocked.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    const body = res._json as { totalInserted: number };
    expect(body.totalInserted).toBe(2); // 1 call + 1 put
  });
});
