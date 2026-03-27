// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

import {
  fetchDarkPoolBlocks,
  clusterDarkPoolTrades,
  formatDarkPoolForClaude,
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
// fetchDarkPoolBlocks
// =============================================================

describe('fetchDarkPoolBlocks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('fetches and filters trades from API', async () => {
    const validTrade = makeTrade();
    const canceledTrade = makeTrade({ canceled: true });
    const extendedHoursTrade = makeTrade({
      trade_settlement: 'next_day_settlement',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [validTrade, canceledTrade, extendedHoursTrade],
          }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    expect(result).toHaveLength(1);
    expect(result[0]!.tracking_id).toBe(123456);

    // Verify auth header and URL
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('darkpool/SPY'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      }),
    );

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

    await fetchDarkPoolBlocks('key', '2025-01-15');

    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('date=2025-01-15');

    vi.unstubAllGlobals();
  });

  it('uses custom minPremium', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    await fetchDarkPoolBlocks('key', undefined, 10_000_000);

    const url = vi.mocked(fetch).mock.calls[0]![0] as string;
    expect(url).toContain('min_premium=10000000');

    vi.unstubAllGlobals();
  });

  it('returns empty on non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      }),
    );

    const result = await fetchDarkPoolBlocks('bad-key');

    expect(result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      expect.stringContaining('non-OK'),
    );

    vi.unstubAllGlobals();
  });

  it('returns empty on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const result = await fetchDarkPoolBlocks('key');

    expect(result).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch dark pool'),
    );

    vi.unstubAllGlobals();
  });

  it('handles missing data field gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await fetchDarkPoolBlocks('key');

    expect(result).toEqual([]);

    vi.unstubAllGlobals();
  });
});

// =============================================================
// clusterDarkPoolTrades
// =============================================================

