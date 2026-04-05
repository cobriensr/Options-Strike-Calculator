import { describe, expect, it } from 'vitest';

import { getTopOIStrikes, formatOI } from '../utils/pin-risk';
import type { ChainStrike } from '../types/api';

// ── Test helpers ───────────────────────────────────────────────

function makeChainStrike(
  strike: number,
  oi: number,
  overrides: Partial<ChainStrike> = {},
): ChainStrike {
  return {
    strike,
    bid: 1.0,
    ask: 1.2,
    mid: 1.1,
    delta: 0.1,
    gamma: 0.001,
    theta: -0.5,
    vega: 0.01,
    oi,
    volume: 100,
    iv: 0.15,
    itm: false,
    ...overrides,
  } as ChainStrike;
}

// ── getTopOIStrikes ────────────────────────────────────────────

describe('getTopOIStrikes', () => {
  const spot = 5800;

  it('returns empty array when no puts or calls', () => {
    expect(getTopOIStrikes([], [], spot)).toEqual([]);
  });

  it('combines put and call OI at the same strike', () => {
    const puts = [makeChainStrike(5800, 5000)];
    const calls = [makeChainStrike(5800, 3000)];
    const result = getTopOIStrikes(puts, calls, spot);
    expect(result).toHaveLength(1);
    expect(result[0]!.putOI).toBe(5000);
    expect(result[0]!.callOI).toBe(3000);
    expect(result[0]!.totalOI).toBe(8000);
  });

  it('returns strikes sorted by total OI descending', () => {
    const puts = [
      makeChainStrike(5800, 5000),
      makeChainStrike(5750, 10000),
      makeChainStrike(5700, 2000),
    ];
    const calls = [makeChainStrike(5800, 3000), makeChainStrike(5850, 1000)];
    const result = getTopOIStrikes(puts, calls, spot);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.totalOI).toBeLessThanOrEqual(result[i - 1]!.totalOI);
    }
  });

  it('limits to topN results', () => {
    const puts = Array.from({ length: 20 }, (_, i) =>
      makeChainStrike(5700 + i * 5, 1000 + i * 100),
    );
    const result = getTopOIStrikes(puts, [], spot, 5);
    expect(result).toHaveLength(5);
  });

  it('uses default topN of 8', () => {
    const puts = Array.from({ length: 20 }, (_, i) =>
      makeChainStrike(5700 + i * 5, 1000 + i * 100),
    );
    const result = getTopOIStrikes(puts, [], spot);
    expect(result).toHaveLength(8);
  });

  it('filters out strikes with zero total OI', () => {
    const puts = [makeChainStrike(5800, 0), makeChainStrike(5750, 5000)];
    const calls = [makeChainStrike(5800, 0)];
    const result = getTopOIStrikes(puts, calls, spot);
    // 5800 has 0 total OI, should be excluded
    expect(result.every((s) => s.totalOI > 0)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('computes distance from spot correctly', () => {
    const puts = [makeChainStrike(5750, 5000)];
    const result = getTopOIStrikes(puts, [], spot);
    expect(result[0]!.distFromSpot).toBe(5750 - spot);
    expect(result[0]!.distFromSpot).toBe(-50);
  });

  it('computes distance percentage', () => {
    const puts = [makeChainStrike(5750, 5000)];
    const result = getTopOIStrikes(puts, [], spot);
    const expectedPct = ((-50 / spot) * 100).toFixed(2);
    expect(result[0]!.distPct).toBe(expectedPct);
  });

  it('classifies as put side when putOI > 2 * callOI', () => {
    const puts = [makeChainStrike(5750, 10000)];
    const calls = [makeChainStrike(5750, 1000)];
    const result = getTopOIStrikes(puts, calls, spot);
    expect(result[0]!.side).toBe('put');
  });

  it('classifies as call side when callOI > 2 * putOI', () => {
    const puts = [makeChainStrike(5850, 1000)];
    const calls = [makeChainStrike(5850, 10000)];
    const result = getTopOIStrikes(puts, calls, spot);
    expect(result[0]!.side).toBe('call');
  });

  it('classifies as both when put and call OI are similar', () => {
    const puts = [makeChainStrike(5800, 5000)];
    const calls = [makeChainStrike(5800, 4000)];
    const result = getTopOIStrikes(puts, calls, spot);
    expect(result[0]!.side).toBe('both');
  });

  it('spot exactly at strike gives distFromSpot = 0', () => {
    const puts = [makeChainStrike(5800, 5000)];
    const result = getTopOIStrikes(puts, [], 5800);
    expect(result[0]!.distFromSpot).toBe(0);
    expect(result[0]!.distPct).toBe('0.00');
  });

  it('handles puts-only without calls', () => {
    const puts = [makeChainStrike(5750, 5000), makeChainStrike(5700, 3000)];
    const result = getTopOIStrikes(puts, [], spot);
    expect(result).toHaveLength(2);
    expect(result[0]!.callOI).toBe(0);
  });

  it('handles calls-only without puts', () => {
    const calls = [makeChainStrike(5850, 5000), makeChainStrike(5900, 3000)];
    const result = getTopOIStrikes([], calls, spot);
    expect(result).toHaveLength(2);
    expect(result[0]!.putOI).toBe(0);
  });
});

// ── formatOI ───────────────────────────────────────────────────

describe('formatOI', () => {
  it('formats values >= 1000 with K suffix', () => {
    expect(formatOI(1000)).toBe('1.0K');
    expect(formatOI(1500)).toBe('1.5K');
    expect(formatOI(10000)).toBe('10.0K');
    expect(formatOI(25300)).toBe('25.3K');
  });

  it('formats values < 1000 as plain numbers', () => {
    expect(formatOI(0)).toBe('0');
    expect(formatOI(1)).toBe('1');
    expect(formatOI(500)).toBe('500');
    expect(formatOI(999)).toBe('999');
  });

  it('formats exact thousands', () => {
    expect(formatOI(2000)).toBe('2.0K');
    expect(formatOI(5000)).toBe('5.0K');
  });
});
