/**
 * Feature extraction — Layer 2 of the data architecture.
 *
 * Walks a sorted snapshot sequence and produces one `MagnetFeatures`
 * record per strike per mode. Includes all the per-mode compute
 * helpers (gex/charm/delta/vanna/callRatio) and the multi-horizon
 * delta reconstruction used by `flowConfluence`.
 *
 * Every function in this file is pure — no hidden mutation, no Date.now(),
 * no network, no database.
 */

import { GEX_TARGET_CONFIG } from './config';
import type { GexSnapshot, GexStrikeRow, MagnetFeatures, Mode } from './types';

// ── Mode-aware column accessors ───────────────────────────────────────

/**
 * Find the row for a given strike inside a snapshot. Returns `null`
 * when the strike isn't present — calling code decides whether that's
 * an error or a "null feature" signal.
 */
export function findStrikeRow(
  snapshot: GexSnapshot,
  strike: number,
): GexStrikeRow | null {
  return snapshot.strikes.find((row) => row.strike === strike) ?? null;
}

/**
 * Compute the call-side GEX dollars for a strike in a given mode.
 *
 * The UW API returns values that are already dollar-weighted (they
 * include the full gamma × OI × 100 shares × spot² × 0.01 calculation).
 * So these fields are used directly without further scaling.
 */
export function computeCallGex(row: GexStrikeRow, mode: Mode): number {
  switch (mode) {
    case 'oi':
      return row.callGammaOi;
    case 'vol':
      return row.callGammaVol;
    case 'dir':
      return row.callGammaAsk + row.callGammaBid;
  }
}

/** Compute the put-side GEX dollars for a strike in a given mode. */
export function computePutGex(row: GexStrikeRow, mode: Mode): number {
  switch (mode) {
    case 'oi':
      return row.putGammaOi;
    case 'vol':
      return row.putGammaVol;
    case 'dir':
      return row.putGammaAsk + row.putGammaBid;
  }
}

/**
 * Compute the signed net GEX dollars for a strike in a given mode.
 *
 * UW API values are already dollar-weighted — no further scaling needed.
 * DIR mode sums all four directionalized columns (ask + bid on calls and
 * puts) to get the net directionalized gamma magnitude.
 */
export function computeGexDollars(row: GexStrikeRow, mode: Mode): number {
  return computeCallGex(row, mode) + computePutGex(row, mode);
}

/**
 * Extract the net charm for a strike in a given mode. OI and DIR modes
 * both read the OI columns (UW does not expose directionalized charm);
 * only VOL mode reads the volume columns.
 */
function computeCharmNet(row: GexStrikeRow, mode: Mode): number {
  if (mode === 'vol') {
    return row.callCharmVol + row.putCharmVol;
  }
  return row.callCharmOi + row.putCharmOi;
}

/**
 * Extract the net delta (DEX) for a strike. UW only exposes OI-weighted
 * DEX, so every mode reads the same columns. DEX is stored but not
 * scored in v1 — see Appendix I of the plan doc.
 */
function computeDeltaNet(row: GexStrikeRow): number {
  return row.callDeltaOi + row.putDeltaOi;
}

/**
 * Extract the net vanna (VEX) for a strike in a given mode. Same
 * OI-vs-VOL convention as charm. VEX is stored but not scored in v1.
 */
function computeVannaNet(row: GexStrikeRow, mode: Mode): number {
  if (mode === 'vol') {
    return row.callVannaVol + row.putVannaVol;
  }
  return row.callVannaOi + row.putVannaOi;
}

/**
 * Compute the call-vs-put volume ratio for a strike. Always reads the
 * volume columns regardless of mode — clarity is intrinsically a
 * today's-flow concept, and using OI here would nuke intraday signal
 * on days where call OI happens to dwarf put OI or vice versa.
 *
 * Returns `0` when the total volume is 0 (no flow → no clarity).
 */
function computeCallRatio(row: GexStrikeRow): number {
  const total = row.callGammaVol + row.putGammaVol;
  if (total === 0) {
    return 0;
  }
  return (row.callGammaVol - row.putGammaVol) / total;
}

/**
 * Convert a snapshot timestamp into "minutes after noon CT", clamped
 * into `[0, 180]`.
 *
 * Uses `toLocaleString` with the `America/Chicago` timezone so the
 * conversion Just Works across CST/CDT without us having to know which
 * half of the year we're in. We extract hour + minute from the locale
 * string rather than doing UTC-offset arithmetic because DST transitions
 * would otherwise require a table.
 */
function computeMinutesAfterNoonCT(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  // en-GB gives a zero-padded 24-hour time we can slice cleanly.
  const timeString = date.toLocaleString('en-GB', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hourStr, minuteStr] = timeString.split(':');
  const hour = Number.parseInt(hourStr ?? '0', 10);
  const minute = Number.parseInt(minuteStr ?? '0', 10);
  const minutesAfterNoon = (hour - 12) * 60 + minute;
  return Math.max(0, Math.min(180, minutesAfterNoon));
}

/**
 * One horizon's three parallel representations: the prior-snapshot
 * gexDollars, the signed dollar delta vs that prior, and the Δ%
 * normalized against that same prior.
 *
 * `pct` is null when `prior` is null or exactly 0 (division would
 * produce a useless value). `delta` is null only when `prior` is null.
 */
