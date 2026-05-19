/**
 * Shared types for the SilentBoomSection UI.
 * Mirror of the API response from /api/silent-boom-feed.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 */

// Re-export canonical OptionType from the shared module — kept
// importable from this path so existing SB call sites don't churn.
import type { OptionType, ScoreTier } from '../../types/index.js';
export type { OptionType };

export type SilentBoomSortMode = 'newest' | 'spike_ratio' | 'vol_oi' | 'peak';

/** Alias of the canonical `ScoreTier` — kept under the SB-specific
 *  name so existing call sites don't churn during Phase 2G. */
export type SilentBoomScoreTier = ScoreTier;

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

/**
 * Ask% band filter — five buckets matching the histogram in the
 * 2026-05-12 saturation audit. '100' is exact ask_pct = 1.0 (the
 * cliff bucket); the other four are half-open ranges. Spec:
 * docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md
 */
export type SilentBoomAskPctBand =
  | '70-80'
  | '80-90'
  | '90-95'
  | '95-99'
  | '100';

export interface SilentBoomOutcomes {
  peakCeilingPct: number | null;
  minutesToPeak: number | null;
  realized30mPct: number | null;
  realized60mPct: number | null;
  realized120mPct: number | null;
  realizedEodPct: number | null;
  /**
   * Phase 2 trail-30/10 realized return (migration #150). Trailing-stop
   * exit policy: activate at +30% from entry, then exit at 10pp
   * giveback from the running peak; if peak never crosses +30%, hold
   * to last tick (EoD). Null on rows enriched before #150 — the
   * nightly enrich pass backfills from parquet. Spec:
   * docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md
   */
  realizedTrail3010Pct: number | null;
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
  /**
   * Phase 4 direction gate (spec:
   * silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when
   * the fire was counter-trend per Market Tide at fire time — the
   * detector demoted score_tier to 'tier3' on insert (T=±100M on
   * mkt_tide_diff). UI renders a "Gated" pill on these rows and
   * offers a "Hide counter-trend" filter chip.
   */
  directionGated: boolean;
  /** Pre-deduct score as stored on the row. Same as `score` when no
   *  round-trip deduct has been applied. */
  rawScore?: number | null;
  /** Post-fire (ask − bid) / total volume over a 60-min window
   *  (Phase 2B cron / migration #154). Null until the evaluate-round-trip
   *  cron has run for the alert. Range [-1, +1]. */
  roundTripNetPct?: number | null;
  /** Stepped bracket deduct (0 / -1 / -2 / -3) — applied to `score` at
   *  read time, drives the "Hide round-tripped" filter chip. */
  roundTripScoreDeduct?: number;
  /**
   * Take-It calibrated win probability (migration #155, spec
   * takeit-phase3-production-scoring-2026-05-16.md). NULL when the
   * model bundle was unreachable at detect time (fail-open).
   */
  takeitProb?: number | null;
  /** SHAP top-3 green + top-3 red flags as JSON. NULL until the Phase 3d
   *  SHAP fill cron back-populates it (~2 min after fire). */
  takeitTopFeatures?: Record<string, unknown> | null;
  /** Bundle version e.g. "v2026-05-23". NULL when no bundle was loaded. */
  takeitModelVersion?: string | null;
  /** Market Tide NCP - NPP at the spike-bucket time. Display-only
   *  context — not a selection signal (lottery_finder convention). */
  mktTideDiff: number | null;
  /** zero_dte_greek_flow NCP - NPP at the spike-bucket time. */
  zeroDteDiff: number | null;
  /** SPX spot_exposures gamma_oi sign at the spike-bucket time. */
  spxSpotGammaOi: number | null;
  /**
   * Multi-leg share at the spike bucket (migration #146). Fraction of
   * spike-bucket size flagged with a multi-leg-sale UW trade code. Used
   * by the UI to render a "SPREAD-CONFIRMED" badge when the value is in
   * the 10-50% sweet spot — EDA 2026-05-15 found 2.08× win50 lift on
   * that range. Null on rows enriched before #146.
   */
  multiLegShare: number | null;
  /**
   * Ticker-level cumulative net call premium at bucket_ct, snapshotted
   * by the silent-boom-feed LATERAL join against
   * ws_net_flow_per_ticker + net_flow_per_ticker_history. Distinct from
   * mktTideDiff (which is SPY-wide market tide). Null when the ws/REST
   * tables held no rows for the ticker before the alert.
   */
  tickerCumNcpAtFire: number | null;
  /** Ticker-level cumulative net put premium at bucket_ct. */
  tickerCumNppAtFire: number | null;
  /**
   * Underlying spot price at the spike-bucket time (migration #152).
   * Null on pre-#152 rows that were inserted before the field existed.
   * The UI uses this to derive ITM/OTM moneyness client-side for the
   * All / OTM / ITM chip group. Rows with null spot fall through under
   * the All mode and are hidden under either OTM or ITM.
   */
  underlyingPriceAtSpike: number | null;
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
    askPctBand: SilentBoomAskPctBand | null;
    sort: SilentBoomSortMode;
    aggressivePremium: boolean;
  };
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  alerts: SilentBoomAlert[];
}
