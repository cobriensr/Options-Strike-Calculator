/**
 * useLotteryFinderTickerCounts — fetches /api/lottery-finder-ticker-counts
 * for the chip strip above LotteryFinderSection. Chain-day deduped so
 * the count matches the row dedup the main feed performs.
 *
 * Polls on the same 30s cadence as the feed during market hours;
 * static on historical days.
 *
 * Phase 2M-2 migration: the hook is now a thin wrapper around
 * `useFetchedData<LotteryFinderTickerCountsResponse>` that returns the
 * canonical `{ data, loading, error, refresh, fetchedAt }` shape.
 * Callers destructure `tickers` from `data` at the call site.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import type {
  LotteryMode,
  OptionType,
  TimeOfDay,
} from '../components/LotteryFinder/types.js';
import {
  gateResponseToDate,
  useFetchedData,
  type UseFetchedDataResult,
} from './useFetchedData.js';

export interface LotteryFinderTickerCount {
  ticker: string;
  count: number;
  peakBestPct: number | null;
  latestTriggerTimeCt: string;
}

interface UseLotteryFinderTickerCountsArgs {
  date: string;
  marketOpen: boolean;
  historical?: boolean;
  reload?: boolean | null;
  cheapCallPm?: boolean | null;
  mode?: LotteryMode | null;
  optionType?: OptionType | null;
  tod?: TimeOfDay | null;
  minScore?: number | null;
  /** Numeric premium floor in dollars. Mirrors the section's
   *  `minPremiumK * 1000` value so the chip-strip counts match the
   *  filtered feed. */
  minPremium?: number;
  /** Chain-day fire_count floor. Server-side so chip counts stay
   *  aligned with the burst-filtered feed. 0/1 = no floor. */
  minFireCount?: number;
  /** Chain-day fire_count CAP. Inverse of `minFireCount` — server-side
   *  so chip counts stay aligned with the burst-capped feed. 0 = no cap
   *  (a cap of 1 IS meaningful: single-fire chains only). */
  maxFireCount?: number;
  /** TAKE-IT calibrated probability floor. Server-side so chip counts
   *  stay aligned with the TAKE-IT-filtered feed. 0 = no floor. */
  minTakeitProb?: number;
  /** Mirror of `showAll` on the feed hook. When true, the count
   *  endpoint bypasses the bottom-quintile inversion-quality
   *  suppression so the chip strip matches the feed under the
   *  "Show filtered tickers" toggle. Off by default — the chip
   *  totals stay aligned with the narrowed default feed instead of
   *  overstating it. */
  showAll?: boolean;
}

export interface LotteryFinderTickerCountsResponse {
  /** Requested trading day, echoed by the server. Drives the cross-day
   *  staleness gate in `gateResponseToDate`. */
  date: string;
  tickers: LotteryFinderTickerCount[];
}

export function useLotteryFinderTickerCounts({
  date,
  marketOpen,
  historical = false,
  reload = null,
  cheapCallPm = null,
  mode = null,
  optionType = null,
  tod = null,
  minScore = null,
  minPremium = 0,
  minFireCount = 0,
  maxFireCount = 0,
  minTakeitProb = 0,
  showAll = false,
}: UseLotteryFinderTickerCountsArgs): UseFetchedDataResult<LotteryFinderTickerCountsResponse> {
  const params = new URLSearchParams({ date });
  if (reload != null) params.set('reload', String(reload));
  if (cheapCallPm != null) params.set('cheapCallPm', String(cheapCallPm));
  if (mode) params.set('mode', mode);
  if (optionType) params.set('optionType', optionType);
  if (tod) params.set('tod', tod);
  if (minScore != null) params.set('minScore', String(minScore));
  if (minPremium > 0) params.set('minPremium', String(minPremium));
  if (minFireCount > 1) params.set('minFireCount', String(minFireCount));
  if (maxFireCount >= 1) params.set('maxFireCount', String(maxFireCount));
  if (minTakeitProb > 0) params.set('minTakeitProb', String(minTakeitProb));
  if (showAll) params.set('showAll', 'true');
  const url = `/api/lottery-finder-ticker-counts?${params.toString()}`;

  const result = useFetchedData<LotteryFinderTickerCountsResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical,
  });
  return gateResponseToDate(result, date);
}
