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

/** Realized exit policies that ship in Phase 1 (default + 2 toggles). */
export type ExitPolicy =
  | 'realizedTrail30_10Pct' // act30_trail10 — default, conservative
  | 'realizedHard30mPct' //   hard 30-min stop, EV-best
  | 'realizedTier50HoldEodPct'; // 50% off at +50%, hold rest

export const EXIT_POLICY_LABELS: Record<ExitPolicy, string> = {
  realizedTrail30_10Pct: 'trail 30/10',
  realizedHard30mPct: 'hard 30m',
  realizedTier50HoldEodPct: 'tier 50 + hold',
};

export const EXIT_POLICY_TOOLTIPS: Record<ExitPolicy, string> = {
  realizedTrail30_10Pct:
    'Trailing stop: activate at +30%, exit when current return drops 10pp below the running peak. Most psychologically sustainable; positive in 50% of LOO days.',
  realizedHard30mPct:
    'Hard time-stop: exit at minute 30 from entry, no matter what. Highest EV in the 15-day backtest (+$127/day mean), but only 25% of days are profitable — wins are bigger but rarer.',
  realizedTier50HoldEodPct:
    'Two-tier exit: sell half at +50%, hold the rest to end-of-session. Middle ground between the trailing stop and the hard exit.',
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
  realizedEodPct: number | null;
  peakCeilingPct: number | null;
  minutesToPeak: number | null;
  enrichedAt: string | null;
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
