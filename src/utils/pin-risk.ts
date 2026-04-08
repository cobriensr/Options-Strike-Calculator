import type { ChainStrike } from '../types/api';

/**
 * Strikes within this fraction of spot are considered "pin zone" — high-OI
 * strikes near ATM that can gravitationally pull price toward them near
 * settlement due to dealer delta-hedging. Default: 0.5% of spot.
 *
 * Shared with `PinRiskAnalysis.tsx` so the inclusion logic in
 * `getTopOIStrikes` and the "PIN" styling in the component always use the
 * same threshold.
 */
export const PIN_ZONE_PCT = 0.005;

export interface OIStrike {
  strike: number;
  putOI: number;
  callOI: number;
  totalOI: number;
  distFromSpot: number;
  distPct: string;
  side: 'put' | 'call' | 'both';
}

/**
 * Combines put and call OI at each strike and returns a merged list of:
 *   1. the top `topN` strikes ranked by total OI (global view), plus
 *   2. every strike within `pinProximityPct` of spot, regardless of rank.
 *
 * The merged result is deduplicated by strike and sorted by total OI
 * descending. This guarantees near-spot pin candidates are never missed
 * just because they ranked below the global top-N by absolute OI. The
 * returned array can exceed `topN` when near-spot strikes fall outside
 * the global top-N.
 *
 * Pass `pinProximityPct = 0` to disable near-spot inclusion and get the
 * strict top-N-by-OI behavior.
 */
export function getTopOIStrikes(
  puts: readonly ChainStrike[],
  calls: readonly ChainStrike[],
  spot: number,
  topN: number = 8,
  pinProximityPct: number = PIN_ZONE_PCT,
): OIStrike[] {
  const oiMap = new Map<number, { putOI: number; callOI: number }>();

  for (const p of puts) {
    const entry = oiMap.get(p.strike) ?? { putOI: 0, callOI: 0 };
    entry.putOI += p.oi;
    oiMap.set(p.strike, entry);
  }
  for (const c of calls) {
    const entry = oiMap.get(c.strike) ?? { putOI: 0, callOI: 0 };
    entry.callOI += c.oi;
    oiMap.set(c.strike, entry);
  }

  const strikes: OIStrike[] = [];
  for (const [strike, { putOI, callOI }] of oiMap) {
    const totalOI = putOI + callOI;
    if (totalOI === 0) continue;
    const distFromSpot = strike - spot;
    strikes.push({
      strike,
      putOI,
      callOI,
      totalOI,
      distFromSpot,
      distPct: ((distFromSpot / spot) * 100).toFixed(2),
      side: putOI > callOI * 2 ? 'put' : callOI > putOI * 2 ? 'call' : 'both',
    });
  }

  strikes.sort((a, b) => b.totalOI - a.totalOI);
  const topByOI = strikes.slice(0, topN);

  // Always include near-spot strikes, regardless of where they fall in
  // the global OI ranking. Guarded on spot > 0 to avoid division by zero.
  const nearSpot =
    spot > 0 && pinProximityPct > 0
      ? strikes.filter((s) => Math.abs(s.distFromSpot / spot) < pinProximityPct)
      : [];

  // Merge + dedupe by strike, then re-sort by OI for display.
  const merged = new Map<number, OIStrike>();
  for (const s of topByOI) merged.set(s.strike, s);
  for (const s of nearSpot) merged.set(s.strike, s);
  return Array.from(merged.values()).sort((a, b) => b.totalOI - a.totalOI);
}

export function formatOI(oi: number): string {
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return String(oi);
}
