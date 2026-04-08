/**
 * GEX migration math: tracks how per-strike gamma exposure shifts over time
 * to identify where price is being magnetically pulled by dealer hedging.
 *
 * The primary use case is directional-buy signal generation — finding the
 * strike with the fastest-growing positive gamma close to spot, so the user
 * can buy a cheap OTM option and profit as price drifts toward the magnet.
 *
 * All functions are pure and synchronous. The endpoint returns raw snapshot
 * rows and the component picks a `GexMode` at render time, so mode switching
 * is instant (no re-fetch).
 */

export type GexMode = 'oi' | 'vol' | 'dir';

/** Raw per-strike row as returned by the endpoint, normalized to numbers. */
export interface GexStrikeRow {
  strike: number;
  price: number;
  callGammaOi: number;
  putGammaOi: number;
  callGammaVol: number;
  putGammaVol: number;
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
}

/** A single point-in-time snapshot of the 0DTE per-strike GEX surface. */
export interface GexSnapshot {
  timestamp: string;
  price: number;
  strikes: GexStrikeRow[];
}

/** Per-strike migration metrics computed from a sequence of snapshots. */
export interface StrikeMigration {
  strike: number;
  distFromSpot: number;
  now: number;
  fiveMinAgo: number | null;
  twentyMinAgo: number | null;
  fiveMinPctDelta: number | null;
  twentyMinPctDelta: number | null;
  sparkline: number[];
  trendAgreement: boolean;
}

/** Confidence level of the target-strike signal. */
export type SignalConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/** The picked target strike — where price is most strongly being pulled. */
export interface TargetStrike {
  strike: number;
  distFromSpot: number;
  fiveMinPctDelta: number;
  twentyMinPctDelta: number;
  signalConf: SignalConfidence;
  sparkline: number[];
  label: 'CALL WALL' | 'PUT WALL' | 'AT SPOT';
  critical: boolean;
}

/** Gamma-weighted center of mass for one snapshot. */
export interface CentroidPoint {
  timestamp: string;
  value: number;
}

/** Full computed migration result for a single mode. */
export interface GexMigrationResult {
  mode: GexMode;
  spot: number;
  asOf: string;
  targetStrike: TargetStrike | null;
  allStrikes: StrikeMigration[];
  centroidSeries: CentroidPoint[];
}

/** Config knobs — kept here so they're unit-testable and easy to tune. */
export const MIGRATION_CONFIG = {
  /** Window size in minutes for the 20-min trend and sparkline. */
  windowMinutes: 20,
  /** Snapshot offset for the short (5-min) comparison — 5 minutes back. */
  fiveMinOffsetSlots: 5,
  /** Critical distance: target strike within this many points of spot. */
  criticalDistancePts: 5,
  /** HIGH confidence threshold — both 5m and 20m exceed these magnitudes. */
  highConfFiveMin: 100,
  highConfTwentyMin: 200,
  /** MEDIUM confidence threshold. */
  medConfFiveMin: 50,
  medConfTwentyMin: 100,
  /**
   * Proximity weight decay: score = pctDelta / (1 + dist² / proximityScale).
   * Higher scale = distance matters less. 100 chosen so a 10pt-away strike
   * gets ~50% of the weight of an at-spot strike.
   */
  proximityScale: 100,
} as const;

// ── Mode-aware accessors ─────────────────────────────────────

/**
 * Net gamma for a strike under the selected mode.
 * - `oi`:  standing open-interest × gamma (slow structural view)
 * - `vol`: today's volume × gamma (fast flow view)
 * - `dir`: directionalized bid/ask view (same sign convention as GexPerStrike)
 */
export function computeNetGamma(row: GexStrikeRow, mode: GexMode): number {
  if (mode === 'oi') return row.callGammaOi + row.putGammaOi;
  if (mode === 'vol') return row.callGammaVol + row.putGammaVol;
  return (
    row.callGammaAsk + row.callGammaBid + row.putGammaAsk + row.putGammaBid
  );
}

// ── Pure helpers ─────────────────────────────────────────────

/**
 * Percent change with safe handling of zero/missing baseline.
 * Uses absolute value in the denominator so a flip from negative → positive
 * produces a positive percent change rather than a sign-flipped one.
 */
