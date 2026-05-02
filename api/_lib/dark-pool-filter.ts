/**
 * passesDarkPoolQualityFilter — central source of truth for the
 * 12-line dark-pool quality filter that previously lived as a verbatim
 * duplicate inside `darkpool.ts` (lines 146-161 and 302-317), each one
 * with a "must stay in sync" comment. The filters had already drifted
 * twice before this consolidation.
 *
 * Filters applied (each one a distinct piece of UW-tape garbage):
 *
 *   - canceled trades            (UW emits + later cancels — must drop)
 *   - extended-hours-flagged     (`ext_hour_sold_codes` non-null)
 *   - non-regular settlement     (excludes 'regular' / 'regular_settlement')
 *   - average-price prints       (blended over a period — uncertain price)
 *   - contingent_trade prints    (pre-arranged swap resets / basket unwinds)
 *   - derivative_priced prints   (synthetic prices)
 *   - pre/post session prints    (08:30 ≤ CT < 15:00 — `ext_hour` misses these)
 *   - cross-date prints when a date is specified (defense in depth)
 *
 * Adoption is part of Phase 1e — see the plan in
 * docs/superpowers/specs/api-refactor-2026-05-02.md.
 *
 * Phase 1e of the refactor.
 */

import { getCTTime, getETDateStr } from '../../src/utils/timezone.js';
import { SESSION_OPEN_MIN_CT, SESSION_CLOSE_MIN_CT } from './constants.js';

/**
 * Structural subset of a UW dark-pool trade. We avoid importing the full
 * `DarkPoolTrade` from `darkpool.ts` so this module stays free of any
 * circular dep — `darkpool.ts` is one of the adoption sites.
 */
export interface DarkPoolFilterableTrade {
  canceled: boolean;
  executed_at: string;
  ext_hour_sold_codes: string | null;
  sale_cond_codes: string | null;
  trade_code: string | null;
  trade_settlement: string;
}

/**
 * Version stamp for the active filter list. Bump when filters change so
 * downstream consumers (metrics, drift detection) can correlate. See the
 * plan's "Thresholds / constants to name" section.
 */
export const DARK_POOL_FILTER_VERSION = '2026-05-02';

/**
 * Regular-hours US equity session window. Authored in CT in
 * `constants.ts` (08:30 inclusive → 15:00 exclusive) — see Phase 5m.
 *
 * `ext_hour_sold_codes` catches trades UW flags as extended-hours, but
 * does NOT catch regular-session-flagged trades whose `executed_at`
 * falls outside normal RTH (e.g. 06:15 CT pre-open block prints with
 * `ext_hour_sold_codes: null`). Per trader preference, those distort
 * the intraday volume profile and must be dropped before aggregation.
 *
 * True when the trade's `executed_at` is inside the regular-hours
 * Central-Time session window. Returns false for unparseable dates.
 */
export function isIntradayCT(executedAt: string): boolean {
  const d = new Date(executedAt);
  if (Number.isNaN(d.getTime())) return false;
  const { hour, minute } = getCTTime(d);
  const mins = hour * 60 + minute;
  return mins >= SESSION_OPEN_MIN_CT && mins < SESSION_CLOSE_MIN_CT;
}

export interface DarkPoolFilterOptions {
  /**
   * If provided, also drop any trade whose ET date doesn't match. UW's
   * date filter is loose (especially when combined with `older_than`),
   * so callers fetching for a specific date apply this guard.
   */
  date?: string;
}

/**
 * Returns true when the trade should be kept after applying all
 * dark-pool quality filters. Returns false (drop) for any disqualifying
 * condition.
 *
 * Filters are evaluated in cheapest-first order so the hot path exits
 * early on common cases (canceled, ext_hour, etc.) before doing date
 * parsing / timezone math.
 */
export function passesDarkPoolQualityFilter(
  trade: DarkPoolFilterableTrade,
  opts: DarkPoolFilterOptions = {},
): boolean {
  if (trade.canceled) return false;
  if (trade.ext_hour_sold_codes) return false;
  if (
    trade.trade_settlement !== 'regular' &&
    trade.trade_settlement !== 'regular_settlement'
  ) {
    return false;
  }
  if (trade.sale_cond_codes === 'average_price_trade') return false;
  if (trade.sale_cond_codes === 'contingent_trade') return false;
  if (trade.trade_code === 'derivative_priced') return false;
  if (!isIntradayCT(trade.executed_at)) return false;
  if (opts.date && getETDateStr(new Date(trade.executed_at)) !== opts.date) {
    return false;
  }
  return true;
}
