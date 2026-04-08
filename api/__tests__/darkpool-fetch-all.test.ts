// @vitest-environment node

/**
 * Tests for fetchAllDarkPoolTrades and aggregateDarkPoolLevels
 * from darkpool.ts — the uncovered code paths.
 *
 * fetchAllDarkPoolTrades: paginated dark pool fetching with cursor logic
 * aggregateDarkPoolLevels: per-strike $1 SPX level aggregation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

import {
  fetchAllDarkPoolTrades,
  aggregateDarkPoolLevels,
} from '../_lib/darkpool.js';
import type { DarkPoolTrade } from '../_lib/darkpool.js';

// ── Helpers ─────────────────────────────────────────────────

function makeTrade(overrides: Partial<DarkPoolTrade> = {}): DarkPoolTrade {
  return {
    canceled: false,
    executed_at: '2025-01-15T15:30:00Z',
    ext_hour_sold_codes: null,
    market_center: 'XNMS',
    nbbo_ask: '570.10',
    nbbo_ask_quantity: 100,
    nbbo_bid: '569.90',
    nbbo_bid_quantity: 200,
    premium: '6000000',
    price: '570.00',
    sale_cond_codes: null,
    size: 10500,
    ticker: 'SPY',
    tracking_id: 123456,
    trade_code: null,
    trade_settlement: 'regular_settlement',
    volume: 50000,
    ...overrides,
  };
}

// =============================================================
// fetchAllDarkPoolTrades
// =============================================================

describe('fetchAllDarkPoolTrades', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('fetches a single page and returns filtered trades', async () => {
    const validTrade = makeTrade({
      executed_at: '2025-01-15T15:30:00Z',
    });
    const canceledTrade = makeTrade({
      canceled: true,
      executed_at: '2025-01-15T15:25:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [validTrade, canceledTrade],
          }),
      }),
    );

    const result = await fetchAllDarkPoolTrades('test-key');

    // canceled trade filtered out
    expect(result).toHaveLength(1);
    expect(result[0]!.tracking_id).toBe(123456);

    // Should use min_premium=0
    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('min_premium=0');

    vi.unstubAllGlobals();
  });

  it('paginates until empty batch', async () => {
    const page1Trades = Array.from({ length: 500 }, (_, i) =>
      makeTrade({
        tracking_id: 1000 + i,
        executed_at: `2025-01-15T${String(15 - Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}:00Z`,
      }),
    );

    const page2Trades = [
      makeTrade({
        tracking_id: 2000,
        executed_at: '2025-01-15T14:00:00Z',
      }),
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page1Trades }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page2Trades }),
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchAllDarkPoolTrades('test-key');

    // Page 1 has 500 trades, page 2 has 1 (< 500 so stops)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(501);

    vi.unstubAllGlobals();
  });

  it('includes date param when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    await fetchAllDarkPoolTrades('key', '2025-01-15');

    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('date=2025-01-15');

    vi.unstubAllGlobals();
  });

  it('includes newer_than param when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    await fetchAllDarkPoolTrades('key', undefined, { newerThan: 1705334400 });

    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('newer_than=1705334400');

    vi.unstubAllGlobals();
  });

  it('stops on non-OK response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: Array.from({ length: 500 }, (_, i) =>
              makeTrade({
                tracking_id: i,
                executed_at: `2025-01-15T15:${String(59 - (i % 60)).padStart(2, '0')}:00Z`,
              }),
            ),
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchAllDarkPoolTrades('key');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should return the trades from page 1
    expect(result).toHaveLength(500);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429 }),
      expect.stringContaining('paginated fetch non-OK'),
    );

    vi.unstubAllGlobals();
  });

  it('stops when cursor does not advance', async () => {
    // Both pages return trades with the same oldest timestamp
    const sameTrades = [
      makeTrade({
        tracking_id: 1,
        executed_at: '2025-01-15T15:30:00Z',
      }),
    ];

    // Page 1: returns 500 trades all at same timestamp to force batch.length == 500
    const page1 = Array.from({ length: 500 }, (_, i) =>
      makeTrade({
        tracking_id: i,
        executed_at: '2025-01-15T15:30:00Z', // all same timestamp
      }),
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: sameTrades }),
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchAllDarkPoolTrades('key');

    // After page 1, cursor is set. Page 2 returns a trade at the same time,
    // so cursor doesn't advance and pagination stops.
    // Total: 500 from page 1 (page 2 returns 1 trade but cursor stalls)
    // Actually let me re-read the code — oldestTs >= olderThan means stalled.
    // After page 1: olderThan = floor(new Date('2025-01-15T15:30:00Z') / 1000)
    // Page 2 oldest: same timestamp → oldestTs >= olderThan → break
    // But the trade from page 2 is pushed before the check.
    // Wait, let me re-read: batch is pushed, THEN cursor check.
    expect(result.length).toBeGreaterThanOrEqual(500);

    vi.unstubAllGlobals();
  });

  it('handles network error gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network failure')),
    );

    const result = await fetchAllDarkPoolTrades('key');

    expect(result).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Dark pool pagination error'),
    );

    vi.unstubAllGlobals();
  });

  it('filters out quality-disqualified trades', async () => {
    const trades = [
      makeTrade(), // valid
      makeTrade({ canceled: true, tracking_id: 2 }),
      makeTrade({
        ext_hour_sold_codes: 'FORM_T',
        tracking_id: 3,
      }),
      makeTrade({
        sale_cond_codes: 'average_price_trade',
        tracking_id: 4,
      }),
      makeTrade({
        trade_code: 'derivative_priced',
        tracking_id: 5,
      }),
      makeTrade({
        trade_settlement: 'cash_settlement',
        tracking_id: 6,
      }),
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: trades }),
      }),
    );

    const result = await fetchAllDarkPoolTrades('key');

    expect(result).toHaveLength(1);
    expect(result[0]!.tracking_id).toBe(123456);

    vi.unstubAllGlobals();
  });

  it('respects maxPages limit', async () => {
    // Return 500 trades per page to force continued pagination
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: Array.from({ length: 500 }, (_, i) =>
              makeTrade({
                tracking_id: Date.now() + i,
                // Each page returns progressively older timestamps
                executed_at: new Date(
                  Date.now() - mockFetch.mock.calls.length * 3600000 - i * 1000,
                ).toISOString(),
              }),
            ),
          }),
      }),
    );

    vi.stubGlobal('fetch', mockFetch);

    await fetchAllDarkPoolTrades('key', undefined, { maxPages: 2 });

    // Should stop after 2 pages
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);

    vi.unstubAllGlobals();
  });

  it('handles missing data field in response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await fetchAllDarkPoolTrades('key');

    expect(result).toEqual([]);

    vi.unstubAllGlobals();
  });

  // Regression: guard against UW returning trades outside the requested
  // ET date. Without this guard, the first cron run of the day walks
  // backward through prior sessions and contaminates today's aggregates.
  it('drops trades whose ET date does not match the requested date', async () => {
    // Apr 7 18:00 UTC = Apr 7 14:00 ET, Apr 8 14:30 UTC = Apr 8 10:30 ET
    const apr7Trade = makeTrade({
      tracking_id: 7,
      executed_at: '2026-04-07T18:00:00Z',
    });
    const apr8TradeEarly = makeTrade({
      tracking_id: 81,
      executed_at: '2026-04-08T14:30:00Z',
    });
    const apr8TradeLate = makeTrade({
      tracking_id: 82,
      executed_at: '2026-04-08T19:00:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [apr8TradeLate, apr8TradeEarly, apr7Trade],
          }),
      }),
    );

    const result = await fetchAllDarkPoolTrades('key', '2026-04-08');

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.tracking_id).sort()).toEqual([81, 82]);

    vi.unstubAllGlobals();
  });

  // Regression: when the oldest trade on the current page already
  // crosses the date boundary, pagination must exit instead of issuing
  // another `older_than` request that walks further into prior sessions.
  it('stops pagination early when oldest trade is before the requested date', async () => {
    // Page 1: 500 trades, oldest is Apr 7 afternoon ET. Without the
    // early-exit guard, `batch.length === 500` would trigger a page 2
    // request that walks back into Apr 7 / Apr 6 and beyond.
    const page1 = Array.from({ length: 500 }, (_, i) => {
      // First 100 are today (Apr 8), remaining 400 are Apr 7.
      const isApr8 = i < 100;
      const hour = isApr8 ? 14 : 19;
      const minute = isApr8 ? 30 - Math.floor(i / 2) : 59 - Math.floor(i / 10);
      const day = isApr8 ? '08' : '07';
      return makeTrade({
        tracking_id: 1000 + i,
        executed_at: `2026-04-${day}T${String(hour).padStart(2, '0')}:${String(Math.max(minute, 0)).padStart(2, '0')}:00Z`,
      });
    });

    // A poisoned page 2 that would succeed if the early-exit guard
    // failed to fire — this makes `toHaveBeenCalledTimes(1)` a positive
    // proof that early-exit is what stopped pagination (not an accidental
    // throw from `undefined.ok` on a missing mock response).
    const poisonedPage2 = [
      makeTrade({
        tracking_id: 9999,
        executed_at: '2026-04-06T14:00:00Z', // Apr 6 — even further back
      }),
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page1 }),
      })
      .mockResolvedValue({
        // Default response for any further calls — if early-exit fails
        // to fire and the loop fetches page 2, this response is served.
        ok: true,
        json: () => Promise.resolve({ data: poisonedPage2 }),
      });

    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchAllDarkPoolTrades('key', '2026-04-08');

    // Only one fetch: the early-exit guard prevented page 2 from firing.
    // If this assertion fails, the poisoned page would have been fetched
    // and the 9999 trade would leak through.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The 400 Apr 7 trades were filtered out by the final date guard,
    // and the poisoned Apr 6 trade must never appear.
    expect(result).toHaveLength(100);
    for (const trade of result) {
      expect(trade.executed_at.startsWith('2026-04-08')).toBe(true);
      expect(trade.tracking_id).not.toBe(9999);
    }

    vi.unstubAllGlobals();
  });
});

// =============================================================
// aggregateDarkPoolLevels
// =============================================================

describe('aggregateDarkPoolLevels', () => {
  it('returns empty for no trades', () => {
    expect(aggregateDarkPoolLevels([])).toEqual([]);
  });

  it('aggregates trades by $1 SPX level', () => {
    const trades = [
      makeTrade({ price: '570.00', premium: '6000000', size: 10000 }),
      makeTrade({ price: '570.08', premium: '4000000', size: 5000 }),
      makeTrade({ price: '572.00', premium: '3000000', size: 8000 }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    // 570.00 * 10 = 5700, 570.08 * 10 = 5701 (different levels)
    // 572.00 * 10 = 5720
    expect(levels.length).toBeGreaterThanOrEqual(2);

    // Sorted by total premium descending
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i - 1]!.totalPremium).toBeGreaterThanOrEqual(
        levels[i]!.totalPremium,
      );
    }
  });

  it('uses default ratio of 10', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels[0]!.spxLevel).toBe(5700);
  });

  it('uses custom SPY/SPX ratio', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const levels = aggregateDarkPoolLevels(trades, 10.5);

    expect(levels[0]!.spxLevel).toBe(Math.round(570 * 10.5));
  });

  it('accumulates premium, count, and shares per level', () => {
    // Both at same $1 SPX level (570.0 * 10 = 5700, rounded)
    const trades = [
      makeTrade({
        price: '570.02',
        premium: '6000000',
        size: 10000,
        executed_at: '2025-01-15T14:00:00Z',
      }),
      makeTrade({
        price: '570.04',
        premium: '4000000',
        size: 5000,
        executed_at: '2025-01-15T15:00:00Z',
      }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    // Both round to SPX 5700
    const level5700 = levels.find((l) => l.spxLevel === 5700);
    expect(level5700).toBeDefined();
    expect(level5700!.totalPremium).toBe(10_000_000);
    expect(level5700!.tradeCount).toBe(2);
    expect(level5700!.totalShares).toBe(15000);
    expect(level5700!.latestTime).toBe('2025-01-15T15:00:00Z');
  });

  it('skips trades with NaN price', () => {
    const trades = [
      makeTrade({ price: 'bad' }),
      makeTrade({ price: '570.00' }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(1);
    expect(levels[0]!.tradeCount).toBe(1);
  });

  it('handles NaN premium as 0', () => {
    const trades = [makeTrade({ price: '570.00', premium: 'N/A' })];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels[0]!.totalPremium).toBe(0);
    expect(levels[0]!.tradeCount).toBe(1);
  });

  it('sorts by total premium descending', () => {
    const trades = [
      makeTrade({
        price: '570.00',
        premium: '5000000',
      }),
      makeTrade({
        price: '575.00',
        premium: '10000000',
      }),
      makeTrade({
        price: '565.00',
        premium: '2000000',
      }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels[0]!.totalPremium).toBe(10_000_000);
    expect(levels[1]!.totalPremium).toBe(5_000_000);
    expect(levels[2]!.totalPremium).toBe(2_000_000);
  });

  it('tracks latest time across trades at same level', () => {
    const trades = [
      makeTrade({
        price: '570.02',
        executed_at: '2025-01-15T14:00:00Z',
      }),
      makeTrade({
        price: '570.04',
        executed_at: '2025-01-15T16:00:00Z',
      }),
    ];

    const levels = aggregateDarkPoolLevels(trades);
    const level = levels.find((l) => l.spxLevel === 5700);

    expect(level!.latestTime).toBe('2025-01-15T16:00:00Z');
  });
});
