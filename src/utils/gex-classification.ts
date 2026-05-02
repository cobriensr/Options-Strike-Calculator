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

/**
 * Map (classification, direction) → human-readable signal label.
 *
 * The 12 returned strings are the canonical set rendered in the
 * GexLandscape strike table and persisted in the trace_live_analyses
 * payload. Changing any string is a frontend-visible change.
 */
export function classSignal(cls: GexClassification, dir: Direction): string {
  if (cls === 'max-launchpad') {
    return dir === 'ceiling'
      ? 'Ceiling Breakout Risk'
      : dir === 'floor'
        ? 'Floor Collapse Risk'
        : 'Launch Zone';
  }
  if (cls === 'fading-launchpad') {
    return dir === 'ceiling'
      ? 'Weakening Ceiling'
      : dir === 'floor'
        ? 'Weakening Floor'
        : 'Fading Launch';
  }
  if (cls === 'sticky-pin') {
    return dir === 'ceiling'
      ? 'Hard Ceiling'
      : dir === 'floor'
        ? 'Hard Floor'
        : 'Pin Zone';
  }
  // weakening-pin
  return dir === 'ceiling'
    ? 'Softening Ceiling'
    : dir === 'floor'
      ? 'Softening Floor'
      : 'Weak Pin';
}
