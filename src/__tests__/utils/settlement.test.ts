import { describe, it, expect } from 'vitest';
import { computeSettlement } from '../../utils/settlement';
import type { HistoryCandle } from '../../types/api';

/** Helper to build a minimal HistoryCandle */
function candle(high: number, low: number, close: number): HistoryCandle {
  return {
    datetime: 0,
    time: '',
    open: (high + low) / 2,
    high,
    low,
    close,
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
    candles.push({
      datetime: Date.now() + i * 60000,
      time: `${10 + Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}`,
      open: price - 2,
      high: opts.highOverride ?? price + 5,
      low: opts.lowOverride ?? price - 5,
      close: i === count - 1 ? (opts.endPrice ?? price) : price,
    });
  }

  return candles;
}

describe('computeSettlement', () => {
  it('returns survived=true when price stays within strikes', () => {
    const candles = [
      candle(5870, 5830, 5850), // entry candle
      candle(5880, 5820, 5860),
      candle(5890, 5810, 5850), // settlement
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.survived).toBe(true);
    expect(result!.callBreached).toBe(false);
    expect(result!.putBreached).toBe(false);
    expect(result!.settledSafe).toBe(true);
  });

  it('detects call breach when high reaches call strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5905, 5840, 5880), // high >= callStrike (5900)
      candle(5890, 5830, 5860),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.callBreached).toBe(true);
    expect(result!.putBreached).toBe(false);
  });

  it('detects put breach when low reaches put strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5860, 5795, 5820), // low <= putStrike (5800)
      candle(5850, 5810, 5830),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.putBreached).toBe(true);
    expect(result!.callBreached).toBe(false);
  });

  it('detects both sides breached', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5910, 5790, 5850), // breaches both in one candle
      candle(5870, 5830, 5850),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.survived).toBe(false);
    expect(result!.callBreached).toBe(true);
    expect(result!.putBreached).toBe(true);
  });

  it('reports settledSafe=true when settlement is within strikes despite intraday breach', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5910, 5830, 5880), // call breached intraday
      candle(5890, 5830, 5860), // settles at 5860, between 5800 and 5900
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.callBreached).toBe(true);
    expect(result!.survived).toBe(false);
    expect(result!.settledSafe).toBe(true); // settlement (5860) between strikes
    expect(result!.settlement).toBe(5860);
  });

  it('reports settledSafe=false when settlement is outside strikes', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5920, 5850, 5910), // breached and stayed high
      candle(5930, 5895, 5920), // settles at 5920, above call strike
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    expect(result!.settledSafe).toBe(false);
    expect(result!.settlement).toBe(5920);
  });

  it('returns null when entryIndex is at the last candle', () => {
    const candles = [candle(5870, 5830, 5850), candle(5880, 5820, 5860)];

    const result = computeSettlement(candles, 1, 5900, 5800, 10);

    expect(result).toBeNull();
  });

  it('returns null when entryIndex is beyond the last candle', () => {
    const candles = [candle(5870, 5830, 5850)];

    const result = computeSettlement(candles, 5, 5900, 5800, 10);

    expect(result).toBeNull();
  });

  it('calculates positive call cushion when high stays below call strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5885, 5825, 5860),
      candle(5880, 5830, 5855),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    // remainingHigh = 5885, callCushion = 5900 - 5885 = 15
    expect(result).not.toBeNull();
    expect(result!.callCushion).toBe(15);
    expect(result!.remainingHigh).toBe(5885);
  });

  it('calculates negative call cushion when high exceeds call strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5910, 5840, 5870),
      candle(5880, 5830, 5855),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    // remainingHigh = 5910, callCushion = 5900 - 5910 = -10
    expect(result).not.toBeNull();
    expect(result!.callCushion).toBe(-10);
  });

  it('calculates positive put cushion when low stays above put strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5880, 5815, 5860),
      candle(5875, 5825, 5855),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    // remainingLow = 5815, putCushion = 5815 - 5800 = 15
    expect(result).not.toBeNull();
    expect(result!.putCushion).toBe(15);
    expect(result!.remainingLow).toBe(5815);
  });

  it('calculates negative put cushion when low goes below put strike', () => {
    const candles = [
      candle(5870, 5830, 5850),
      candle(5860, 5790, 5830),
      candle(5855, 5820, 5840),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    // remainingLow = 5790, putCushion = 5790 - 5800 = -10
    expect(result).not.toBeNull();
    expect(result!.putCushion).toBe(-10);
  });

  it('rounds cushion and settlement values to 2 decimal places', () => {
    const candles = [
      candle(5870.337, 5829.663, 5850.555),
      candle(5880.123, 5820.456, 5855.789),
    ];

    const result = computeSettlement(candles, 0, 5900, 5800, 10);

    expect(result).not.toBeNull();
    // callCushion = 5900 - 5880.123 = 19.877 → rounded to 19.88
    expect(result!.callCushion).toBe(19.88);
    // putCushion = 5820.456 - 5800 = 20.456 → rounded to 20.46
    expect(result!.putCushion).toBe(20.46);
    // settlement = 5855.789 → rounded to 5855.79
    expect(result!.settlement).toBe(5855.79);
  });

  it('passes through the delta value unchanged', () => {
    const candles = [candle(5870, 5830, 5850), candle(5880, 5820, 5860)];

    const result = computeSettlement(candles, 0, 5900, 5800, 15);

    expect(result).not.toBeNull();
    expect(result!.delta).toBe(15);
  });

  it('passes through the call and put strike values unchanged', () => {
    const candles = [candle(5870, 5830, 5850), candle(5880, 5820, 5860)];

    const result = computeSettlement(candles, 0, 5865, 5835, 10);

    expect(result).not.toBeNull();
    expect(result!.callStrike).toBe(5865);
    expect(result!.putStrike).toBe(5835);
  });

  it('uses only candles strictly after entryIndex', () => {
    // Pre-entry candle at index 0 (wild range) must be ignored, AND
    // the entry candle at index 1 must also be ignored because its
    // high/low are pre-entry relative to spot = candle.close (FE-MATH-003).
    const candles = [
      candle(5950, 5750, 5850), // index 0: extreme pre-entry range
      candle(5870, 5830, 5850), // index 1: entry candle (also excluded)
      candle(5880, 5820, 5860), // index 2: first post-entry candle
    ];

    const result = computeSettlement(candles, 1, 5900, 5800, 10);

    expect(result).not.toBeNull();
    // Only candle 2 contributes: high=5880, low=5820
    expect(result!.remainingHigh).toBe(5880);
    expect(result!.remainingLow).toBe(5820);
    expect(result!.survived).toBe(true);
  });

  // ── settledSafe boundary tests (ported from legacy test file) ────────

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

  it('uses the last candle close as settlement regardless of intermediate prices', () => {
    const candles = [
      candle(5810, 5790, 5800),
      candle(5815, 5795, 5805),
      candle(5820, 5800, 5812),
    ];
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.settlement).toBe(5812);
  });

  it('handles both sides breached simultaneously across the session', () => {
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
    // Entry candle (excluded per FE-MATH-003) + two post-entry candles.
    // Both post-entry highs/lows are within the strikes, settlement lands
    // 1 pt below the call strike — safe.
    const candles = [
      candle(5805, 5795, 5800), // entry candle (excluded)
      candle(5810, 5790, 5820), // post-entry 1
      candle(5810, 5790, 5849), // post-entry 2 / settlement
    ];
    const result = computeSettlement(candles, 0, 5850, 5700, 10);
    expect(result).not.toBeNull();
    expect(result!.survived).toBe(true); // remainingHigh = 5810 < 5850
    expect(result!.settledSafe).toBe(true); // 5849 < 5850
    expect(result!.callCushion).toBe(Math.round((5850 - 5810) * 100) / 100);
  });

  // ── FE-MATH-003: entry candle is excluded from the breach scan ───────

  it('FE-MATH-003: excludes entry candle high/low from breach scan', () => {
    // The entry candle itself has extreme high/low that WOULD trigger a
    // breach if included. Post-entry candles are calm. Under the old
    // inclusive behavior this reported a false breach. Under the fix
    // (exclusive of entry candle) no breach is reported.
    const candles = [
      candle(5955, 5640, 5800), // index 0: entry — wild wick, close = 5800
      candle(5810, 5790, 5805), // index 1: calm post-entry
      candle(5815, 5795, 5810), // index 2: calm settlement
    ];
    // Call strike 5850 would be breached by the 5955 wick
    // Put strike 5750 would be breached by the 5640 wick
    // Both breaches happened BEFORE entry (which is the close = 5800).
    const result = computeSettlement(candles, 0, 5850, 5750, 10);
    expect(result).not.toBeNull();
    expect(result!.callBreached).toBe(false);
    expect(result!.putBreached).toBe(false);
    expect(result!.survived).toBe(true);
    expect(result!.remainingHigh).toBe(5815); // max of candles 1 & 2
    expect(result!.remainingLow).toBe(5790); // min of candles 1 & 2
  });

  it('FE-MATH-003: entry candle can be wild even when subsequent bars dominate', () => {
    // Sanity: even in the easy case where post-entry candles dominate,
    // the entry candle's wick is still excluded.
    const candles = [
      candle(5900, 5700, 5800), // index 0: entry with wick
      candle(5815, 5795, 5810), // index 1
      candle(5820, 5790, 5815), // index 2
    ];
    const result = computeSettlement(candles, 0, 5900, 5700, 10);
    expect(result).not.toBeNull();
    // remainingHigh = max(5815, 5820) = 5820 (NOT 5900 from entry candle)
    // remainingLow  = min(5795, 5790) = 5790 (NOT 5700 from entry candle)
    expect(result!.remainingHigh).toBe(5820);
    expect(result!.remainingLow).toBe(5790);
    expect(result!.callCushion).toBe(80); // 5900 - 5820
    expect(result!.putCushion).toBe(90); // 5790 - 5700
  });
});
