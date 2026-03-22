import { describe, it, expect } from 'vitest';
import { getTopOIStrikes, formatOI } from '../../utils/pin-risk';
import type { ChainStrike } from '../../types/api';

/** Helper to build a minimal ChainStrike with the fields pin-risk cares about */
function strike(s: number, oi: number): ChainStrike {
  return {
    strike: s,
    bid: 0,
    ask: 0,
    mid: 0,
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    iv: 0,
    volume: 0,
    oi,
    itm: false,
  };
}

describe('formatOI', () => {
  it('returns number as-is for values below 1000', () => {
    expect(formatOI(0)).toBe('0');
    expect(formatOI(1)).toBe('1');
    expect(formatOI(500)).toBe('500');
    expect(formatOI(999)).toBe('999');
  });

  it('returns K suffix for values >= 1000', () => {
    expect(formatOI(1000)).toBe('1.0K');
    expect(formatOI(1500)).toBe('1.5K');
    expect(formatOI(10000)).toBe('10.0K');
    expect(formatOI(25300)).toBe('25.3K');
  });

  it('rounds to one decimal place', () => {
    expect(formatOI(1234)).toBe('1.2K');
    expect(formatOI(1250)).toBe('1.3K'); // 1.250 → toFixed(1) → "1.3" (JS rounds 5 up)
    expect(formatOI(1260)).toBe('1.3K');
  });
});

describe('getTopOIStrikes', () => {
  it('combines put and call OI at the same strike', () => {
    const puts = [strike(5800, 3000)];
    const calls = [strike(5800, 2000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.strike).toBe(5800);
    expect(result[0]!.putOI).toBe(3000);
    expect(result[0]!.callOI).toBe(2000);
    expect(result[0]!.totalOI).toBe(5000);
  });

  it('returns top N sorted by total OI', () => {
    const puts = [strike(5700, 1000), strike(5750, 5000), strike(5800, 3000)];
    const calls = [strike(5700, 500), strike(5750, 500), strike(5800, 4000)];
    const result = getTopOIStrikes(puts, calls, 5850, 2);

    expect(result).toHaveLength(2);
    // 5800: 3000+4000=7000, 5750: 5000+500=5500, 5700: 1000+500=1500
    expect(result[0]!.strike).toBe(5800);
    expect(result[0]!.totalOI).toBe(7000);
    expect(result[1]!.strike).toBe(5750);
    expect(result[1]!.totalOI).toBe(5500);
  });

  it('classifies side as "put" when putOI > callOI * 2', () => {
    const puts = [strike(5700, 5000)];
    const calls = [strike(5700, 1000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result[0]!.side).toBe('put');
  });

  it('classifies side as "call" when callOI > putOI * 2', () => {
    const puts = [strike(5900, 1000)];
    const calls = [strike(5900, 5000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result[0]!.side).toBe('call');
  });

  it('classifies side as "both" when neither dominates by 2x', () => {
    const puts = [strike(5800, 3000)];
    const calls = [strike(5800, 2000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    // putOI (3000) > callOI * 2 (4000)? No → callOI (2000) > putOI * 2 (6000)? No → both
    expect(result[0]!.side).toBe('both');
  });

  it('classifies side as "put" at exact 2x boundary (putOI = callOI * 2 + 1)', () => {
    // putOI > callOI * 2 → need putOI strictly greater than callOI * 2
    const puts = [strike(5800, 2001)];
    const calls = [strike(5800, 1000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result[0]!.side).toBe('put');
  });

  it('classifies side as "both" at exact 2x boundary (putOI = callOI * 2)', () => {
    const puts = [strike(5800, 2000)];
    const calls = [strike(5800, 1000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    // putOI (2000) > callOI * 2 (2000)? No (not strictly greater) → both
    expect(result[0]!.side).toBe('both');
  });

  it('handles empty arrays', () => {
    const result = getTopOIStrikes([], [], 5850);
    expect(result).toEqual([]);
  });

  it('handles puts-only (no calls)', () => {
    const puts = [strike(5700, 3000)];
    const result = getTopOIStrikes(puts, [], 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.putOI).toBe(3000);
    expect(result[0]!.callOI).toBe(0);
    expect(result[0]!.side).toBe('put');
  });

  it('handles calls-only (no puts)', () => {
    const calls = [strike(5900, 4000)];
    const result = getTopOIStrikes([], calls, 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.callOI).toBe(4000);
    expect(result[0]!.putOI).toBe(0);
    expect(result[0]!.side).toBe('call');
  });

  it('calculates distFromSpot correctly', () => {
    const puts = [strike(5800, 1000)];
    const calls = [strike(5900, 1000)];
    const result = getTopOIStrikes(puts, calls, 5850);

    const below = result.find((r) => r.strike === 5800)!;
    const above = result.find((r) => r.strike === 5900)!;

    expect(below.distFromSpot).toBe(-50); // 5800 - 5850
    expect(above.distFromSpot).toBe(50); // 5900 - 5850
  });

  it('calculates distPct correctly', () => {
    const puts = [strike(5800, 1000)];
    const result = getTopOIStrikes(puts, [], 5800);

    // distFromSpot = 5800 - 5800 = 0, pct = 0.00
    expect(result[0]!.distPct).toBe('0.00');

    const puts2 = [strike(5750, 1000)];
    const result2 = getTopOIStrikes(puts2, [], 5800);

    // distFromSpot = 5750 - 5800 = -50, pct = (-50/5800)*100 = -0.862...
    expect(result2[0]!.distPct).toBe('-0.86');
  });

  it('skips strikes with zero total OI', () => {
    const puts = [strike(5800, 0)];
    const calls = [strike(5800, 0)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result).toEqual([]);
  });

  it('defaults to top 8 when topN is not specified', () => {
    const puts = Array.from({ length: 12 }, (_, i) =>
      strike(5700 + i * 10, 1000 + i * 100),
    );
    const result = getTopOIStrikes(puts, [], 5850);

    expect(result).toHaveLength(8);
  });
});
