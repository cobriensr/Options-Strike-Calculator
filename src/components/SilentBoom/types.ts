/**
 * Shared types for the SilentBoomSection UI.
 * Mirror of the API response from /api/silent-boom-feed.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 */

export type OptionType = 'C' | 'P';

export type SilentBoomSortMode = 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';

export type SilentBoomScoreTier = 'tier1' | 'tier2' | 'tier3';

export type SilentBoomTod = 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE';

export type SilentBoomDteBucket = '0' | '1-3' | '4+';

export type SilentBoomBurstColor = 'red' | 'yellow' | 'grey';

export interface SilentBoomOutcomes {
  peakCeilingPct: number | null;
  minutesToPeak: number | null;
  realized30mPct: number | null;
  realized60mPct: number | null;
  realized120mPct: number | null;
  realizedEodPct: number | null;
  enrichedAt: string | null;
}

export interface SilentBoomAlert {
  id: number;
  date: string;
  /** UTC ISO of the 5-min bucket start. */
  bucketCt: string;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  dte: number;
  spikeVolume: number;
  baselineVolume: number;
  /** spikeVolume / max(baselineVolume, 1). */
  spikeRatio: number;
  /** ask_size / (ask_size + bid_size) in the spike bucket. */
  askPct: number;
  /** spikeVolume / open_interest. */
  volOi: number;
  entryPrice: number;
  openInterest: number;
  /** Composite conviction score. See api/_lib/silent-boom-score.ts.
   *  Null only on legacy rows pre-Phase-1. */
  score: number | null;
  /** 'tier1' | 'tier2' | 'tier3'; null only on legacy rows. */
  scoreTier: SilentBoomScoreTier | null;
  /** Market Tide NCP - NPP at the spike-bucket time. Display-only
   *  context — not a selection signal (lottery_finder convention). */
  mktTideDiff: number | null;
  /** zero_dte_greek_flow NCP - NPP at the spike-bucket time. */
  zeroDteDiff: number | null;
  /** SPX spot_exposures gamma_oi sign at the spike-bucket time. */
  spxSpotGammaOi: number | null;
  outcomes: SilentBoomOutcomes;
  insertedAt: string;
}

export interface SilentBoomFeedResponse {
  date: string;
  filters: {
    ticker?: string;
    optionType?: OptionType;
    minVolOi: number;
    minSpikeRatio: number;
    minScore: number | null;
    tod: SilentBoomTod | null;
    dte: SilentBoomDteBucket | null;
    burst: SilentBoomBurstColor | null;
    sort: SilentBoomSortMode;
  };
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  alerts: SilentBoomAlert[];
}
