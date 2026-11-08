/**
 * The label (`ts`) of a `zero_gamma_levels` row: the END of the 5-minute
 * bucket of the ladder it was computed from
 * (docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.4).
 *
 * `strike_exposures.timestamp` is the newest UW row time floored to 5
 * minutes, so a ladder observed at :02 or :03 is stamped :00. Keying the
 * zero-gamma row on that floor would put its label up to about 4 minutes
 * BEFORE the data existed, which is lookahead for any `ts <= at` reader (the
 * dealer-regime replay). The bucket end is never earlier than the data. It is
 * still derived from the source ladder alone (R6), so recomputing a ladder
 * gives the same key and writes nothing. At compute time (:04) the newest
 * row's label (:05) is about a minute ahead of the clock; readers that judge
 * freshness as `now - ts` see that as fresh.
 *
 * Shared by api/cron/compute-zero-gamma.ts and scripts/backfill-zero-gamma.ts
 * so the live rows and the backfilled ones carry the same keys.
 */

import { BUCKET_MS } from './closed-buckets.js';

/** `ladderTsIso` (a `strike_exposures.timestamp`) plus one bucket, as ISO. */
export function zeroGammaLabelTs(ladderTsIso: string): string {
  return new Date(Date.parse(ladderTsIso) + BUCKET_MS).toISOString();
}
