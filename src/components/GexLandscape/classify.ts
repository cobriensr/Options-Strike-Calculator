/**
 * Classification helpers for the GexLandscape module.
 *
 * `classify` maps (netGamma, netCharm) to one of the four quadrant labels.
 * `getDirection` maps (strike, price, ticker) to ceiling / floor / atm
 *   using a per-ticker spot band (`BAND_BY_TICKER`).
 * `computeGammaPressure` returns whether today's directional flow is
 *   reinforcing or unwinding the wall at a given strike.
 * `signalTooltip` and `charmTooltip` render the per-cell tooltip text.
 */

import {
  BAND_BY_TICKER,
  PRESSURE_NEUTRAL_BAND_RATIO,
  type Ticker,
} from './constants';
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

/**
 * Per-strike gamma-pressure label. Independent of the four-quadrant
 * `classify()` result — even within a "Sticky Pin" classification, the wall
 * may be silently reinforcing OR unwinding based on directional flow.
 */
export type GammaPressure = 'reinforcing' | 'unwinding' | 'neutral';

/**
 * Compute the gamma pressure label for a single strike from its bid/ask
 * volume Greek splits.
 *
 *   gamma_pressure = (call_gamma_ask_vol - call_gamma_bid_vol)
 *                  + (put_gamma_bid_vol  - put_gamma_ask_vol)
 *
 * Sign:
 *   - positive → customers net buying gamma  → dealers shorter → walls
 *     unwinding
 *   - negative → customers net selling gamma → dealers longer  → walls
 *     reinforcing
 *
 * Neutral band: `|pressure| / |dollarGammaOi| < PRESSURE_NEUTRAL_BAND_RATIO`
 * scales with strike importance — small absolute pressure at a tiny strike
 * doesn't trigger; meaningful pressure at a major wall does. If
 * `dollarGammaOi` is 0 or null, returns `'neutral'` defensively to avoid
 * divide-by-zero.
 */
export function computeGammaPressure(opts: {
  callGammaAskVol: number | null;
  callGammaBidVol: number | null;
  putGammaAskVol: number | null;
  putGammaBidVol: number | null;
  /** |call_gamma_oi + put_gamma_oi| at this strike, or netGamma magnitude. */
  dollarGammaOi: number;
}): GammaPressure {
  const dollarGammaOi = Math.abs(opts.dollarGammaOi);
  if (!Number.isFinite(dollarGammaOi) || dollarGammaOi === 0) return 'neutral';

  const callAsk = opts.callGammaAskVol ?? 0;
  const callBid = opts.callGammaBidVol ?? 0;
  const putAsk = opts.putGammaAskVol ?? 0;
  const putBid = opts.putGammaBidVol ?? 0;

  const pressure = callAsk - callBid + (putBid - putAsk);
  if (!Number.isFinite(pressure)) return 'neutral';

  const ratio = Math.abs(pressure) / dollarGammaOi;
  if (ratio < PRESSURE_NEUTRAL_BAND_RATIO) return 'neutral';

  return pressure > 0 ? 'unwinding' : 'reinforcing';
}

export function getDirection(
  strike: number,
  price: number,
  ticker: Ticker,
): Direction {
  const band = BAND_BY_TICKER[ticker];
  if (strike > price + band) return 'ceiling';
  if (strike < price - band) return 'floor';
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
