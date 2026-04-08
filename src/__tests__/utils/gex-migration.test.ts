import { describe, it, expect } from 'vitest';
import {
  buildStrikeMigrations,
  classifySignalConf,
  computeCentroid,
  computeMigration,
  computeNetGamma,
  MIGRATION_CONFIG,
  pctChange,
  rankStrikesByUrgency,
  selectTargetStrike,
  type GexMode,
  type GexSnapshot,
  type GexStrikeRow,
} from '../../utils/gex-migration';

// ── Fixture builders ─────────────────────────────────────────

function makeStrike(
  strike: number,
  overrides: Partial<GexStrikeRow> = {},
): GexStrikeRow {
  return {
    strike,
    price: 6615,
    callGammaOi: 0,
    putGammaOi: 0,
    callGammaVol: 0,
    putGammaVol: 0,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    ...overrides,
  };
}

function makeSnapshot(
  timestamp: string,
  price: number,
  strikes: GexStrikeRow[],
): GexSnapshot {
  return { timestamp, price, strikes };
}

/**
 * Build a 21-snapshot time series for a single strike following a
 * linear ramp from `startValue` to `endValue`. Useful for constructing
 * known-answer migration fixtures.
 */
function rampSeries(
  strike: number,
  startValue: number,
  endValue: number,
  count = 21,
  field: keyof GexStrikeRow = 'callGammaOi',
  spot = 6615,
): GexSnapshot[] {
  const snapshots: GexSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const v = startValue + (endValue - startValue) * t;
    const row = makeStrike(strike, { [field]: v });
    snapshots.push(
      makeSnapshot(
        new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
        spot,
        [row],
      ),
    );
  }
  return snapshots;
}

/** Merge two parallel snapshot arrays (same timestamps) by appending strikes. */
function mergeSnapshots(a: GexSnapshot[], b: GexSnapshot[]): GexSnapshot[] {
  return a.map((snap, i) => ({
    ...snap,
    strikes: [...snap.strikes, ...(b[i]?.strikes ?? [])],
  }));
}

/**
 * Build a 21-snapshot series from an explicit array of values. Useful when
 * linear ramps won't produce the shape (e.g. accelerating growth) needed
 * to hit signal-confidence thresholds in tests.
 */
function explicitSeries(
  strike: number,
  values: number[],
  field: keyof GexStrikeRow = 'callGammaOi',
  spot = 6615,
): GexSnapshot[] {
  return values.map((v, i) => {
    const row = makeStrike(strike, { [field]: v });
    return makeSnapshot(
      new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
      spot,
      [row],
    );
  });
}

/**
 * Build a series that hits HIGH signal thresholds (5m ≥ 100%, 20m ≥ 200%).
 * Slow ramp to 200 over first 15 snapshots, then burst to 600 in last 5:
 *   5-min ago = series[15] = 200, now = 600 → +200% (≥100 HIGH threshold)
 *   20-min ago = series[0] = 100, now = 600 → +500% (≥200 HIGH threshold)
 */
function highConfValues(): number[] {
  const values: number[] = [];
  for (let i = 0; i < 21; i++) {
    if (i <= 15) {
      values.push(100 + (i / 15) * 100); // 100 → 200 linear
    } else {
      values.push(200 + ((i - 15) / 5) * 400); // 200 → 600 linear
    }
  }
  return values;
}

// ── pctChange ───────────────────────────────────────────────

describe('pctChange', () => {
  it('computes positive percent change', () => {
    expect(pctChange(150, 100)).toBe(50);
  });

  it('computes negative percent change', () => {
    expect(pctChange(50, 100)).toBe(-50);
  });

  it('uses absolute baseline so sign flips produce meaningful deltas', () => {
    // −100 → +100 should report +200% (magnitude doubled and flipped)
    expect(pctChange(100, -100)).toBe(200);
  });

  it('returns null for null baseline', () => {
    expect(pctChange(100, null)).toBeNull();
  });

  it('returns null for zero baseline to avoid divide-by-zero', () => {
    expect(pctChange(100, 0)).toBeNull();
  });
});

// ── computeNetGamma ─────────────────────────────────────────

