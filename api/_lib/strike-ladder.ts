/**
 * Snapshot checks shared by the two UW strike-ladder crons,
 * `fetch-strike-exposure` (per expiry) and `fetch-strike-all` (all expiries).
 * Both store a ladder under today's `date` and a 5-minute `timestamp`, and
 * both were writing three kinds of wrong ladder
 * (docs/superpowers/specs/live-data-integrity-2026-11-06.md, F5 to F7):
 *
 *   - F5, prior-day ladder: until UW rolls over (09:28 to 09:32 ET) the first
 *     poll of the day is yesterday's close. `isBeforeEtDay` is the same
 *     stale-cache check as fetch-gex-0dte (099171ab), judged on the ET day
 *     the row will be stored under rather than on a wall-clock CT date;
 *     inside the 09:25 ET to 16:05 ET cron window the two agree.
 *   - F6, frozen ladder: UW's stale cache is bypassed by a narrow
 *     `min_strike`/`max_strike` window around the live spot, the workaround
 *     fetch-gex-0dte has used since 2026-04-23. `strikeWindow` gives the
 *     bounds, rounded outward exactly as that cron does.
 *   - F7, all-zero ladder: `hasGammaSignal` is the R-zero test, moved here
 *     unchanged from fetch-strike-all (e21f0903).
 *
 * Pure functions on UW's string-typed rows; no I/O.
 */

import { getETDateStr, isPastETDate } from '../../src/utils/timezone.js';

interface TimedRow {
  time: string;
}

/**
 * UW's documented maximum `limit` on the strike endpoints
 * (`/spot-exposures/strike` and `/spot-exposures/expiry-strike`). The one
 * constant for the strike crons (`fetch-strike-exposure`, `fetch-strike-all`,
 * `fetch-gex-0dte`) and `fetch-strike-all`'s TypeScript backfill: a windowed
 * page this full is not trusted. The two plain-node backfills
 * (`scripts/backfill-strike-exposure.mjs` and `-lottery.mjs`) cannot import it:
 * this module's runtime import of `src/utils/timezone.js` is a `.js` specifier
 * that Node's type stripping does not map to the `.ts` file. They keep their
 * own `'500'`.
 */
export const UW_STRIKE_PAGE_LIMIT = 500;

/**
 * Why a ladder was not stored. The crons and the backfill treat every kind
 * the same way (api/_lib/ladder-skip.ts): never stored, a warning, a metric,
 * and from 09:40 ET a Sentry error.
 *   - stale: the newest strike row is from an earlier ET day.
 *   - stale_spot: the spot row the window was centered on is from an earlier
 *     ET day (judged by the caller, before any ladder is fetched).
 *   - stale_source: a derived writer's source ladder (strike_exposures, for
 *     compute-zero-gamma) is from today but older than the allowed age.
 *   - all_zero: no strike in the stored range carries gamma OI.
 *   - empty: UW returned no strike rows (or the source has none).
 *   - outside_window: rows came back but none is inside the stored range.
 */
export type LadderSkipKind =
  | 'stale'
  | 'stale_spot'
  | 'stale_source'
  | 'all_zero'
  | 'empty'
  | 'outside_window';

interface StrikeRowLike {
  strike: string;
}

interface GammaRowLike {
  call_gamma_oi: string;
  put_gamma_oi: string;
}

/** Request bounds for `min_strike` / `max_strike`: spot ± range, rounded out. */
export function strikeWindow(
  spot: number,
  range: number,
): { minStrike: number; maxStrike: number } {
  return {
    minStrike: Math.floor(spot - range),
    maxStrike: Math.ceil(spot + range),
  };
}

/**
 * The stored-strike filter: spot ± range, both ends inclusive. Kept after the
 * windowed request as a safety net against UW returning a wider ladder.
 */
export function keepWithinRange<T extends StrikeRowLike>(
  rows: readonly T[],
  spot: number,
  range: number,
): T[] {
  const min = spot - range;
  const max = spot + range;
  return rows.filter((r) => {
    const strike = Number.parseFloat(r.strike);
    return strike >= min && strike <= max;
  });
}

/**
 * The snapshot's calculation time: the latest parseable `time` across the
 * rows, as an ISO string. Null when no row has one. `rows[0]` is not
 * "the newest" for a paged or unordered answer.
 */
export function newestRowTime(rows: readonly TimedRow[]): string | null {
  let newestMs = Number.NaN;
  for (const r of rows) {
    const ms = Date.parse(r.time);
    if (!Number.isNaN(ms) && (Number.isNaN(newestMs) || ms > newestMs)) {
      newestMs = ms;
    }
  }
  return Number.isNaN(newestMs) ? null : new Date(newestMs).toISOString();
}

/**
 * True when `timeIso` falls on an ET calendar day earlier than `today`
 * (YYYY-MM-DD, the ET date the snapshot would be stored under): UW served a
 * prior session's ladder. YYYY-MM-DD strings order chronologically.
 */
export function isBeforeEtDay(timeIso: string, today: string): boolean {
  return isPastETDate(getETDateStr(new Date(timeIso)), today);
}

/**
 * R-zero: false when no strike carries any call or put gamma OI, the
 * signature of the all-zero ladder UW returns at the open. Blank and
 * unparseable values count as zero. Gamma OI is the test because every other
 * column derives from the same OI and it is what compute-zero-gamma reads.
 */
export function hasGammaSignal(rows: readonly GammaRowLike[]): boolean {
  const toNumber = (v: string): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  return rows.some(
    (r) => toNumber(r.call_gamma_oi) !== 0 || toNumber(r.put_gamma_oi) !== 0,
  );
}

/** What to do with a fetched ladder. */
export type LadderVerdict<T> =
  | { kind: 'store'; rows: T[]; snapshotTime: string }
  /** No row has a parseable `time`: a malformed payload, not a skip. */
  | { kind: 'malformed' }
  | { kind: 'empty' }
  | { kind: 'stale'; dataEtDate: string; snapshotTime: string }
  | { kind: 'outside_window'; total: number }
  | { kind: 'all_zero'; total: number };

/**
 * The store-or-skip decision for one fetched ladder, shared by both crons and
 * the backfill. `day` is the ET date the rows would be stored under (the
 * cron's `today`, the backfill's date). Checked in this order, the first
 * failing check names the verdict: no rows, no parseable time, newest row
 * from an earlier ET day, no row inside spot ± range, no gamma in range. A
 * `store` verdict carries only the in-range rows and the newest row time.
 */
export function judgeLadder<T extends TimedRow & StrikeRowLike & GammaRowLike>(
  rows: readonly T[],
  opts: { spot: number; range: number; day: string },
): LadderVerdict<T> {
  if (rows.length === 0) return { kind: 'empty' };

  const snapshotTime = newestRowTime(rows);
  if (snapshotTime === null) return { kind: 'malformed' };

  if (isBeforeEtDay(snapshotTime, opts.day)) {
    return {
      kind: 'stale',
      dataEtDate: getETDateStr(new Date(snapshotTime)),
      snapshotTime,
    };
  }

  const inRange = keepWithinRange(rows, opts.spot, opts.range);
  if (inRange.length === 0) {
    return { kind: 'outside_window', total: rows.length };
  }
  if (!hasGammaSignal(inRange)) {
    return { kind: 'all_zero', total: inRange.length };
  }
  return { kind: 'store', rows: inRange, snapshotTime };
}
