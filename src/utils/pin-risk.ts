import type { ChainStrike } from '../types/api';

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
 * Combines put and call OI at each strike, returns top N by total OI.
 */
export function getTopOIStrikes(
  puts: readonly ChainStrike[],
  calls: readonly ChainStrike[],
  spot: number,
  topN: number = 8,
): OIStrike[] {
  const oiMap = new Map<number, { putOI: number; callOI: number }>();

  for (const p of puts) {
    const entry = oiMap.get(p.strike) ?? { putOI: 0, callOI: 0 };
    entry.putOI = p.oi;
    oiMap.set(p.strike, entry);
  }
  for (const c of calls) {
    const entry = oiMap.get(c.strike) ?? { putOI: 0, callOI: 0 };
    entry.callOI = c.oi;
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
  return strikes.slice(0, topN);
}

export function formatOI(oi: number): string {
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return String(oi);
}
