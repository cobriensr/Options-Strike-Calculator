/**
 * Top-level pipeline: universe selection, per-strike scoring,
 * per-mode ranking, and the three-mode entry point.
 *
 * Consumes the pure scorers from `./scorers.ts` and the feature
 * extractor from `./features.ts`; returns `TargetScore` records
 * ready for the hook/endpoint layer.
 */

import { GEX_TARGET_CONFIG } from './config';
import {
  charmScore,
  clarity,
  computeAttractingMomentum,
  dominance,
  flowConfluence,
  priceConfirm,
  proximity,
} from './scorers';
import { computeGexDollars, extractFeatures } from './features';
import { assignTier, assignWallSide } from './tiers';
import type {
  ComponentScores,
  GexSnapshot,
  MagnetFeatures,
  Mode,
  PriceMovementContext,
  StrikeScore,
  TargetScore,
} from './types';

// ── Universe selection ────────────────────────────────────────────────

/**
 * Pick the top-`universeSize` strikes by `|gexDollars|` in the given
 * mode. Returns an array of strike values (plain numbers) — the
 * features are extracted later by `extractFeatures`.
 *
 * Appendix C.2 "admission ticket": strikes without meaningful standing
 * gamma are ignored regardless of their flow story. A strike's raw
 * size is the filter that decides whether it even gets scored.
 *
 * Ties are broken by strike value ascending, so the ordering is
 * deterministic across runs (important for snapshot diffing).
 */
export function pickUniverse(
  latestSnapshot: GexSnapshot,
  mode: Mode,
): number[] {
  const withSize = latestSnapshot.strikes.map((row) => ({
    strike: row.strike,
    absGex: Math.abs(computeGexDollars(row, mode)),
  }));

  withSize.sort((a, b) => {
    if (a.absGex !== b.absGex) {
      return b.absGex - a.absGex;
    }
    return a.strike - b.strike;
  });

  return withSize.slice(0, GEX_TARGET_CONFIG.universeSize).map((x) => x.strike);
}

// ── Per-strike scoring ────────────────────────────────────────────────

/**
 * Score one strike. Calls all six component scorers, runs the composite
 * formula from Appendix C.4, assigns tier and wall side, and returns a
 * `StrikeScore` with `rankByScore` and `rankBySize` temporarily set to
 * 0 — `scoreMode` fills those in after sorting the full universe.
 *
 * `peerMomenta` MUST include this strike's own `computeAttractingMomentum`
 * value; it's the universe-wide array used by `dominance` to compute the
 * peer median and max for momentum-weighted dominance.
 */
export function scoreStrike(
  features: MagnetFeatures,
  priceCtx: PriceMovementContext,
  peerMomenta: number[],
): StrikeScore {
  const components: ComponentScores = {
    flowConfluence: flowConfluence(features),
    priceConfirm: priceConfirm(features, priceCtx),
    charmScore: charmScore(features),
    dominance: dominance(features, peerMomenta),
    clarity: clarity(features),
    proximity: proximity(features),
  };

  const { weights } = GEX_TARGET_CONFIG;
  const finalScore =
    weights.flowConfluence *
      components.flowConfluence *
      components.dominance *
      components.proximity +
    weights.priceConfirm *
      components.priceConfirm *
      components.dominance *
      components.proximity +
    weights.charmScore * components.charmScore * components.proximity +
    weights.clarity * (components.clarity - 0.5);

  const tier = assignTier(finalScore);
  const wallSide = assignWallSide(tier, features.gexDollars);

  return {
    strike: features.strike,
    features,
    components,
    finalScore,
    tier,
    wallSide,
    rankByScore: 0,
    rankBySize: 0,
    isTarget: false,
  };
}

// ── Mode-level pipeline ───────────────────────────────────────────────

/**
 * Compute board-level spot movement deltas once per snapshot sequence.
 * `priceConfirm` is the only consumer, and it needs 1/3/5 minute horizons.
 *
 * Missing history (fewer snapshots than required) falls back to 0 for
 * the missing horizons. This lets the pipeline produce usable scores
 * during the first few minutes of a session without the extractor
 * having to special-case the partial-window state.
 */
function computePriceMovementContext(
  snapshots: GexSnapshot[],
): PriceMovementContext {
  const latest = snapshots.at(-1);
  if (!latest) {
    return {
      deltaSpot_1m: 0,
      deltaSpot_3m: 0,
      deltaSpot_5m: 0,
      deltaSpot_20m: 0,
    };
  }

  const spotAtOffset = (offset: number): number => {
    const idx = snapshots.length - 1 - offset;
    if (idx < 0) return latest.price;
    return snapshots[idx]?.price ?? latest.price;
  };

  return {
    deltaSpot_1m: latest.price - spotAtOffset(1),
    deltaSpot_3m: latest.price - spotAtOffset(3),
    deltaSpot_5m: latest.price - spotAtOffset(5),
    // Falls back to 0 (same as current price) when fewer than 20
    // snapshots are available (early-session start-up window).
    deltaSpot_20m: latest.price - spotAtOffset(20),
  };
}

