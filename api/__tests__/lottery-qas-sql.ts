/**
 * The displayed quality-adjusted score (qas) as SQL text, written once for the
 * three places that compute it:
 *
 *   - the feed (`qasExprText` in api/lottery-finder.ts), aliases `f.` / `ranked.`
 *   - the chip strip (api/lottery-finder-ticker-counts.ts), alias `cd.`
 *   - the detector's feed-tier monitor (api/cron/detect-lottery-fires.ts),
 *     alias `f.`
 *
 * A chip count or a tier alert that disagrees with the feed is a silent bug,
 * so each of the three tests asserts its captured SQL contains this same text.
 * Change the expression in one place and the other two tests fail until it
 * follows.
 *
 * Whitespace is dropped before comparing: the call sites format the SQL
 * differently, and that is not a difference in what it computes.
 */

import { INVERSION_BONUS_CASE_SQL } from '../_lib/lottery-inversion-bonus.js';

export type QasAlias = 'f.' | 'ranked.' | 'cd.';

/** SQL text with every run of whitespace removed. */
export const squashSql = (sql: string): string => sql.replace(/\s+/g, '');

/**
 * GREATEST(0, score + round_trip_score_deduct) + the inversion bonus CASE,
 * with the fire columns prefixed by `alias`. No fire-count term: the fire-count
 * adjustment was retired on 2026-11-15, so the qas does not depend on how many
 * times a chain has fired.
 */
export function expectedQasSql(alias: QasAlias): string {
  return squashSql(
    `GREATEST(0, COALESCE(${alias}score, 0) + COALESCE(${alias}round_trip_score_deduct, 0)) + ${INVERSION_BONUS_CASE_SQL}`,
  );
}
