/**
 * The edge-cache rule shared by the live Periscope / GEX readers
 * (`/api/gex-landscape`, `/api/periscope-map`, `/api/periscope-exposure`,
 * `/api/periscope-strikes`). One rule in one place: four copies drift.
 *
 * A live read whose response carries data, or any live read during the
 * session, is cached 10 s at the edge with no stale reuse. Every panel polls
 * once a minute, so a longer cache let healthy data sit at the edge for up to
 * a minute, and let the first polls after the open get a pre-open reply up to
 * about six minutes old. Each owner or guest session has its own cache entry
 * (`Vary: Cookie`), so 10 s only collapses a burst from several tabs.
 *
 * A historical read (a past slot or minute never changes) and a live read
 * with no data outside the session keep 300 s + 60 s SWR.
 *
 * Call it on each success path, once the response kind is known; an error
 * response sets no header.
 */

import type { VercelResponse } from '@vercel/node';
import { setCacheHeaders } from './api-helpers.js';

export function setLiveReadCache(
  res: VercelResponse,
  opts: {
    /** A scrubbed or picked-slot read: `at`, `date` or `time` was given. */
    historical: boolean;
    /** The response carries a slot or strikes (not a no_slot / no_spot reply). */
    hasData: boolean;
    /** The server's session flag (`isMarketOpen()`). */
    marketOpen: boolean;
  },
): void {
  if (!opts.historical && (opts.hasData || opts.marketOpen)) {
    setCacheHeaders(res, 10, 0);
  } else {
    setCacheHeaders(res, 300, 60);
  }
}
