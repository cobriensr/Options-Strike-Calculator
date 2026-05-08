/**
 * Shared types for the SilentBoomSection UI.
 * Mirror of the API response from /api/silent-boom-feed.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 */

export type OptionType = 'C' | 'P';

export type SilentBoomSortMode = 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';

export type SilentBoomScoreTier = 'tier1' | 'tier2' | 'tier3';

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
    sort: SilentBoomSortMode;
  };
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  alerts: SilentBoomAlert[];
}
