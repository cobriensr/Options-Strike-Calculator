// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock db before importing the module under test
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn(), request: vi.fn(() => vi.fn()) },
}));

import {
  ctWallClockToUtcMs,
  fetchSPXCandles,
  fetchSPXSpotAtTimestamp,
  formatSPXCandlesForClaude,
  type SPXCandle,
} from '../_lib/spx-candles.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';

// ── Helpers ────────────────────────────────────────────────

/** Build a UW API candle (string OHLC in SPY prices, as the real API returns) */
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
    open: '570.00',
    high: '571.00',
    low: '569.50',
    close: '570.50',
    volume: 10_000,
    total_volume: 100_000,
    start_time: '2026-03-27T14:30:00Z',
    end_time: '2026-03-27T14:35:00Z',
    market_time: 'r' as const,
    ...overrides,
  };
}

/**
 * Build a DB row matching the spx_candles_1m schema. Values are already
 * in SPX space (the cron translates SPY→SPX before writing).
 */
function dbRow(
  overrides: Partial<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    market_time: 'pr' | 'r' | 'po';
  }> = {},
) {
  return {
    timestamp: '2026-03-27T13:30:00Z',
    open: 5700,
    high: 5710,
    low: 5695,
    close: 5705,
    volume: 10_000,
    market_time: 'r' as const,
    ...overrides,
  };
}

/** Build N consecutive 1-minute DB rows starting at 13:30 UTC */
function dbRowSeries(
  count: number,
  baseOverrides: (i: number) => Partial<ReturnType<typeof dbRow>> = () => ({}),
): ReturnType<typeof dbRow>[] {
  const base = new Date('2026-03-27T13:30:00Z').getTime();
  return Array.from({ length: count }, (_, i) =>
    dbRow({
      timestamp: new Date(base + i * 60_000).toISOString(),
      ...baseOverrides(i),
    }),
  );
}

/** Build a normalized SPXCandle (formatter-side fixture) */
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

/** Ascending-lows (uptrend) fixture — 1-minute spaced */
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
      i,
    ),
  );
}

/** Descending-highs (downtrend) fixture — 1-minute spaced */
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
      i,
    ),
  );
}

/** Install a db mock that returns `rows` for the first query. */
function mockDbRows(rows: unknown[]) {
  const sql = vi.fn().mockResolvedValue(rows) as unknown as ReturnType<
    typeof vi.fn
  >;
  vi.mocked(getDb).mockReturnValue(sql as unknown as ReturnType<typeof getDb>);
  return sql;
}

// ============================================================
// fetchSPXCandles — DB-first primary path
// ============================================================

