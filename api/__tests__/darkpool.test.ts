// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockSentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: {
    dbSave: vi.fn(),
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

import {
  fetchDarkPoolBlocks,
  fetchAllDarkPoolTrades,
  aggregateDarkPoolLevels,
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
    const avgPriceTrade = makeTrade({
      sale_cond_codes: 'average_price_trade',
      tracking_id: 900,
    });
    const derivativeTrade = makeTrade({
      trade_code: 'derivative_priced',
      tracking_id: 901,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              validTrade,
              canceledTrade,
              extendedHoursTrade,
              avgPriceTrade,
              derivativeTrade,
            ],
          }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    expect(result).toEqual({
      kind: 'ok',
      data: expect.arrayContaining([
        expect.objectContaining({ tracking_id: 123456 }),
      ]),
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('accepts both "regular" and "regular_settlement" values', async () => {
    const regularTrade = makeTrade({
      trade_settlement: 'regular',
      tracking_id: 100,
    });
    const regularSettlementTrade = makeTrade({
      trade_settlement: 'regular_settlement',
      tracking_id: 101,
    });
    const otherTrade = makeTrade({
      trade_settlement: 'cash_settlement',
      tracking_id: 102,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [regularTrade, regularSettlementTrade, otherTrade],
          }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(2);
    expect(result.data.map((t) => t.tracking_id)).toEqual(
      expect.arrayContaining([100, 101]),
    );

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

    expect(result).toEqual({ kind: 'error', reason: 'HTTP 403' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      expect.stringContaining('non-OK'),
    );

    vi.unstubAllGlobals();
  });

  it('returns error outcome on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const result = await fetchDarkPoolBlocks('key');

    expect(result).toEqual({ kind: 'error', reason: 'timeout' });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch dark pool'),
    );

    vi.unstubAllGlobals();
  });

  it('handles missing data field gracefully (empty outcome)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await fetchDarkPoolBlocks('key');

    expect(result).toEqual({ kind: 'empty' });

    vi.unstubAllGlobals();
  });

  // Regression: same cross-date contamination guard as the paginated
  // fetcher. UW's date parameter can be loose, so we never trust it
  // alone — the final filter must drop trades whose ET date doesn't
  // match the requested date.
  it('drops trades whose ET date does not match the requested date', async () => {
    const apr7Trade = makeTrade({
      tracking_id: 7,
      executed_at: '2026-04-07T18:00:00Z',
    });
    const apr8Trade = makeTrade({
      tracking_id: 8,
      executed_at: '2026-04-08T14:30:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [apr8Trade, apr7Trade],
          }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key', '2026-04-08');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.tracking_id).toBe(8);

    vi.unstubAllGlobals();
  });

  // BE-DARKPOOL-001: contingent_trade prints are pre-arranged swap
  // resets and must be dropped unconditionally.
  it('drops trades with sale_cond_codes === "contingent_trade"', async () => {
    const regularTrade = makeTrade({
      tracking_id: 10,
      sale_cond_codes: 'regular',
    });
    const contingentTrade = makeTrade({
      tracking_id: 11,
      sale_cond_codes: 'contingent_trade',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [regularTrade, contingentTrade],
          }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.tracking_id).toBe(10);

    vi.unstubAllGlobals();
  });

  // BE-DARKPOOL-002: regular-hours window guard — 08:30–15:00 CT.
  // Covers inside/outside/boundary conditions.
  it('keeps trades inside the 08:30–15:00 CT intraday window', async () => {
    // 2026-04-09T14:30:00Z → 09:30 CT (CDT), inside
    const tradeInside = makeTrade({
      tracking_id: 42,
      executed_at: '2026-04-09T14:30:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [tradeInside] }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.tracking_id).toBe(42);

    vi.unstubAllGlobals();
  });

  it('drops pre-session trades with null ext_hour_sold_codes', async () => {
    // 06:15 CT pre-open — during CST (Jan) 06:15 CT = 12:15 UTC.
    // UW has been observed to emit these with ext_hour_sold_codes=null,
    // which is the exact failure mode the audit flagged.
    const preSessionTrade = makeTrade({
      tracking_id: 100,
      executed_at: '2025-01-15T12:15:00Z',
      ext_hour_sold_codes: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [preSessionTrade] }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    expect(result).toEqual({ kind: 'empty' });

    vi.unstubAllGlobals();
  });

  it('drops post-close trades after 15:00 CT', async () => {
    // 15:30 CT post-close during CST → 21:30 UTC
    const postCloseTrade = makeTrade({
      tracking_id: 101,
      executed_at: '2025-01-15T21:30:00Z',
      ext_hour_sold_codes: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [postCloseTrade] }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    expect(result).toEqual({ kind: 'empty' });

    vi.unstubAllGlobals();
  });

  it('keeps the 08:30 CT boundary (inclusive) and drops 15:00 CT (exclusive)', async () => {
    // CST (Jan): 08:30 CT = 14:30 UTC, 15:00 CT = 21:00 UTC
    const openBoundary = makeTrade({
      tracking_id: 830,
      executed_at: '2025-01-15T14:30:00Z',
    });
    const closeBoundary = makeTrade({
      tracking_id: 1500,
      executed_at: '2025-01-15T21:00:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [openBoundary, closeBoundary] }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.tracking_id).toBe(830);

    vi.unstubAllGlobals();
  });

  // DST boundary sanity check: during CDT (April), 08:30 CT = 13:30 UTC
  // (not 14:30 UTC as during CST). The helper must not hard-code UTC.
  it('honors the intraday window across the CST/CDT boundary', async () => {
    // CDT: 13:30 UTC = 08:30 CT (keep); 13:29 UTC = 08:29 CT (drop)
    const insideCdt = makeTrade({
      tracking_id: 200,
      executed_at: '2026-04-09T13:30:00Z',
    });
    const outsideCdt = makeTrade({
      tracking_id: 201,
      executed_at: '2026-04-09T13:29:00Z',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [insideCdt, outsideCdt] }),
      }),
    );

    const result = await fetchDarkPoolBlocks('test-key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.tracking_id).toBe(200);

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

// =============================================================
// fetchAllDarkPoolTrades — pagination loop
// =============================================================

/**
 * Build a tape of N full-size pages of `pageSize` distinct trades each,
 * descending in `executed_at` so the cursor advances on every page.
 * `baseTs` is the most recent trade's epoch-ms; each trade is 1 second older
 * than the previous within a page, and each subsequent page starts 1 second
 * after the previous page's last trade.
 */
function makeFullPage(
  startMsAgo: number,
  count: number,
  baseMs: number,
): DarkPoolTrade[] {
  return Array.from({ length: count }, (_, i) => {
    const ts = baseMs - (startMsAgo + i) * 1000;
    return makeTrade({
      tracking_id: 100000 + startMsAgo + i,
      executed_at: new Date(ts).toISOString(),
    });
  });
}

describe('fetchAllDarkPoolTrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockSentry.captureMessage.mockReset();
    mockSentry.captureException.mockReset();
  });

  it('returns single-page batch when under page size and terminates', async () => {
    // 09:30 CT in CST is 15:30 UTC on 2025-01-15
    const batch = [
      makeTrade({
        tracking_id: 1,
        executed_at: '2025-01-15T15:30:00Z',
      }),
      makeTrade({
        tracking_id: 2,
        executed_at: '2025-01-15T15:29:00Z',
      }),
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: batch }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAllDarkPoolTrades('key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('paginates across pages and threads older_than between calls', async () => {
    // Use times in 09:00 CT zone (15:00 UTC during CST) so all pass intraday filter.
    // Page 0: 500 trades at 15:30 UTC down to 15:21:40 UTC (1s spacing → 8m20s)
    const baseMs = new Date('2025-01-15T15:30:00Z').getTime();
    const page0 = makeFullPage(0, 500, baseMs);
    const page1 = makeFullPage(500, 500, baseMs);
    // Final page < 500 → loop terminates
    const page2 = [
      makeTrade({
        tracking_id: 9001,
        executed_at: '2025-01-15T14:31:00Z',
      }),
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page2 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAllDarkPoolTrades('key');

    if (result.kind !== 'ok') throw new Error('expected ok');
    // 500 + 500 + 1 = 1001 trades, all intraday → all pass filter
    expect(result.data).toHaveLength(1001);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify older_than was added on pages 1 and 2 (not page 0)
    const url0 = fetchMock.mock.calls[0]![0] as string;
    const url1 = fetchMock.mock.calls[1]![0] as string;
    const url2 = fetchMock.mock.calls[2]![0] as string;
    expect(url0).not.toContain('older_than');
    expect(url1).toContain('older_than=');
    expect(url2).toContain('older_than=');
    // Cursor must advance — page 2's older_than > page 1's older_than
    const cursor1 = Number(new URL(url1).searchParams.get('older_than'));
    const cursor2 = Number(new URL(url2).searchParams.get('older_than'));
    expect(cursor2).toBeLessThan(cursor1);

    vi.unstubAllGlobals();
  });

  it('rethrows when the first page returns non-OK and captures Sentry warning', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllDarkPoolTrades('key')).rejects.toThrow(
      /UW dark pool fetch failed: HTTP 503/,
    );

    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'Dark pool paginated fetch non-OK',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          status: 503,
          page: 0,
          fetched: 0,
        }),
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, page: 0 }),
      expect.stringContaining('non-OK'),
    );

    vi.unstubAllGlobals();
  });

  it('preserves partial data when a later page fails mid-pagination', async () => {
    const baseMs = new Date('2025-01-15T15:30:00Z').getTime();
    const page0 = makeFullPage(0, 500, baseMs);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page0 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Envoy upstream timeout'),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAllDarkPoolTrades('key');

    // Mid-pagination failure: partial data returned as `ok`
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'Dark pool paginated fetch non-OK',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          status: 503,
          page: 1,
          fetched: 500,
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('rethrows on non-HTTP error (no "UW API <status>:" prefix)', async () => {
    // Network-level error: fetch() itself rejects, message has no UW API prefix
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED 1.2.3.4:443'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllDarkPoolTrades('key')).rejects.toThrow(/ECONNREFUSED/);

    // The non-HTTP path uses Sentry.captureException (not captureMessage)
    expect(mockSentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ fetched: 0 }),
      }),
    );
    expect(mockLogger.error).toHaveBeenCalled();
    // And captureMessage (HTTP path) must NOT have been called
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('respects maxPages cap and stops requesting after the limit', async () => {
    const baseMs = new Date('2025-01-15T15:30:00Z').getTime();
    const page0 = makeFullPage(0, 500, baseMs);
    const page1 = makeFullPage(500, 500, baseMs);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: page1 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAllDarkPoolTrades('key', undefined, {
      maxPages: 2,
    });

    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.data).toHaveLength(1000);
    // Loop exited at the maxPages cap — no third fetch call
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('includes date and newer_than params in the URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchAllDarkPoolTrades('key', '2025-01-15', {
      newerThan: 1736953200,
    });

    const url = fetchMock.mock.calls[0]![0] as string;
    const params = new URL(url).searchParams;
    expect(params.get('date')).toBe('2025-01-15');
    expect(params.get('newer_than')).toBe('1736953200');
    expect(params.get('min_premium')).toBe('0');
    expect(params.get('limit')).toBe('500');

    vi.unstubAllGlobals();
  });
});

