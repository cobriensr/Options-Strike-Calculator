// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Fixed system time for determinism. Although this helper's public
 *  API takes explicit date strings (no dependency on `Date.now()`),
 *  freezing the clock keeps behavior stable if the internal date
 *  helpers ever grow a "today" fallback. */
const FIXED_NOW = new Date('2026-04-18T15:30:00.000Z');

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  computeVolumeProfile,
  formatVolumeProfileForClaude,
  priorTradeDate,
} from '../_lib/volume-profile.js';

/**
 * Build N bars clustered around `centerPrice` with the specified total
 * volume evenly distributed. Each bar is a 1-point wide candle.
 */
function bars(
  centerPrice: number,
  count: number,
  volumePerBar: number,
): Array<{ high: string; low: string; volume: string }> {
  return Array.from({ length: count }, () => ({
    high: String(centerPrice + 0.5),
    low: String(centerPrice - 0.5),
    volume: String(volumePerBar),
  }));
}

describe('computeVolumeProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when bar count is below 50 (half-day / holiday)', async () => {
    mockSql.mockResolvedValueOnce(bars(5000, 40, 1000));
    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).toBeNull();
  });

  it('computes POC at the price bucket with highest volume', async () => {
    // 60 bars total: 30 at 5000 (heavy volume), 20 at 4990, 10 at 5010
    const rows = [
      ...bars(5000, 30, 10_000),
      ...bars(4990, 20, 1_000),
      ...bars(5010, 10, 1_000),
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).not.toBeNull();
    expect(result!.poc).toBe(5000);
    expect(result!.barCount).toBe(60);
    expect(result!.totalVolume).toBe(30 * 10_000 + 20 * 1_000 + 10 * 1_000);
  });

  it('places VAL <= POC <= VAH and covers >=70% of volume', async () => {
    // Gaussian-like distribution: volume peaks at 5000, tails down both sides.
    const rows: Array<{ high: string; low: string; volume: string }> = [];
    const bellCurve = [
      [4990, 500],
      [4991, 800],
      [4992, 1200],
      [4993, 1800],
      [4994, 2500],
      [4995, 3500],
      [4996, 5000],
      [4997, 7000],
      [4998, 9000],
      [4999, 11_000],
      [5000, 13_000], // peak
      [5001, 11_000],
      [5002, 9000],
      [5003, 7000],
      [5004, 5000],
      [5005, 3500],
      [5006, 2500],
      [5007, 1800],
      [5008, 1200],
      [5009, 800],
      [5010, 500],
    ];
    for (const [price, vol] of bellCurve) {
      // 3 bars per price bucket to pass the 50-bar floor (21 * 3 = 63)
      rows.push(...bars(price!, 3, Math.floor(vol! / 3)));
    }
    mockSql.mockResolvedValueOnce(rows);

    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).not.toBeNull();
    expect(result!.poc).toBe(5000);
    expect(result!.val).toBeLessThanOrEqual(result!.poc);
    expect(result!.vah).toBeGreaterThanOrEqual(result!.poc);
    // VAH - VAL width should be less than the full range because the
    // band only needs to cover 70% of volume.
    expect(result!.vah - result!.val).toBeLessThan(20);
  });

  it('handles uniform flat distribution with VAH/VAL near the extremes', async () => {
    // 50 bars spread evenly across 10 buckets (5 bars each).
    const rows: Array<{ high: string; low: string; volume: string }> = [];
    for (let i = 0; i < 10; i++) {
      rows.push(...bars(4995 + i, 5, 1000));
    }
    mockSql.mockResolvedValueOnce(rows);

    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).not.toBeNull();
    // With uniform distribution, POC is the smallest price (tie break)
    expect(result!.poc).toBeGreaterThanOrEqual(4995);
    expect(result!.poc).toBeLessThanOrEqual(5004);
    expect(result!.vah - result!.val).toBeGreaterThan(0);
  });

  it('returns null when all bars have zero volume', async () => {
    const rows = bars(5000, 60, 0);
    mockSql.mockResolvedValueOnce(rows);
    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).toBeNull();
  });

  it('filters out rows with non-finite high/low/volume', async () => {
    const rows = [
      ...bars(5000, 50, 1000),
      { high: 'NaN', low: 'NaN', volume: '100' },
      { high: '5000', low: '4999', volume: 'not-a-number' },
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).not.toBeNull();
    expect(result!.barCount).toBe(50);
  });

  it('returns null when DB returns zero rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await computeVolumeProfile('ES', '2026-04-17');
    expect(result).toBeNull();
  });
});

describe('formatVolumeProfileForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatVolumeProfileForClaude(null)).toBeNull();
  });

  it('renders symbol, date, POC/VAH/VAL, and bar/volume counts', () => {
    const output = formatVolumeProfileForClaude({
      symbol: 'ES',
      tradeDate: '2026-04-17',
      poc: 5000,
      vah: 5008,
      val: 4990,
      totalVolume: 1_234_567,
      barCount: 720,
    });
    expect(output).not.toBeNull();
    expect(output).toContain('ES');
    expect(output).toContain('2026-04-17');
    expect(output).toContain('POC: 5000.00');
    expect(output).toContain('VAH: 5008.00');
    expect(output).toContain('VAL: 4990.00');
    expect(output).toContain('720');
    expect(output).toContain('1,234,567');
  });
});

describe('priorTradeDate', () => {
  it('returns Friday for a Monday input', () => {
    // 2026-04-20 is a Monday
    expect(priorTradeDate('2026-04-20')).toBe('2026-04-17');
  });

  it('returns the previous weekday for a mid-week input', () => {
    // 2026-04-16 is a Thursday → Wednesday
    expect(priorTradeDate('2026-04-16')).toBe('2026-04-15');
  });

  it('skips weekends entirely', () => {
    // 2026-04-19 is a Sunday → Friday 2026-04-17
    expect(priorTradeDate('2026-04-19')).toBe('2026-04-17');
  });
});
