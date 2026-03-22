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

  it('uses only candles from entryIndex onward', () => {
    const candles = [
      candle(5950, 5750, 5850), // index 0: extreme range (should be ignored)
      candle(5870, 5830, 5850), // index 1: entry
      candle(5880, 5820, 5860), // index 2: settlement
    ];

    const result = computeSettlement(candles, 1, 5900, 5800, 10);

    expect(result).not.toBeNull();
    // remainingHigh from index 1 onward = 5880, not 5950
    expect(result!.remainingHigh).toBe(5880);
    expect(result!.remainingLow).toBe(5820);
    expect(result!.survived).toBe(true);
  });
});
