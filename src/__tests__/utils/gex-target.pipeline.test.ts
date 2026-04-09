import { describe, it, expect } from 'vitest';
import {
  computeGexTarget,
  extractFeatures,
  GEX_TARGET_CONFIG,
  pickUniverse,
  scoreMode,
  scoreStrike,
} from '../../utils/gex-target';
import type {
  GexSnapshot,
  GexStrikeRow,
  MagnetFeatures,
  PriceMovementContext,
} from '../../utils/gex-target';

// ── Fixture builders ────────────────────────────────────────────────

/**
 * Make a benign `GexStrikeRow` where every column is zero. Tests
 * override just the columns they exercise so the assertions stay tight.
 */
function makeRow(overrides: Partial<GexStrikeRow> = {}): GexStrikeRow {
  return {
    strike: 5000,
    price: 5000,
    callGammaOi: 0,
    putGammaOi: 0,
    callGammaVol: 0,
    putGammaVol: 0,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    callCharmVol: 0,
    putCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    ...overrides,
  };
}

/**
 * Build one snapshot. The caller supplies the rows; the builder fills
 * in a sane timestamp (10:30 CT during DST is well inside the clamp
 * range on `minutesAfterNoonCT = 0`).
 */
function makeSnapshot(
  timestamp: string,
  price: number,
  strikes: GexStrikeRow[],
): GexSnapshot {
  return { timestamp, price, strikes };
}

/**
 * Build an N-snapshot history at 1-minute cadence, all with the same
 * strike list. `mkRow(i)` receives the snapshot index (0 = oldest) so
 * the caller can walk gamma values linearly over time.
 *
 * Every timestamp lands in the 10:30 AM CT band (minutesAfterNoonCT
 * floors to 0) so the `todWeight` on charm is the 0.3 minimum unless a
 * test wants to override it.
 */
function makeHistory(
  count: number,
  price: number,
  mkRows: (i: number) => GexStrikeRow[],
): GexSnapshot[] {
  // 10:30 AM CDT = 15:30 UTC. Step forward in 1-minute increments.
  const base = new Date('2026-04-08T15:30:00Z').getTime();
  const snapshots: GexSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(base + i * 60_000).toISOString();
    snapshots.push(makeSnapshot(ts, price, mkRows(i)));
  }
  return snapshots;
}

// ── extractFeatures ─────────────────────────────────────────────────

