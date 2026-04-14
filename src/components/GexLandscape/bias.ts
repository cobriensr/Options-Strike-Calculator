/**
 * Structural bias synthesis. Turns the current (optionally smoothed) strike
 * landscape into a directional verdict + supporting metrics.
 *
 * Algorithm:
 *   Regime  = sign of total net GEX across all strikes in the window
 *             Positive → dealers counter moves (dampened / range-bound day)
 *             Negative → dealers amplify moves  (trending / volatile day)
 *
 *   Gravity = strike with the largest |netGamma| anywhere in the window
 *             This is where MMs have the heaviest hedge book — price drifts toward it
 *
 *   Verdict = gravity direction × regime
 *             Above + Positive → gex-pull-up        (MMs pull price up to wall)
 *             Above + Negative → breakout-risk-up    (no dampener above; acceleration risk)
 *             Below + Positive → gex-pull-down       (MMs pull price down to wall)
 *               └─ override: the wall is now a support floor → gex-floor-below
 *                  (upside freedom; price has already broken above it)
 *             Below + Negative → breakdown-risk-down (no dampener below; breakdown risk)
 *             ATM   + Positive → rangebound
 *             ATM   + Negative → volatile
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { classify } from './classify';
import { SPOT_BAND } from './constants';
import type { BiasMetrics, DriftTarget } from './types';

export function computeBias(
  rows: GexStrikeLevel[],
  currentPrice: number,
  gexDeltaMap: Map<number, number | null>,
  gexDelta5mMap: Map<number, number | null>,
): BiasMetrics {
  const above = rows.filter((s) => s.strike > currentPrice + SPOT_BAND);
  const below = rows.filter((s) => s.strike < currentPrice - SPOT_BAND);

  // Regime: sign of total net GEX
  let totalNetGex = 0;
  for (const s of rows) totalNetGex += s.netGamma;
  const regime: 'positive' | 'negative' =
    totalNetGex >= 0 ? 'positive' : 'negative';

  // GEX gravity: strike with the largest absolute GEX anywhere in the window.
  // Include strikes within SPOT_BAND of spot — the strongest pin is often
  // right at or near ATM, and excluding it would give a misleading gravity.
  // The ATM-proximity check later naturally maps small |gravityOffset| to
  // a `rangebound` / `volatile` verdict.
  let gravityRow: GexStrikeLevel | null = null;
  for (const s of rows) {
    if (
      gravityRow === null ||
      Math.abs(s.netGamma) > Math.abs(gravityRow.netGamma)
    ) {
      gravityRow = s;
    }
  }
  const gravityOffset = gravityRow ? gravityRow.strike - currentPrice : 0;

  // Verdict: gravity direction × regime
  let verdict: BiasMetrics['verdict'];
  if (Math.abs(gravityOffset) <= SPOT_BAND) {
    verdict = regime === 'negative' ? 'volatile' : 'rangebound';
  } else if (gravityOffset > 0) {
    verdict = regime === 'negative' ? 'breakout-risk-up' : 'gex-pull-up';
  } else {
    verdict = regime === 'negative' ? 'breakdown-risk-down' : 'gex-pull-down';
  }

  // Floor left-behind correction: in positive regime, when the largest wall is
  // below spot and price has already broken above it, that wall is now a support
  // floor — not a downward magnet. The effective bias flips upward.
  if (verdict === 'gex-pull-down') {
    verdict = 'gex-floor-below';
  }

  // Drift targets: top 2 above and below spot by |netGamma|
  const byAbsGex = (a: GexStrikeLevel, b: GexStrikeLevel) =>
    Math.abs(b.netGamma) - Math.abs(a.netGamma);
  const toTarget = (s: GexStrikeLevel): DriftTarget => ({
    strike: s.strike,
    cls: classify(s.netGamma, s.netCharm),
    netGamma: s.netGamma,
    volReinforcement: s.volReinforcement,
  });
  const upsideTargets = [...above].sort(byAbsGex).slice(0, 2).map(toTarget);
  const downsideTargets = [...below].sort(byAbsGex).slice(0, 2).map(toTarget);

  // Aggregate 1m Δ% trends above and below spot
  const avg = (vals: (number | null | undefined)[]) => {
    let sum = 0;
    let count = 0;
    for (const v of vals) {
      if (v !== null && v !== undefined) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  };

  return {
    verdict,
    regime,
    totalNetGex,
    gravityStrike: gravityRow?.strike ?? currentPrice,
    gravityOffset,
    gravityGex: gravityRow?.netGamma ?? 0,
    upsideTargets,
    downsideTargets,
    floorTrend: avg(below.map((s) => gexDeltaMap.get(s.strike))),
    ceilingTrend: avg(above.map((s) => gexDeltaMap.get(s.strike))),
    floorTrend5m: avg(below.map((s) => gexDelta5mMap.get(s.strike))),
    ceilingTrend5m: avg(above.map((s) => gexDelta5mMap.get(s.strike))),
  };
}
