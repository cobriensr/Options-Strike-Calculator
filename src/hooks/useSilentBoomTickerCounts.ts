/**
 * useSilentBoomTickerCounts — fetches /api/silent-boom-ticker-counts
 * for the chip strip above SilentBoomSection. Polls on the same 30s
 * cadence as the feed during market hours; static on historical days.
 *
 * Filter surface mirrors useSilentBoomFeed minus ticker (the strip IS
 * the ticker selector), pagination, and sort.
 *
 * Phase 2M-2 migration: the hook is now a thin wrapper around
 * `useFetchedData<SilentBoomTickerCountsResponse>` that returns the
 * canonical `{ data, loading, error, refresh, fetchedAt }` shape.
 * Callers destructure `tickers` from `data` at the call site.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import type {
  OptionType,
  SilentBoomAskPctBand,
  SilentBoomBurstColor,
  SilentBoomDteBucket,
  SilentBoomTod,
} from '../components/SilentBoom/types.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';

export interface SilentBoomTickerCount {
  ticker: string;
  count: number;
  peakBestPct: number | null;
  latestBucketCt: string;
}

interface UseSilentBoomTickerCountsArgs {
  date: string;
  marketOpen: boolean;
  /** Historical day → static, skip polling. */
  historical?: boolean;
  optionType?: OptionType | null;
  minVolOi?: number;
  minSpikeRatio?: number;
  minScore?: number | null;
  tod?: SilentBoomTod | null;
  dte?: SilentBoomDteBucket | null;
  /** Numeric DTE floor — 0 = all, N = only dte >= N. */
  minDte?: number;
  /** Numeric premium floor in dollars. */
  minPremium?: number;
  /** Hide alerts after 14:30 CT — server-side. */
  hideLatePm?: boolean;
  burst?: SilentBoomBurstColor | null;
  askPctBand?: SilentBoomAskPctBand | null;
  /** TAKE-IT calibrated probability floor. Server-side so chip
   *  counts stay aligned with the TAKE-IT-filtered feed. 0 = no
   *  floor. */
  minTakeitProb?: number;
}

export interface SilentBoomTickerCountsResponse {
  tickers: SilentBoomTickerCount[];
}

export function useSilentBoomTickerCounts({
  date,
  marketOpen,
  historical = false,
  optionType = null,
  minVolOi = 0.5,
  minSpikeRatio = 0,
  minScore = null,
  tod = null,
  dte = null,
  minDte = 0,
  minPremium = 0,
  hideLatePm = false,
  burst = null,
  askPctBand = null,
  minTakeitProb = 0,
}: UseSilentBoomTickerCountsArgs): UseFetchedDataResult<SilentBoomTickerCountsResponse> {
  const params = new URLSearchParams({
    date,
    minVolOi: String(minVolOi),
    minSpikeRatio: String(minSpikeRatio),
  });
  if (optionType) params.set('optionType', optionType);
  if (minScore != null) params.set('minScore', String(minScore));
  if (tod) params.set('tod', tod);
  if (dte) params.set('dte', dte);
  if (minDte > 0) params.set('minDte', String(minDte));
  if (minPremium > 0) params.set('minPremium', String(minPremium));
  if (hideLatePm) params.set('hideLatePm', 'true');
  if (burst) params.set('burst', burst);
  if (askPctBand) params.set('askPctBand', askPctBand);
  if (minTakeitProb > 0) params.set('minTakeitProb', String(minTakeitProb));
  const url = `/api/silent-boom-ticker-counts?${params.toString()}`;

  return useFetchedData<SilentBoomTickerCountsResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical,
  });
}
