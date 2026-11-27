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
import {
  CASH_OPEN_MIN_ET,
  CLOSED_FINAL_FETCH_OFFSET_MIN,
  getMarketCloseHourET,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';
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

/** A cache life: `s-maxage` seconds, then `stale-while-revalidate` seconds. */
interface ClosedCache {
  edgeSec: number;
  swr: number;
}

/** The ET instant, in epoch ms, of a wall-clock minute on an ET date. */
function etInstantMs(etDate: string, etMinutes: number): number | null {
  const iso = etWallClockToUtcIso(etDate, etMinutes);
  return iso === null ? null : Date.parse(iso);
}

/**
 * How long a closed-market response may live at the edge, as an
 * `s-maxage` + `stale-while-revalidate` pair. The whole life ends before two
 * moments, so a closed response never answers a fetch that must see newer data:
 *
 * - On a trading day, close + `CLOSED_FINAL_FETCH_OFFSET_MIN` (3 min). The
 *   client's final fetch of a session runs then. Nothing is cached from the
 *   close up to it (`0` + `0`), so no closed response written before the last
 *   capture landed can answer that fetch. The close is `getMarketCloseHourET`
 *   (13:00 ET on a half day). A weekend or holiday has no such window.
 * - The next 09:30 ET wall clock, on any calendar day. Everywhere else the life
 *   is 300 s + 60 s, cut short so that it still ends by then. A weekend day
 *   counts as having a 09:30: that can only shorten a life, never lengthen it.
 *
 * At the open instant itself the open has happened, so the next one is the
 * following day's. Every instant comes from the ET wall clock, so the rule
 * stays right across a DST change. If a conversion ever yields no instant (an
 * ET date that does not parse, which the formatter cannot produce), nothing is
 * cached.
 */
export function closedCacheSeconds(now: Date): ClosedCache {
  const nowMs = now.getTime();
  const etDate = getETDateStr(now);

  // getMarketCloseHourET alone returns 16 on a weekend, so ask isTradingDay.
  const closeHour = isTradingDay(etDate) ? getMarketCloseHourET(etDate) : null;
  if (closeHour !== null) {
    const closeMs = etInstantMs(etDate, closeHour * 60);
    if (closeMs === null) return { edgeSec: 0, swr: 0 };
    const finalFetchMs = closeMs + CLOSED_FINAL_FETCH_OFFSET_MIN * 60_000;
    if (nowMs >= closeMs && nowMs < finalFetchMs) return { edgeSec: 0, swr: 0 };
  }

  let openMs = etInstantMs(etDate, CASH_OPEN_MIN_ET);
  if (openMs !== null && nowMs >= openMs) {
    // The next ET calendar day. UTC noon plus 24 h never crosses a DST edge.
    const tomorrow = new Date(Date.parse(`${etDate}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    openMs = etInstantMs(tomorrow, CASH_OPEN_MIN_ET);
  }
  if (openMs === null) return { edgeSec: 0, swr: 0 };

  const untilOpen = Math.floor((openMs - nowMs) / 1000);
  const edgeSec = Math.min(300, untilOpen);
  return { edgeSec, swr: Math.min(60, untilOpen - edgeSec) };
}

/**
 * Edge-cache headers for a closed-market response (the live route's data
 * served after the cash close): see `closedCacheSeconds`. `setLiveReadCache`
 * keeps its own rule for the readers that call it.
 */
export function setClosedReadCache(
  res: VercelResponse,
  now: Date = new Date(),
): void {
  const { edgeSec, swr } = closedCacheSeconds(now);
  setCacheHeaders(res, edgeSec, swr);
}