/**
 * Score one mode (OI, VOL, or DIR). This is the per-mode entry point:
 *
 * 1. Build the universe from the latest snapshot.
 * 2. Compute the board-level price movement context once.
 * 3. Extract features for each universe strike and score it.
 * 4. Sort by `|finalScore|` desc and assign `rankByScore`.
 * 5. Sort a copy by `|gexDollars|` desc and assign `rankBySize`.
 * 6. Set `isTarget = true` on the top-by-score strike iff its tier is
 *    not NONE. Otherwise the target is `null` and the panel renders
 *    "board churning" — this is the first-class no-confluence case.
 *
 * Returns an empty `TargetScore` when the input is too short to
 * compute a 1-minute delta (length < 2).
 */
export function scoreMode(snapshots: GexSnapshot[], mode: Mode): TargetScore {
  if (snapshots.length < 2) {
    return { target: null, leaderboard: [] };
  }

  const latest = snapshots.at(-1);
  if (!latest) {
    return { target: null, leaderboard: [] };
  }

  const universe = pickUniverse(latest, mode);
  if (universe.length === 0) {
    return { target: null, leaderboard: [] };
  }

  const priceCtx = computePriceMovementContext(snapshots);

  // Extract features for every strike in the universe first so we can
  // build the peer momentum array before scoring (dominance needs the
  // full peer set to compute median and max).
  const featuresList: MagnetFeatures[] = universe.map((strike) =>
    extractFeatures(snapshots, mode, strike),
  );
  const peerMomenta = featuresList.map(computeAttractingMomentum);

  const unranked: StrikeScore[] = featuresList.map((features) =>
    scoreStrike(features, priceCtx, peerMomenta),
  );

  // Rank by score: sort by |finalScore| desc, assign 1..N.
  const sortedByScore = [...unranked].sort(
    (a, b) => Math.abs(b.finalScore) - Math.abs(a.finalScore),
  );
  sortedByScore.forEach((entry, i) => {
    entry.rankByScore = i + 1;
  });

  // Rank by size: sort a copy by |gexDollars| desc, assign 1..N. We
  // write `rankBySize` onto the same objects — `unranked`/`sortedByScore`
  // reference the same records, so both ranks land on every entry.
  const sortedBySize = [...unranked].sort(
    (a, b) => Math.abs(b.features.gexDollars) - Math.abs(a.features.gexDollars),
  );
  sortedBySize.forEach((entry, i) => {
    entry.rankBySize = i + 1;
  });

  // Target selection: highest |finalScore| entry that satisfies two gates:
  //   (a) tier is not NONE — meaningful conviction above the noise floor.
  //   (b) attractingMomentum > 0 — the wall must be actively growing in
  //       its own direction over the 5m or 20m horizon. A call wall where
  //       deltaGex_5m and deltaGex_20m are both ≤ 0 has zero attracting
  //       momentum and is shrinking; it is ineligible regardless of its
  //       historical size or current charm signal.
  //
  // NOTE: priceConfirm is deliberately NOT a hard gate. It contributes to
  // the finalScore (0.25 weight), so a wall where price is temporarily
  // moving away scores lower but remains eligible. Hard-gating on
  // priceConfirm wrongly excludes a growing wall above spot during a
  // pullback — exactly the scenario where GEX physics should predict
  // price returning to the wall. The attractingMomentum gate (5m/20m)
  // is more robust than the 1m-dominated flowConfluence gate that it
  // replaces, and is internally consistent with the dominance scorer
  // which uses the same computeAttractingMomentum metric.

  const topTarget = sortedByScore.find(
    (entry) =>
      entry.tier !== 'NONE' && computeAttractingMomentum(entry.features) > 0,
  );
  if (topTarget) {
    topTarget.isTarget = true;
  }

  const target = topTarget ?? null;

  return { target, leaderboard: sortedByScore };
}

// ── Top-level pipeline ────────────────────────────────────────────────

/**
 * Top-level three-mode pipeline. Runs the OI, VOL, and DIR scoring
 * independently and returns all three results. The three are NOT
 * combined — the component decides which one to display, and the ML
 * pipeline trains on all three in parallel.
 *
 * Short-circuits to three empty `TargetScore`s when there's no history
 * (0 or 1 snapshot): no delta horizons can be computed from a single
 * snapshot, so every mode would produce degenerate scores anyway.
 */
export function computeGexTarget(snapshots: GexSnapshot[]): {
  oi: TargetScore;
  vol: TargetScore;
  dir: TargetScore;
} {
  if (snapshots.length < 2) {
    const empty: TargetScore = { target: null, leaderboard: [] };
    return { oi: empty, vol: empty, dir: empty };
  }
  return {
    oi: scoreMode(snapshots, 'oi'),
    vol: scoreMode(snapshots, 'vol'),
    dir: scoreMode(snapshots, 'dir'),
  };
}
