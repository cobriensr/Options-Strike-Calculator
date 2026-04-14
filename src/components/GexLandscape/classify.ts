/**
 * Classification helpers for the GexLandscape module.
 *
 * `classify` maps (netGamma, netCharm) to one of the four quadrant labels.
 * `getDirection` maps (strike, price) to ceiling / floor / atm.
 * `signalTooltip` and `charmTooltip` render the per-cell tooltip text.
 */

import { SPOT_BAND } from './constants';
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
  if (strike > price + SPOT_BAND) return 'ceiling';
  if (strike < price - SPOT_BAND) return 'floor';
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
