// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────

const mockGetAccessToken = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/schwab.js', () => ({
  getAccessToken: mockGetAccessToken,
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

import {
  fetchSPXCandles,
  formatSPXCandlesForClaude,
} from '../_lib/schwab-candles.js';
import type { SPXCandle } from '../_lib/schwab-candles.js';

// ── Helpers ─────────────────────────────────────────────────

/** Build a candle at a given minute offset from 9:30 AM ET */
function makeCandle(
  minuteOffset: number,
  overrides: Partial<SPXCandle> = {},
): SPXCandle {
  // 2025-01-15 14:30 UTC = 9:30 AM ET
  const base = new Date('2025-01-15T14:30:00Z').getTime();
  return {
    open: 5700,
    high: 5705,
    low: 5695,
    close: 5702,
    volume: 1000,
    datetime: base + minuteOffset * 60_000,
    ...overrides,
  };
}

/** Build N uniform candles starting at 9:30 */
function makeCandles(
  n: number,
  baseOverrides: Partial<SPXCandle> = {},
): SPXCandle[] {
  return Array.from({ length: n }, (_, i) =>
    makeCandle(i * 5, { ...baseOverrides }),
  );
}

// =============================================================
// fetchSPXCandles
// =============================================================

describe('fetchSPXCandles', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetAccessToken.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('returns empty when auth fails', async () => {
    mockGetAccessToken.mockResolvedValue({
      error: 'SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set',
    });

    const result = await fetchSPXCandles();

    expect(result).toEqual({ candles: [], previousClose: null });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      expect.stringContaining('Schwab auth failed'),
    );
  });

  it('returns candles on successful API response', async () => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-token' });

    const mockCandles = [makeCandle(10), makeCandle(5), makeCandle(0)];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          symbol: '$SPX',
          empty: false,
          previousClose: 5690,
          candles: mockCandles,
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchSPXCandles();

    expect(result.previousClose).toBe(5690);
    expect(result.candles).toHaveLength(3);
    // Should be sorted ascending by datetime
    expect(result.candles[0]!.datetime).toBeLessThan(
      result.candles[1]!.datetime,
    );
    expect(result.candles[1]!.datetime).toBeLessThan(
      result.candles[2]!.datetime,
    );

    // Verify Authorization header
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('pricehistory'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );

    vi.unstubAllGlobals();
  });

  it('returns empty on non-OK response', async () => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-token' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      }),
    );

    const result = await fetchSPXCandles();

    expect(result).toEqual({ candles: [], previousClose: null });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      expect.stringContaining('non-OK'),
    );

    vi.unstubAllGlobals();
  });

  it('returns empty when API says data is empty', async () => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-token' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            symbol: '$SPX',
            empty: true,
            previousClose: 5690,
            candles: [],
          }),
      }),
    );

    const result = await fetchSPXCandles();

    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBe(5690);

    vi.unstubAllGlobals();
  });

  it('returns empty on fetch error', async () => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-token' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const result = await fetchSPXCandles();

    expect(result).toEqual({ candles: [], previousClose: null });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to fetch SPX candles'),
    );

    vi.unstubAllGlobals();
  });
});

// =============================================================
// formatSPXCandlesForClaude
// =============================================================