interface HorizonValues {
  prior: number | null;
  delta: number | null;
  pct: number | null;
}

/**
 * Look up the prior-snapshot gexDollars for this strike at `offset`
 * positions before the latest snapshot, then derive the signed dollar
 * delta and the Δ% normalized against that same prior.
 *
 * Each horizon uses its own prior — **no shared baseline**. A 20-minute
 * horizon's Δ% is `(latest - prior_20m) / |prior_20m|`, not
 * `(latest - prior_20m) / |prior_1m|`. Using a shared baseline would
 * produce a meaningless ratio that the ML pipeline could not threshold.
 *
 * Returns all-null when the history is too short to reach back that
 * far, or when the prior snapshot is missing the strike entirely (new
 * listing mid-day). `flowConfluence` handles the null case by dropping
 * that horizon and renormalizing the remaining weights.
 */
function computeHorizon(
  snapshots: GexSnapshot[],
  offset: number,
  strike: number,
  mode: Mode,
  latestGexDollars: number,
): HorizonValues {
  const latestIdx = snapshots.length - 1;
  const priorIdx = latestIdx - offset;
  if (priorIdx < 0) {
    return { prior: null, delta: null, pct: null };
  }
  const priorSnapshot = snapshots[priorIdx];
  if (!priorSnapshot) {
    return { prior: null, delta: null, pct: null };
  }
  const priorRow = findStrikeRow(priorSnapshot, strike);
  if (!priorRow) {
    return { prior: null, delta: null, pct: null };
  }
  const prior = computeGexDollars(priorRow, mode);
  const delta = latestGexDollars - prior;
  const pct = prior !== 0 ? delta / Math.abs(prior) : null;
  return { prior, delta, pct };
}

// ── Public extractor ──────────────────────────────────────────────────

/**
 * Extract the per-strike `MagnetFeatures` for one strike in one mode.
 *
 * `snapshots` must be sorted ascending by timestamp (latest LAST). The
 * function reads the latest snapshot to get current gamma / charm /
 * volume columns, and walks back 1/5/20/60 snapshots to compute the
 * four delta horizons. Missing history produces `null` delta horizons —
 * `flowConfluence` handles the renormalization.
 *
 * Throws if the strike isn't present in the latest snapshot. Callers
 * should only invoke this with strikes returned by `pickUniverse`,
 * which guarantees presence.
 */
export function extractFeatures(
  snapshots: GexSnapshot[],
  mode: Mode,
  strike: number,
): MagnetFeatures {
  if (snapshots.length === 0) {
    throw new Error('extractFeatures: snapshots array is empty');
  }
  const latest = snapshots.at(-1);
  if (!latest) {
    throw new Error('extractFeatures: failed to read latest snapshot');
  }
  const latestRow = findStrikeRow(latest, strike);
  if (!latestRow) {
    throw new Error(
      `extractFeatures: strike ${strike} not present in latest snapshot`,
    );
  }

  const spot = latest.price;
  const gexDollars = computeGexDollars(latestRow, mode);
  const callGexDollars = computeCallGex(latestRow, mode);
  const putGexDollars = computePutGex(latestRow, mode);
  const { horizonOffsets } = GEX_TARGET_CONFIG;

  // Compute all four horizons in one pass. Each horizon call returns
  // the triple (prior, delta, pct) — storing all three in
  // MagnetFeatures preserves the Layer 2 (calculated inputs) state so
  // the ML pipeline can query any transformation without reconstructing.
  const h1m = computeHorizon(
    snapshots,
    horizonOffsets.h1m,
    strike,
    mode,
    gexDollars,
  );
  const h5m = computeHorizon(
    snapshots,
    horizonOffsets.h5m,
    strike,
    mode,
    gexDollars,
  );
  const h10m = computeHorizon(
    snapshots,
    horizonOffsets.h10m,
    strike,
    mode,
    gexDollars,
  );
  const h15m = computeHorizon(
    snapshots,
    horizonOffsets.h15m,
    strike,
    mode,
    gexDollars,
  );
  const h20m = computeHorizon(
    snapshots,
    horizonOffsets.h20m,
    strike,
    mode,
    gexDollars,
  );
  const h60m = computeHorizon(
    snapshots,
    horizonOffsets.h60m,
    strike,
    mode,
    gexDollars,
  );

  return {
    strike,
    spot,
    distFromSpot: strike - spot,
    gexDollars,
    callGexDollars,
    putGexDollars,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: h1m.delta,
    deltaGex_5m: h5m.delta,
    deltaGex_20m: h20m.delta,
    deltaGex_60m: h60m.delta,
    prevGexDollars_1m: h1m.prior,
    prevGexDollars_5m: h5m.prior,
    prevGexDollars_10m: h10m.prior,
    prevGexDollars_15m: h15m.prior,
    prevGexDollars_20m: h20m.prior,
    prevGexDollars_60m: h60m.prior,
    deltaPct_1m: h1m.pct,
    deltaPct_5m: h5m.pct,
    deltaPct_20m: h20m.pct,
    deltaPct_60m: h60m.pct,
    callRatio: computeCallRatio(latestRow),
    charmNet: computeCharmNet(latestRow, mode),
    deltaNet: computeDeltaNet(latestRow),
    vannaNet: computeVannaNet(latestRow, mode),
    minutesAfterNoonCT: computeMinutesAfterNoonCT(latest.timestamp),
  };
}
