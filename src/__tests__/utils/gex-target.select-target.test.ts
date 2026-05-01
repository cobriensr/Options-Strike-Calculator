/**
 * `selectTarget` unit tests.
 *
 * Covers the live UI decision rule extracted from `GexTarget/index.tsx`:
 *   - Empty leaderboard → no target.
 *   - Primary 4-gate rule (tier, growing wall, priceConfirm, forward
 *     distance) wins when satisfied.
 *   - Each primary gate, in isolation, demotes a row past the primary
 *     rule into the fallback decision.
 *   - Fallback 2-gate rule (tier + growing wall) selects the next-best
 *     row when no row passes the primary rule.
 *   - No row passes either rule → null target, leaderboard returned
 *     re-scored.
 *   - The hook spread-copies its input — caller-owned arrays are not
 *     mutated.
 */
import { describe, it, expect } from 'vitest';
import { selectTarget } from '../../utils/gex-target';
import type {
  MagnetFeatures,
  PriceMovementContext,
  StrikeScore,
  Tier,
} from '../../utils/gex-target';

// ── Fixture builders ────────────────────────────────────────────────

/**
 * Build a `MagnetFeatures` record from a small set of overrides. Every
 * field is set to a benign zero unless the test names a specific value
 * — `selectTarget` only reads features through the component scorers,
 * so missing-data zeros effectively short-circuit each scorer to its
 * neutral output.
 */
function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5000,
    spot: 5000,
    distFromSpot: 0,
    gexDollars: 0,
    callGexDollars: 0,
    putGexDollars: 0,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: null,
    deltaGex_5m: null,
    deltaGex_20m: null,
    deltaGex_60m: null,
    prevGexDollars_1m: null,
    prevGexDollars_5m: null,
    prevGexDollars_10m: null,
    prevGexDollars_15m: null,
    prevGexDollars_20m: null,
    prevGexDollars_60m: null,
    deltaPct_1m: null,
    deltaPct_5m: null,
    deltaPct_20m: null,
    deltaPct_60m: null,
    callRatio: 0,
    charmNet: 0,
    deltaNet: 0,
    vannaNet: 0,
    minutesAfterNoonCT: 0,
    ...overrides,
  };
}

/**
 * Build a `StrikeScore` shell. The cron-side fields (`finalScore`,
 * `tier`, `wallSide`, `components`) are placeholders — `selectTarget`
 * recomputes all of them from `features` + `priceCtx` before deciding,
 * so test cases don't need to seed them with realistic values.
 */
function makeScore(overrides: Partial<StrikeScore> = {}): StrikeScore {
  return {
    strike: 5000,
    features: makeFeatures(),
    components: {
      flowConfluence: 0,
      priceConfirm: 0,
      charmScore: 0,
      dominance: 0,
      clarity: 0.5,
      proximity: 0,
    },
    finalScore: 0,
    tier: 'NONE' as Tier,
    wallSide: 'NEUTRAL',
    rankByScore: 1,
    rankBySize: 1,
    isTarget: false,
    ...overrides,
  };
}

/**
 * Features tuned so the live rescore lands above the HIGH tier
 * threshold (`|finalScore| > 0.5`):
 *   - Strong 1m flow drives `flowConfluence` near +1.
 *   - Spot 25 pts away → `proximity ≈ exp(-25^2/(2·15^2)) ≈ 0.25`.
 *   - But because `dominance` is unsigned and depends on peer momenta,
 *     constructing a deterministic single-strike score is fragile.
 *     Instead, `selectTarget` is invariant to the absolute score
 *     value — it only cares about ordering and tier — so we craft
 *     two strikes where one clearly outscores the other and let the
 *     rescore hash settle naturally.
 */
const ZERO_PRICE_CTX: PriceMovementContext = {
  deltaSpot_1m: 0,
  deltaSpot_3m: 0,
  deltaSpot_5m: 0,
  deltaSpot_20m: 0,
};