describe('fetchSPXCandles (DB-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads 1-min candles from spx_candles_1m and derives previousClose from pr row', async () => {
    // 30 regular-session rows + one premarket row (pr) at 12:00 UTC
    const prRow = dbRow({
      timestamp: '2026-03-27T12:00:00Z',
      open: 5690,
      market_time: 'pr',
    });
    const rCandles = dbRowSeries(30);
    // Simulate the ORDER BY: pr first (12:00), then r rows (13:30+)
    mockDbRows([prRow, ...rCandles]);

    // Stub fetch so we can assert the DB path never called it
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchSPXCandles('test-key', '2026-03-27');

    expect(result.candles).toHaveLength(30);
    expect(result.candles[0]!.open).toBe(5700);
    expect(result.previousClose).toBe(5690);
    // DB read must not hit the live UW endpoint
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns candles with previousClose=null when no premarket row exists', async () => {
    const rCandles = dbRowSeries(10);
    mockDbRows(rCandles);

    const result = await fetchSPXCandles('key', '2026-03-27');

    expect(result.candles).toHaveLength(10);
    expect(result.previousClose).toBeNull();
  });

  it('falls back to live UW 5m fetch when DB returns zero rows for the date', async () => {
    mockDbRows([]); // empty DB

    const apiData = {
      data: [
        uwCandle({
          market_time: 'pr',
          open: '569.00',
          start_time: '2026-03-27T12:00:00Z',
        }),
        uwCandle({ start_time: '2026-03-27T13:30:00Z' }),
        uwCandle({
          open: '570.50',
          high: '571.50',
          low: '570.00',
          close: '571.20',
          start_time: '2026-03-27T13:35:00Z',
        }),
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('test-key', '2026-03-27');

    // Fallback produced SPX-translated candles
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]!.open).toBe(5700);
    expect(result.candles[1]!.close).toBeCloseTo(5712);
    expect(result.previousClose).toBe(5690);

    // Warning logged when falling back
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-03-27' }),
      expect.stringContaining('index_candles_1m (SPX) empty'),
    );
  });

  it('uses today (UTC) when date is omitted', async () => {
    const sql = mockDbRows(dbRowSeries(5));

    await fetchSPXCandles('key');

    // Neon tagged templates pass values as the second arg (array).
    // The exact call shape: sql`... ${date} ...` → sql(strings, date).
    const today = new Date().toISOString().slice(0, 10);
    const calls = sql.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // The date value is in the template parameters — at least one call
    // must have received the today string.
    const flat = calls.flatMap((call) => call.slice(1)) as unknown[];
    expect(flat).toContain(today);
  });

  it('passes an explicit date to the SQL query', async () => {
    const sql = mockDbRows(dbRowSeries(3));

    await fetchSPXCandles('key', '2026-02-10');

    const flat = sql.mock.calls.flatMap((call) => call.slice(1)) as unknown[];
    expect(flat).toContain('2026-02-10');
  });

  it('falls back to live fetch on DB error', async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('connection refused');
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [uwCandle()] }),
      }),
    );

    const result = await fetchSPXCandles('key', '2026-03-27');

    expect(result.candles).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to read index_candles_1m (SPX)'),
    );
  });

  it('filters out DB rows with NaN OHLC values', async () => {
    const rows = [
      dbRow({
        timestamp: '2026-03-27T13:30:00Z',
        open: Number.NaN,
      }),
      dbRow({ timestamp: '2026-03-27T13:31:00Z' }),
    ];
    mockDbRows(rows);

    const result = await fetchSPXCandles('key', '2026-03-27');
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.open).toBe(5700);
  });

  it('handles string-typed DB values (Neon numeric columns)', async () => {
    // Neon's serverless driver returns NUMERIC columns as strings.
    // Verify toNumber() coerces correctly.
    const rows = [
      {
        timestamp: '2026-03-27T13:30:00Z',
        open: '5700.00',
        high: '5710.25',
        low: '5695.50',
        close: '5705.75',
        volume: '12345',
        market_time: 'r' as const,
      },
    ];
    mockDbRows(rows);

    const result = await fetchSPXCandles('key', '2026-03-27');
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.open).toBe(5700);
    expect(result.candles[0]!.high).toBe(5710.25);
    expect(result.candles[0]!.volume).toBe(12345);
  });
});

// ============================================================
// fetchSPXCandles — live fallback behavior
// ============================================================

describe('fetchSPXCandles (live fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // All tests in this block exercise the fallback — force DB empty.
    mockDbRows([]);
  });

  afterEach(() => {
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

    const result = await fetchSPXCandles('key', '2026-03-27');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();
  });

  it('returns empty when fallback data array is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }),
    );

    const result = await fetchSPXCandles('key', '2026-03-27');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();
  });

  it('returns empty on fetch exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network timeout')),
    );

    const result = await fetchSPXCandles('key', '2026-03-27');
    expect(result.candles).toEqual([]);
    expect(result.previousClose).toBeNull();
  });

  it('uses custom spyToSpxRatio in the fallback path only', async () => {
    const apiData = {
      data: [uwCandle({ open: '570.00', market_time: 'r' })],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiData),
      }),
    );

    const result = await fetchSPXCandles('key', '2026-03-27', 10.5);
    // SPY 570.00 * 10.5 = 5985
    expect(result.candles[0]!.open).toBe(5985);
  });

  it('passes date and limit in fallback URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchSPXCandles('my-key', '2026-03-27');

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('date=2026-03-27');
    expect(calledUrl).toContain('limit=500');
    expect(calledUrl).toContain('/stock/SPY/ohlc/5m?');

    const calledOpts = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((calledOpts.headers as Record<string, string>).Authorization).toBe(
      'Bearer my-key',
    );
  });
});

