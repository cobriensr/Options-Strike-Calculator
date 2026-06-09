/**
 * useSilentBoomFeed — fetches /api/silent-boom-feed with filter chips
 * and pagination. Polls every 30s during market hours when on page 0
 * AND the selected date is today (historical days are static).
 *
 * Phase 2M-4: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `data?.alerts ?? []`, `data?.total ?? 0`, etc.
 */

import { POLL_INTERVALS } from '../constants/index.js';
import {
  gateResponseToDate,
  useFetchedData,
  type UseFetchedDataResult,
} from './useFetchedData.js';
import type {
  OptionType,
  SilentBoomAskPctBand,
  SilentBoomBurstColor,
  SilentBoomDteBucket,
  SilentBoomFeedResponse,
  SilentBoomSortMode,
  SilentBoomTod,
} from '../components/SilentBoom/types.js';

interface UseSilentBoomFeedArgs {
  date: string;
  marketOpen: boolean;
  /** When true, the date is in the past — feed is static, skip polling. */
  historical?: boolean;
  ticker?: string | null;
  optionType?: OptionType | null;
  /** Vol/OI floor — UI default 0.5 to trim to actionable density. */
  minVolOi?: number;
  /** Spike-ratio floor. */
  minSpikeRatio?: number;
  /** Composite-score floor — Tier 1 = 21, Tier 2 = 8. */
  minScore?: number | null;
  /** Time-of-day filter — null = all phases. */
  tod?: SilentBoomTod | null;
  /**
   * DTE bucket filter — null = all DTEs. Legacy; new callers should
   * use `minDte` instead. Kept for back-compat with any cached query
   * strings. Server honors `minDte` over this when both are set.
   */
  dte?: SilentBoomDteBucket | null;
  /** Numeric DTE floor — 0 = all DTEs, N = only alerts with dte >= N. */
  minDte?: number;
  /** Numeric premium floor in dollars (entry_price × spike_volume × 100). */
  minPremium?: number;
  /** Hide alerts after 14:30 CT — server-side so pagination is accurate. */
  hideLatePm?: boolean;
  /** Burst-color category filter — null = all colors. */
  burst?: SilentBoomBurstColor | null;
  /** Ask% band filter — null = all bands. */
  askPctBand?: SilentBoomAskPctBand | null;
  /**
   * Aggressive Premium chip — single toggle that ANDs the trader's
   * UW filter (premium ≥ $100K, DTE ≤ 8, vol/OI > 1, single-leg, OTM)
   * onto the existing filters. Server-side enforced in
   * api/silent-boom-feed.ts.
   */
  aggressivePremium?: boolean;
  /** TAKE-IT calibrated P(peak >= +20%) floor. 0 = no floor. Server-
   *  side so pagination + chip totals reflect the post-filter result. */
  minTakeitProb?: number;
  sort?: SilentBoomSortMode;
  page?: number;
  pageSize?: number;
}

export function useSilentBoomFeed({
  date,
  marketOpen,
  historical = false,
  ticker = null,
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
  aggressivePremium = false,
  minTakeitProb = 0,
  sort = 'newest',
  page = 0,
  pageSize = 50,
}: UseSilentBoomFeedArgs): UseFetchedDataResult<SilentBoomFeedResponse> {
  const params = new URLSearchParams({
    date,
    limit: String(pageSize),
    offset: String(page * pageSize),
    minVolOi: String(minVolOi),
    minSpikeRatio: String(minSpikeRatio),
    sort,
  });
  if (ticker) params.set('ticker', ticker);
  if (optionType) params.set('optionType', optionType);
  if (minScore != null) params.set('minScore', String(minScore));
  if (tod) params.set('tod', tod);
  if (dte) params.set('dte', dte);
  if (minDte > 0) params.set('minDte', String(minDte));
  if (minPremium > 0) params.set('minPremium', String(minPremium));
  if (hideLatePm) params.set('hideLatePm', 'true');
  if (burst) params.set('burst', burst);
  if (askPctBand) params.set('askPctBand', askPctBand);
  if (aggressivePremium) params.set('aggressivePremium', 'true');
  if (minTakeitProb > 0) params.set('minTakeitProb', String(minTakeitProb));
  const url = `/api/silent-boom-feed?${params.toString()}`;

  // Original gates were `[marketOpen, page === 0, !historical]` — fold
  // the `page === 0` gate into the historical flag so paginated views
  // single-fetch instead of polling.
  const result = useFetchedData<SilentBoomFeedResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: historical || page !== 0,
  });
  return gateResponseToDate(result, date);
}