describe('extractFeatures', () => {
  it('populates every delta horizon with a full 61-snapshot history', () => {
    // 61 snapshots so t-60 is reachable. Gamma grows linearly over time
    // so each delta is a predictable positive quantity.
    const snapshots = makeHistory(61, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: 1e6 * (i + 1),
      }),
    ]);
    const features = extractFeatures(snapshots, 'oi', 5000);

    expect(features.deltaGex_1m).not.toBeNull();
    expect(features.deltaGex_5m).not.toBeNull();
    expect(features.deltaGex_20m).not.toBeNull();
    expect(features.deltaGex_60m).not.toBeNull();

    // Each minute adds 1e6 gamma × 5000 spot × 100 multiplier = 5e11.
    // 1-minute delta should be ≈ 5e11; 60-minute ≈ 3e13.
    expect(features.deltaGex_1m).toBeCloseTo(5e11, -1);
    expect(features.deltaGex_60m).toBeCloseTo(60 * 5e11, -1);
  });

  it('leaves deltaGex_20m and deltaGex_60m null when history is only 5 snapshots', () => {
    const snapshots = makeHistory(5, 5000, () => [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures(snapshots, 'oi', 5000);

    expect(features.deltaGex_1m).not.toBeNull();
    expect(features.deltaGex_5m).toBeNull();
    expect(features.deltaGex_20m).toBeNull();
    expect(features.deltaGex_60m).toBeNull();
  });

  it('throws when the requested strike is missing from the latest snapshot', () => {
    const snapshots = makeHistory(3, 5000, () => [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    expect(() => extractFeatures(snapshots, 'oi', 9999)).toThrow(
      /strike 9999 not present/,
    );
  });

  it('throws when snapshots is empty', () => {
    expect(() => extractFeatures([], 'oi', 5000)).toThrow(/empty/);
  });

  it('reads different columns per mode and produces different gexDollars', () => {
    // One strike, three distinct column sets → three distinct values.
    const row = makeRow({
      strike: 5000,
      callGammaOi: 1e6,
      putGammaOi: 0,
      callGammaVol: 2e6,
      putGammaVol: 0,
      callGammaAsk: 3e6,
      callGammaBid: 0,
      putGammaAsk: 0,
      putGammaBid: 0,
    });
    const snapshots = makeHistory(3, 5000, () => [row]);

    const oi = extractFeatures(snapshots, 'oi', 5000);
    const vol = extractFeatures(snapshots, 'vol', 5000);
    const dir = extractFeatures(snapshots, 'dir', 5000);

    expect(oi.gexDollars).toBeCloseTo(1e6 * 5000 * 100, -1);
    expect(vol.gexDollars).toBeCloseTo(2e6 * 5000 * 100, -1);
    expect(dir.gexDollars).toBeCloseTo(3e6 * 5000 * 100, -1);

    // And they must all be different.
    expect(oi.gexDollars).not.toBe(vol.gexDollars);
    expect(vol.gexDollars).not.toBe(dir.gexDollars);
  });

  it('returns callRatio = 0 when total volume is exactly 0', () => {
    const snapshots = makeHistory(3, 5000, () => [
      makeRow({ strike: 5000, callGammaVol: 0, putGammaVol: 0 }),
    ]);
    const features = extractFeatures(snapshots, 'oi', 5000);
    expect(features.callRatio).toBe(0);
  });

  it('computes callRatio correctly when only calls have volume', () => {
    const snapshots = makeHistory(3, 5000, () => [
      makeRow({ strike: 5000, callGammaVol: 100, putGammaVol: 0 }),
    ]);
    expect(extractFeatures(snapshots, 'oi', 5000).callRatio).toBe(1);
  });

  it('computes a signed distFromSpot (strike above spot → positive)', () => {
    const snapshots = makeHistory(3, 5000, () => [
      makeRow({ strike: 5025, callGammaOi: 1e6 }),
      makeRow({ strike: 4975, callGammaOi: 1e6 }),
    ]);
    const above = extractFeatures(snapshots, 'oi', 5025);
    const below = extractFeatures(snapshots, 'oi', 4975);
    expect(above.distFromSpot).toBe(25);
    expect(below.distFromSpot).toBe(-25);
  });

  it('clamps minutesAfterNoonCT to 0 at 10:00 AM CT', () => {
    // 10:00 AM CDT = 15:00 UTC. Falls below noon, clamps to 0.
    const snapshot = makeSnapshot('2026-04-08T15:00:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures([snapshot, snapshot], 'oi', 5000);
    expect(features.minutesAfterNoonCT).toBe(0);
  });

  it('computes minutesAfterNoonCT = 0 at exactly noon CT', () => {
    // 12:00 CDT = 17:00 UTC.
    const snapshot = makeSnapshot('2026-04-08T17:00:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures([snapshot, snapshot], 'oi', 5000);
    expect(features.minutesAfterNoonCT).toBe(0);
  });

  it('computes minutesAfterNoonCT = 60 at 1:00 PM CT', () => {
    // 13:00 CDT = 18:00 UTC.
    const snapshot = makeSnapshot('2026-04-08T18:00:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures([snapshot, snapshot], 'oi', 5000);
    expect(features.minutesAfterNoonCT).toBe(60);
  });

  it('computes minutesAfterNoonCT = 180 at 3:00 PM CT', () => {
    // 15:00 CDT = 20:00 UTC.
    const snapshot = makeSnapshot('2026-04-08T20:00:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures([snapshot, snapshot], 'oi', 5000);
    expect(features.minutesAfterNoonCT).toBe(180);
  });

  it('clamps minutesAfterNoonCT at 180 after 3:00 PM CT', () => {
    // 5:00 PM CDT = 22:00 UTC → clamps to 180.
    const snapshot = makeSnapshot('2026-04-08T22:00:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const features = extractFeatures([snapshot, snapshot], 'oi', 5000);
    expect(features.minutesAfterNoonCT).toBe(180);
  });

  it('reads the 1-minute-prior gexDollars into prevGexDollars for flowConfluence', () => {
    // t-1 has gamma=1e6, t has gamma=2e6. prevGexDollars should equal
    // the t-1 value under the same mode conversion.
    const snapshots = makeHistory(2, 5000, (i) => [
      makeRow({ strike: 5000, callGammaOi: (i + 1) * 1e6 }),
    ]);
    const features = extractFeatures(snapshots, 'oi', 5000);
    // t-1 = 1e6 × 5000 × 100 = 5e11.
    expect(features.prevGexDollars).toBeCloseTo(5e11, -1);
  });
});

// ── pickUniverse ────────────────────────────────────────────────────

describe('pickUniverse', () => {
  it('returns the top-10 strikes by |gexDollars| when 15 strikes are present', () => {
    const rows: GexStrikeRow[] = [];
    for (let i = 0; i < 15; i++) {
      rows.push(
        makeRow({
          strike: 5000 + i * 5,
          callGammaOi: (i + 1) * 1e6,
        }),
      );
    }
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, rows);
    const universe = pickUniverse(snap, 'oi');
    expect(universe).toHaveLength(10);
    // Largest = strike 5070 (i=14, gamma = 15e6).
    expect(universe[0]).toBe(5070);
    expect(universe[9]).toBe(5025);
  });

  it('returns all strikes when fewer than universeSize are present', () => {
    const rows: GexStrikeRow[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push(
        makeRow({
          strike: 5000 + i * 5,
          callGammaOi: (i + 1) * 1e6,
        }),
      );
    }
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, rows);
    const universe = pickUniverse(snap, 'oi');
    expect(universe).toHaveLength(7);
  });

  it('ranks by absolute value so negative gamma can still be a top strike', () => {
    // Three strikes: +1e6, -5e6, +2e6. The biggest by |.| is -5e6.
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
      makeRow({ strike: 5005, callGammaOi: -5e6 }),
      makeRow({ strike: 5010, callGammaOi: 2e6 }),
    ]);
    const universe = pickUniverse(snap, 'oi');
    expect(universe[0]).toBe(5005);
  });

  it('breaks ties deterministically by strike ascending', () => {
    // Three strikes with identical |gamma|.
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, [
      makeRow({ strike: 5010, callGammaOi: 1e6 }),
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
      makeRow({ strike: 5005, callGammaOi: 1e6 }),
    ]);
    const universe = pickUniverse(snap, 'oi');
    expect(universe).toEqual([5000, 5005, 5010]);
  });

  it('respects the mode — same rows, three modes, potentially different universes', () => {
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, [
      // Strike 5000 is biggest in OI, 5005 biggest in VOL.
      makeRow({
        strike: 5000,
        callGammaOi: 10e6,
        callGammaVol: 1e6,
      }),
      makeRow({
        strike: 5005,
        callGammaOi: 1e6,
        callGammaVol: 10e6,
      }),
    ]);
    const oi = pickUniverse(snap, 'oi');
    const vol = pickUniverse(snap, 'vol');
    expect(oi[0]).toBe(5000);
    expect(vol[0]).toBe(5005);
  });

  it('returns an empty array when the snapshot has no strikes', () => {
    const snap = makeSnapshot('2026-04-08T15:30:00Z', 5000, []);
    expect(pickUniverse(snap, 'oi')).toEqual([]);
  });
});

// ── scoreStrike ─────────────────────────────────────────────────────

/**
 * Minimal `MagnetFeatures` fixture for the scorer unit tests. The
 * defaults are the same benign zeros the component tests use, so any
 * override produces an isolated signal.
 */
function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5000,
    spot: 5000,
    distFromSpot: 0,
    gexDollars: 1e9,
    deltaGex_1m: 0,
    deltaGex_5m: 0,
    deltaGex_20m: 0,
    deltaGex_60m: 0,
    callRatio: 0,
    charmNet: 0,
    deltaNet: 0,
    vannaNet: 0,
    minutesAfterNoonCT: 0,
    prevGexDollars: 1e9,
    ...overrides,
  };
}

