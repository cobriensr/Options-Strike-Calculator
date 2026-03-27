// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchSPXCandles,
  formatSPXCandlesForClaude,
  type SPXCandle,
} from '../_lib/spx-candles.js';

// ── Helpers ────────────────────────────────────────────────

/** Build a UW API candle (string OHLC, as the real API returns) */
function uwCandle(
  overrides: Partial<{
    open: string;
    high: string;
    low: string;
    close: string;
    volume: number;
    start_time: string;
    end_time: string;
    market_time: 'pr' | 'r' | 'po';
  }> = {},
) {
  return {
    open: '5700.00',
    high: '5710.00',
    low: '5695.00',
    close: '5705.00',
    volume: 10_000,
    total_volume: 100_000,
    start_time: '2026-03-27T14:30:00Z',
    end_time: '2026-03-27T14:35:00Z',
    market_time: 'r' as const,
    ...overrides,
  };
}

/** Build a normalized SPXCandle */
function spxCandle(
  overrides: Partial<SPXCandle> = {},
  minuteOffset = 0,
): SPXCandle {
  return {
    open: 5700,
    high: 5710,
    low: 5695,
    close: 5705,
    volume: 10_000,
    // 2026-03-27 09:30 AM ET = 13:30 UTC
    datetime:
      new Date('2026-03-27T13:30:00Z').getTime() + minuteOffset * 60_000,
    ...overrides,
  };
}

/** Build an array of candles with ascending highs/lows (uptrend) */
function uptrendCandles(count: number, base = 5700): SPXCandle[] {
  return Array.from({ length: count }, (_, i) =>
    spxCandle(
      {
        open: base + i * 2,
        high: base + i * 2 + 5,
        low: base + i * 2 - 2 + i, // each low higher than previous
        close: base + i * 2 + 3,
        volume: 10_000 + i * 100,
      },
      i * 5,
    ),
  );
}

/** Build an array of candles with descending highs (downtrend) */
function downtrendCandles(count: number, base = 5720): SPXCandle[] {
  return Array.from({ length: count }, (_, i) =>
    spxCandle(
      {
        open: base - i * 2,
        high: base - i * 2 + 3 - i, // each high lower than previous
        low: base - i * 2 - 5,
        close: base - i * 2 - 2,
        volume: 10_000 + i * 100,
      },
      i * 5,
    ),
  );
}

// ============================================================
// fetchSPXCandles
// ============================================================

