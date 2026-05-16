// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  computeRangePos,
  type UWStockCandle,
} from '../_lib/uw-stock-candles.js';

function bar(start: string, high: number, low: number): UWStockCandle {
  return {
    start_time: start,
    open: String(low),
    high: String(high),
    low: String(low),
    close: String(high),
  };
}

describe('computeRangePos', () => {
  it('returns null on empty candles', () => {
    expect(computeRangePos([], '2026-05-08T14:30:00Z', 100)).toBeNull();
  });

  it('returns null when every candle is after the trigger time', () => {
    const candles = [bar('2026-05-08T14:31:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:30:00Z', 105)).toBeNull();
  });

  it('returns 0 when spot is exactly at session low', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 112, 100),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 100)).toBe(0);
  });

  it('returns 1 when spot is exactly at session high', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 112, 102),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 112)).toBe(1);
  });

  it('returns 0.5 for spot at midpoint of session range', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100),
      bar('2026-05-08T14:01:00Z', 110, 100),
    ];
    expect(computeRangePos(candles, '2026-05-08T14:02:00Z', 105)).toBe(0.5);
  });

  it('clamps to 0 when spot is below session low (extreme spike print)', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 95)).toBe(0);
  });

  it('clamps to 1 when spot is above session high', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 110, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 115)).toBe(1);
  });

  it('only considers candles at or before the trigger time', () => {
    const candles = [
      bar('2026-05-08T14:00:00Z', 110, 100), // included
      bar('2026-05-08T14:30:00Z', 120, 90), // EXCLUDED (after trigger)
    ];
    // Trigger at 14:15 — only first candle counts; high=110, low=100.
    // Spot at 105 → 0.5
    expect(computeRangePos(candles, '2026-05-08T14:15:00Z', 105)).toBe(0.5);
  });

  it('returns null when high equals low (single flat bar)', () => {
    const candles = [bar('2026-05-08T14:00:00Z', 100, 100)];
    expect(computeRangePos(candles, '2026-05-08T14:01:00Z', 100)).toBeNull();
  });
});
