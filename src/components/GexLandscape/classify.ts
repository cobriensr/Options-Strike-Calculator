/**
 * Classification helpers for the GexLandscape module.
 *
 * `classify` maps (netGamma, netCharm) to one of the four quadrant labels.
 * `getDirection` maps (strike, price) to ceiling / floor / atm using
 *   `SPX_SPOT_BAND` (SPX-only since Phase 3 of the MM swap).
 * `signalTooltip` and `charmTooltip` render the per-cell tooltip text.
 * `computeVolReinforcement` maps (netGamma, Δ1m/5m/10m) to delta-trend
 *   agreement per Locked Decision #1 of the 1-min GexBot rebuild spec
 *   (docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md).
 */

import { SPX_SPOT_BAND } from './constants';
import type { Direction, GexClassification } from './types';

export function classify(
  netGamma: number,
  netCharm: number,
): GexClassification {
  if (netGamma < 0 && netCharm >= 0) return 'max-launchpad';
  if (netGamma < 0 && netCharm < 0) return 'fading-launchpad';
  if (netGamma >= 0 && netCharm >= 0) return 'sticky-pin';
  return 'weakening-pin';
}

export function getDirection(strike: number, price: number): Direction {
  if (strike > price + SPX_SPOT_BAND) return 'ceiling';
  if (strike < price - SPX_SPOT_BAND) return 'floor';
  return 'atm';
}

export function signalTooltip(cls: GexClassification, dir: Direction): string {
  const mechanic =
    cls === 'max-launchpad' || cls === 'fading-launchpad'
      ? 'Market makers add fuel to moves here — they buy when price rises and sell when it falls.'
      : 'Market makers absorb moves here — they sell into rallies and buy into dips.';
  const position =
    dir === 'ceiling'
      ? 'This strike is above current price — it is overhead resistance.'
      : dir === 'floor'
        ? 'This strike is below current price — it is downside support.'
        : 'This strike is right at the money — pressure is balanced in both directions.';
  const charm =
    cls === 'max-launchpad' || cls === 'sticky-pin'
      ? 'The influence at this level builds as the session ages.'
      : 'The influence at this level fades as the session ages.';
  return `${mechanic} ${position} ${charm}`;
}

export function charmTooltip(netCharm: number): string {
  return netCharm >= 0
    ? 'Positive: market maker hedging pressure at this level is growing throughout the day — the structural effect gets stronger into the close.'
    : 'Negative: market maker hedging pressure at this level is draining throughout the day — the structural effect weakens into the close.';
}

/**
 * Delta-trend agreement signal — per Locked Decision #1 of the 1-min
 * GexBot rebuild. Reads as "reinforcing" when all three deltas
 * (Δ1m / Δ5m / Δ10m) move in the same direction as the current netGamma
 * sign — the wall is being added to. Reads as "opposing" when all three
 * deltas push against the current sign — the wall is being unwound.
 * Anything mixed, any null (sparse data), any zero (no sign), or a
 * zero netGamma is "neutral".
 *
 * No WS dependency — this replaces the volume-vs-OI reinforcement signal
 * the legacy MM hook computed off the WS side channel.
 */
export function computeVolReinforcement(opts: {
  netGamma: number;
  delta1m: number | null;
  delta5m: number | null;
  delta10m: number | null;
}): 'reinforcing' | 'opposing' | 'neutral' {
  const { netGamma, delta1m, delta5m, delta10m } = opts;
  if (netGamma === 0) return 'neutral';
  if (delta1m === null || delta5m === null || delta10m === null) {
    return 'neutral';
  }
  if (delta1m === 0 || delta5m === 0 || delta10m === 0) return 'neutral';
  const currentSign = Math.sign(netGamma);
  const s1 = Math.sign(delta1m);
  const s5 = Math.sign(delta5m);
  const s10 = Math.sign(delta10m);
  if (s1 === currentSign && s5 === currentSign && s10 === currentSign) {
    return 'reinforcing';
  }
  if (s1 === -currentSign && s5 === -currentSign && s10 === -currentSign) {
    return 'opposing';
  }
  return 'neutral';
}