describe('fetchSPXCandles', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and normalizes regular-session candles', async () => {
    const apiData = {
      data: [
        uwCandle({
          market_time: 'pr',
          open: '5690.00',
          start_time: '2026-03-27T12:00:00Z',
        }),
        uwCandle({ start_time: '2026-03-27T13:30:00Z' }),
        uwCandle({
          open: '5705.00',
          high: '5715.00',
          low: '5700.00',
          close: '5712.00',
          start_time: '2026-03-27T13:35:00Z',
        }),
        uwCandle({ market_time: 'po', start_time: '2026-03-27T20:05:00Z' }),
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('test-key');

    // Only 2 regular-session candles
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]!.open).toBe(5700);
    expect(result.candles[1]!.close).toBe(5712);
    // Sorted by datetime ascending
    expect(result.candles[0]!.datetime).toBeLessThan(
      result.candles[1]!.datetime,
    );
    // Previous close from first premarket candle
    expect(result.previousClose).toBe(5690);

    vi.unstubAllGlobals();
  });

  it('passes date parameter and limit in URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchSPXCandles('my-key', '2026-03-27');

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('date=2026-03-27');
    expect(calledUrl).toContain('limit=500');
    expect(calledUrl).toContain('/stock/SPX/ohlc/5m?');

    // Check auth header
    const calledOpts = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((calledOpts.headers as Record<string, string>).Authorization).toBe(
      'Bearer my-key',
    );

    vi.unstubAllGlobals();
  });

  it('returns empty on non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      }),
    );

    const result = await fetchSPXCandles('key');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns empty when data array is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    const result = await fetchSPXCandles('key');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns empty when data is null/undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await fetchSPXCandles('key');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns empty on fetch exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network timeout')),
    );

    const result = await fetchSPXCandles('key');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('filters out candles with NaN values', async () => {
    const apiData = {
      data: [
        uwCandle({ open: 'invalid', start_time: '2026-03-27T13:30:00Z' }),
        uwCandle({ start_time: '2026-03-27T13:35:00Z' }),
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('key');
    // Only the valid candle should remain
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.open).toBe(5700);

    vi.unstubAllGlobals();
  });

  it('returns null previousClose when no premarket candles', async () => {
    const apiData = {
      data: [uwCandle({ market_time: 'r' })],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('key');
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null previousClose when premarket open is NaN', async () => {
    const apiData = {
      data: [
        uwCandle({ market_time: 'pr', open: 'bad' }),
        uwCandle({ market_time: 'r' }),
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('key');
    expect(result.previousClose).toBeNull();

    vi.unstubAllGlobals();
  });

  it('omits date from URL when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchSPXCandles('key');

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain('date=');
    expect(calledUrl).toContain('limit=500');

    vi.unstubAllGlobals();
  });
});

// ============================================================
// formatSPXCandlesForClaude
// ============================================================

describe('formatSPXCandlesForClaude', () => {
  it('returns null for empty candles', () => {
    expect(formatSPXCandlesForClaude([], null)).toBeNull();
  });

  it('includes session OHLC summary', () => {
    const candles = [
      spxCandle({ open: 5700, high: 5720, low: 5690, close: 5715 }, 0),
      spxCandle({ open: 5715, high: 5730, low: 5710, close: 5725 }, 5),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('SPX Intraday Price Data');
    expect(result).toContain('Open: 5700.00');
    expect(result).toContain('High: 5730.00');
    expect(result).toContain('Low: 5690.00');
    expect(result).toContain('Last: 5725.00');
    expect(result).toContain('Session Range: 40.0 pts');
  });

  it('includes gap analysis when previousClose is provided', () => {
    const candles = [spxCandle({ open: 5710 }, 0)];

    const result = formatSPXCandlesForClaude(candles, 5700)!;
    expect(result).toContain('Previous Close: 5700.00');
    expect(result).toContain('Gap: UP 10.0 pts');
  });

  it('labels gap DOWN when open < previousClose', () => {
    const candles = [spxCandle({ open: 5690 }, 0)];

    const result = formatSPXCandlesForClaude(candles, 5700)!;
    expect(result).toContain('Gap: DOWN 10.0 pts');
  });

  it('labels gap FLAT when open === previousClose', () => {
    const candles = [spxCandle({ open: 5700 }, 0)];

    const result = formatSPXCandlesForClaude(candles, 5700)!;
    expect(result).toContain('Gap: FLAT 0.0 pts');
  });

  it('omits gap line when previousClose is null', () => {
    const candles = [spxCandle({}, 0)];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Previous Close');
    expect(result).not.toContain('Gap:');
  });

  // ── Cone context ──────────────────────────────────────────

  it('includes cone context when bounds are provided', () => {
    const candles = [
      spxCandle({ open: 5700, high: 5720, low: 5690, close: 5710 }, 0),
    ];

    const result = formatSPXCandlesForClaude(candles, null, 5750, 5650)!;
    expect(result).toContain('Straddle Cone: 5650.0 – 5750.0 (100 pts)');
    // range is 30 pts, cone is 100 pts → 30% consumed
    expect(result).toContain('Range consumed: 30% of cone');
    expect(result).toContain('Price INSIDE cone');
  });

  it('labels price OUTSIDE cone', () => {
    const candles = [
      spxCandle({ open: 5760, high: 5770, low: 5755, close: 5765 }, 0),
    ];

    const result = formatSPXCandlesForClaude(candles, null, 5750, 5650)!;
    expect(result).toContain('Price OUTSIDE cone');
  });

  it('handles zero-width cone without division error', () => {
    const candles = [spxCandle({}, 0)];

    const result = formatSPXCandlesForClaude(candles, null, 5700, 5700)!;
    expect(result).toContain('Range consumed: 0% of cone');
  });

  it('omits cone lines when bounds are not provided', () => {
    const candles = [spxCandle({}, 0)];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Straddle Cone');
    expect(result).not.toContain('Range consumed');
  });

  // ── Pattern detection ─────────────────────────────────────

  it('detects HIGHER LOWS pattern', () => {
    const candles = uptrendCandles(6);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Pattern: HIGHER LOWS');
    expect(result).toContain('uptrend intact');
  });

  it('detects LOWER HIGHS pattern', () => {
    const candles = downtrendCandles(6);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Pattern: LOWER HIGHS');
    expect(result).toContain('downtrend intact');
  });

  it('skips pattern detection with fewer than 6 candles', () => {
    const candles = uptrendCandles(5);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Pattern: HIGHER LOWS');
    expect(result).not.toContain('Pattern: LOWER HIGHS');
  });

  it('detects RANGE COMPRESSION when late candles are <50% of early', () => {
    // 6 early candles with wide ranges, 6 late candles with narrow ranges
    const early = Array.from({ length: 6 }, (_, i) =>
      spxCandle(
        {
          open: 5700 + i,
          high: 5700 + i + 20, // 20pt range
          low: 5700 + i,
          close: 5700 + i + 10,
          volume: 10_000,
        },
        i * 5,
      ),
    );
    const late = Array.from({ length: 6 }, (_, i) =>
      spxCandle(
        {
          open: 5720 + i,
          high: 5720 + i + 5, // 5pt range (<50% of 20)
          low: 5720 + i,
          close: 5720 + i + 3,
          volume: 10_000,
        },
        (i + 6) * 5,
      ),
    );

    const result = formatSPXCandlesForClaude([...early, ...late], null)!;
    expect(result).toContain('Pattern: RANGE COMPRESSION');
    expect(result).toContain('Narrowing range often precedes a breakout');
  });

  it('skips range compression with fewer than 12 candles', () => {
    const candles = Array.from({ length: 11 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i * 5),
    );

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('RANGE COMPRESSION');
  });

  // ── Wide-range bar ────────────────────────────────────────

  it('detects wide-range bars (>2x avg range and >5 pts)', () => {
    const normal = Array.from({ length: 5 }, (_, i) =>
      spxCandle(
        {
          open: 5700,
          high: 5704, // 4pt range
          low: 5700,
          close: 5702,
          volume: 10_000,
        },
        i * 5,
      ),
    );
    // Add one wide bar: 15pt range (>2x 4pt avg, >5pts)
    const wide = spxCandle(
      {
        open: 5700,
        high: 5715,
        low: 5700,
        close: 5712, // bullish
        volume: 50_000,
      },
      30,
    );

    const result = formatSPXCandlesForClaude([...normal, wide], null)!;
    expect(result).toContain('Wide-Range Bar');
    expect(result).toContain('bullish');
    expect(result).toContain('1 total wide bars');
  });

  it('labels bearish wide-range bars', () => {
    const normal = Array.from({ length: 5 }, (_, i) =>
      spxCandle(
        {
          open: 5700,
          high: 5704,
          low: 5700,
          close: 5702,
          volume: 10_000,
        },
        i * 5,
      ),
    );
    const wide = spxCandle(
      {
        open: 5715,
        high: 5715,
        low: 5700, // close < open = bearish
        close: 5702,
        volume: 50_000,
      },
      30,
    );

    const result = formatSPXCandlesForClaude([...normal, wide], null)!;
    expect(result).toContain('bearish');
  });

  it('skips wide-range bar detection with fewer than 4 candles', () => {
    const candles = Array.from({ length: 3 }, (_, i) =>
      spxCandle(
        { open: 5700, high: 5730, low: 5690, close: 5720, volume: 10_000 },
        i * 5,
      ),
    );

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Wide-Range Bar');
  });

  // ── VWAP ──────────────────────────────────────────────────

  it('computes and displays approximate VWAP', () => {
    const candles = [
      spxCandle(
        { open: 5700, high: 5710, low: 5695, close: 5705, volume: 20_000 },
        0,
      ),
      spxCandle(
        { open: 5705, high: 5720, low: 5700, close: 5715, volume: 10_000 },
        5,
      ),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Approx VWAP');
    // Last close (5715) is above VWAP
    expect(result).toContain('above VWAP');
  });

  it('labels price below VWAP', () => {
    // First candle with high volume anchors VWAP high
    const candles = [
      spxCandle(
        { open: 5730, high: 5740, low: 5725, close: 5735, volume: 100_000 },
        0,
      ),
      spxCandle(
        { open: 5710, high: 5715, low: 5705, close: 5710, volume: 1_000 },
        5,
      ),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('below VWAP');
  });

  it('skips VWAP when total volume is 0', () => {
    const candles = [spxCandle({ volume: 0 }, 0)];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('VWAP');
  });

  // ── Candle table ──────────────────────────────────────────

  it('renders recent candle table with up/down arrows', () => {
    const candles = [
      spxCandle({ open: 5700, close: 5710, volume: 10_000 }, 0), // ▲
      spxCandle({ open: 5710, close: 5705, volume: 8_000 }, 5), // ▼
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Recent 5-min Candles:');
    expect(result).toContain('▲');
    expect(result).toContain('▼');
  });

  it('limits table to last 12 candles', () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i * 5),
    );

    const result = formatSPXCandlesForClaude(candles, null)!;
    // Count candle table data rows (contain ▲ or ▼)
    const dataRows = result
      .split('\n')
      .filter((l) => l.includes('▲') || l.includes('▼'));
    expect(dataRows).toHaveLength(12);
  });
});
