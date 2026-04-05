import { describe, expect, it } from 'vitest';

import { computeSettlement } from '../utils/settlement';
import type { HistoryCandle } from '../types/api';

// ── Test helpers ───────────────────────────────────────────────

function makeCandle(overrides: Partial<HistoryCandle> = {}): HistoryCandle {
  return {
    datetime: Date.now(),
    time: '10:00',
    open: 5800,
    high: 5810,
    low: 5790,
    close: 5805,
    ...overrides,
  };
}

/**
 * Creates a sequence of candles simulating an intraday session.
 * Price starts at `start` and trends toward `end` within a `range`.
 */
function makeCandleSeries(
  count: number,
  opts: {
    startPrice?: number;
    endPrice?: number;
    highOverride?: number;
    lowOverride?: number;
  } = {},
): HistoryCandle[] {
  const start = opts.startPrice ?? 5800;
  const end = opts.endPrice ?? start;
  const candles: HistoryCandle[] = [];

  for (let i = 0; i < count; i++) {
    const fraction = count > 1 ? i / (count - 1) : 0;
    const price = start + (end - start) * fraction;
    candles.push(
      makeCandle({
        datetime: Date.now() + i * 60000,
        time: `${10 + Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}`,
        open: price - 2,
        high: opts.highOverride ?? price + 5,
        low: opts.lowOverride ?? price - 5,
        close: i === count - 1 ? (opts.endPrice ?? price) : price,
      }),
    );
  }

  return candles;
}

// ── computeSettlement ──────────────────────────────────────────

describe('computeSettlement', () => {
  it('returns null when entryIndex is at or beyond the last candle', () => {
    const candles = [makeCandle()];
    expect(computeSettlement(candles, 0, 5850, 5750, 10)).toBeNull();
    expect(computeSettlement(candles, 1, 5850, 5750, 10)).toBeNull();
  });

  it('survived = true when price stays between strikes', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
    });
    // Strikes wide enough that ±5 range never touches them
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(true);
    expect(result!.callBreached).toBe(false);
    expect(result!.putBreached).toBe(false);
  });

  it('survived = false when high reaches call strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
      highOverride: 5860, // breaches 5850 call
    });
    const result = computeSettlement(candles, 0, 5850, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.callBreached).toBe(true);
  });

  it('survived = false when low reaches put strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
      lowOverride: 5740, // breaches 5750 put
    });
    const result = computeSettlement(candles, 0, 5900, 5750, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.putBreached).toBe(true);
  });

  it('settledSafe = true when settlement is between strikes', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
    });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.settledSafe).toBe(true);
    expect(result!.settlement).toBe(5800);
  });

  it('settledSafe = false when settlement equals call strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5850,
    });
    const result = computeSettlement(candles, 0, 5850, 5700, 10);
    expect(result).not.toBeNull();
    // settlement = callStrike, condition is settlement < callStrike → false
    expect(result!.settledSafe).toBe(false);
  });

  it('settledSafe = false when settlement equals put strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5750,
    });
    const result = computeSettlement(candles, 0, 5900, 5750, 10);
    expect(result).not.toBeNull();
    // settlement = putStrike, condition is settlement > putStrike → false
    expect(result!.settledSafe).toBe(false);
  });

  it('callCushion is positive when high is below call strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
    });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.callCushion).toBeGreaterThan(0);
  });

  it('putCushion is positive when low is above put strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
    });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.putCushion).toBeGreaterThan(0);
  });

  it('callCushion is negative when high exceeds call strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
      highOverride: 5910,
    });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.callCushion).toBeLessThan(0);
  });

  it('putCushion is negative when low goes below put strike', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
      lowOverride: 5690,
    });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.putCushion).toBeLessThan(0);
  });

  it('uses the last candle close as settlement', () => {
    const candles = [
      makeCandle({ close: 5800, high: 5810, low: 5790 }),
      makeCandle({ close: 5805, high: 5815, low: 5795 }),
      makeCandle({ close: 5812, high: 5820, low: 5800 }),
    ];
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.settlement).toBe(5812);
  });

  it('tracks high/low from entryIndex onward, not before', () => {
    const candles = [
      makeCandle({ high: 5950, low: 5650 }), // wild candle before entry
      makeCandle({ high: 5810, low: 5790, close: 5800 }),
      makeCandle({ high: 5815, low: 5785, close: 5800 }),
    ];
    // Entry at index 1 should ignore the wild candle at index 0
    const result = computeSettlement(candles, 1, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.remainingHigh).toBe(5815);
    expect(result!.remainingLow).toBe(5785);
    expect(result!.survived).toBe(true);
  });

  it('delta is passed through correctly', () => {
    const candles = makeCandleSeries(5, { startPrice: 5800 });
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.delta).toBe(10);
  });

  it('strike values are passed through correctly', () => {
    const candles = makeCandleSeries(5, { startPrice: 5800 });
    const result = computeSettlement(candles, 0, 5860, 5740, 10);
    expect(result).not.toBeNull();
    expect(result!.callStrike).toBe(5860);
    expect(result!.putStrike).toBe(5740);
  });

  it('rounds cushion and settlement values to 2 decimal places', () => {
    const candles = [
      makeCandle({ high: 5810.333, low: 5789.777, close: 5800.555 }),
      makeCandle({ high: 5812.666, low: 5788.123, close: 5801.999 }),
    ];
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    // Check that values are rounded to 2 decimal places
    expect(result!.settlement).toBe(Math.round(5801.999 * 100) / 100);
    expect(result!.remainingHigh).toBe(Math.round(5812.666 * 100) / 100);
    expect(result!.remainingLow).toBe(Math.round(5788.123 * 100) / 100);
  });

  it('handles both sides breached simultaneously', () => {
    const candles = makeCandleSeries(10, {
      startPrice: 5800,
      endPrice: 5800,
      highOverride: 5870,
      lowOverride: 5730,
    });
    const result = computeSettlement(candles, 0, 5850, 5750, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.callBreached).toBe(true);
    expect(result!.putBreached).toBe(true);
  });

  it('can survive despite settling near a strike', () => {
    // Price stays within range but settlement is very close to a strike
    const candles = [
      makeCandle({ high: 5805, low: 5795, close: 5800 }),
      makeCandle({ high: 5810, low: 5790, close: 5849 }),
    ];
    const result = computeSettlement(candles, 0, 5850, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(true); // high = 5810 < 5850
    expect(result!.settledSafe).toBe(true); // 5849 < 5850
    expect(result!.callCushion).toBe(Math.round((5850 - 5810) * 100) / 100);
  });
});