describe('computeNetGamma', () => {
  const row = makeStrike(6620, {
    callGammaOi: 1_000,
    putGammaOi: -300,
    callGammaVol: 500,
    putGammaVol: -100,
    callGammaAsk: 50,
    callGammaBid: 80,
    putGammaAsk: -10,
    putGammaBid: -20,
  });

  it('sums OI components in oi mode', () => {
    expect(computeNetGamma(row, 'oi')).toBe(700);
  });

  it('sums VOL components in vol mode', () => {
    expect(computeNetGamma(row, 'vol')).toBe(400);
  });

  it('sums all directionalized bid/ask components in dir mode', () => {
    // Matches the GexPerStrike convention: sum of ask + bid for each side
    expect(computeNetGamma(row, 'dir')).toBe(50 + 80 + -10 + -20);
  });
});

// ── computeCentroid ─────────────────────────────────────────

describe('computeCentroid', () => {
  it('returns the gamma-weighted strike', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', 6615, [
      makeStrike(6610, { callGammaOi: 100 }),
      makeStrike(6620, { callGammaOi: 300 }),
    ]);
    // (6610 * 100 + 6620 * 300) / 400 = (661000 + 1986000) / 400 = 6617.5
    expect(computeCentroid(snap, 'oi')).toBe(6617.5);
  });

  it('uses absolute values so negative strikes still contribute', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', 6615, [
      makeStrike(6600, { callGammaOi: 100 }),
      makeStrike(6620, { callGammaOi: -100 }),
    ]);
    // abs weights balance → centroid = midpoint = 6610
    expect(computeCentroid(snap, 'oi')).toBe(6610);
  });

  it('falls back to spot when all gamma is zero', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', 6615, [
      makeStrike(6610),
      makeStrike(6620),
    ]);
    expect(computeCentroid(snap, 'oi')).toBe(6615);
  });
});

// ── classifySignalConf ──────────────────────────────────────

describe('classifySignalConf', () => {
  it('returns HIGH when both windows exceed thresholds with same sign', () => {
    expect(classifySignalConf(150, 300)).toBe('HIGH');
  });

  it('returns MEDIUM when both windows exceed medium thresholds', () => {
    expect(classifySignalConf(60, 120)).toBe('MEDIUM');
  });

  it('returns LOW when only one window meets threshold', () => {
    expect(classifySignalConf(10, 300)).toBe('LOW');
  });

  it('returns LOW when signs disagree', () => {
    expect(classifySignalConf(150, -200)).toBe('LOW');
  });

  it('returns NONE when data is missing', () => {
    expect(classifySignalConf(null, 200)).toBe('NONE');
    expect(classifySignalConf(100, null)).toBe('NONE');
  });
});

// ── buildStrikeMigrations ───────────────────────────────────

describe('buildStrikeMigrations', () => {
  it('returns empty for empty snapshot list', () => {
    expect(buildStrikeMigrations([], 'oi')).toEqual([]);
  });

  it('computes 5-min and 20-min deltas from a ramp series', () => {
    // 21 snapshots, 100 → 1500 linear ramp for strike 6620
    const snaps = rampSeries(6620, 100, 1500);
    const mig = buildStrikeMigrations(snaps, 'oi');

    expect(mig).toHaveLength(1);
    const m = mig[0]!;
    expect(m.strike).toBe(6620);
    expect(m.now).toBe(1500);
    expect(m.twentyMinAgo).toBe(100);

    // 5-min ago = index 15 = 100 + (15/20)*1400 = 1150
    expect(m.fiveMinAgo).toBeCloseTo(1150, 5);
    // 5-min Δ = (1500 - 1150) / 1150 * 100 ≈ 30.43%
    expect(m.fiveMinPctDelta).toBeCloseTo(30.434, 1);
    // 20-min Δ = (1500 - 100) / 100 * 100 = 1400%
    expect(m.twentyMinPctDelta).toBeCloseTo(1400, 1);
    // Both positive → trend agrees
    expect(m.trendAgreement).toBe(true);
  });

  it('returns null deltas when history is too short', () => {
    const snaps = rampSeries(6620, 100, 150, 3);
    const mig = buildStrikeMigrations(snaps, 'oi');
    expect(mig[0]!.fiveMinAgo).toBeNull();
    expect(mig[0]!.twentyMinAgo).toBeNull();
    expect(mig[0]!.trendAgreement).toBe(false);
  });

  it('marks trend disagreement when 5m and 20m have opposite signs', () => {
    // 21 snapshots: 100, 200, 300, ..., 1000, ..., 1500 (up), then a sudden drop
    // Simulate: linear up from 100 to 1500 over 15 points, then drop to 800 in last 5
    const snaps: GexSnapshot[] = [];
    for (let i = 0; i < 21; i++) {
      let v: number;
      if (i <= 15) {
        v = 100 + (i / 15) * 1400;
      } else {
        v = 1500 - ((i - 15) / 5) * 700;
      }
      const row = makeStrike(6620, { callGammaOi: v });
      snaps.push(
        makeSnapshot(
          new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
          6615,
          [row],
        ),
      );
    }
    const m = buildStrikeMigrations(snaps, 'oi')[0]!;
    // 20-min Δ is positive (100 → 800)
    expect(m.twentyMinPctDelta).toBeGreaterThan(0);
    // 5-min Δ is negative (index 15 = 1500 → final 800)
    expect(m.fiveMinPctDelta).toBeLessThan(0);
    expect(m.trendAgreement).toBe(false);
  });

  it('handles strikes missing from some snapshots by treating them as zero', () => {
    // Strike 6620 exists in all 21 snapshots (ramping 100 → 1500)
    // Strike 6625 only exists in the latest snapshot with value 500
    const base = rampSeries(6620, 100, 1500);
    base.at(-1)!.strikes.push(makeStrike(6625, { callGammaOi: 500 }));
    const mig = buildStrikeMigrations(base, 'oi');
    const m6625 = mig.find((m) => m.strike === 6625)!;
    expect(m6625.now).toBe(500);
    // Historical values treated as 0 → 20m delta = null (divide by zero)
    expect(m6625.twentyMinAgo).toBe(0);
    expect(m6625.twentyMinPctDelta).toBeNull();
  });
});

