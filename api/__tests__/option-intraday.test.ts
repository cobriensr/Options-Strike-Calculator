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

// UW premium_*_side fields are dollars INCLUDING the x100 contract
// multiplier: premium = price x contracts x 100. Verified 2026-11-05
// against cached option_intraday_nbbo rows (premium_side / volume_side /
// avg_price = 100.0 on every cached date, May-Nov 2026). Fixtures below
// use that real shape: ask 104 contracts at $30.20 -> 314,080.
describe('deriveMid', () => {
  it('returns per-share synthetic mid when both sides have volume', () => {
    // ask: 104 contracts at $30.20 -> 30.20 * 104 * 100 = 314,080
    // bid: 50 contracts at $30.00  -> 30.00 * 50 * 100  = 150,000
    // mid = (30.20 + 30.00) / 2 = 30.10 per share
    const mid = deriveMid({
      premiumAskSide: 314_080,
      premiumBidSide: 150_000,
      volumeAskSide: 104,
      volumeBidSide: 50,
      high: 30.5,
      low: 29.5,
      closePrice: 30.05,
      avgPrice: 30.1,
    });
    expect(mid).toBeCloseTo(30.1, 5);
  });

  it('agrees with (high+low)/2 to within a few percent when the range brackets the sides', () => {
    const high = 30.4;
    const low = 29.8;
    const mid = deriveMid({
      premiumAskSide: 314_080,
      premiumBidSide: 150_000,
      volumeAskSide: 104,
      volumeBidSide: 50,
      high,
      low,
      closePrice: 30.05,
      avgPrice: 30.1,
    });
    const rangeMid = (high + low) / 2;
    expect(mid).not.toBeNull();
    // The old bug returned 100x rangeMid; the corrected value is within 2%.
    expect(Math.abs(mid! / rangeMid - 1)).toBeLessThan(0.02);
  });

  it.each([
    // [label, askPrice, askContracts, bidPrice, bidContracts, expectedMid]
    ['a sub-dollar contract', 0.45, 20, 0.4, 30, 0.425],
    ['a single-contract minute', 2.5, 1, 2.3, 1, 2.4],
    ['a deep ITM contract', 150, 3, 148, 7, 149],
  ])(
    'prices %s per share (premium includes the x100 multiplier)',
    (_label, askPrice, askQty, bidPrice, bidQty, expected) => {
      const mid = deriveMid({
        premiumAskSide: askPrice * askQty * 100,
        premiumBidSide: bidPrice * bidQty * 100,
        volumeAskSide: askQty,
        volumeBidSide: bidQty,
        high: null,
        low: null,
        closePrice: null,
        avgPrice: null,
      });
      expect(mid).toBeCloseTo(expected, 6);
    },
  );

  it('falls back to (high+low)/2 when one side has no volume', () => {
    const mid = deriveMid({
      premiumAskSide: 500, // 5 contracts at $1.00
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
        // 100 contracts at $1.10 / $1.00, premium includes the x100 multiplier.
        premium_ask_side: '11000',
        premium_bid_side: '10000',
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
        // 100 contracts at $1.10 / $1.00, premium includes the x100 multiplier.
        premium_ask_side: '11000',
        premium_bid_side: '10000',
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

  it('records an error tombstone and rethrows when the UW fetch fails', async () => {
    mockSql.mockResolvedValueOnce([]); // cache miss
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 503: outage'));
    mockSql.mockResolvedValueOnce([]); // recordFetch error

    // An outage must reach the caller, not pass as "no intraday data".
    await expect(
      fetchAndCacheOptionIntraday('KEY', 'SPY260502C00500000', '2026-05-02'),
    ).rejects.toThrow('UW API 503: outage');

    expect(mockSql).toHaveBeenCalledTimes(2);
    const tombstone = (mockSql.mock.calls[1]![0] as string[]).join(' ');
    expect(tombstone).toContain('INSERT INTO option_intraday_nbbo_fetches');
    expect(mockSql.mock.calls[1]).toContain('error');
  });
});
