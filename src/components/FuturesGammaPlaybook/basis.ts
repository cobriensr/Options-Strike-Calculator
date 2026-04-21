/**
 * SPX → ES translation primitives.
 *
 * ES futures trade at a cash-carry basis relative to SPX; the observed
 * spread (ES − SPX) is captured live in `FuturesSnapshotResponse.esSpxBasis`.
 * These helpers translate structural SPX levels (walls, zero-gamma) into
 * ES-tradeable prices and classify how price is interacting with them.
 *
 * Everything here is pure — no hooks, no fetches. The aggregator hook
 * does the composition.
 */

import { ES_TICK_SIZE, LEVEL_PROXIMITY_ES_POINTS } from './playbook.js';
import type { EsLevel } from './types';

/**
 * Round a price to the nearest ES tick (0.25 index points).
 *
 * Uses banker-style "round half away from zero" (the default `Math.round`
 * behavior shifted by tick size) — consistent, predictable, symmetric
 * around zero. Example: 6.13 → 6.00, 6.25 → 6.25, 6.38 → 6.50, 6.125 → 6.25.
 */
export function esTickRound(price: number): number {
  return Math.round(price / ES_TICK_SIZE) * ES_TICK_SIZE;
}

/**
 * Translate an SPX level to an ES price using the live basis.
 *
 * `basis = ES_price - SPX_price` at the snapshot instant, so
 * `ES_level = SPX_level + basis`. Rounded to the nearest ES tick so the
 * output is a tradeable price rather than a fractional value a trader
 * would then have to round themselves.
 */
export function translateSpxToEs(spxLevel: number, basis: number): number {
  return esTickRound(spxLevel + basis);
}

/**
 * Signed distance in ES points from the current price to a level.
 * Positive when the level is *above* the price, negative when below.
 */
export function distanceInEsPoints(esPrice: number, esLevel: number): number {
  return esLevel - esPrice;
}

/**
 * Classify how price is interacting with a level.
 *
 * Heuristic, not a signal model:
 *   - `APPROACHING` — |distance| ≤ LEVEL_PROXIMITY_ES_POINTS (5 pts).
 *   - `REJECTED`    — history shows price was inside the proximity band
 *                     recently but is now moving away (|distance| growing).
 *   - `BROKEN`      — history shows the sign of distance flipped (price
 *                     crossed the level at some point in the series).
 *   - `IDLE`        — none of the above; level is too far off to matter.
 *
 * `priorHistoryDistances` must be the distances series PRIOR to the
 * current value — do not include the current distance, or the "moving
 * away" comparison becomes self-vs-self. Optional; when absent or
 * shorter than two points the function falls back to proximity-only.
 *
 * Only the last 5 prior points are considered — longer windows make the
 * status labels stick around too long after the move has completed.
 */
export function classifyLevelStatus(
  distanceEsPoints: number,
  priorHistoryDistances: number[] | undefined,
): EsLevel['status'] {
  const currentInside = Math.abs(distanceEsPoints) <= LEVEL_PROXIMITY_ES_POINTS;

  // No history — fall back to proximity-only.
  if (!priorHistoryDistances || priorHistoryDistances.length < 2) {
    return currentInside ? 'APPROACHING' : 'IDLE';
  }

  const recent = priorHistoryDistances.slice(-5);

  // BROKEN — the sign of distance has flipped relative to the oldest
  // point in the window. A sign flip means price traveled through the
  // level between then and now.
  const oldest = recent[0];
  if (
    oldest !== undefined &&
    oldest !== 0 &&
    distanceEsPoints !== 0 &&
    Math.sign(oldest) !== Math.sign(distanceEsPoints)
  ) {
    return 'BROKEN';
  }

  // REJECTED — we were inside the proximity band at some point in the
  // recent window but are now outside AND moving away (|distance| is
  // larger than it was one step ago).
  const wasInside = recent.some(
    (d) => Math.abs(d) <= LEVEL_PROXIMITY_ES_POINTS,
  );
  const prev = recent.at(-1);
  const movingAway =
    prev !== undefined && Math.abs(distanceEsPoints) > Math.abs(prev);
  if (!currentInside && wasInside && movingAway) {
    return 'REJECTED';
  }

  return currentInside ? 'APPROACHING' : 'IDLE';
}
