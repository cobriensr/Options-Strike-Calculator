/**
 * Structural bias synthesis. Turns the current strike landscape into a
 * verdict + supporting metrics.
 *
 * The input is GEXBot gamma in its taker-side sign (positive = traders net
 * long gamma at the strike). It is classified taker flow, not a
 * market-maker position, so the verdict is a description of where the
 * taker gamma sits, not a forecast of dealer hedging (owner decision D1
 * revised, 2026-10-29). The ids below keep their UW-era names; the display
 * text in constants.ts describes only what is computed.
 *
 * Algorithm:
 *   Regime  = sign of total net gamma across all strikes in the window
 *             (positive = traders net long gamma, negative = net short)
 *
 *   Gravity = strike with the largest |netGamma| anywhere in the window
 *
 *   Verdict = gravity position × regime
 *             Above + Positive → gex-pull-up
 *             Above + Negative → breakout-risk-up
 *             Below + Positive → gex-pull-down, always rewritten to
 *                                gex-floor-below
 *             Below + Negative → breakdown-risk-down
 *             ATM   + Positive → rangebound, or drifting-up / drifting-down
 *                                when the 30-min price trend is not flat
 *             ATM   + Negative → volatile
 */

import { classify } from './classify';
import { SPX_SPOT_BAND } from './constants';
import type {
  BiasMetrics,
  DriftTarget,
  GexStrikeLevel,
  PriceTrend,
} from './types';

/**
 * Mean of nullable percent values, ignoring nulls/undefineds. Returns
 * `null` when no usable values exist — matches the BiasPanel's "no
 * data yet" rendering contract.
 */
function avgPct(vals: (number | null | undefined)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const v of vals) {
    if (v !== null && v !== undefined) {
      sum += v;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

export function computeBias(
  rows: GexStrikeLevel[],
  currentPrice: number,
  gexDelta5mMap: Map<number, number | null>,
  gexDelta15mMap: Map<number, number | null>,
  gexDelta30mMap: Map<number, number | null>,
  priceTrend: PriceTrend | null = null,
): BiasMetrics {
  const above = rows.filter((s) => s.strike > currentPrice + SPX_SPOT_BAND);
  const below = rows.filter((s) => s.strike < currentPrice - SPX_SPOT_BAND);

  // Regime: sign of total net GEX
  let totalNetGex = 0;
  for (const s of rows) totalNetGex += s.netGamma;
  const regime: 'positive' | 'negative' =
    totalNetGex >= 0 ? 'positive' : 'negative';

  // GEX gravity: strike with the largest absolute GEX anywhere in the window.
  // Include strikes within the per-ticker band of spot — the strongest pin
  // is often right at or near ATM, and excluding it would give a misleading
  // gravity. The ATM-proximity check later naturally maps small
  // |gravityOffset| to a `rangebound` / `volatile` verdict.
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
  if (Math.abs(gravityOffset) <= SPX_SPOT_BAND) {
    verdict = regime === 'negative' ? 'volatile' : 'rangebound';
  } else if (gravityOffset > 0) {
    verdict = regime === 'negative' ? 'breakout-risk-up' : 'gex-pull-up';
  } else {
    verdict = regime === 'negative' ? 'breakdown-risk-down' : 'gex-pull-down';
  }

  // UW-era "floor left behind" rule: positive regime with the largest strike
  // below spot is always reported as gex-floor-below, never gex-pull-down.
  // Kept so the computed classification is unchanged; the display text no
  // longer calls the strike a floor.
  if (verdict === 'gex-pull-down') {
    verdict = 'gex-floor-below';
  }

  // Price-drift override: positive regime with the largest strike at spot,
  // but price persistently moving one way over 30 min → drifting-down /
  // drifting-up, so the label reports the price move.
  if (
    verdict === 'rangebound' &&
    priceTrend &&
    priceTrend.direction !== 'flat'
  ) {
    verdict = priceTrend.direction === 'down' ? 'drifting-down' : 'drifting-up';
  }

  // Top 2 strikes above and below spot by |netGamma| (the `*Targets` fields
  // keep their UW-era names).
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

  return {
    verdict,
    regime,
    totalNetGex,
    gravityStrike: gravityRow?.strike ?? currentPrice,
    gravityOffset,
    gravityGex: gravityRow?.netGamma ?? 0,
    upsideTargets,
    downsideTargets,
    floorTrend5m: avgPct(below.map((s) => gexDelta5mMap.get(s.strike))),
    ceilingTrend5m: avgPct(above.map((s) => gexDelta5mMap.get(s.strike))),
    floorTrend15m: avgPct(below.map((s) => gexDelta15mMap.get(s.strike))),
    ceilingTrend15m: avgPct(above.map((s) => gexDelta15mMap.get(s.strike))),
    floorTrend30m: avgPct(below.map((s) => gexDelta30mMap.get(s.strike))),
    ceilingTrend30m: avgPct(above.map((s) => gexDelta30mMap.get(s.strike))),
    priceTrend,
  };
}
