/**
 * Shared fire-time spot resolution for the LotteryFinder UI.
 *
 * The moneyness FILTER (`isFireOtm` in index.tsx) and the row's
 * ITM/OTM BADGE (`fireSpot`/`otmPct` in LotteryRow.tsx) must classify a
 * fire against the SAME underlying spot, or a chain that moved between
 * its first and latest fire can show an OTM badge while the OTM filter
 * hides it (and vice-versa). This module is the single source of truth
 * for that spot value so the two can never disagree.
 *
 * Precedence: `entry.spotAtTrigger` (this specific fire's tick) when it
 * is a finite, positive number, else `entry.spotAtFirst` (the chain's
 * first-fire spot, populated on every row pre/post migration #176) when
 * finite, else `null` (no usable spot — extremely rare; both fields
 * non-finite).
 */
import type { LotteryFire } from './types.js';

/**
 * Resolve the fire-time underlying spot for moneyness classification.
 * Returns `null` only when neither snapshot is a finite number.
 */
export function fireSpot(fire: LotteryFire): number | null {
  const atTrigger = fire.entry.spotAtTrigger;
  if (atTrigger != null && Number.isFinite(atTrigger) && atTrigger > 0) {
    return atTrigger;
  }
  const atFirst = fire.entry.spotAtFirst;
  if (Number.isFinite(atFirst)) return atFirst;
  return null;
}

/**
 * Classify a fire as out-of-the-money against `fireSpot(fire)`.
 *
 * Call OTM ⇔ strike >= spot; put OTM ⇔ strike <= spot. The boundary is
 * inclusive so an exactly-ATM fire (strike === spot) counts as OTM,
 * matching the row badge's `otmPct >= 0` convention in LotteryRow.tsx —
 * otherwise an ATM fire would show an OTM badge yet hide under the OTM
 * filter. When no usable spot exists the fire cannot be classified and
 * is treated as NOT OTM (so it surfaces under the "ITM" branch rather
 * than vanishing — the badge shows no %OTM chip in this case either,
 * keeping the two surfaces consistent).
 */
export function isFireOtm(fire: LotteryFire): boolean {
  const spot = fireSpot(fire);
  if (spot == null || spot <= 0) return false;
  return fire.optionType === 'C' ? fire.strike >= spot : fire.strike <= spot;
}
