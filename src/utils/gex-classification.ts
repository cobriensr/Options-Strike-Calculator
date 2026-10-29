/**
 * GEX classification helpers shared between the GexLandscape frontend
 * and the TRACE Live capture daemon.
 *
 * Single source of truth for:
 *   - the four classification quadrants (`GexClassification`),
 *   - the three position-relative-to-spot directions (`Direction`),
 *   - the per-(class, direction) signal label rendered both in the
 *     frontend's table cells and in the daemon's `signal` payload field.
 *
 * Pure functions only. No React, no Tailwind, no DOM. Safe to import
 * from `daemon/src/` (Node ESM strict resolver) and from `src/components/`
 * (Vite). The daemon's tsconfig explicitly includes this file via its
 * `include` array — when adding new exports here, keep it pure-data.
 */

export type GexClassification =
  | 'max-launchpad'
  | 'fading-launchpad'
  | 'sticky-pin'
  | 'weakening-pin';

export type Direction = 'ceiling' | 'floor' | 'atm';

/** Position wording for each direction (SPX spot band = 25 pts). */
const POSITION_TEXT: Record<Direction, string> = {
  ceiling: 'above spot',
  floor: 'below spot',
  atm: 'at spot',
};

/**
 * Map (classification, direction) → human-readable signal label: the
 * taker side of the strike's gamma and where the strike sits.
 *
 * The GexLandscape data is GEXBot taker flow in its taker-side sign, so
 * the label describes positioning and makes no market-maker or price-path
 * prediction (owner decision D1 revised, 2026-10-29; the UW-era labels
 * such as "Hard Floor" and "Ceiling Breakout Risk" are gone). Charm is
 * shown by the classification badge, so the six labels depend on the
 * gamma side and the direction only. Changing any string is a
 * frontend-visible change.
 */
export function classSignal(cls: GexClassification, dir: Direction): string {
  const side =
    cls === 'max-launchpad' || cls === 'fading-launchpad'
      ? 'Taker-short'
      : 'Taker-long';
  return `${side} γ ${POSITION_TEXT[dir]}`;
}
