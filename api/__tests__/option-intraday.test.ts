// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
const mockUwFetch = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/uw-fetch.js', () => ({
  uwFetch: mockUwFetch,
  // Pass-through retry — runs the inner fn once for tests.
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchAndCacheOptionIntraday, deriveMid } =
  await import('../_lib/option-intraday.js');

describe('deriveMid', () => {
  it('returns synthetic NBBO mid when both sides have volume', () => {
    // ask: $30.20 (3020/100), bid: $30.00 (3000/100), mid = 30.10
    const mid = deriveMid({
      premiumAskSide: 3020,
      premiumBidSide: 3000,
      volumeAskSide: 100,
      volumeBidSide: 100,
      high: 30.5,
      low: 29.5,
      closePrice: 30.05,
      avgPrice: 30.1,
    });
    expect(mid).toBeCloseTo(30.1, 5);
  });

  it('falls back to (high+low)/2 when one side has no volume', () => {
    const mid = deriveMid({
      premiumAskSide: 100,
      premiumBidSide: null,
      volumeAskSide: 5,
      volumeBidSide: 0,
      high: 1.4,
      low: 1.0,
      closePrice: 1.2,
      avgPrice: 1.15,
    });
    expect(mid).toBe(1.2);
  });

  it('falls back to close when both sides + range are missing', () => {
    const mid = deriveMid({
      premiumAskSide: null,
      premiumBidSide: null,
      volumeAskSide: 0,
      volumeBidSide: 0,
      high: null,
      low: null,
      closePrice: 0.5,
      avgPrice: 0.55,
    });
    expect(mid).toBe(0.5);
  });

  it('returns null when no field is available', () => {
    const mid = deriveMid({
      premiumAskSide: null,
      premiumBidSide: null,
      volumeAskSide: null,
      volumeBidSide: null,
      high: null,
      low: null,
      closePrice: null,
      avgPrice: null,
    });
    expect(mid).toBeNull();
  });
});

describe('fetchAndCacheOptionIntraday', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits to cache when fetches table has status=ok', async () => {
    // Cache check returns a hit.
    mockSql.mockResolvedValueOnce([{ status: 'ok' }]);
    // readCached SELECT returns one cached minute.
    mockSql.mockResolvedValueOnce([
      {
        ts: new Date('2026-05-02T15:00:00Z'),
        avg_price: '1.05',
        close_price: '1.06',
        high_price: '1.10',
        low_price: '1.00',
        premium_ask_side: '110',
        premium_bid_side: '100',
        volume_ask_side: 100,
        volume_bid_side: 100,
      },
    ]);

    const result = await fetchAndCacheOptionIntraday(
      'KEY',
      'SPY260502C00500000',
      '2026-05-02',
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.mid).toBeCloseTo(1.05, 4);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('fetches + caches on miss', async () => {
    mockSql.mockResolvedValueOnce([]); // cache miss
    mockUwFetch.mockResolvedValueOnce([
      {
        start_time: '2026-05-02T15:00:00.000Z',
        avg_price: '1.05',
        close: '1.06',
        high: '1.10',
        low: '1.00',
        premium_ask_side: '110',
        premium_bid_side: '100',
        volume_ask_side: 100,
        volume_bid_side: 100,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // persistRows INSERT
    mockSql.mockResolvedValueOnce([]); // recordFetch INSERT

    const result = await fetchAndCacheOptionIntraday(
      'KEY',
      'SPY260502C00500000',
      '2026-05-02',
    );

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]!.mid).toBeCloseTo(1.05, 4);
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('records error tombstone when UW fetch fails', async () => {
    mockSql.mockResolvedValueOnce([]); // cache miss
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 503: outage'));
    mockSql.mockResolvedValueOnce([]); // recordFetch error

    const result = await fetchAndCacheOptionIntraday(
      'KEY',
      'SPY260502C00500000',
      '2026-05-02',
    );

    expect(result).toEqual([]);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