describe('clusterDarkPoolTrades', () => {
  it('returns empty for no trades', () => {
    expect(clusterDarkPoolTrades([])).toEqual([]);
  });

  it('groups trades into $0.50 price bands', () => {
    const trades = [
      makeTrade({ price: '570.10', premium: '6000000' }),
      makeTrade({ price: '570.20', premium: '7000000' }),
      makeTrade({ price: '572.80', premium: '5000000' }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    // 570.10 and 570.20 round to band 570.0; 572.80 rounds to 573.0
    expect(clusters).toHaveLength(2);
  });

  it('sorts clusters by total premium descending', () => {
    const trades = [
      makeTrade({ price: '570.00', premium: '5000000' }),
      makeTrade({ price: '575.00', premium: '10000000' }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.totalPremium).toBeGreaterThan(
      clusters[1]!.totalPremium,
    );
  });

  it('translates SPY to SPX using default ratio of 10', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.spxApprox).toBe(5700);
  });

  it('uses custom SPY/SPX ratio', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const clusters = clusterDarkPoolTrades(trades, 10.5);

    expect(clusters[0]!.spxApprox).toBe(Math.round(570 * 10.5));
  });

  it('classifies buyer-initiated trades (price >= ask)', () => {
    const trades = [
      makeTrade({
        price: '570.10',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.buyerInitiated).toBe(1);
    expect(clusters[0]!.sellerInitiated).toBe(0);
  });

  it('classifies seller-initiated trades (price <= bid)', () => {
    const trades = [
      makeTrade({
        price: '569.90',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.sellerInitiated).toBe(1);
    expect(clusters[0]!.buyerInitiated).toBe(0);
  });

  it('classifies mid-price trades using NBBO midpoint', () => {
    // Price above mid → buyer; price below mid → seller
    const aboveMid = makeTrade({
      price: '570.05',
      nbbo_ask: '570.10',
      nbbo_bid: '569.90',
      tracking_id: 1,
    });
    const belowMid = makeTrade({
      price: '569.95',
      nbbo_ask: '570.10',
      nbbo_bid: '569.90',
      tracking_id: 2,
    });

    const clusters = clusterDarkPoolTrades([aboveMid, belowMid]);

    expect(clusters[0]!.buyerInitiated).toBe(1);
    expect(clusters[0]!.sellerInitiated).toBe(1);
  });

  it('marks trades as neutral when NBBO is NaN', () => {
    const trades = [makeTrade({ nbbo_ask: 'N/A', nbbo_bid: 'N/A' })];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.neutral).toBe(1);
  });

  it('skips trades with NaN price', () => {
    const trades = [
      makeTrade({ price: 'bad' }),
      makeTrade({ price: '570.00' }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.tradeCount).toBe(1);
  });

  it('tracks price range and latest time within cluster', () => {
    const trades = [
      makeTrade({
        price: '570.05',
        executed_at: '2025-01-15T15:30:00Z',
      }),
      makeTrade({
        price: '570.20',
        executed_at: '2025-01-15T16:00:00Z',
      }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    // Both round to band 570.0 ($0.50 bands)
    expect(clusters[0]!.spyPriceLow).toBe(570.05);
    expect(clusters[0]!.spyPriceHigh).toBe(570.2);
    expect(clusters[0]!.latestTime).toBe('2025-01-15T16:00:00Z');
  });

  it('accumulates total shares across band', () => {
    const trades = [
      makeTrade({ price: '570.00', size: 5000 }),
      makeTrade({ price: '570.20', size: 3000 }),
    ];

    const clusters = clusterDarkPoolTrades(trades);

    expect(clusters[0]!.totalShares).toBe(8000);
  });
});

// =============================================================
// formatDarkPoolForClaude
// =============================================================

describe('formatDarkPoolForClaude', () => {
  it('returns null for empty trades', () => {
    expect(formatDarkPoolForClaude([])).toBeNull();
  });

  it('returns null when all trades have NaN price (empty clusters)', () => {
    const trades = [makeTrade({ price: 'bad' })];
    expect(formatDarkPoolForClaude(trades)).toBeNull();
  });

  it('includes summary with total blocks and premium', () => {
    const trades = [
      makeTrade({ premium: '6000000' }),
      makeTrade({ premium: '8000000', price: '575.00' }),
    ];

    const result = formatDarkPoolForClaude(trades);

    expect(result).toContain('SPY Dark Pool Block Trades');
    expect(result).toContain('2 blocks');
    expect(result).toContain('14.0M');
  });

  it('shows buyer-dominated bias', () => {
    // All buyer-initiated (price >= ask)
    const trades = [
      makeTrade({
        price: '570.10',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
      makeTrade({
        price: '570.15',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
    ];

    const result = formatDarkPoolForClaude(trades);

    expect(result).toContain('Buyer-dominated');
  });

  it('shows seller-dominated bias', () => {
    const trades = [
      makeTrade({
        price: '569.90',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
      makeTrade({
        price: '569.88',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
    ];

    const result = formatDarkPoolForClaude(trades);

    expect(result).toContain('Seller-dominated');
  });

  it('shows mixed bias when balanced', () => {
    const trades = [
      makeTrade({
        price: '570.10',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
      makeTrade({
        price: '569.90',
        nbbo_ask: '570.10',
        nbbo_bid: '569.90',
      }),
    ];

    const result = formatDarkPoolForClaude(trades);

    expect(result).toContain('Mixed');
  });

  it('shows relative position when currentSpx provided', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const result = formatDarkPoolForClaude(trades, 5710);

    // SPX approx = 5700, current = 5710, so 10 pts below
    expect(result).toContain('10 pts below');
  });

  it('shows AT PRICE when cluster is within 3 pts of current SPX', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const result = formatDarkPoolForClaude(trades, 5702);

    expect(result).toContain('AT PRICE');
  });

  it('shows above when cluster is above current SPX', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const result = formatDarkPoolForClaude(trades, 5680);

    expect(result).toContain('pts above');
  });

  it('shows institutional floor signal for buyer cluster at price', () => {
    // Buyer-initiated, within 5 pts of current
    const trades = [
      makeTrade({
        price: '570.00',
        nbbo_ask: '570.00',
        nbbo_bid: '569.80',
      }),
    ];

    const result = formatDarkPoolForClaude(trades, 5702);

    expect(result).toContain('strong floor signal');
  });

  it('shows support and resistance levels', () => {
    const buyerTrade = makeTrade({
      price: '570.00',
      nbbo_ask: '570.00',
      nbbo_bid: '569.80',
      premium: '8000000',
    });
    const sellerTrade = makeTrade({
      price: '575.00',
      nbbo_ask: '575.20',
      nbbo_bid: '575.00',
      premium: '7000000',
    });

    const result = formatDarkPoolForClaude([buyerTrade, sellerTrade]);

    expect(result).toContain('Dark Pool Support Levels');
    expect(result).toContain('Dark Pool Resistance Levels');
  });

  it('uses custom spyToSpxRatio', () => {
    const trades = [makeTrade({ price: '570.00' })];

    const result = formatDarkPoolForClaude(trades, undefined, 10.5);

    // 570 * 10.5 = 5985
    expect(result).toContain('5985');
  });

  it('formats premium using abbreviated notation', () => {
    const trades = [
      makeTrade({ premium: '1500000000' }), // 1.5B
    ];

    const result = formatDarkPoolForClaude(trades);

    expect(result).toContain('1.5B');
  });

  it('limits output to top 8 clusters', () => {
    // Create 10 clusters at different price bands
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTrade({
        price: `${560 + i}.00`,
        premium: `${(10 - i) * 1000000}`,
      }),
    );

    const result = formatDarkPoolForClaude(trades);

    // Count cluster detail lines (they contain "$" premium + "block")
    const clusterLines = result!
      .split('\n')
      .filter((l) => l.includes('block') && l.includes('shares'));
    expect(clusterLines.length).toBeLessThanOrEqual(8);
  });
});