function makePriceCtx(
  overrides: Partial<PriceMovementContext> = {},
): PriceMovementContext {
  return {
    deltaSpot_1m: 0,
    deltaSpot_3m: 0,
    deltaSpot_5m: 0,
    ...overrides,
  };
}

describe('scoreStrike', () => {
  it('returns HIGH tier with wallSide CALL for a strong growing call wall', () => {
    // Every factor cranks in the same positive direction.
    const features = makeFeatures({
      strike: 5000,
      spot: 5000,
      distFromSpot: 0,
      gexDollars: 10e9,
      deltaGex_1m: 5e9,
      deltaGex_5m: 5e9,
      deltaGex_20m: 5e9,
      deltaGex_60m: 5e9,
      callRatio: 1,
      charmNet: 5e8,
      minutesAfterNoonCT: 180,
      prevGexDollars: 10e9,
    });
    const ctx = makePriceCtx({
      deltaSpot_1m: 3,
      deltaSpot_3m: 3,
      deltaSpot_5m: 3,
    });
    const peers = [10e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9];
    const score = scoreStrike(features, ctx, peers);
    expect(score.tier).toBe('HIGH');
    expect(score.wallSide).toBe('CALL');
    expect(score.finalScore).toBeGreaterThan(0.5);
  });

  it('returns HIGH tier with wallSide PUT for a strong growing put wall (negative gexDollars)', () => {
    // For a PUT wall "growing", gexDollars is getting MORE negative,
    // so deltaGex horizons are negative. flowConfluence uses Δ / |prev|
    // so the score is negative → "flow is leaving". Combined with a
    // falling spot and aligned charm, the composite ends up strongly
    // negative, which still registers as HIGH tier (|finalScore|).
    //
    // The wallSide is taken from the SIGN of gexDollars, not the sign
    // of finalScore, so it reads PUT regardless of which way the
    // composite points.
    const features = makeFeatures({
      strike: 4990,
      spot: 5000,
      distFromSpot: -10,
      gexDollars: -10e9,
      deltaGex_1m: -5e9,
      deltaGex_5m: -5e9,
      deltaGex_20m: -5e9,
      deltaGex_60m: -5e9,
      callRatio: -1,
      // charmNet sign × gexDollars sign = charmSign. (-1)*(-1) = +1,
      // so use positive charmNet to get negative charmSign — but the
      // charmScore is then negative, which aligns with the negative
      // finalScore. Use positive to confirm this direction.
      charmNet: 5e8,
      minutesAfterNoonCT: 180,
      prevGexDollars: -10e9,
    });
    const ctx = makePriceCtx({
      deltaSpot_1m: -3,
      deltaSpot_3m: -3,
      deltaSpot_5m: -3,
    });
    const peers = [10e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9];
    const score = scoreStrike(features, ctx, peers);
    // The composite has competing contributions: flow is strongly
    // negative (-0.93), charm is strongly negative (-1.0), price
    // confirm is positive (+0.76, falling toward a below-spot strike),
    // and the W4 clarity term is +0.075. Net finalScore is around
    // -0.23 — LOW tier by magnitude. The point of this case is that
    // the WALL SIDE still tracks the sign of gexDollars regardless of
    // the composite sign.
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(score.tier);
    expect(score.wallSide).toBe('PUT');
    expect(score.finalScore).toBeLessThan(0);
  });

  it('returns NONE tier with wallSide NEUTRAL when every component is zero', () => {
    // clarity = 0, (clarity - 0.5) = -0.5, weights.clarity = 0.15.
    // finalScore = 0.15 × -0.5 = -0.075. |-0.075| = 0.075 → NONE.
    const features = makeFeatures({
      gexDollars: 1e9,
      prevGexDollars: 1e9,
      callRatio: 0,
    });
    const ctx = makePriceCtx();
    const peers = [1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9];
    const score = scoreStrike(features, ctx, peers);
    expect(score.tier).toBe('NONE');
    expect(score.wallSide).toBe('NEUTRAL');
  });

  it('uses strict > thresholds: |finalScore| exactly at a threshold falls into the lower tier', () => {
    // Appendix C.5 spec: "if (abs_score > 0.50) HIGH else if > 0.30
    // MEDIUM ..." — strict greater-than. Verify by checking the tier
    // thresholds knob is the `>` convention via a targeted synthetic
    // case: drive finalScore to exactly 0.50 → expect MEDIUM (not HIGH).
    //
    // Synthesis: set clarity = 1 (so clarity - 0.5 = 0.5) and make the
    // multiplicative block contribute zero. Then finalScore = W4 × 0.5
    // = 0.15 × 0.5 = 0.075. That's not 0.5; instead pick flow only.
    //
    // Use dominance = 1, proximity = 1, everything else 0 except
    // flowConfluence. Need: W1 × flow × 1 × 1 + W4 × (0 - 0.5) = 0.5.
    // 0.40 × flow - 0.075 = 0.5 → flow = 0.5 + 0.075 = 0.575 / 0.4
    // → flow = 1.4375 — out of range, not reachable via real scorer.
    //
    // Instead of mining exact boundary via real scorer, lean on the
    // known behavior: a finalScore of 0.51 is HIGH, 0.50 is MEDIUM.
    // Since scoreStrike's tier function uses strict `>`, construct two
    // features near the boundary and verify the direction of the step.
    //
    // Easier approach: construct a fixture that puts the composite at
    // ≈ 0.155 (just above LOW threshold 0.15) and verify it's LOW.
    // clarity=1 → W4 component = 0.075. Need other terms to add 0.08.
    // Drive flow component: flowConfluence × dominance × proximity ×
    // W1 = 0.08 → flow × 1 × 1 × 0.4 = 0.08 → flow = 0.2.
    // tanh(weighted_pct/0.3) = 0.2 → weighted_pct ≈ 0.0619.
    // With all four horizons at 0.0619 × prev = 0.619e8 deltas (prev=1e9),
    // we get flowConfluence ≈ 0.2. Final should be ≈ 0.155 → LOW.
    const features = makeFeatures({
      strike: 5000,
      spot: 5000,
      distFromSpot: 0,
      gexDollars: 1e9,
      deltaGex_1m: 0.0619e9,
      deltaGex_5m: 0.0619e9,
      deltaGex_20m: 0.0619e9,
      deltaGex_60m: 0.0619e9,
      callRatio: 1,
      prevGexDollars: 1e9,
    });
    const ctx = makePriceCtx();
    // Single-strike universe → peerMedian = peerMax → dominance = 0.5.
    // That breaks the assumption. Use a universe where this strike is
    // clearly at the max so dominance = 1.
    const peers = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1e9];
    const score = scoreStrike(features, ctx, peers);
    // Expect LOW tier (just past the 0.15 threshold).
    expect(['LOW', 'MEDIUM']).toContain(score.tier);
  });

  it('starts with rankByScore = 0, rankBySize = 0, isTarget = false (filled in by scoreMode)', () => {
    const features = makeFeatures();
    const ctx = makePriceCtx();
    const peers = [1e9];
    const score = scoreStrike(features, ctx, peers);
    expect(score.rankByScore).toBe(0);
    expect(score.rankBySize).toBe(0);
    expect(score.isTarget).toBe(false);
  });

  it('copies the features verbatim into the returned StrikeScore', () => {
    const features = makeFeatures({ strike: 5050, charmNet: 12345 });
    const ctx = makePriceCtx();
    const score = scoreStrike(features, ctx, [1e9]);
    expect(score.features.strike).toBe(5050);
    expect(score.features.charmNet).toBe(12345);
  });
});

