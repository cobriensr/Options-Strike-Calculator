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
 * At the open instant itself on a weekend or a holiday the open has happened,
 * so the next one is the following day's. (On a trading day that instant is
 * inside the session, which the in-session rule below handles.) Every instant
 * comes from the ET wall clock, so the rule stays right across a DST change.
 * If a conversion ever yields no instant (an ET date that does not parse,
 * which the formatter cannot produce), nothing is cached.
 *
 * A closed response whose `now` lies inside the session itself, from the cash
 * open up to the close on a trading day, is cached `0` + `0` as well. The
 * handlers take `now` before `isMarketOpen()` and before every read, so that
 * `now` is the instant the request started, and `isMarketOpen()` reads its own
 * clock a moment later. A `now` inside the session that the handler still
 * decided was closed is therefore possible: `now` at 15:59:59.999 against an
 * `isMarketOpen()` read at 16:00. Without this rule the next-open arithmetic
 * above would give that response a life of up to 360 s, answering live polls
 * with the closed body. Even so, a closed response can outlive 09:30 by up to
 * one query's duration: the edge counts a response's life from when it was
 * sent, and one sent at 09:29:59.9 is good until it expires. The client's
 * carried-over drop (`isCarriedOver`) covers that: a body captured before the
 * open is not shown once the market is open.
 */
export function closedCacheSeconds(now: Date): ClosedCache {
  const nowMs = now.getTime();
  const etDate = getETDateStr(now);

  // getMarketCloseHourET alone returns 16 on a weekend, so ask isTradingDay.
  const closeHour = isTradingDay(etDate) ? getMarketCloseHourET(etDate) : null;
  let closeMs: number | null = null;
  if (closeHour !== null) {
    closeMs = etInstantMs(etDate, closeHour * 60);
    if (closeMs === null) return { edgeSec: 0, swr: 0 };
    const finalFetchMs = closeMs + CLOSED_FINAL_FETCH_OFFSET_MIN * 60_000;
    if (nowMs >= closeMs && nowMs < finalFetchMs) return { edgeSec: 0, swr: 0 };
  }

  let openMs = etInstantMs(etDate, CASH_OPEN_MIN_ET);
  // The open race: inside the session of a trading day, cache nothing.
  if (
    closeMs !== null &&
    openMs !== null &&
    nowMs >= openMs &&
    nowMs < closeMs
  ) {
    return { edgeSec: 0, swr: 0 };
  }
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
 * keeps its own rule for the readers that call it. `now` is the instant the
 * handler took before `isMarketOpen()` and before its reads, so a `now` that
 * falls inside the session, while the handler still decided the market was
 * closed, is seen as one and cached for nothing.
 */
export function setClosedReadCache(res: VercelResponse, now: Date): void {
  const { edgeSec, swr } = closedCacheSeconds(now);
  setCacheHeaders(res, edgeSec, swr);
}
