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

// ── Near-spot inclusion (FE-MATH-001) ─────────────────────────

describe('getTopOIStrikes - near-spot inclusion (FE-MATH-001)', () => {
  it('includes near-spot strike that ranks below topN', () => {
    // Spot = 5850. The top 5 by OI are all far from spot.
    // Strike 5855 (+0.09% from spot) is a legitimate pin candidate but
    // ranks #6 by OI — the old implementation would silently drop it
    // and the PIN RISK banner would never fire.
    const puts = [
      strike(5700, 50000), // rank 1, -2.56%
      strike(5750, 40000), // rank 2, -1.71%
      strike(5800, 30000), // rank 3, -0.85%
      strike(5650, 25000), // rank 4, -3.42%
      strike(5600, 20000), // rank 5, -4.27%
      strike(5855, 8000), // rank 6, +0.09% ← NEAR PIN
    ];
    const result = getTopOIStrikes(puts, [], 5850, 5);

    // Top 5 by OI + the near-spot strike = 6 total
    expect(result).toHaveLength(6);
    expect(result.find((s) => s.strike === 5855)).toBeDefined();
    // Result is still sorted by OI descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.totalOI).toBeLessThanOrEqual(result[i - 1]!.totalOI);
    }
  });

  it('does not duplicate when near-spot strike is also in topN', () => {
    // Strike 5850 has both the highest OI and zero distance from spot.
    // It must appear exactly once in the result.
    const puts = [strike(5850, 20000), strike(5800, 10000), strike(5900, 8000)];
    const result = getTopOIStrikes(puts, [], 5850, 5);

    expect(result).toHaveLength(3);
    expect(result.filter((s) => s.strike === 5850)).toHaveLength(1);
  });

  it('respects custom pinProximityPct (widens the inclusion window)', () => {
    // Spot = 5850. Strike 5890 is at +0.68% — outside the default 0.5%
    // window but inside a custom 1.0% window.
    const puts = [
      strike(5700, 50000),
      strike(5750, 40000),
      strike(5890, 5000), // +0.68% — outside default, inside custom 1%
    ];

    const resultDefault = getTopOIStrikes(puts, [], 5850, 2);
    expect(resultDefault).toHaveLength(2);
    expect(resultDefault.find((s) => s.strike === 5890)).toBeUndefined();

    const resultCustom = getTopOIStrikes(puts, [], 5850, 2, 0.01);
    expect(resultCustom).toHaveLength(3);
    expect(resultCustom.find((s) => s.strike === 5890)).toBeDefined();
  });

  it('disables near-spot inclusion when pinProximityPct is 0', () => {
    // Escape hatch: callers who want strict top-N-by-OI can pass 0.
    const puts = [
      strike(5700, 50000),
      strike(5750, 40000),
      strike(5800, 30000),
      strike(5650, 25000),
      strike(5600, 20000),
      strike(5855, 8000), // near spot but must be excluded
    ];
    const result = getTopOIStrikes(puts, [], 5850, 5, 0);

    expect(result).toHaveLength(5);
    expect(result.find((s) => s.strike === 5855)).toBeUndefined();
  });

  it('includes a strike sitting exactly at spot', () => {
    // Zero distance is always within any positive pin window.
    const puts = [
      strike(5700, 50000),
      strike(5750, 40000),
      strike(5850, 5000), // exactly at spot, low OI
    ];
    const result = getTopOIStrikes(puts, [], 5850, 2);

    expect(result).toHaveLength(3);
    expect(result.find((s) => s.strike === 5850)).toBeDefined();
  });

  it('handles spot <= 0 gracefully (no near-spot filter applied)', () => {
    // Guard against division by zero in the proximity filter.
    const puts = [strike(5800, 1000), strike(5850, 500)];
    const result = getTopOIStrikes(puts, [], 0, 8);
    // With spot=0 the near-spot filter is skipped; we still get top-N.
    expect(result).toHaveLength(2);
  });
});

// ── OI accumulation (FE-MATH-002) ─────────────────────────────

describe('getTopOIStrikes - OI accumulation (FE-MATH-002)', () => {
  it('accumulates put OI when the same strike appears twice in puts', () => {
    // Defensive test: ChainResponse is single-expiry by contract so this
    // never happens today. But any future multi-expiry merging or
    // deduplication-gap must not silently drop OI.
    const puts = [strike(5800, 2000), strike(5800, 3000)];
    const result = getTopOIStrikes(puts, [], 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.putOI).toBe(5000);
    expect(result[0]!.totalOI).toBe(5000);
  });

  it('accumulates call OI when the same strike appears twice in calls', () => {
    const calls = [strike(5900, 1500), strike(5900, 2500)];
    const result = getTopOIStrikes([], calls, 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.callOI).toBe(4000);
    expect(result[0]!.totalOI).toBe(4000);
  });

  it('accumulates across puts and calls independently', () => {
    const puts = [strike(5800, 1000), strike(5800, 2000)];
    const calls = [strike(5800, 500), strike(5800, 1500)];
    const result = getTopOIStrikes(puts, calls, 5850);

    expect(result).toHaveLength(1);
    expect(result[0]!.putOI).toBe(3000);
    expect(result[0]!.callOI).toBe(2000);
    expect(result[0]!.totalOI).toBe(5000);
  });
});