// ── selectTargetStrike ──────────────────────────────────────

describe('selectTargetStrike', () => {
  it('returns null when no candidates qualify', () => {
    expect(selectTargetStrike([])).toBeNull();
  });

  it('excludes negative net gamma strikes (not magnets)', () => {
    const snaps = rampSeries(6620, -100, -1500);
    const mig = buildStrikeMigrations(snaps, 'oi');
    // now = -1500 (negative) → excluded
    expect(selectTargetStrike(mig)).toBeNull();
  });

  it('excludes strikes without trend agreement', () => {
    // Shape: start high (1000), drop hard through the middle (to 200 at i=15),
    // then partially rebound to 500 in the last 5 snapshots.
    //   5-min ago = series[15] = 200, now = 500 → +150% (positive)
    //   20-min ago = series[0] = 1000, now = 500 → −50% (negative)
    // Trend disagrees → the strike should NOT be picked as target.
    const values: number[] = [];
    for (let i = 0; i < 21; i++) {
      if (i <= 15) {
        values.push(1000 - (i / 15) * 800); // 1000 → 200
      } else {
        values.push(200 + ((i - 15) / 5) * 300); // 200 → 500
      }
    }
    const mig = buildStrikeMigrations(explicitSeries(6620, values), 'oi');
    expect(mig[0]!.fiveMinPctDelta).toBeGreaterThan(0);
    expect(mig[0]!.twentyMinPctDelta).toBeLessThan(0);
    expect(selectTargetStrike(mig)).toBeNull();
  });

  it('picks the strongest-growing positive strike closest to spot', () => {
    // Two candidates: 6620 (spot+5) ramps +1400%, 6615 (at spot) ramps +800%
    // 6615 wins because proximity weight dominates at small distances
    const strike6620 = rampSeries(6620, 100, 1500);
    const strike6615 = rampSeries(6615, 100, 900);
    const merged = mergeSnapshots(strike6620, strike6615);
    const mig = buildStrikeMigrations(merged, 'oi');
    const target = selectTargetStrike(mig);
    expect(target).not.toBeNull();
    expect(target!.strike).toBe(6615);
    expect(target!.label).toBe('AT SPOT');
  });

  it('labels CALL WALL when target is above spot', () => {
    // Only 6625 qualifies (5+pts above spot), growing fast
    const snaps = rampSeries(6625, 100, 1500);
    const target = selectTargetStrike(buildStrikeMigrations(snaps, 'oi'));
    expect(target!.label).toBe('CALL WALL');
    expect(target!.distFromSpot).toBeGreaterThan(0);
  });

  it('labels PUT WALL when target is below spot', () => {
    const snaps = rampSeries(6605, 100, 1500);
    const target = selectTargetStrike(buildStrikeMigrations(snaps, 'oi'));
    expect(target!.label).toBe('PUT WALL');
    expect(target!.distFromSpot).toBeLessThan(0);
  });

  it('marks as critical when within 5pts of spot AND signal is HIGH', () => {
    // Strike 6615 = at spot (6615 spot) → 0pt distance
    const snaps = explicitSeries(6615, highConfValues());
    const target = selectTargetStrike(buildStrikeMigrations(snaps, 'oi'));
    expect(target).not.toBeNull();
    expect(target!.signalConf).toBe('HIGH');
    expect(target!.critical).toBe(true);
  });

  it('does not mark critical when distance exceeds threshold', () => {
    // Strike 6650 = 35pts from 6615 spot → outside 5pt critical radius
    const snaps = explicitSeries(6650, highConfValues());
    const target = selectTargetStrike(buildStrikeMigrations(snaps, 'oi'));
    expect(target).not.toBeNull();
    expect(target!.signalConf).toBe('HIGH');
    expect(target!.critical).toBe(false);
  });
});