describe('formatSPXCandlesForClaude', () => {
  it('returns null for empty candles', () => {
    expect(formatSPXCandlesForClaude([], null)).toBeNull();
  });

  it('includes session OHLC summary', () => {
    const candles = [
      makeCandle(0, { open: 5700, high: 5720, low: 5695, close: 5710 }),
      makeCandle(5, { open: 5710, high: 5725, low: 5700, close: 5715 }),
    ];

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).toContain('SPX Intraday Price Data');
    expect(result).toContain('Open: 5700.00');
    expect(result).toContain('High: 5725.00');
    expect(result).toContain('Low: 5695.00');
    expect(result).toContain('Last: 5715.00');
    expect(result).toContain('Session Range: 30.0 pts');
  });

  it('includes previous close and gap info', () => {
    const candles = [makeCandle(0, { open: 5710 })];

    const result = formatSPXCandlesForClaude(candles, 5700);

    expect(result).toContain('Previous Close: 5700.00');
    expect(result).toContain('Gap: UP');
    expect(result).toContain('10.0 pts');
  });

  it('shows DOWN gap when open is below previous close', () => {
    const candles = [makeCandle(0, { open: 5690 })];

    const result = formatSPXCandlesForClaude(candles, 5700);

    expect(result).toContain('Gap: DOWN');
  });

  it('includes straddle cone context', () => {
    const candles = [makeCandle(0, { high: 5720, low: 5700, close: 5710 })];

    const result = formatSPXCandlesForClaude(
      candles,
      null,
      undefined,
      5750, // coneUpper
      5650, // coneLower
    );

    expect(result).toContain('Straddle Cone: 5650.0 – 5750.0');
    expect(result).toContain('100 pts');
    expect(result).toContain('Price INSIDE cone');
  });

  it('marks price OUTSIDE cone', () => {
    const candles = [makeCandle(0, { high: 5760, low: 5755, close: 5758 })];

    const result = formatSPXCandlesForClaude(
      candles,
      null,
      undefined,
      5750,
      5650,
    );

    expect(result).toContain('Price OUTSIDE cone');
  });

  // ── Pattern detection ───────────────────────────────────

  it('detects HIGHER LOWS pattern', () => {
    // 6 candles with progressively higher lows (5 of 5 transitions)
    const candles = Array.from({ length: 6 }, (_, i) =>
      makeCandle(i * 5, {
        low: 5700 + i * 2,
        high: 5720,
        open: 5710,
        close: 5712,
      }),
    );

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).toContain('HIGHER LOWS');
  });

  it('detects LOWER HIGHS pattern', () => {
    const candles = Array.from({ length: 6 }, (_, i) =>
      makeCandle(i * 5, {
        high: 5720 - i * 2,
        low: 5695,
        open: 5710,
        close: 5708,
      }),
    );

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).toContain('LOWER HIGHS');
  });

  it('detects RANGE COMPRESSION when recent candles are narrow', () => {
    // Need 12+ candles: first 6 wide, last 6 narrow
    const earlyCandles = Array.from({ length: 6 }, (_, i) =>
      makeCandle(i * 5, {
        open: 5700,
        high: 5720, // 20pt range
        low: 5700,
        close: 5710,
        volume: 1000,
      }),
    );
    const lateCandles = Array.from({ length: 6 }, (_, i) =>
      makeCandle((i + 6) * 5, {
        open: 5710,
        high: 5714, // 4pt range — well below 50% of 20
        low: 5710,
        close: 5712,
        volume: 1000,
      }),
    );

    const result = formatSPXCandlesForClaude(
      [...earlyCandles, ...lateCandles],
      null,
    );

    expect(result).toContain('RANGE COMPRESSION');
  });

  it('detects wide-range bars', () => {
    // 4 normal candles (5pt range each) + 1 wide bar (15pt range)
    const normal = makeCandles(4, {
      open: 5700,
      high: 5705,
      low: 5700,
      close: 5702,
      volume: 500,
    });
    const wideBar = makeCandle(20, {
      open: 5700,
      high: 5720, // 20pt range >> 2x avg of ~5
      low: 5700,
      close: 5718,
      volume: 5000,
    });

    const result = formatSPXCandlesForClaude([...normal, wideBar], null);

    expect(result).toContain('Wide-Range Bar');
    expect(result).toContain('bullish');
  });

  it('labels bearish wide-range bar', () => {
    const normal = makeCandles(4, {
      open: 5700,
      high: 5705,
      low: 5700,
      close: 5702,
      volume: 500,
    });
    const wideBar = makeCandle(20, {
      open: 5720,
      high: 5720,
      low: 5700,
      close: 5702,
      volume: 5000,
    });

    const result = formatSPXCandlesForClaude([...normal, wideBar], null);

    expect(result).toContain('bearish');
  });

  // ── VWAP ────────────────────────────────────────────────

  it('includes VWAP approximation', () => {
    const candles = [
      makeCandle(0, {
        open: 5700,
        high: 5710,
        low: 5690,
        close: 5705,
        volume: 1000,
      }),
    ];

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).toContain('Approx VWAP');
    // VWAP = (5710 + 5690 + 5705) / 3 = 5701.67
    expect(result).toContain('5701.7');
  });

  it('skips VWAP when total volume is zero', () => {
    const candles = [makeCandle(0, { volume: 0 })];

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).not.toContain('VWAP');
  });

  // ── Candle table ────────────────────────────────────────

  it('renders recent candle table (last 12)', () => {
    const candles = makeCandles(15);

    const result = formatSPXCandlesForClaude(candles, null);

    expect(result).toContain('Recent 5-min Candles:');
    expect(result).toContain('Time ET');
    // Should show 12 candle rows (last 12 of 15), each with ▲ or ▼
    const arrowLines = result!
      .split('\n')
      .filter((l) => l.includes('▲') || l.includes('▼'));
    expect(arrowLines).toHaveLength(12);
  });

  it('renders ▲ for bullish and ▼ for bearish candles', () => {
    const candles = [
      makeCandle(0, { open: 5700, close: 5710 }), // bullish
      makeCandle(5, { open: 5710, close: 5700 }), // bearish
    ];

    const result = formatSPXCandlesForClaude(candles, null);

    const lines = result!.split('\n');
    const dataLines = lines.filter(
      (l) => l.includes('5700') && l.includes('5710'),
    );
    expect(dataLines.some((l) => l.includes('▲'))).toBe(true);
    expect(dataLines.some((l) => l.includes('▼'))).toBe(true);
  });
});
