/**
 * The windowed, paged `/stock/SPX/spot-exposures/strike` walk, shared by
 * `fetch-strike-all` (the live cron) and `scripts/backfill-strike-all.ts` (a
 * past date), so the two cannot drift
 * (docs/superpowers/plans/2026-10-23-uw-rest-fixes.md, Task R1).
 *
 * The ladder is requested with `min_strike`/`max_strike` = spot ± range. That
 * routes the call through UW's live path (F6) and keeps the strike-ordered
 * 500-row page from ending below spot (R1). UW's `/strike` doc says to walk
 * `page` from 0 until a page comes back empty; its pages are dense, so a page
 * shorter than the limit is the last (probed 2026-11-07: with `limit=50` the
 * pages held 50, 31 and 0 rows). The walk therefore continues only while a
 * page holds exactly UW_STRIKE_PAGE_LIMIT rows, which saves the empty
 * request, and throws at MAX_PAGES: a ±range window holds well under one
 * page, so a walk that long means UW is not honouring the window, and a
 * ladder cut off somewhere is not stored.
 */

import { strikeWindow, UW_STRIKE_PAGE_LIMIT } from './strike-ladder.js';
import { uwFetchPaged } from './uw-fetch-paged.js';

/** One row of the all-expiry ladder, as UW sends it (numbers as strings). */
export interface StrikeAllRow {
  strike: string;
  price: string;
  time: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_ask: string;
  call_charm_bid: string;
  put_charm_ask: string;
  put_charm_bid: string;
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
}

/** Stored strikes are spot ± this many points. */
export const STRIKE_ALL_ATM_RANGE = 200;
const MAX_PAGES = 10;

/**
 * Every strike row of the SPX all-expiry ladder inside the window around
 * `spot`, for today (no `date`) or for the past ET date `date`.
 */
export async function fetchStrikeAllLadder<T>(
  apiKey: string,
  spot: number,
  date?: string,
): Promise<T[]> {
  const { minStrike, maxStrike } = strikeWindow(spot, STRIKE_ALL_ATM_RANGE);
  const { rows, reachedPageCap } = await uwFetchPaged<T>({
    apiKey,
    maxPages: MAX_PAGES,
    buildPath: (page) => {
      const params = new URLSearchParams({
        ...(date === undefined ? {} : { date }),
        min_strike: String(minStrike),
        max_strike: String(maxStrike),
        limit: String(UW_STRIKE_PAGE_LIMIT),
        page: String(page),
      });
      return `/stock/SPX/spot-exposures/strike?${params}`;
    },
    onPage: (batch) => ({ done: batch.length < UW_STRIKE_PAGE_LIMIT }),
  });
  if (reachedPageCap) {
    throw new Error(
      `strike-all ladder: ${MAX_PAGES} full pages of ${UW_STRIKE_PAGE_LIMIT} strikes, ladder may be cut off`,
    );
  }
  return rows;
}
