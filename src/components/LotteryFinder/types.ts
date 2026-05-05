/**
 * Shared types for the LotteryFinder UI.
 * Mirror of the API response from /api/lottery-finder.
 *
 * Spec: docs/superpowers/specs/lottery-finder-2026-05-02.md
 */

export type OptionType = 'C' | 'P';
export type LotteryMode =
  | 'A_intraday_0DTE'
  | 'B_multi_day_DTE1_3'
  | 'OUT_OF_UNIVERSE';
export type TimeOfDay = 'AM_open' | 'MID' | 'LUNCH' | 'PM';

/** Realized exit policies surfaced by the LotteryRow chip selector. */
export type ExitPolicy =
  | 'realizedTrail30_10Pct' // act30_trail10 — default, conservative
  | 'realizedHard30mPct' //   hard 30-min stop, EV-best
  | 'realizedTier50HoldEodPct' // 50% off at +50%, hold rest
  | 'realizedFlowInversionPct'; // exit when matched-side ticker flow inverts

export const EXIT_POLICY_LABELS: Record<ExitPolicy, string> = {
  realizedTrail30_10Pct: 'trail 30/10',
  realizedHard30mPct: 'hard 30m',
  realizedTier50HoldEodPct: 'tier 50 + hold',
  realizedFlowInversionPct: 'flow-inversion',
};

export const EXIT_POLICY_TOOLTIPS: Record<ExitPolicy, string> = {
  realizedTrail30_10Pct:
    'Trailing stop: activate at +30%, exit when current return drops 10pp below the running peak. Most psychologically sustainable; positive in 50% of LOO days.',
  realizedHard30mPct:
    'Hard time-stop: exit at minute 30 from entry, no matter what. Highest EV in the 15-day backtest (+$127/day mean), but only 25% of days are profitable — wins are bigger but rarer.',
  realizedTier50HoldEodPct:
    'Two-tier exit: sell half at +50%, hold the rest to end-of-session. Middle ground between the trailing stop and the hard exit.',
  realizedFlowInversionPct:
    'Exit when matched-side ticker net flow slope flips negative for ≥3 consecutive minutes after the post-trigger flow peak. Validated on 47k fires: +9.8pp mean uplift after costs and 5x lottery rate (6.7% vs 1.3% under trail-30/10), at the cost of more small losses (44.4% win rate vs 54.7%). Edge concentrates on call fires × AM/MID time-of-day, with the top 5 trading days carrying ~29% of all winners. Populated only for fires inside the 15-day parquet window — older / very-recent fires show —.',
};

export interface LotteryFireTrigger {
  volToOiWindow: number;
  volToOiCum: number;
  iv: number;
  delta: number;
  askPct: number;
  windowSize: number;
  windowPrints: number;
}

export interface LotteryFireEntry {
  price: number;
  openInterest: number;
  spotAtFirst: number;
  alertSeq: number;
  minutesSincePrevFire: number;
}

export interface LotteryFireTags {
  flowQuad: string; // call_ask, call_bid, call_mixed, put_*
  tod: TimeOfDay;
  mode: LotteryMode;
  reload: boolean;
  cheapCallPm: boolean;
  burstRatioVsPrev: number | null;
  entryDropPctVsPrev: number | null;
}

/**
 * Macro context snapshot at fire time. **Display-only** per spec
 * Appendix A — every macro-augmented selection rule UNDERPERFORMED
 * the cheap-call-PM-only baseline on total realized $ in the 15-day
 * backtest. Surfaced as informational badges, never as filter chips.
 */
export interface LotteryFireMacro {
  mktTideNcp: number | null;
  mktTideNpp: number | null;
  mktTideDiff: number | null;
  mktTideOtmDiff: number | null;
  spxFlowDiff: number | null;
  spyEtfDiff: number | null;
  qqqEtfDiff: number | null;
  zeroDteDiff: number | null;
  spxSpotGammaOi: number | null;
  spxSpotGammaVol: number | null;
  spxSpotCharmOi: number | null;
  spxSpotVannaOi: number | null;
  gexStrikeCallMinusPut: number | null;
  gexStrikeCallAskMinusBid: number | null;
  gexStrikePutAskMinusBid: number | null;
  gexStrikeActualStrike: number | null;
}

export interface LotteryFireOutcomes {
  realizedTrail30_10Pct: number | null;
  realizedHard30mPct: number | null;
  realizedTier50HoldEodPct: number | null;
  realizedFlowInversionPct: number | null;
  realizedEodPct: number | null;
  peakCeilingPct: number | null;
  minutesToPeak: number | null;
  enrichedAt: string | null;
}

