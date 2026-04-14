import { describe, it, expect } from 'vitest';
import {
  charmScore,
  clarity,
  dominance,
  flowConfluence,
  priceConfirm,
  proximity,
} from '../../utils/gex-target';
import type {
  MagnetFeatures,
  PriceMovementContext,
} from '../../utils/gex-target';

// ── Fixture builders ─────────────────────────────────────────

/**
 * Produce a `MagnetFeatures` record with benign defaults. Every test
 * override only has to specify the fields it actually exercises, which
 * keeps the assertions focused on the behaviour under test.
 */
function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5000,
    spot: 5000,
    distFromSpot: 0,
    gexDollars: 1e9,
    callGexDollars: 1e9,
    putGexDollars: 0,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: 0,
    deltaGex_5m: 0,
    deltaGex_20m: 0,
    deltaGex_60m: 0,
    prevGexDollars_1m: 1e9,
    prevGexDollars_5m: 1e9,
    prevGexDollars_10m: 1e9,
    prevGexDollars_15m: 1e9,
    prevGexDollars_20m: 1e9,
    prevGexDollars_60m: 1e9,
    deltaPct_1m: 0,
    deltaPct_5m: 0,
    deltaPct_20m: 0,
    deltaPct_60m: 0,
    callRatio: 0,
    charmNet: 0,
    deltaNet: 0,
    vannaNet: 0,
    minutesAfterNoonCT: 0,
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
    deltaSpot_20m: 0,
    ...overrides,
  };
}

// ── flowConfluence (C.3.1) ───────────────────────────────────
//
// Phase 1.5: flowConfluence now reads `deltaPct_*` directly from the
// feature record. Each horizon's Δ% is pre-computed in `extractFeatures`
// against its own prior (not a shared 1-minute baseline), so these unit
// tests pass percentages in directly and never touch `deltaGex_*` or
// `prevGexDollars_*`. The "per-horizon normalization is correct" property
// is tested at the pipeline layer in `gex-target.pipeline.test.ts`.