// =============================================================
// aggregateDarkPoolLevels
// =============================================================

describe('aggregateDarkPoolLevels', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateDarkPoolLevels([])).toEqual([]);
  });

  it('skips trades with NaN price and aggregates the rest', () => {
    const trades = [
      makeTrade({ price: 'not-a-number', premium: '1000000' }),
      makeTrade({ price: '590.00', premium: '2000000' }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(1);
    expect(levels[0]!.spxLevel).toBe(5900);
    expect(levels[0]!.totalPremium).toBe(2_000_000);
    expect(levels[0]!.tradeCount).toBe(1);
  });

  it('treats NaN premium as 0 but still counts the trade', () => {
    const trades = [
      makeTrade({ price: '590.00', premium: 'invalid', size: 100 }),
      makeTrade({ price: '590.00', premium: '2000000', size: 200 }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(1);
    // Bad-premium trade contributes 0 to totalPremium but +1 to tradeCount
    // and its size to totalShares.
    expect(levels[0]!.totalPremium).toBe(2_000_000);
    expect(levels[0]!.tradeCount).toBe(2);
    expect(levels[0]!.totalShares).toBe(300);
  });

  it('collapses multiple trades at the same SPX level', () => {
    const trades = [
      makeTrade({
        price: '590.00',
        premium: '1000000',
        size: 100,
        executed_at: '2025-01-15T15:00:00Z',
      }),
      makeTrade({
        price: '590.00',
        premium: '2000000',
        size: 200,
        executed_at: '2025-01-15T15:01:00Z',
      }),
      makeTrade({
        price: '590.00',
        premium: '3000000',
        size: 300,
        executed_at: '2025-01-15T15:02:00Z',
      }),
    ];

    const levels = aggregateDarkPoolLevels(trades, 10);

    expect(levels).toHaveLength(1);
    expect(levels[0]!.spxLevel).toBe(5900);
    expect(levels[0]!.totalPremium).toBe(6_000_000);
    expect(levels[0]!.tradeCount).toBe(3);
    expect(levels[0]!.totalShares).toBe(600);
  });

  it('produces distinct levels for different SPX strikes', () => {
    const trades = [
      makeTrade({ price: '590.00', premium: '1000000' }),
      makeTrade({ price: '595.00', premium: '2000000' }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(2);
    const sorted = [...levels].sort((a, b) => a.spxLevel - b.spxLevel);
    expect(sorted[0]!.spxLevel).toBe(5900);
    expect(sorted[1]!.spxLevel).toBe(5950);
  });

  it('tracks latestTime as the max executed_at within a level', () => {
    const trades = [
      makeTrade({
        price: '590.00',
        premium: '1000000',
        executed_at: '2025-01-15T15:00:00Z',
      }),
      makeTrade({
        price: '590.00',
        premium: '1000000',
        executed_at: '2025-01-15T15:30:00Z',
      }),
      makeTrade({
        price: '590.00',
        premium: '1000000',
        executed_at: '2025-01-15T15:15:00Z',
      }),
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(1);
    expect(levels[0]!.latestTime).toBe('2025-01-15T15:30:00Z');
  });

  it('uses custom spyToSpxRatio for the SPX level calculation', () => {
    const trades = [makeTrade({ price: '590.00', premium: '1000000' })];

    const levels = aggregateDarkPoolLevels(trades, 5);

    expect(levels).toHaveLength(1);
    // 590 * 5 = 2950
    expect(levels[0]!.spxLevel).toBe(2950);
  });

  it('sorts output by totalPremium descending', () => {
    const trades = [
      makeTrade({ price: '588.00', premium: '3000000' }), // SPX 5880
      makeTrade({ price: '590.00', premium: '7000000' }), // SPX 5900 — top
      makeTrade({ price: '592.00', premium: '5000000' }), // SPX 5920
    ];

    const levels = aggregateDarkPoolLevels(trades);

    expect(levels).toHaveLength(3);
    expect(levels[0]!.spxLevel).toBe(5900);
    expect(levels[0]!.totalPremium).toBe(7_000_000);
    expect(levels[1]!.spxLevel).toBe(5920);
    expect(levels[1]!.totalPremium).toBe(5_000_000);
    expect(levels[2]!.spxLevel).toBe(5880);
    expect(levels[2]!.totalPremium).toBe(3_000_000);
  });
});
