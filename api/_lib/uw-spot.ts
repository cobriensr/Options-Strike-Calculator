/**
 * Shared Unusual Whales spot helper.
 *
 * `/stock/{ticker}/spot-exposures` is UW's per-minute exposure series. It
 * returns the whole session so far, one row per minute, and its `price` is
 * the underlying at that minute. The per-strike endpoints
 * (`/spot-exposures/strike`, `/spot-exposures/expiry-strike`) repeat a
 * `price` on every strike row, but when UW serves a frozen cache that price
 * is frozen too. A caller that needs the underlying right now (the center of
 * a `min_strike`/`max_strike` window, the price stored with a ladder) takes it
 * from here instead.
 *
 * Contract (docs/superpowers/plans/2026-10-23-uw-rest-fixes.md, Task R1):
 *   - the row with the greatest `start_time ?? time` wins, wherever it sits
 *     in the array (the same ordering key as fetch-spot-gex.ts);
 *   - null, with a warning, when there is no usable row or the newest row's
 *     price is NaN, missing or <= 0. An older row's price is never a
 *     substitute: it is not the current spot;
 *   - a uwFetch rejection propagates. Retry and surfacing belong to the
 *     caller, and a caller that cannot get a spot must say so, not guess.
 *
 * `date` (YYYY-MM-DD) asks for a past session, for the backfills.
 */

import logger from './logger.js';
import { uwFetch } from './uw-fetch.js';

interface SpotExposureRow {
  price?: string | number | null;
  time?: string;
  start_time?: string;
}

export interface UwSpot {
  /** Underlying price at `time`. Always finite and > 0. */
  price: number;
  /** The row's own timestamp as UW sent it (`start_time ?? time`). */
  time: string;
}

export async function fetchUwSpot(
  apiKey: string,
  ticker: string,
  date?: string,
): Promise<UwSpot | null> {
  const path =
    date === undefined
      ? `/stock/${ticker}/spot-exposures`
      : `/stock/${ticker}/spot-exposures?date=${date}`;
  const rows = await uwFetch<SpotExposureRow>(apiKey, path);

  let newest: { row: SpotExposureRow; time: string; ms: number } | null = null;
  for (const row of rows) {
    const time = row.start_time ?? row.time;
    const ms = time === undefined ? Number.NaN : Date.parse(time);
    if (Number.isNaN(ms) || time === undefined) continue;
    if (newest === null || ms > newest.ms) newest = { row, time, ms };
  }

  if (newest === null) {
    logger.warn(
      { ticker, date, rows: rows.length },
      'fetchUwSpot: no usable spot row',
    );
    return null;
  }

  const price = Number.parseFloat(String(newest.row.price));
  if (!Number.isFinite(price) || price <= 0) {
    logger.warn(
      { ticker, date, price: newest.row.price, time: newest.time },
      'fetchUwSpot: newest spot price is not a positive number',
    );
    return null;
  }

  return { price, time: newest.time };
}