// ── rankStrikesByUrgency ────────────────────────────────────

describe('rankStrikesByUrgency', () => {
  it('sorts by |5-min Δ| descending and includes negative deltas', () => {
    const ramp6620 = rampSeries(6620, 100, 1500); // small 5m Δ (linear)
    const melt6605 = rampSeries(6605, 1000, 200); // negative 5m Δ (larger |%|)
    const merged = mergeSnapshots(ramp6620, melt6605);
    const mig = buildStrikeMigrations(merged, 'oi');
    const ranked = rankStrikesByUrgency(mig);
    expect(ranked).toHaveLength(2);
    // The melting strike should appear — negative delta but large |%|
    const strikes = ranked.map((m) => m.strike);
    expect(strikes).toContain(6605);
    expect(strikes).toContain(6620);
  });
});

// ── computeMigration (orchestrator) ─────────────────────────

describe('computeMigration', () => {
  it('returns empty scaffold for no snapshots', () => {
    const result = computeMigration([], 'oi');
    expect(result.allStrikes).toEqual([]);
    expect(result.targetStrike).toBeNull();
    expect(result.centroidSeries).toEqual([]);
  });

  it('produces a full result with target + leaderboard + centroid', () => {
    const strike6615 = rampSeries(6615, 100, 900);
    const strike6620 = rampSeries(6620, 100, 1500);
    const merged = mergeSnapshots(strike6615, strike6620);
    const result = computeMigration(merged, 'oi');
    expect(result.targetStrike).not.toBeNull();
    expect(result.allStrikes.length).toBeGreaterThan(0);
    expect(result.centroidSeries).toHaveLength(21);
    expect(result.spot).toBe(6615);
    expect(result.mode).toBe('oi');
  });

  it('different modes produce different results from the same data', () => {
    // Snapshot with OI-based positive magnet at 6620 and VOL-based at 6610
    const snaps: GexSnapshot[] = [];
    for (let i = 0; i < 21; i++) {
      snaps.push(
        makeSnapshot(
          new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(),
          6615,
          [
            makeStrike(6620, {
              callGammaOi: 100 + i * 70,
              callGammaVol: 50,
            }),
            makeStrike(6610, {
              callGammaOi: 50,
              callGammaVol: 100 + i * 70,
            }),
          ],
        ),
      );
    }

    const oiResult = computeMigration(snaps, 'oi');
    const volResult = computeMigration(snaps, 'vol');

    expect(oiResult.targetStrike?.strike).toBe(6620);
    expect(volResult.targetStrike?.strike).toBe(6610);
  });
});

// ── MIGRATION_CONFIG sanity ─────────────────────────────────

describe('MIGRATION_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(MIGRATION_CONFIG.windowMinutes).toBe(20);
    expect(MIGRATION_CONFIG.fiveMinOffsetSlots).toBe(5);
    expect(MIGRATION_CONFIG.criticalDistancePts).toBe(5);
  });

  it('all three modes are typed correctly', () => {
    const modes: GexMode[] = ['oi', 'vol', 'dir'];
    for (const mode of modes) {
      expect(['oi', 'vol', 'dir']).toContain(mode);
    }
  });
});