export function pctChange(now: number, past: number | null): number | null {
  if (past == null) return null;
  if (past === 0) return null;
  return ((now - past) / Math.abs(past)) * 100;
}

/**
 * Gamma-weighted centroid across all strikes in a snapshot.
 * Uses absolute magnitude so negative-gamma strikes still contribute to the
 * center-of-mass calculation (otherwise negative strikes would cancel and
 * the centroid would lock to spot regardless of structure).
 * Falls back to the snapshot's spot price if every strike has zero gamma.
 */
export function computeCentroid(snapshot: GexSnapshot, mode: GexMode): number {
  let num = 0;
  let den = 0;
  for (const row of snapshot.strikes) {
    const g = Math.abs(computeNetGamma(row, mode));
    num += row.strike * g;
    den += g;
  }
  return den > 0 ? num / den : snapshot.price;
}

/**
 * Classify signal confidence from the magnitudes of the 5-min and 20-min
 * percent deltas. Requires trend agreement (same sign in both windows).
 */
export function classifySignalConf(
  fiveMinPctDelta: number | null,
  twentyMinPctDelta: number | null,
): SignalConfidence {
  if (fiveMinPctDelta == null || twentyMinPctDelta == null) return 'NONE';
  if (Math.sign(fiveMinPctDelta) !== Math.sign(twentyMinPctDelta)) return 'LOW';
  if (fiveMinPctDelta === 0 || twentyMinPctDelta === 0) return 'LOW';

  const fiveMag = Math.abs(fiveMinPctDelta);
  const twentyMag = Math.abs(twentyMinPctDelta);

  if (
    fiveMag >= MIGRATION_CONFIG.highConfFiveMin &&
    twentyMag >= MIGRATION_CONFIG.highConfTwentyMin
  ) {
    return 'HIGH';
  }
  if (
    fiveMag >= MIGRATION_CONFIG.medConfFiveMin &&
    twentyMag >= MIGRATION_CONFIG.medConfTwentyMin
  ) {
    return 'MEDIUM';
  }
  return 'LOW';
}

// ── Core computation ─────────────────────────────────────────

/**
 * For each strike present in any snapshot, compute the time series of net
 * gamma under the given mode and derive 5-min / 20-min percent deltas.
 *
 * Strikes that appear in some snapshots but not others (e.g. ATM band
 * shifting) are treated as 0 in the missing snapshots — acceptable since
 * the ±200pt ingestion window doesn't shift significantly in 20 minutes.
 */
export function buildStrikeMigrations(
  snapshots: GexSnapshot[],
  mode: GexMode,
): StrikeMigration[] {
  if (snapshots.length === 0) return [];

  const latest = snapshots.at(-1);
  if (!latest) return [];
  const spot = latest.price;

  const strikeSet = new Set<number>();
  for (const s of snapshots) {
    for (const row of s.strikes) strikeSet.add(row.strike);
  }
  const strikes = Array.from(strikeSet).sort((a, b) => a - b);

  const fiveMinIdx = snapshots.length - 1 - MIGRATION_CONFIG.fiveMinOffsetSlots;
  const twentyMinIdx = 0;

  const migrations: StrikeMigration[] = [];
  for (const strike of strikes) {
    const series: number[] = snapshots.map((snap) => {
      const row = snap.strikes.find((r) => r.strike === strike);
      return row ? computeNetGamma(row, mode) : 0;
    });

    const now = series.at(-1) ?? 0;
    const fiveMinAgo = fiveMinIdx >= 0 ? (series[fiveMinIdx] ?? null) : null;
    const twentyMinAgo =
      snapshots.length > MIGRATION_CONFIG.fiveMinOffsetSlots
        ? (series[twentyMinIdx] ?? null)
        : null;

    const fiveMinPctDelta = pctChange(now, fiveMinAgo);
    const twentyMinPctDelta = pctChange(now, twentyMinAgo);

    const trendAgreement =
      fiveMinPctDelta != null &&
      twentyMinPctDelta != null &&
      fiveMinPctDelta !== 0 &&
      twentyMinPctDelta !== 0 &&
      Math.sign(fiveMinPctDelta) === Math.sign(twentyMinPctDelta);

    migrations.push({
      strike,
      distFromSpot: strike - spot,
      now,
      fiveMinAgo,
      twentyMinAgo,
      fiveMinPctDelta,
      twentyMinPctDelta,
      sparkline: series,
      trendAgreement,
    });
  }

  return migrations;
}

