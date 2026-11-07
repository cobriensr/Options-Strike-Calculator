/**
 * The testable pieces of scripts/backfill-strike-all.mjs: the same spot,
 * window and paging rules api/cron/fetch-strike-all.ts applies, for a past
 * date.
 *
 * Plain `node` can't import the cron's TypeScript helpers
 * (api/_lib/uw-spot.ts, strike-ladder.ts, uw-fetch-paged.ts), so the rules
 * are restated here. Keep the three constants and the two stop rules in step
 * with the cron; strike-all-backfill.test.mjs pins them.
 *
 * Plan: docs/superpowers/plans/2026-10-23-uw-rest-fixes.md, Task R1.
 */

/** Stored strikes are spot ± this many points. */
export const ATM_RANGE = 200;
/** UW's maximum `limit`. A page with exactly this many rows may have more. */
export const PAGE_SIZE = 500;
/** Page-walk safety stop; a ±ATM_RANGE window fits in one page. */
export const MAX_PAGES = 10;

/** Request bounds for `min_strike` / `max_strike`: spot ± range, rounded out. */
export function strikeWindow(spot, range) {
  return {
    minStrike: Math.floor(spot - range),
    maxStrike: Math.ceil(spot + range),
  };
}

/**
 * The spot from `/stock/{ticker}/spot-exposures?date=` rows: the row with the
 * greatest `start_time ?? time`, wherever it sits (the ordering key of
 * api/_lib/uw-spot.ts). Null when no row has a parseable time, or when the
 * newest row's price is not a positive number: an older row's price is not
 * the spot.
 */
export function newestSpot(rows) {
  let newest = null;
  for (const row of rows) {
    const time = row.start_time ?? row.time;
    const ms = typeof time === 'string' ? Date.parse(time) : Number.NaN;
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest.ms) newest = { row, time, ms };
  }
  if (newest === null) return null;
  const price = Number.parseFloat(String(newest.row.price));
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, time: newest.time };
}

/** The latest parseable `time` across the rows, as an ISO string, or null. */
export function newestRowTime(rows) {
  let newestMs = Number.NaN;
  for (const row of rows) {
    const ms = Date.parse(row.time);
    if (!Number.isNaN(ms) && (Number.isNaN(newestMs) || ms > newestMs)) {
      newestMs = ms;
    }
  }
  return Number.isNaN(newestMs) ? null : new Date(newestMs).toISOString();
}

/** Floor an ISO time to its 5-minute bucket, as an ISO string. */
export function fiveMinuteBucket(iso) {
  const fiveMin = 5 * 60 * 1000;
  return new Date(
    Math.floor(Date.parse(iso) / fiveMin) * fiveMin,
  ).toISOString();
}

/**
 * Walk `fetchPage(pageIdx)` (0-based) while a page comes back with exactly
 * PAGE_SIZE rows; a shorter page, or an empty one, is the end. Throws if
 * MAX_PAGES full pages come back: the ladder may be cut off, and a cut-off
 * ladder is not stored. A page failure propagates, with no partial result.
 */
export async function walkLadderPages(fetchPage) {
  const rows = [];
  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
    const batch = await fetchPage(pageIdx);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, pages: pageIdx + 1 };
  }
  throw new Error(
    `${MAX_PAGES} full pages of ${PAGE_SIZE} strikes, ladder may be cut off`,
  );
}
