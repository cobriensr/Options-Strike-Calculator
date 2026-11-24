/**
 * Classification helpers for the GexLandscape module.
 *
 * `classify` maps (netGamma, netCharm) to one of the four quadrant labels.
 * `getDirection` maps (strike, price) to ceiling / floor / atm using
 *   `SPX_SPOT_BAND` (SPX-only since Phase 3 of the MM swap).
 * `signalTooltip` and `charmTooltip` render the per-cell tooltip text;
 *   `takerSideWords`, `positionBand`, `positionDistance` and `charmHint` are
 *   the words they and the strike table's screen-reader hints share.
 * `computeVolReinforcement` maps (netGamma, Δ5m/15m/30m) to delta-trend
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

/**
 * Which side the takers hold of a strike's gamma and charm, for a class. One
 * source for the per-cell tooltip (`signalTooltip`) and the words a screen
 * reader hears on the class badge, so the two cannot drift apart.
 */
export function takerSideWords(cls: GexClassification): {
  gamma: 'long' | 'short';
  charm: 'long' | 'short';
} {
  return {
    gamma:
      cls === 'max-launchpad' || cls === 'fading-launchpad' ? 'short' : 'long',
    charm: cls === 'max-launchpad' || cls === 'sticky-pin' ? 'long' : 'short',
  };
}

/**
 * How far a strike sits from spot, in words, with the side left out: outside
 * the spot band, or inside it. The position cell already reads "above spot",
 * "below spot" or "at spot", so its screen-reader hint is this alone and does
 * not say the side twice.
 */
export function positionDistance(dir: Direction): string {
  return dir === 'atm'
    ? `within ${SPX_SPOT_BAND} pts`
    : `more than ${SPX_SPOT_BAND} pts`;
}

/**
 * Where a strike sits against spot, in words: outside the spot band above or
 * below it, or inside it. Used by `signalTooltip`, whose sentence has no
 * visible text beside it, so it names the side.
 */
export function positionBand(dir: Direction): string {
  const distance = positionDistance(dir);
  if (dir === 'ceiling') return `${distance} above spot`;
  if (dir === 'floor') return `${distance} below spot`;
  return `${distance} of spot`;
}

/**
 * Per-cell signal tooltip: which side traders hold at the strike and where
 * it sits. GEXBot gamma and charm are classified taker flow in the
 * vendor's taker-side sign (owner decision D1 revised, 2026-10-29), so the
 * UW-era market-maker hedging read ("market makers absorb moves here")
 * does not apply and is not stated.
 */
export function signalTooltip(cls: GexClassification, dir: Direction): string {
  const { gamma, charm } = takerSideWords(cls);
  return `In GEXBot's taker-side sign, traders (takers) are net ${gamma} gamma and net ${charm} charm at this strike, which sits ${positionBand(dir)}.`;
}

/**
 * GEXBot charm in its taker-side sign (owner decision D1 revised: GEXBot
 * is classified taker flow, not a market-maker position), so the tooltip
 * states who is long or short and makes no market-maker claim.
 */
export function charmTooltip(netCharm: number): string {
  return netCharm >= 0
    ? 'Positive GEXBot charm (taker-side sign): traders are net long charm at this strike.'
    : 'Negative GEXBot charm (taker-side sign): traders are net short charm at this strike.';
}

/**
 * The short form of `charmTooltip` for a screen reader: the visible value is
 * only a signed number, so this says which side of charm the takers hold.
 * Splits at the same point as `charmTooltip` (zero counts as long).
 */
export function charmHint(netCharm: number): string {
  return netCharm >= 0 ? 'takers net long charm' : 'takers net short charm';
}

/**
 * Delta-trend agreement signal — per Locked Decision #1 of the 1-min
 * GexBot rebuild. Reads as "reinforcing" when all three deltas
 * (Δ5m / Δ15m / Δ30m) move in the same direction as the current netGamma
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
  delta5m: number | null;
  delta15m: number | null;
  delta30m: number | null;
}): 'reinforcing' | 'opposing' | 'neutral' {
  const { netGamma, delta5m, delta15m, delta30m } = opts;
  if (netGamma === 0) return 'neutral';
  if (delta5m === null || delta15m === null || delta30m === null) {
    return 'neutral';
  }
  if (delta5m === 0 || delta15m === 0 || delta30m === 0) return 'neutral';
  const currentSign = Math.sign(netGamma);
  const s5 = Math.sign(delta5m);
  const s15 = Math.sign(delta15m);
  const s30 = Math.sign(delta30m);
  if (s5 === currentSign && s15 === currentSign && s30 === currentSign) {
    return 'reinforcing';
  }
  if (s5 === -currentSign && s15 === -currentSign && s30 === -currentSign) {
    return 'opposing';
  }
  return 'neutral';
}