/** Tier label derived from `score`. Tier 1 ≥18, Tier 2 12-17, Tier 3 <12. */
export type LotteryScoreTier = 'tier1' | 'tier2' | 'tier3';

/** Sort modes accepted by /api/lottery-finder?sort=. */
export type LotterySortMode = 'chronological' | 'score' | 'peak';

/**
 * Per-ticker reliability stats joined from `lottery_ticker_stats`.
 * `null` when no stats row exists for the ticker (rare — universe is
 * ~50 tickers and the seed covers all of them).
 */
export interface LotteryTickerStats {
  nFires: number;
  highPeakRate: number;
  ciLower: number;
  ciUpper: number;
  ciWidth: number;
  /** 'reliable' (CI <10pp), 'uncertain' (>15pp), '' in the middle. */
  tier: 'reliable' | 'uncertain' | '';
}

export interface LotteryFire {
  id: number;
  date: string;
  triggerTimeCt: string;
  entryTimeCt: string;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  dte: number;

  /** Composite score (0-25). `null` only on rows pre-#126 backfill. */
  score: number | null;
  /** Tier label derived from `score` (tier3 when score is null). */
  scoreTier: LotteryScoreTier;
  /** Predicted peak-return range string for the tier (display-only). */
  forecastHighPeakPct: string;
  /** Per-ticker reliability stats; `null` when no row exists. */
  tickerStats: LotteryTickerStats | null;
  /**
   * Number of underlying fires collapsed onto this row by the API's
   * (ticker × strike × option_type × minute-bucket) dedup CTE. 1 means
   * unique; >1 means the row is the latest of a cluster (the detector
   * cooldown is per cron invocation, so successive runs re-qualify the
   * next tick).
   */
  fireCount: number;

  trigger: LotteryFireTrigger;
  entry: LotteryFireEntry;
  tags: LotteryFireTags;
  macro: LotteryFireMacro;
  outcomes: LotteryFireOutcomes;

  insertedAt: string;
}

export interface LotteryFinderResponse {
  date: string;
  /** Cumulative cutoff (back-compat, not used by current UI). */
  asOf: string | null;
  /** 1-minute point-in-time bucket the slider is on, when set. */
  minute: string | null;
  filters: {
    ticker?: string;
    reload?: boolean;
    cheapCallPm?: boolean;
    mode?: LotteryMode;
    optionType?: OptionType;
    tod?: TimeOfDay;
    sort?: LotterySortMode;
    minScore?: number;
  };
  /** Number of fires actually returned in this response (≤ limit). */
  count: number;
  /** Total matching rows BEFORE limit/offset — for "page X of Y" UI. */
  total: number;
  /** The effective limit applied. */
  limit: number;
  /** Page offset (0 = first page). */
  offset: number;
  /** True when offset + count < total — surfaces the Next button. */
  hasMore: boolean;
  fires: LotteryFire[];
}

// ============================================================
// /api/net-flow-history response
// ============================================================

/** One per-tick row with deltas + cumulative columns. */
export interface NetFlowTick {
  /** UTC ISO timestamp. */
  ts: string;
  /** Per-tick net call premium (delta). */
  ncp: number;
  /** Per-tick net call volume (delta). */
  ncv: number;
  /** Per-tick net put premium (delta). */
  npp: number;
  /** Per-tick net put volume (delta). */
  npv: number;
  /** Cumulative NCP since session open. */
  cumNcp: number;
  /** Cumulative NCV since session open. */
  cumNcv: number;
  /** Cumulative NPP since session open. */
  cumNpp: number;
  /** Cumulative NPV since session open. */
  cumNpv: number;
}

export interface NetFlowHistoryResponse {
  ticker: string;
  date: string;
  /** Lower window bound, UTC ISO. */
  from: string;
  /** Upper window bound, UTC ISO. */
  to: string;
  count: number;
  series: NetFlowTick[];
}

// ============================================================
// /api/lottery-contract-tape response
// ============================================================

/** One per-minute bar with side-split volumes + price stats. */
export interface ContractTapeBar {
  /** UTC ISO timestamp at the start of the minute bucket. */
  ts: string;
  /** Volume printed at the ask side. */
  askVol: number;
  /** Volume printed at the bid side. */
  bidVol: number;
  /** Volume printed at the mid. */
  midVol: number;
  /** Volume with no side classification. */
  noSideVol: number;
  /** Total volume across all sides. */
  totalVol: number;
  /** Volume-weighted average price across the minute. */
  avgPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
}

export interface ContractTapeResponse {
  /** OCC OSI symbol. */
  chain: string;
  date: string;
  from: string;
  to: string;
  count: number;
  series: ContractTapeBar[];
}