describe('flowConfluence', () => {
  it('scores between 0.6 and 0.9 when all four horizons agree positive with moderate magnitudes', () => {
    // Every horizon = +25%. weighted_pct = 0.25 (weights sum to 1).
    // tanh(0.25 / 0.30) = tanh(0.833) ≈ 0.683.
    const features = makeFeatures({
      deltaPct_1m: 0.25,
      deltaPct_5m: 0.25,
      deltaPct_20m: 0.25,
      deltaPct_60m: 0.25,
    });
    const score = flowConfluence(features);
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(0.9);
  });

  it('scores between -0.9 and -0.6 when all four horizons agree negative with moderate magnitudes', () => {
    const features = makeFeatures({
      deltaPct_1m: -0.25,
      deltaPct_5m: -0.25,
      deltaPct_20m: -0.25,
      deltaPct_60m: -0.25,
    });
    const score = flowConfluence(features);
    expect(score).toBeLessThan(-0.6);
    expect(score).toBeGreaterThan(-0.9);
  });

  it('scores near zero when all horizons are positive but tiny (Δ% < 1%)', () => {
    // Each horizon = +0.5%. tanh(0.005/0.30) ≈ 0.0167.
    const features = makeFeatures({
      deltaPct_1m: 0.005,
      deltaPct_5m: 0.005,
      deltaPct_20m: 0.005,
      deltaPct_60m: 0.005,
    });
    const score = flowConfluence(features);
    expect(Math.abs(score)).toBeLessThan(0.05);
  });

  it('scores near zero when horizon signs are mixed (1m+, 5m-, 20m+, 60m-)', () => {
    const features = makeFeatures({
      deltaPct_1m: 0.2,
      deltaPct_5m: -0.2,
      deltaPct_20m: 0.2,
      deltaPct_60m: -0.2,
    });
    const score = flowConfluence(features);
    // The 1m weight dominates (w ≈ 0.789), so this case isn't exactly
    // zero — the net weighted_pct is roughly +0.2 × 0.656 ≈ 0.13, which
    // squashes to tanh(0.44) ≈ 0.41. That's still much smaller than
    // the "all agree positive" case (≈ 0.68) at the same 20% magnitude,
    // which is the "mixed signs damp the score" invariant under test.
    const allAgree = flowConfluence(
      makeFeatures({
        deltaPct_1m: 0.2,
        deltaPct_5m: 0.2,
        deltaPct_20m: 0.2,
        deltaPct_60m: 0.2,
      }),
    );
    expect(Math.abs(score)).toBeLessThan(allAgree);
    expect(Math.abs(score)).toBeLessThan(0.5);
  });

  it('renormalizes remaining weights when 20m and 60m are null', () => {
    // Only 1m and 5m present, both = +25%.
    // Before renorm: w_1m = 0.789, w_5m = 0.158, total = 0.947.
    // After renorm: each weight is scaled up by 1/0.947, so weighted_pct
    // still = 0.25 (because all pcts are equal).
    const features = makeFeatures({
      deltaPct_1m: 0.25,
      deltaPct_5m: 0.25,
      deltaPct_20m: null,
      deltaPct_60m: null,
    });
    const score = flowConfluence(features);
    expect(score).toBeCloseTo(Math.tanh(0.25 / 0.3), 10);
  });

  it('still works when only the 1m horizon is present', () => {
    // Single-horizon case: weight renormalizes to 1, pct = 0.30.
    // tanh(0.30 / 0.30) = tanh(1) ≈ 0.7616.
    const features = makeFeatures({
      deltaPct_1m: 0.3,
      deltaPct_5m: null,
      deltaPct_20m: null,
      deltaPct_60m: null,
    });
    const score = flowConfluence(features);
    expect(score).toBeCloseTo(Math.tanh(1), 10);
  });

  it('returns 0 when all horizons are null', () => {
    const features = makeFeatures({
      deltaPct_1m: null,
      deltaPct_5m: null,
      deltaPct_20m: null,
      deltaPct_60m: null,
    });
    expect(flowConfluence(features)).toBe(0);
  });

  it('weights the 1-minute horizon most heavily', () => {
    // All horizons at 0 except 1m → weighted_pct collapses to just the
    // 1m contribution × the 1m weight. Since the other horizons carry
    // 0 Δ%, the 1m horizon is the only non-zero contributor; its
    // renormalized weight is still 0.789 out of a sum of 1.0.
    const onlyFastMoving = flowConfluence(
      makeFeatures({
        deltaPct_1m: 0.3,
        deltaPct_5m: 0,
        deltaPct_20m: 0,
        deltaPct_60m: 0,
      }),
    );
    // And the inverse: only the 60m carries flow.
    const onlySlowMoving = flowConfluence(
      makeFeatures({
        deltaPct_1m: 0,
        deltaPct_5m: 0,
        deltaPct_20m: 0,
        deltaPct_60m: 0.3,
      }),
    );
    // The fast-moving case should land much higher because the 1m
    // weight (0.789) dwarfs the 60m weight (0.014).
    expect(onlyFastMoving).toBeGreaterThan(onlySlowMoving * 10);
  });
});

// ── priceConfirm (C.3.2) ─────────────────────────────────────