/**
 * Build features that push `flowConfluence` toward +1 and have positive
 * 5-minute delta so `attractingMomentum > 0` for a call wall above spot.
 *
 * `deltaGex_5m > 0` AND `gexDollars > 0` (call wall) ⇒ wall is growing.
 */
function strongCallWall(
  overrides: Partial<MagnetFeatures> = {},
): MagnetFeatures {
  return makeFeatures({
    spot: 5000,
    distFromSpot: 25,
    gexDollars: 5e8, // call wall (positive)
    deltaGex_1m: 1e8,
    deltaGex_5m: 5e8, // strongly growing
    deltaGex_20m: 5e8,
    deltaGex_60m: 5e8,
    prevGexDollars_1m: 4e8,
    prevGexDollars_5m: 1e8,
    prevGexDollars_20m: 1e8,
    prevGexDollars_60m: 1e8,
    // pct ≥ 30% pushes flowConfluence near +1 via tanh.
    deltaPct_1m: 0.3,
    deltaPct_5m: 5.0,
    deltaPct_20m: 5.0,
    deltaPct_60m: 5.0,
    callRatio: 0.8,
    charmNet: 1e8,
    minutesAfterNoonCT: 90,
    ...overrides,
  });
}

/**
 * Features for a STALE / shrinking call wall — `attractingMomentum ≤ 0`
 * because both the 5m and 20m deltas are non-positive. This row will
 * always fail both the primary AND fallback rules.
 */
