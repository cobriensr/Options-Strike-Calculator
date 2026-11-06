/**
 * Request headers for the Railway sidecar's /archive/* routes, shared by
 * the plain-node archive scripts (backfill-day-embeddings,
 * backfill-day-features, backfill-day-ohlc, compare-analog-backends).
 * Plain `node` can't import api/_lib/archive-sidecar.ts, so this is the
 * scripts' own sidecarArchiveHeaders(): the bearer from
 * SIDECAR_TAKEIT_SECRET, read from the environment the script was started
 * with (the scripts are run as `source .env.local && node ...`).
 */

import process from 'node:process';

let warnedUnset = false;

/**
 * `{ Authorization: 'Bearer <secret>' }`, or `{}` with a one-time warning
 * when SIDECAR_TAKEIT_SECRET is unset.
 */
export function sidecarArchiveHeaders() {
  const secret = process.env.SIDECAR_TAKEIT_SECRET;
  if (!secret) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn(
        'SIDECAR_TAKEIT_SECRET unset: sidecar archive requests are sent without Authorization',
      );
    }
    return {};
  }
  return { Authorization: `Bearer ${secret}` };
}