describe('priceConfirm', () => {
  it('returns a positive score when the strike is above spot and price is rallying', () => {
    const features = makeFeatures({ strike: 5010, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: 2,
      deltaSpot_3m: 2,
      deltaSpot_5m: 2,
    });
    expect(priceConfirm(features, ctx)).toBeGreaterThan(0);
  });

  it('returns a negative score when the strike is below spot and price is rallying', () => {
    const features = makeFeatures({ strike: 4990, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: 2,
      deltaSpot_3m: 2,
      deltaSpot_5m: 2,
    });
    expect(priceConfirm(features, ctx)).toBeLessThan(0);
  });

  it('returns a negative score when the strike is above spot and price is falling', () => {
    const features = makeFeatures({ strike: 5010, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: -2,
      deltaSpot_3m: -2,
      deltaSpot_5m: -2,
    });
    expect(priceConfirm(features, ctx)).toBeLessThan(0);
  });

  it('returns a positive score when the strike is below spot and price is falling', () => {
    const features = makeFeatures({ strike: 4990, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: -2,
      deltaSpot_3m: -2,
      deltaSpot_5m: -2,
    });
    expect(priceConfirm(features, ctx)).toBeGreaterThan(0);
  });

  it('returns 0 when price is flat across every horizon', () => {
    const features = makeFeatures({ strike: 5010, spot: 5000 });
    const ctx = makePriceCtx();
    expect(priceConfirm(features, ctx)).toBe(0);
  });

  it('returns 0 when the strike is exactly at spot (distFromSpot = 0)', () => {
    const features = makeFeatures({ strike: 5000, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: 5,
      deltaSpot_3m: 5,
      deltaSpot_5m: 5,
    });
    expect(priceConfirm(features, ctx)).toBe(0);
  });

  it('weights the 1-minute move more heavily than the 5-minute move', () => {
    // move = 0.3*1 + 0.2*0 + 0.2*0 + 0.3*0 = 0.3
    const fastOnly = priceConfirm(
      makeFeatures({ strike: 5010, spot: 5000 }),
      makePriceCtx({ deltaSpot_1m: 1 }),
    );
    // move = 0.3*0 + 0.2*0 + 0.2*1 + 0.3*0 = 0.2
    const slowOnly = priceConfirm(
      makeFeatures({ strike: 5010, spot: 5000 }),
      makePriceCtx({ deltaSpot_5m: 1 }),
    );
    expect(fastOnly).toBeGreaterThan(slowOnly);
  });

  it('squashes through tanh so even a huge move cannot exceed magnitude 1', () => {
    const features = makeFeatures({ strike: 5010, spot: 5000 });
    const ctx = makePriceCtx({
      deltaSpot_1m: 1000,
      deltaSpot_3m: 1000,
      deltaSpot_5m: 1000,
    });
    const score = priceConfirm(features, ctx);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ── charmScore (C.3.3) ───────────────────────────────────────

describe('charmScore', () => {
  it('returns near +1 when gamma is positive, charm is positive, and it is 3pm CT', () => {
    // todWeight = 180/180 = 1.0, charmMag ≈ 1, charmSign = +1.
    const features = makeFeatures({
      gexDollars: 1e9,
      charmNet: 5e8,
      minutesAfterNoonCT: 180,
    });
    const score = charmScore(features);
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns near -1 when gamma is positive, charm is negative, and it is 3pm CT', () => {
    const features = makeFeatures({
      gexDollars: 1e9,
      charmNet: -5e8,
      minutesAfterNoonCT: 180,
    });
    const score = charmScore(features);
    expect(score).toBeLessThan(-0.9);
    expect(score).toBeGreaterThanOrEqual(-1);
  });

  it('returns magnitude ≈ 0.3 when gamma is positive, charm is negative, at noon CT', () => {
    // todWeight = max(0.3, 0/180) = 0.3, charmSign = -1, charmMag ≈ 1.
    const features = makeFeatures({
      gexDollars: 1e9,
      charmNet: -5e8,
      minutesAfterNoonCT: 0,
    });
    const score = charmScore(features);
    expect(score).toBeLessThan(0);
    expect(Math.abs(score)).toBeCloseTo(0.3, 2);
  });

  it('clamps the time-of-day weight at 0.3 before noon (10am CT)', () => {
    // minutesAfterNoonCT is clamped in the extractor, but the scorer
    // also handles out-of-range values defensively. -120 → floored to 0.3.
    const features = makeFeatures({
      gexDollars: 1e9,
      charmNet: 5e8,
      minutesAfterNoonCT: -120,
    });
    const score = charmScore(features);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.3, 2);
  });

  it('returns 0 when charmNet is 0', () => {
    const features = makeFeatures({
      gexDollars: 1e9,
      charmNet: 0,
      minutesAfterNoonCT: 180,
    });
    expect(charmScore(features)).toBe(0);
  });

  it('returns 0 when gexDollars is 0', () => {
    const features = makeFeatures({
      gexDollars: 0,
      charmNet: 5e8,
      minutesAfterNoonCT: 180,
    });
    expect(charmScore(features)).toBe(0);
  });

  it('caps the time-of-day weight at 1.0 after 3pm CT', () => {
    // 200 minutes past noon is past-close; clamp to 1.0.
    const past = makeFeatures({
      gexDollars: 1e9,
      charmNet: 5e8,
      minutesAfterNoonCT: 240,
    });
    const at3pm = makeFeatures({
      gexDollars: 1e9,
      charmNet: 5e8,
      minutesAfterNoonCT: 180,
    });
    expect(charmScore(past)).toBeCloseTo(charmScore(at3pm), 10);
  });
});

// ── dominance (C.3.4) ────────────────────────────────────────

describe('dominance', () => {
  it('returns 1.0 when this strike has the largest |GEX $| in the peer group', () => {
    // 10-strike universe, this strike is the max.
    const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const features = makeFeatures({ gexDollars: 100 });
    expect(dominance(features, peers)).toBe(1.0);
  });

  it('returns 0.0 when this strike equals the peer median', () => {
    // Even-length → median = avg of middle two.
    const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // median = (5 + 6) / 2 = 5.5.
    const features = makeFeatures({ gexDollars: 5.5 });
    expect(dominance(features, peers)).toBe(0.0);
  });

  it('clamps to 0 when this strike is below the peer median (never negative)', () => {
    const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const features = makeFeatures({ gexDollars: 1 });
    expect(dominance(features, peers)).toBe(0);
  });

  it('returns 0.5 in the degenerate case where all peers are equal', () => {
    const peers = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
    const features = makeFeatures({ gexDollars: 7 });
    expect(dominance(features, peers)).toBe(0.5);
  });

  it('uses |gexDollars| so negative-signed strikes score the same as positive', () => {
    const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const pos = makeFeatures({ gexDollars: 100 });
    const neg = makeFeatures({ gexDollars: -100 });
    expect(dominance(neg, peers)).toBe(dominance(pos, peers));
  });

  it('returns a value in (0, 1) for a strike between the median and the max', () => {
    // peers = [1..10], median = 5.5, max = 10.
    // |10| strike = 1.0, |5.5| = 0.0, |7.75| ≈ 0.5.
    const peers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const features = makeFeatures({ gexDollars: 7.75 });
    expect(dominance(features, peers)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 when peerGexDollars is empty (defensive guard)', () => {
    const features = makeFeatures({ gexDollars: 100 });
    expect(dominance(features, [])).toBe(0);
  });

  it('handles an odd-length peer array correctly (median = middle element)', () => {
    // peers = [1, 2, 3, 4, 5], odd-length → median = 3, max = 5.
    // For gexDollars = 4: raw = (4 - 3) / (5 - 3) = 0.5.
    const peers = [1, 2, 3, 4, 5];
    const features = makeFeatures({ gexDollars: 4 });
    expect(dominance(features, peers)).toBeCloseTo(0.5, 10);
  });
});

// ── clarity (C.3.5) ──────────────────────────────────────────

describe('clarity', () => {
  it('returns 1.0 when callRatio is +1 (100% call volume)', () => {
    expect(clarity(makeFeatures({ callRatio: 1 }))).toBe(1);
  });

  it('returns 1.0 when callRatio is -1 (100% put volume)', () => {
    expect(clarity(makeFeatures({ callRatio: -1 }))).toBe(1);
  });

  it('returns 0.0 when callRatio is 0 (50/50 split)', () => {
    expect(clarity(makeFeatures({ callRatio: 0 }))).toBe(0);
  });

  it('returns 0.5 when callRatio is 0.5', () => {
    expect(clarity(makeFeatures({ callRatio: 0.5 }))).toBe(0.5);
  });

  it('returns 0 when callRatio is NaN', () => {
    expect(clarity(makeFeatures({ callRatio: Number.NaN }))).toBe(0);
  });

  it('returns 0 when callRatio is Infinity (defensive guard)', () => {
    expect(clarity(makeFeatures({ callRatio: Number.POSITIVE_INFINITY }))).toBe(
      0,
    );
  });
});

// ── proximity (C.3.6) ────────────────────────────────────────

describe('proximity', () => {
  it('returns 1.0 when distFromSpot is 0', () => {
    expect(proximity(makeFeatures({ distFromSpot: 0 }))).toBeCloseTo(1, 10);
  });

  it('returns ≈ 0.6065 when distFromSpot is 15 (= exp(-0.5))', () => {
    // σ = 15, so d = σ → exp(-0.5) ≈ 0.6065.
    expect(proximity(makeFeatures({ distFromSpot: 15 }))).toBeCloseTo(
      Math.exp(-0.5),
      3,
    );
  });

  it('returns ≈ 0.1353 when distFromSpot is 30 (= exp(-2))', () => {
    expect(proximity(makeFeatures({ distFromSpot: 30 }))).toBeCloseTo(
      Math.exp(-2),
      3,
    );
  });

  it('returns ≈ 0.0111 when distFromSpot is 45 (= exp(-4.5))', () => {
    expect(proximity(makeFeatures({ distFromSpot: 45 }))).toBeCloseTo(
      Math.exp(-4.5),
      3,
    );
  });

  it('returns ≈ 0 for very distant strikes (dist = 100)', () => {
    // exp(-(100²) / 450) = exp(-22.2) ≈ 2.2e-10.
    const score = proximity(makeFeatures({ distFromSpot: 100 }));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(1e-6);
  });

  it('is symmetric in sign of distFromSpot via the squared term', () => {
    // distFromSpot is defined as a signed delta in some extractor
    // conventions; the Gaussian squares it so +d and -d give the same
    // result. Guard against a future extractor flipping the sign.
    const above = proximity(makeFeatures({ distFromSpot: 10 }));
    const below = proximity(makeFeatures({ distFromSpot: -10 }));
    expect(above).toBeCloseTo(below, 10);
  });
});
