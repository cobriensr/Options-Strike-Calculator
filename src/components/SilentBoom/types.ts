/**
 * Shared types for the SilentBoomSection UI.
 * Mirror of the API response from /api/silent-boom-feed.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 */

export type OptionType = 'C' | 'P';

export type SilentBoomSortMode = 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';

export type SilentBoomScoreTier = 'tier1' | 'tier2' | 'tier3';

/**
 * Realized exit policies surfaced by the section's chip selector.
 * Whichever chip is active becomes the primary % shown on every
 * SilentBoomRow. Mirrors the LotteryFinder pattern.
 */
export type SilentBoomExitPolicy =
  | 'realized30mPct'
  | 'realized60mPct'
  | 'realized120mPct'
  | 'realizedEodPct'
  | 'peakCeilingPct';

export const SILENT_BOOM_EXIT_POLICY_LABELS: Record<
  SilentBoomExitPolicy,
  string
> = {
  realized30mPct: '30m',
  realized60mPct: '60m',
  realized120mPct: '120m',
  realizedEodPct: 'eod',
  peakCeilingPct: 'peak',
};

export const SILENT_BOOM_EXIT_POLICY_TOOLTIPS: Record<
  SilentBoomExitPolicy,
  string
> = {
  realized30mPct:
    'Fixed-horizon realized return at +30 minutes from the spike bucket start.',
  realized60mPct:
    'Fixed-horizon realized return at +60 minutes from the spike bucket start.',
  realized120mPct:
    'Fixed-horizon realized return at +120 minutes from the spike bucket start.',
  realizedEodPct: 'Realized return at the last tick of the session.',
  peakCeilingPct:
    'Look-ahead peak ceiling — best-case % gain from entry to the highest post-bucket print. Reference only, not a tradeable exit.',
};

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
  /**
   * Cohort-derived "typical exit window" hint (P75 of minutes-to-peak
   * among historical winners for the (tier, ticker) cohort). Always
   * populated by /api/silent-boom-feed. See api/_lib/silent-boom-hold.ts.
   */
  avgHoldMinutes: number;
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