/**
 * Select the target strike:
 *   "closest-to-spot positive-gamma strike with the highest 5-min Δ
 *    that is trend-confirmed by the 20-min"
 *
 * Candidates must have positive current net gamma (it's a *magnet*, not a
 * repellent), a positive 5-min delta (the magnet is strengthening), and
 * trend agreement (the 20-min direction also points up).
 *
 * Scoring: 5-min percent delta × proximity weight. The proximity weight is
 * `1 / (1 + dist² / proximityScale)` — a simple inverse-square pull with a
 * smoothing constant so at-spot strikes don't blow up and 1-2pt differences
 * barely matter, but 20pt+ differences dominate.
 */
export function selectTargetStrike(
  migrations: StrikeMigration[],
): TargetStrike | null {
  const candidates = migrations.filter(
    (m) =>
      m.now > 0 &&
      m.fiveMinPctDelta != null &&
      m.fiveMinPctDelta > 0 &&
      m.trendAgreement,
  );

  if (candidates.length === 0) return null;

  let best: StrikeMigration | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const dist = Math.abs(c.distFromSpot);
    const proximityWeight =
      1 / (1 + (dist * dist) / MIGRATION_CONFIG.proximityScale);
    const score = (c.fiveMinPctDelta ?? 0) * proximityWeight;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best) return null;

  const signalConf = classifySignalConf(
    best.fiveMinPctDelta,
    best.twentyMinPctDelta,
  );
  const critical =
    Math.abs(best.distFromSpot) <= MIGRATION_CONFIG.criticalDistancePts &&
    signalConf === 'HIGH';

  const label: TargetStrike['label'] =
    Math.abs(best.distFromSpot) < 0.5
      ? 'AT SPOT'
      : best.distFromSpot > 0
        ? 'CALL WALL'
        : 'PUT WALL';

  return {
    strike: best.strike,
    distFromSpot: best.distFromSpot,
    fiveMinPctDelta: best.fiveMinPctDelta ?? 0,
    twentyMinPctDelta: best.twentyMinPctDelta ?? 0,
    signalConf,
    sparkline: best.sparkline,
    label,
    critical,
  };
}

/**
 * Rank all strikes by |5-min Δ| descending. Used for the "urgency"
 * leaderboard in the UI — surfaces the fastest movers regardless of sign,
 * so both building magnets (positive Δ) and dissolving ones (negative Δ)
 * appear together.
 */
export function rankStrikesByUrgency(
  migrations: StrikeMigration[],
): StrikeMigration[] {
  return migrations
    .filter((m) => m.fiveMinPctDelta != null)
    .sort((a, b) => {
      const bAbs = Math.abs(b.fiveMinPctDelta ?? 0);
      const aAbs = Math.abs(a.fiveMinPctDelta ?? 0);
      return bAbs - aAbs;
    });
}

/**
 * Top-level orchestrator — takes raw snapshots and a mode, returns the full
 * computed result for the component to render. This is the single function
 * the component will call inside a `useMemo`.
 */
export function computeMigration(
  snapshots: GexSnapshot[],
  mode: GexMode,
): GexMigrationResult {
  if (snapshots.length === 0) {
    return {
      mode,
      spot: 0,
      asOf: '',
      targetStrike: null,
      allStrikes: [],
      centroidSeries: [],
    };
  }

  const latest = snapshots.at(-1)!;
  const migrations = buildStrikeMigrations(snapshots, mode);
  const targetStrike = selectTargetStrike(migrations);
  const allStrikes = rankStrikesByUrgency(migrations);
  const centroidSeries: CentroidPoint[] = snapshots.map((s) => ({
    timestamp: s.timestamp,
    value: computeCentroid(s, mode),
  }));

  return {
    mode,
    spot: latest.price,
    asOf: latest.timestamp,
    targetStrike,
    allStrikes,
    centroidSeries,
  };
}
