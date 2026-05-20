/**
 * useLotteryFinder — fetches /api/lottery-finder with a per-minute
 * scrubber bucket, paginated results (50 per page by default), and the
 * full filter chip set (ticker / reload / cheap-call-PM / mode /
 * optionType / TOD). Polls every 30s during market hours when no
 * minute is selected and the date is today; otherwise the response is
 * stable and polling is skipped.
 *
 * Phase 2M-5: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `data?.fires ?? []`, `data?.reignitedFires ?? []`,
 * `data?.total ?? 0`, etc.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';
import type {
  LotteryFinderResponse,
  LotteryMode,
  LotterySortMode,
  OptionType,
  TimeOfDay,
} from '../components/LotteryFinder/types.js';

interface UseLotteryFinderArgs {
  /** YYYY-MM-DD trading day. */
  date: string;
  /**
   * Optional 1-minute point-in-time bucket. When set, the endpoint
   * returns only fires whose trigger_time_ct is in
   * `[minute, minute + 1m)`. Drives the time-scrubber UX.
   */
  minute?: string | null;
  marketOpen: boolean;
  /** Filter by ticker. `null` returns all. */
  ticker?: string | null;
  /** Filter to RE-LOAD only. */
  reload?: boolean | null;
  /** Filter to cheap-call-PM only. */
  cheapCallPm?: boolean | null;
  /** Filter by mode (Mode A or Mode B). */
  mode?: LotteryMode | null;
  /** Filter by option type ('C' / 'P'). */
  optionType?: OptionType | null;
  /** Filter by time-of-day bucket. */
  tod?: TimeOfDay | null;
  /** Sort mode for the result set. Default 'chronological'. */
  sort?: LotterySortMode;
  /** Minimum score floor (Tier 1 = 18 enables High Conviction filter). */
  minScore?: number | null;
  /**
   * Numeric premium floor in dollars
   * (entry_price * trigger_window_size * 100). 0 / null = no floor.
   * Server-side filter so pagination + ticker counts reflect the
   * post-filter result. Mirrors the SilentBoom feed param.
   */
  minPremium?: number | null;
  /**
   * Phase 4 inversion-quality escape hatch. When `true`, the URL
   * builder appends `showAll=true` and the server bypasses the bottom-
   * quintile (Q1/Q2) inversion-quality suppression. Off by default —
   * the lottery feed is intentionally narrowed.
   */
  showAll?: boolean;
  /** 0-based page index (offset = page * limit). */
  page?: number;
  /** Page size. Default 50. */
  pageSize?: number;
}

export function useLotteryFinder({
  date,
  minute,
  marketOpen,
  ticker = null,
  reload = null,
  cheapCallPm = null,
  mode = null,
  optionType = null,
  tod = null,
  sort = 'chronological',
  minScore = null,
  minPremium = null,
  showAll = false,
  page = 0,
  pageSize = 50,
}: UseLotteryFinderArgs): UseFetchedDataResult<LotteryFinderResponse> {
  const params = new URLSearchParams({
    date,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  if (minute) params.set('minute', minute);
  if (ticker) params.set('ticker', ticker);
  if (reload != null) params.set('reload', String(reload));
  if (cheapCallPm != null) params.set('cheapCallPm', String(cheapCallPm));
  if (mode != null) params.set('mode', mode);
  if (optionType != null) params.set('optionType', optionType);
  if (tod != null) params.set('tod', tod);
  if (sort !== 'chronological') params.set('sort', sort);
  if (minScore != null) params.set('minScore', String(minScore));
  if (minPremium != null && minPremium > 0)
    params.set('minPremium', String(minPremium));
  if (showAll) params.set('showAll', 'true');
  const url = `/api/lottery-finder?${params.toString()}`;

  // Original gates were `[marketOpen, !minute, page === 0]` — fold the
  // `!minute` and `page === 0` gates into the historical flag so the
  // minute-scrub view and paginated views single-fetch instead of polling.
  return useFetchedData<LotteryFinderResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: minute != null || page !== 0,
  });
}
