/**
 * Private helpers shared by `./parse.ts` and `./summary.ts`.
 *
 * NOT re-exported from the barrel — consumers must import from
 * `./csv-parser.js` and use the public API (`parseFullCSV`,
 * `buildFullSummary`, `pairShortsWithLongs`, etc.).
 */

/**
 * Sanity cap on recognized spread width (points). Not a business rule:
 * just a guard against parser noise pairing legs that aren't actually
 * related. 200pt is wide enough to accept legitimate crash protection
 * (e.g. 100pt PCS hedges) while still rejecting random strike collisions.
 *
 * Used by:
 *   - `identifyClosedSpreads` in `parse.ts` (closed-spread leg pairing)
 *   - `pairShortsWithLongs` in `summary.ts` (open-spread display pairing)
 */
export const MAX_RECOGNIZED_SPREAD_WIDTH = 200;