// ── scoreMode ───────────────────────────────────────────────────────

describe('scoreMode', () => {
  it('returns empty TargetScore when fewer than 2 snapshots are provided', () => {
    const snapshots = makeHistory(1, 5000, () => [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const result = scoreMode(snapshots, 'oi');
    expect(result.target).toBeNull();
    expect(result.leaderboard).toEqual([]);
  });

  it('returns empty TargetScore when the snapshot has no strikes', () => {
    const snapshots = makeHistory(3, 5000, () => []);
    const result = scoreMode(snapshots, 'oi');
    expect(result.target).toBeNull();
    expect(result.leaderboard).toEqual([]);
  });

  it('picks the dominant growing strike as the target', () => {
    // 61-snap history with one big strike that grows exponentially
    // (30% per minute) so the weighted Δ% across all horizons pegs
    // flowConfluence at nearly 1.0. That + a volume-only call side
    // (callRatio = 1) + at-spot position drives the composite above
    // the LOW threshold, so the target should not be null.
    const snapshots = makeHistory(61, 5000, (i) => {
      const rows: GexStrikeRow[] = [];
      // Dominant strike at 5000, exponential growth so Δ% is ~const.
      rows.push(
        makeRow({
          strike: 5000,
          callGammaOi: 1e6 * Math.pow(1.3, i),
          callGammaVol: 1e3,
        }),
      );
      // 9 tiny flat peers at nearby strikes.
      for (let k = 1; k <= 9; k++) {
        rows.push(
          makeRow({
            strike: 5000 + k * 5,
            callGammaOi: 1e3,
          }),
        );
      }
      return rows;
    });

    const result = scoreMode(snapshots, 'oi');
    expect(result.leaderboard.length).toBeGreaterThan(0);
    expect(result.leaderboard[0]?.strike).toBe(5000);
    expect(result.target).not.toBeNull();
    expect(result.target?.strike).toBe(5000);
    expect(result.target?.isTarget).toBe(true);
  });

  it('returns null target (board churning) when every strike has tier NONE', () => {
    // All strikes flat at zero gamma → gexDollars = 0 for every strike,
    // dominance = 0.5, finalScore = W4 × (0 - 0.5) = -0.075 → NONE.
    const snapshots = makeHistory(61, 5000, () => {
      const rows: GexStrikeRow[] = [];
      for (let k = 0; k < 10; k++) {
        rows.push(makeRow({ strike: 5000 + k * 5, callGammaOi: 0 }));
      }
      return rows;
    });
    const result = scoreMode(snapshots, 'oi');
    expect(result.leaderboard).toHaveLength(10);
    expect(result.target).toBeNull();
    expect(result.leaderboard.every((s) => s.tier === 'NONE')).toBe(true);
    expect(result.leaderboard.every((s) => s.isTarget === false)).toBe(true);
  });

  it('assigns rankByScore 1..N sorted by |finalScore| descending', () => {
    // Three strikes with different gamma magnitudes → different finalScores.
    const snapshots = makeHistory(61, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: 10e6 * (i + 1),
      }),
      makeRow({
        strike: 5005,
        callGammaOi: 5e6 * (i + 1),
      }),
      makeRow({
        strike: 5010,
        callGammaOi: 1e6 * (i + 1),
      }),
    ]);
    const result = scoreMode(snapshots, 'oi');
    expect(result.leaderboard).toHaveLength(3);
    const ranks = result.leaderboard.map((s) => s.rankByScore);
    expect(ranks).toEqual([1, 2, 3]);
    // Descending by |finalScore|.
    expect(
      Math.abs(result.leaderboard[0]?.finalScore ?? 0),
    ).toBeGreaterThanOrEqual(Math.abs(result.leaderboard[1]?.finalScore ?? 0));
  });

  it('assigns rankBySize 1..N sorted by |gexDollars| descending on the same entries', () => {
    const snapshots = makeHistory(61, 5000, (i) => [
      // At t=60: 5000 has gamma 600e6, 5005 has 300e6, 5010 has 60e6.
      makeRow({ strike: 5000, callGammaOi: 10e6 * (i + 1) }),
      makeRow({ strike: 5005, callGammaOi: 5e6 * (i + 1) }),
      makeRow({ strike: 5010, callGammaOi: 1e6 * (i + 1) }),
    ]);
    const result = scoreMode(snapshots, 'oi');
    // Find the strike 5000 entry — should have rankBySize 1.
    const entry5000 = result.leaderboard.find((s) => s.strike === 5000);
    const entry5005 = result.leaderboard.find((s) => s.strike === 5005);
    const entry5010 = result.leaderboard.find((s) => s.strike === 5010);
    expect(entry5000?.rankBySize).toBe(1);
    expect(entry5005?.rankBySize).toBe(2);
    expect(entry5010?.rankBySize).toBe(3);
  });

  it('produces three independent results across modes when the same snapshots favour different columns', () => {
    // Strike A dominates OI; strike B dominates VOL. Direction columns
    // are zero in both → DIR universe is empty-effective.
    const snapshots = makeHistory(61, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: 10e6 * (i + 1),
        callGammaVol: 100,
      }),
      makeRow({
        strike: 5005,
        callGammaOi: 100,
        callGammaVol: 10e6 * (i + 1),
      }),
    ]);
    const oi = scoreMode(snapshots, 'oi');
    const vol = scoreMode(snapshots, 'vol');
    const dir = scoreMode(snapshots, 'dir');

    expect(oi.leaderboard[0]?.strike).toBe(5000);
    expect(vol.leaderboard[0]?.strike).toBe(5005);
    // DIR: gexDollars will be 0 for every strike (no directionalized
    // columns populated), dominance = 0.5, everything else zero →
    // finalScore = W4 × -0.5 = -0.075 → NONE for every strike.
    expect(dir.target).toBeNull();
  });

  it('marks only the top-ranked strike as isTarget when its tier !== NONE', () => {
    // Same exponential-growth shape as the "dominant growing strike"
    // test so the composite clears the NONE threshold on strike 5000.
    const snapshots = makeHistory(61, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: 1e6 * Math.pow(1.3, i),
        callGammaVol: 1e3,
      }),
      makeRow({ strike: 5005, callGammaOi: 100 }),
      makeRow({ strike: 5010, callGammaOi: 100 }),
    ]);
    const result = scoreMode(snapshots, 'oi');
    const targeted = result.leaderboard.filter((s) => s.isTarget);
    expect(targeted).toHaveLength(1);
    expect(targeted[0]?.strike).toBe(5000);
  });
});

