/**
 * Request headers for the Railway sidecar's /archive/* routes, shared by
 * the plain-node archive scripts (backfill-day-embeddings,
 * backfill-day-features, backfill-day-ohlc, compare-analog-backends).
 * Plain `node` can't import api/_lib/archive-sidecar.ts, so this is the
 * scripts' own sidecarArchiveHeaders(): the bearer from
 * SIDECAR_TAKEIT_SECRET, read from the environment the script was started
 * with (the scripts are run as `source .env.local && node ...`).
 *
 * The sidecar refuses /archive/* calls that carry no bearer, so the helper
 * throws when the secret is missing. Every caller builds its request as
 * `fetch(url, { headers: sidecarArchiveHeaders() })`, so the throw lands
 * before `fetch` runs and the run stops instead of sending a call that is
 * certain to be refused.
 */

import process from 'node:process';

/**
 * `{ Authorization: 'Bearer <secret>' }`.
 *
 * @throws {Error} when SIDECAR_TAKEIT_SECRET is unset or empty. The message
 * carries no secret value.
 */
export function sidecarArchiveHeaders() {
  const secret = process.env.SIDECAR_TAKEIT_SECRET;
  if (!secret) {
    throw new Error(
      "SIDECAR_TAKEIT_SECRET is not set: the sidecar's /archive/* routes need it as a bearer, so the run stops before the request",
    );
  }
  return { Authorization: `Bearer ${secret}` };
}