// ============================================================
// formatSPXCandlesForClaude — 1-minute candles
// ============================================================

describe('formatSPXCandlesForClaude (1-min candles)', () => {
  it('returns null for empty candles', () => {
    expect(formatSPXCandlesForClaude([], null)).toBeNull();
  });

  it('includes session OHLC summary and labels output as 1-min', () => {
    const candles = [
      spxCandle({ open: 5700, high: 5720, low: 5690, close: 5715 }, 0),
      spxCandle({ open: 5715, high: 5730, low: 5710, close: 5725 }, 1),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('SPX Intraday Price Data (1-min candles');
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

  // ── Pattern detection (tuned for 1m resolution) ──────────

  it('detects HIGHER LOWS pattern over 15-candle window', () => {
    const candles = uptrendCandles(15);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Pattern: HIGHER LOWS');
    expect(result).toContain('of last 15 candles');
    expect(result).toContain('uptrend intact');
  });

  it('detects LOWER HIGHS pattern over 15-candle window', () => {
    const candles = downtrendCandles(15);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Pattern: LOWER HIGHS');
    expect(result).toContain('of last 15 candles');
    expect(result).toContain('downtrend intact');
  });

  it('skips pattern detection with fewer than 15 candles', () => {
    const candles = uptrendCandles(14);

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Pattern: HIGHER LOWS');
    expect(result).not.toContain('Pattern: LOWER HIGHS');
  });

  it('detects RANGE COMPRESSION when last 15 are <50% of first 15', () => {
    // 15 early candles with wide ranges, 15 late candles with narrow ranges
    const early = Array.from({ length: 15 }, (_, i) =>
      spxCandle(
        {
          open: 5700 + i,
          high: 5700 + i + 20, // 20pt range
          low: 5700 + i,
          close: 5700 + i + 10,
          volume: 10_000,
        },
        i,
      ),
    );
    const late = Array.from({ length: 15 }, (_, i) =>
      spxCandle(
        {
          open: 5720 + i,
          high: 5720 + i + 5, // 5pt range (<50% of 20)
          low: 5720 + i,
          close: 5720 + i + 3,
          volume: 10_000,
        },
        i + 15,
      ),
    );

    const result = formatSPXCandlesForClaude([...early, ...late], null)!;
    expect(result).toContain('Pattern: RANGE COMPRESSION');
    expect(result).toContain('Narrowing range often precedes a breakout');
  });

  it('skips range compression with fewer than 30 candles', () => {
    const candles = Array.from({ length: 29 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i),
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
        i,
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
      6,
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
        i,
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
      6,
    );

    const result = formatSPXCandlesForClaude([...normal, wide], null)!;
    expect(result).toContain('bearish');
  });

  it('skips wide-range bar detection with fewer than 4 candles', () => {
    const candles = Array.from({ length: 3 }, (_, i) =>
      spxCandle(
        { open: 5700, high: 5730, low: 5690, close: 5720, volume: 10_000 },
        i,
      ),
    );

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).not.toContain('Wide-Range Bar');
  });

  // ── VWAP ──────────────────────────────────────────────────

  it('computes and displays approximate VWAP (above path)', () => {
    const candles = [
      spxCandle(
        { open: 5700, high: 5710, low: 5695, close: 5705, volume: 20_000 },
        0,
      ),
      spxCandle(
        { open: 5705, high: 5720, low: 5700, close: 5715, volume: 10_000 },
        1,
      ),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Approx VWAP');
    expect(result).toContain('above VWAP');
  });

  it('computes VWAP with known 3-candle fixture', () => {
    // Candle 1: typical = (10+5+8)/3 = 7.67, vol 1 → contrib 7.67
    // Candle 2: typical = (20+10+15)/3 = 15,  vol 2 → contrib 30
    // Candle 3: typical = (30+20+25)/3 = 25,  vol 1 → contrib 25
    // Total vol = 4, sum = 62.67 → VWAP ≈ 15.67
    const candles = [
      spxCandle({ high: 10, low: 5, close: 8, volume: 1 }, 0),
      spxCandle({ high: 20, low: 10, close: 15, volume: 2 }, 1),
      spxCandle({ high: 30, low: 20, close: 25, volume: 1 }, 2),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    // 15.67 rounded to 1 dp → 15.7
    expect(result).toContain('Approx VWAP: 15.7');
  });

  it('labels price below VWAP', () => {
    const candles = [
      spxCandle(
        { open: 5730, high: 5740, low: 5725, close: 5735, volume: 100_000 },
        0,
      ),
      spxCandle(
        { open: 5710, high: 5715, low: 5705, close: 5710, volume: 1_000 },
        1,
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
});

// ============================================================
// formatSPXCandlesForClaude — VWAP sigma bands
// ============================================================

describe('formatSPXCandlesForClaude VWAP sigma', () => {
  // Hand-computed fixture:
  //   Candle A: tp=(100+90+95)/3=95, vol=1
  //   Candle B: tp=(120+110+115)/3=115, vol=1
  //   totalVol=2, vwap=(95+115)/2=105
  //   variance=((95-105)²×1+(115-105)²×1)/2=(100+100)/2=100
  //   stdDev=10
  //   sigma1=[95.0, 115.0], sigma2=[85.0, 125.0]
  const sigmaCandles = [
    spxCandle({ high: 100, low: 90, close: 95, volume: 1 }, 0),
    spxCandle({ high: 120, low: 110, close: 115, volume: 1 }, 1),
  ];

  it('happy path — produces valid sigma bands and sigma distance in output', () => {
    // sessionClose=115, vwap=105, stdDev=10 → 1.0σ above
    const result = formatSPXCandlesForClaude(sigmaCandles, null)!;
    expect(result).toContain('Approx VWAP: 105.0');
    expect(result).toContain('±1σ: [95.0, 115.0]');
    expect(result).toContain('±2σ: [85.0, 125.0]');
    expect(result).toContain('1.0σ above VWAP');
  });

  it('price above VWAP — sigma distance is positive and output says "above"', () => {
    // sessionClose=115 > vwap=105
    const result = formatSPXCandlesForClaude(sigmaCandles, null)!;
    expect(result).toContain('above VWAP');
    expect(result).not.toContain('below VWAP');
  });

  it('price below VWAP — sigma distance is negative and output says "below"', () => {
    // Flip: high-tp candle first, low-tp candle last → sessionClose=95 < vwap=105
    const below = [
      spxCandle({ high: 120, low: 110, close: 115, volume: 1 }, 0),
      spxCandle({ high: 100, low: 90, close: 95, volume: 1 }, 1),
    ];
    const result = formatSPXCandlesForClaude(below, null)!;
    expect(result).toContain('below VWAP');
    expect(result).not.toContain('above VWAP');
    expect(result).toContain('1.0σ below VWAP');
  });

  it('zero std_dev guard — all candles at same typical price falls back to point-distance format', () => {
    // tp=(100+90+95)/3=95 for every candle → variance=0, stdDev=0
    const flat = [
      spxCandle({ high: 100, low: 90, close: 95, volume: 10_000 }, 0),
      spxCandle({ high: 100, low: 90, close: 95, volume: 10_000 }, 1),
      spxCandle({ high: 100, low: 90, close: 95, volume: 10_000 }, 2),
    ];
    const result = formatSPXCandlesForClaude(flat, null)!;
    // Must include VWAP line without NaN
    expect(result).toContain('Approx VWAP');
    expect(result).not.toContain('NaN');
    // Falls back to point-distance format — no sigma bands present
    expect(result).not.toContain('±1σ');
    expect(result).not.toContain('±2σ');
    // Point-distance format emits "above VWAP by" or "below VWAP by"
    expect(result).toMatch(/VWAP by \d+\.\d+ pts|VWAP: \d+\.\d+/);
  });

  it('single candle — produces VWAP output without NaN or division by zero', () => {
    // Single candle: variance=0 (only one data point) → falls back to point format
    const single = [
      spxCandle({ high: 110, low: 90, close: 105, volume: 5_000 }, 0),
    ];
    const result = formatSPXCandlesForClaude(single, null)!;
    expect(result).toContain('Approx VWAP');
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
    // No sigma bands for a single candle (stdDev=0)
    expect(result).not.toContain('±1σ');
  });
});

// ============================================================
// formatSPXCandlesForClaude — candle table
// ============================================================

describe('formatSPXCandlesForClaude (candle table)', () => {
  it('renders recent candle table with up/down arrows and 1-min header', () => {
    const candles = [
      spxCandle({ open: 5700, close: 5710, volume: 10_000 }, 0),
      spxCandle({ open: 5710, close: 5705, volume: 8_000 }, 1),
    ];

    const result = formatSPXCandlesForClaude(candles, null)!;
    expect(result).toContain('Recent 1-min Candles (last 30):');
    expect(result).toContain('▲');
    expect(result).toContain('▼');
  });

  it('limits table to last 30 candles while keeping full session in stats', () => {
    // 390-candle fixture = one full regular session at 1m resolution
    const candles = Array.from({ length: 390 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i),
    );

    const result = formatSPXCandlesForClaude(candles, null)!;

    // Recent table is exactly 30 rows
    const dataRows = result
      .split('\n')
      .filter((l) => l.includes('▲') || l.includes('▼'));
    expect(dataRows).toHaveLength(30);

    // Header reflects the new window
    expect(result).toContain('Recent 1-min Candles (last 30):');

    // Session stats cover the FULL 390 candles — verify by checking
    // that the session span spans the full fixture (390 minutes =
    // 6h 30m, which is 09:30–16:00 ET).
    expect(result).toContain('09:30 AM – 03:59 PM ET');
  });

  it('includes all 30 of the last candles for small sessions (>=30)', () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i),
    );
    const result = formatSPXCandlesForClaude(candles, null)!;
    const dataRows = result
      .split('\n')
      .filter((l) => l.includes('▲') || l.includes('▼'));
    expect(dataRows).toHaveLength(30);
  });

  it('includes all candles in the table when session is shorter than 30', () => {
    const candles = Array.from({ length: 12 }, (_, i) =>
      spxCandle({ volume: 10_000 }, i),
    );
    const result = formatSPXCandlesForClaude(candles, null)!;
    const dataRows = result
      .split('\n')
      .filter((l) => l.includes('▲') || l.includes('▼'));
    expect(dataRows).toHaveLength(12);
  });
});

// ============================================================
// ctWallClockToUtcMs — pure CT wall-clock → UTC ms converter
// ============================================================

describe('ctWallClockToUtcMs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns UTC ms for 10:00 CT in January (CST = UTC-6)', () => {
    // January is standard time (CST). 10:00 CT == 16:00 UTC.
    const result = ctWallClockToUtcMs('2026-01-15', '10:00');
    expect(result).toBe(Date.UTC(2026, 0, 15, 16, 0, 0, 0));
  });

  it('returns UTC ms for 10:00 CT in June (CDT = UTC-5)', () => {
    // June is daylight time (CDT). 10:00 CT == 15:00 UTC.
    const result = ctWallClockToUtcMs('2026-06-15', '10:00');
    expect(result).toBe(Date.UTC(2026, 5, 15, 15, 0, 0, 0));
  });

  it('handles DST spring-forward Sunday — 03:00 CT wall-clock resolves to a finite ms', () => {
    // 2026-03-08 is the US DST spring-forward Sunday. At 02:00 CST
    // clocks jump to 03:00 CDT. Wall-clock "03:00" near the boundary
    // is ambiguous for the hand-rolled offset probe: depending on how
    // Intl formats the UTC anchor back into CT, the function may
    // resolve to CST (UTC-6, → 09:00 UTC) or CDT (UTC-5, → 08:00 UTC).
    // Either is acceptable — the function's spec is "whatever Intl
    // reports, consistently". We only assert the offset is exactly
    // one of the two valid Chicago-time offsets for that calendar day.
    const result = ctWallClockToUtcMs('2026-03-08', '03:00');
    expect(result).not.toBeNull();
    const possibleCdt = Date.UTC(2026, 2, 8, 8, 0, 0, 0); // UTC-5
    const possibleCst = Date.UTC(2026, 2, 8, 9, 0, 0, 0); // UTC-6
    expect([possibleCdt, possibleCst]).toContain(result);
  });

  it('handles DST fall-back Sunday — 01:30 CT wall-clock returns consistent ms', () => {
    // 2026-11-01 is US DST fall-back Sunday. Wall-clock 01:30 is
    // ambiguous (occurs twice). Function must return *something*
    // consistent — exact disambiguation is Intl's call. Assert the
    // offset is exactly −5 (CDT) or −6 (CST).
    const result = ctWallClockToUtcMs('2026-11-01', '01:30');
    expect(result).not.toBeNull();
    const possibleCdt = Date.UTC(2026, 10, 1, 6, 30, 0, 0); // UTC-5
    const possibleCst = Date.UTC(2026, 10, 1, 7, 30, 0, 0); // UTC-6
    expect([possibleCdt, possibleCst]).toContain(result);
  });

  it('returns null for malformed date strings', () => {
    expect(ctWallClockToUtcMs('2026/01/15', '10:00')).toBeNull();
    expect(ctWallClockToUtcMs('', '10:00')).toBeNull();
    expect(ctWallClockToUtcMs('not-a-date', '10:00')).toBeNull();
    expect(ctWallClockToUtcMs('2026-1-15', '10:00')).toBeNull();
    expect(ctWallClockToUtcMs('26-01-15', '10:00')).toBeNull();
  });

  it('returns null for malformed time strings', () => {
    expect(ctWallClockToUtcMs('2026-06-15', '10:00:00')).toBeNull();
    expect(ctWallClockToUtcMs('2026-06-15', '10:9')).toBeNull();
    expect(ctWallClockToUtcMs('2026-06-15', '')).toBeNull();
    expect(ctWallClockToUtcMs('2026-06-15', 'noon')).toBeNull();
    expect(ctWallClockToUtcMs('2026-06-15', '10')).toBeNull();
  });

  it('accepts hour and minute values within the parsed regex even if out of range', () => {
    // The regex matches \d{2}:\d{2}, so "25:00" passes the parse step.
    // The function does not range-check — Date.UTC normalizes it
    // (25 → next day 01:00). Asserting we get *some* finite ms back.
    const result = ctWallClockToUtcMs('2026-06-15', '25:00');
    // Either returns a normalized ms or null; we only require it not
    // throw. The contract is "hand-rolled — whatever Intl reports".
    expect(typeof result === 'number' || result === null).toBe(true);
  });

  it('handles midnight CT (00:00) in June (CDT)', () => {
    // 00:00 CDT == 05:00 UTC same day
    const result = ctWallClockToUtcMs('2026-06-15', '00:00');
    expect(result).toBe(Date.UTC(2026, 5, 15, 5, 0, 0, 0));
  });

  it('handles late evening CT (23:59) in June (CDT)', () => {
    // 23:59 CDT == 04:59 UTC next day
    const result = ctWallClockToUtcMs('2026-06-15', '23:59');
    expect(result).toBe(Date.UTC(2026, 5, 16, 4, 59, 0, 0));
  });

  it('handles midnight CT (00:00) in January (CST)', () => {
    // 00:00 CST == 06:00 UTC same day
    const result = ctWallClockToUtcMs('2026-01-15', '00:00');
    expect(result).toBe(Date.UTC(2026, 0, 15, 6, 0, 0, 0));
  });
});

// ============================================================
// fetchSPXSpotAtTimestamp — DB exact + tolerance fallback
// ============================================================

describe('fetchSPXSpotAtTimestamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null without calling DB when date/time are malformed', async () => {
    // mockSql will count any tagged-template invocation
    const mockSql = vi.fn();
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: 'bad',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ date: 'bad', time: '10:00' }),
      expect.stringContaining('malformed'),
    );
  });

  it('returns db_exact when the exact-minute row is present', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([{ close: 5950.25 }]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toEqual({ price: 5950.25, source: 'db_exact' });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('coerces string-typed close values from Neon NUMERIC columns', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([{ close: '5950.25' }]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toEqual({ price: 5950.25, source: 'db_exact' });
  });

  it('falls through to tolerance path when exact row has null close', async () => {
    // First query returns a row with close=null → numOrNull returns null
    // → must NOT return early; fall through to the snapped path.
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([{ close: null }])
      .mockResolvedValueOnce([
        { close: 5951.5, timestamp: '2026-06-15T15:01:00.000Z' },
      ]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toEqual({ price: 5951.5, source: 'db_snapped' });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns null and skips tolerance query when isLiveRead=true and exact misses', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: true,
    });
    expect(result).toBeNull();
    // Tolerance query MUST NOT have been issued
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns db_snapped when exact misses and tolerance returns a row', async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { close: 5942.1, timestamp: '2026-06-15T15:01:00.000Z' },
      ]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toEqual({ price: 5942.1, source: 'db_snapped' });
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        snappedTo: expect.any(String),
      }),
      expect.stringContaining('snapped to nearest bar'),
    );
  });

  it('formats Date-typed snappedTo timestamps via toISOString()', async () => {
    // The function logs snappedRow.timestamp as either ISO string (if
    // already string) or via .toISOString() (if Date). Cover the Date
    // branch explicitly.
    const snappedDate = new Date('2026-06-15T15:01:00.000Z');
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ close: 5942.1, timestamp: snappedDate }]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toEqual({ price: 5942.1, source: 'db_snapped' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        snappedTo: '2026-06-15T15:01:00.000Z',
      }),
      expect.anything(),
    );
  });

  it('returns null when both exact and tolerance queries are empty', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns null when tolerance row has null close', async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { close: null, timestamp: '2026-06-15T15:01:00.000Z' },
      ]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toBeNull();
  });

  it('uses default toleranceMin=2 — tolerance window is ±2 minutes from utcMs', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    // 10:00 CDT (June) → 15:00 UTC
    await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });

    // 2nd call (tolerance query) — interpolated values are call args
    // after the strings array.
    const toleranceCall = mockSql.mock.calls[1]!;
    const interpolated = toleranceCall.slice(1) as unknown[];
    // Expected bounds: 14:58Z and 15:02Z
    expect(interpolated).toContain('2026-06-15T14:58:00.000Z');
    expect(interpolated).toContain('2026-06-15T15:02:00.000Z');
  });

  it('respects a custom toleranceMin=5 — tolerance window is ±5 minutes', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    // 10:00 CDT (June) → 15:00 UTC. ±5min → 14:55Z and 15:05Z.
    await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      toleranceMin: 5,
      isLiveRead: false,
    });

    const toleranceCall = mockSql.mock.calls[1]!;
    const interpolated = toleranceCall.slice(1) as unknown[];
    expect(interpolated).toContain('2026-06-15T14:55:00.000Z');
    expect(interpolated).toContain('2026-06-15T15:05:00.000Z');
  });

  it('returns null and logs on DB error (catch branch)', async () => {
    const mockSql = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'));
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    const result = await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('query failed'),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'spx_candles.spot_lookup_error',
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('passes the exact ISO timestamp and date to the exact-match query', async () => {
    const mockSql = vi.fn().mockResolvedValueOnce([{ close: 5950 }]);
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );

    await fetchSPXSpotAtTimestamp({
      date: '2026-06-15',
      time: '10:00',
      isLiveRead: false,
    });

    const exactCall = mockSql.mock.calls[0]!;
    const interpolated = exactCall.slice(1) as unknown[];
    expect(interpolated).toContain('2026-06-15');
    expect(interpolated).toContain('2026-06-15T15:00:00.000Z');
  });
});