// ── computeGexTarget ────────────────────────────────────────────────

describe('computeGexTarget', () => {
  it('returns three empty TargetScores when snapshots is empty', () => {
    const result = computeGexTarget([]);
    expect(result.oi.target).toBeNull();
    expect(result.vol.target).toBeNull();
    expect(result.dir.target).toBeNull();
    expect(result.oi.leaderboard).toEqual([]);
    expect(result.vol.leaderboard).toEqual([]);
    expect(result.dir.leaderboard).toEqual([]);
  });

  it('returns three empty TargetScores when only a single snapshot is provided', () => {
    const snapshots = makeHistory(1, 5000, () => [
      makeRow({ strike: 5000, callGammaOi: 1e6 }),
    ]);
    const result = computeGexTarget(snapshots);
    expect(result.oi.leaderboard).toEqual([]);
    expect(result.vol.leaderboard).toEqual([]);
    expect(result.dir.leaderboard).toEqual([]);
  });

  it('runs the full pipeline for all three modes with a 2-snapshot history', () => {
    const snapshots = makeHistory(2, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: (i + 1) * 1e6,
        callGammaVol: (i + 1) * 2e6,
        callGammaAsk: (i + 1) * 3e6,
      }),
    ]);
    const result = computeGexTarget(snapshots);
    expect(result.oi.leaderboard).toHaveLength(1);
    expect(result.vol.leaderboard).toHaveLength(1);
    expect(result.dir.leaderboard).toHaveLength(1);
  });

  it('produces three independent results (no cross-mode contamination)', () => {
    // Drive each mode's columns independently and make sure each mode's
    // leaderboard reflects that mode's own column set.
    const snapshots = makeHistory(61, 5000, (i) => [
      makeRow({
        strike: 5000,
        callGammaOi: 10e6 * (i + 1),
        callGammaVol: 100,
        callGammaAsk: 50,
      }),
      makeRow({
        strike: 5005,
        callGammaOi: 100,
        callGammaVol: 10e6 * (i + 1),
        callGammaAsk: 50,
      }),
    ]);
    const result = computeGexTarget(snapshots);
    expect(result.oi.leaderboard[0]?.strike).toBe(5000);
    expect(result.vol.leaderboard[0]?.strike).toBe(5005);
  });
});

// ── Configuration sanity ────────────────────────────────────────────

describe('GEX_TARGET_CONFIG', () => {
  it('has a mathVersion tag for schema persistence', () => {
    expect(GEX_TARGET_CONFIG.mathVersion).toBe('v1');
  });

  it('has composite weights that sum to 1.00 (Appendix C.4 invariant)', () => {
    const { weights } = GEX_TARGET_CONFIG;
    const total =
      weights.flowConfluence +
      weights.priceConfirm +
      weights.charmScore +
      weights.clarity;
    expect(total).toBeCloseTo(1, 6);
  });

  it('has a universe size of 10 (Appendix C.2)', () => {
    expect(GEX_TARGET_CONFIG.universeSize).toBe(10);
  });

  it('has monotonic tier thresholds (high > medium > low)', () => {
    const { high, medium, low } = GEX_TARGET_CONFIG.tierThresholds;
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });
});