function shrinkingCallWall(
  overrides: Partial<MagnetFeatures> = {},
): MagnetFeatures {
  return makeFeatures({
    spot: 5000,
    distFromSpot: 25,
    gexDollars: 5e8,
    deltaGex_1m: -1e7,
    deltaGex_5m: -1e8,
    deltaGex_20m: -1e8,
    deltaGex_60m: -1e8,
    prevGexDollars_1m: 6e8,
    prevGexDollars_5m: 6e8,
    prevGexDollars_20m: 6e8,
    prevGexDollars_60m: 6e8,
    deltaPct_1m: -0.05,
    deltaPct_5m: -0.05,
    deltaPct_20m: -0.05,
    deltaPct_60m: -0.05,
    callRatio: 0.5,
    minutesAfterNoonCT: 90,
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('selectTarget', () => {
  it('returns target=null and empty leaderboard for an empty input', () => {
    const result = selectTarget([], ZERO_PRICE_CTX);
    expect(result.target).toBeNull();
    expect(result.leaderboard).toEqual([]);
  });

  it('returns target=null when no row clears tier=NONE after rescoring', () => {
    // Both rows have zero features → every component scorer returns 0 →
    // finalScore = 0 → tier NONE → both rules reject.
    const result = selectTarget(
      [makeScore({ strike: 5000 }), makeScore({ strike: 5050 })],
      ZERO_PRICE_CTX,
    );
    expect(result.target).toBeNull();
    expect(result.leaderboard).toHaveLength(2);
    // Returned leaderboard has fresh scores written, but isTarget remains
    // false on every entry.
    for (const s of result.leaderboard) {
      expect(s.isTarget).toBe(false);
    }
  });

  it('selects the strong call wall under primary gates (above-spot, growing, +priceCtx)', () => {
    const strong = makeScore({
      strike: 5025,
      features: strongCallWall(),
    });
    const weak = makeScore({
      strike: 5050,
      features: strongCallWall({ deltaGex_5m: 1e7, deltaPct_5m: 0.05 }),
    });

    const priceCtx: PriceMovementContext = {
      deltaSpot_1m: 1.5,
      deltaSpot_3m: 2.5,
      deltaSpot_5m: 3.0,
      deltaSpot_20m: 5.0,
    };
    const result = selectTarget([strong, weak], priceCtx);

    expect(result.target).not.toBeNull();
    // The strong row outranks the weak one by both deltaGex_5m and
    // deltaPct_5m, so it wins the rescore-then-pick.
    expect(result.target?.strike).toBe(5025);
    expect(result.target?.isTarget).toBe(true);
    // Other rows are not marked.
    const others = result.leaderboard.filter((s) => s.strike !== 5025);
    for (const s of others) {
      expect(s.isTarget).toBe(false);
    }
  });

  it('falls back when no row clears |distFromSpot| >= 5 (at-spot exclusion)', () => {
    // One eligible-by-fallback strong wall sitting AT spot — primary
    // rule would reject it on the distance gate; fallback would accept.
    //
    // Two strikes so dominance differentiates them; the at-spot row is
    // the only one with positive attractingMomentum, so fallback picks it.
    const atSpot = makeScore({
      strike: 5000,
      features: strongCallWall({ distFromSpot: 0, spot: 5000 }),
    });
    const flat = makeScore({
      strike: 5050,
      features: makeFeatures({ spot: 5000, distFromSpot: 50 }),
    });

    const priceCtx: PriceMovementContext = {
      deltaSpot_1m: 1.5,
      deltaSpot_3m: 2.5,
      deltaSpot_5m: 3.0,
      deltaSpot_20m: 5.0,
    };
    const result = selectTarget([atSpot, flat], priceCtx);

    // Primary rule rejects (distance < 5); fallback accepts because tier
    // != NONE AND attractingMomentum > 0.
    expect(result.target?.strike).toBe(5000);
  });

  it('rejects rows whose wall is shrinking under both primary and fallback', () => {
    const shrinking = makeScore({
      strike: 5025,
      features: shrinkingCallWall(),
    });
    const result = selectTarget([shrinking], ZERO_PRICE_CTX);
    expect(result.target).toBeNull();
  });

  it('uses a fallback row when the primary rule excludes everything but a non-priceConfirm row', () => {
    // Strong wall ABOVE spot but priceCtx is moving DOWN — priceConfirm
    // for a call wall above spot becomes negative, primary rejects.
    // Fallback ignores priceConfirm and at-spot, so the strong row wins.
    //
    // Two strikes so `dominance` differentiates them — with a single
    // strike, peer momenta collapse to one entry and dominance = 0.5
    // for everyone, suppressing the composite below the LOW tier.
    const strong = makeScore({
      strike: 5025,
      features: strongCallWall({ distFromSpot: 25 }),
    });
    const flat = makeScore({
      strike: 5050,
      features: makeFeatures({ spot: 5000, distFromSpot: 50 }),
    });
    const downCtx: PriceMovementContext = {
      deltaSpot_1m: -0.5,
      deltaSpot_3m: -0.7,
      deltaSpot_5m: -0.8,
      deltaSpot_20m: -1.0,
    };
    const result = selectTarget([strong, flat], downCtx);
    // Mild negative priceConfirm should still leave the composite well
    // above the LOW tier. Primary rule rejects because priceConfirm < 0;
    // fallback accepts. Strong row wins.
    expect(result.target?.strike).toBe(5025);
    expect(result.target?.isTarget).toBe(true);
  });

  it('does not mutate the input leaderboard array or its rows', () => {
    const input: StrikeScore[] = [
      makeScore({ strike: 5025, features: strongCallWall() }),
    ];
    const inputCopy = JSON.parse(JSON.stringify(input)) as StrikeScore[];
    selectTarget(input, ZERO_PRICE_CTX);
    // Reference comparison — the hook may return a different array but
    // never mutates the one we passed.
    expect(input[0]!.isTarget).toBe(inputCopy[0]!.isTarget);
    expect(input[0]!.tier).toBe(inputCopy[0]!.tier);
    expect(input[0]!.finalScore).toBe(inputCopy[0]!.finalScore);
  });

  it('accepts a custom weights override (parameterization for testability)', () => {
    // Weights that zero every signal → every row scores 0 → every row
    // tiers NONE → no target selected even when features look strong.
    const strong = makeScore({
      strike: 5025,
      features: strongCallWall(),
    });
    const result = selectTarget([strong], ZERO_PRICE_CTX, {
      flowConfluence: 0,
      priceConfirm: 0,
      charmScore: 0,
      clarity: 0,
    });
    expect(result.target).toBeNull();
  });
});
