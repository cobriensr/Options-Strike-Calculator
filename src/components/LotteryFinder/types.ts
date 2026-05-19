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
  /**
   * Ticker-level cumulative net call premium at trigger_time_ct,
   * snapshotted by the lottery-finder LATERAL join against
   * ws_net_flow_per_ticker + net_flow_per_ticker_history. Distinct
   * from mktTideNcp (which is SPY-wide). Null when the ws/REST
   * tables held no rows for the ticker before the fire.
   */
  tickerCumNcpAtFire: number | null;
  /**
   * Ticker-level cumulative net put premium at trigger_time_ct.
   * Mirrors `tickerCumNcpAtFire` semantics for puts.
   */
  tickerCumNppAtFire: number | null;
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
  /**
   * Phase 4 direction gate (spec:
   * silent-boom-direction-gate-and-trail-ui-2026-05-14.md). TRUE when
   * the fire was counter-trend per OTM Market Tide at fire time. The
   * raw `score` is preserved; the feed forces `scoreTier` to 'tier3'
   * when this flag is set. UI renders a "Gated" pill and offers a
   * "Hide counter-trend" filter chip.
   */
  directionGated: boolean;
  /** Pre-deduct score as stored on the row. Same as `score` when no
   *  round-trip deduct has been applied (migration #154 / Phase 2C). */
  rawScore?: number | null;
  /** Post-fire (ask − bid) / total volume over a 60-min window from
   *  the evaluate-round-trip cron. Null until that cron has run. */
  roundTripNetPct?: number | null;
  /** Stepped bracket deduct (0 / -1 / -2 / -3) applied to `score` at
   *  read time. Drives the "Hide round-tripped" filter chip. */
  roundTripScoreDeduct?: number;
  /**
   * Read-time score adjustment from the chain's same-day `fireCount`.
   * Mapped via api/_lib/lottery-score-weights.ts:fireCountScoreAdjustment:
   *   1 fire    → -3 (severe; mean R = -5.8%, 45% win rate)
   *   2-3 fires → -1 (still below baseline)
   *   4-7 fires →  0 (neutral)
   *   8-15      → +1 (knee of the burst curve)
   *   ≥16       → +2 (highest-edge cohort)
   * Spec basis: docs/tmp/burst-profitability-findings-2026-05-17.md.
   * Surfaced so the UI can render a "+N burst" tooltip on the score
   * badge. Always emitted by the API (defaults to 0 for the neutral
   * 4-7 fire bucket), but typed optional to match the rest of the
   * API-emitted-but-stale-fixture fields (`rawScore?`, `takeitProb?`,
   * `roundTripScoreDeduct?` — same pattern).
   */
  fireCountScoreAdjustment?: number;
  /**
   * Volume-weighted gamma over the rolling trigger window — captured
   * at fire-detect time by the cron from raw_payload->>'gamma'. NULL
   * on rows inserted before migration #168 (the storage column was
   * NULLable on add). Empirical lift (LF +4.8pp / SB +10.7pp at the
   * top decile) is documented in
   * docs/tmp/gamma-deep-dive-findings-2026-05-17.md.
   */
  gammaAtTrigger?: number | null;
  /**
   * Per-row score bonus from `gammaAtTrigger` — mirrors the SQL CASE
   * expression in `combined_score`. Returns 1 when gamma ≥ 0.025 AND
   * ticker ∉ {SPY, USO}, else 0. The bonus is already folded into
   * `score`; this field exists so the UI can render a "+1 high-Γ"
   * tooltip on the score badge.
   */
  gammaScoreAdjustment?: number;
  /**
   * Take-It calibrated win probability (migration #155, spec
   * takeit-phase3-production-scoring-2026-05-16.md). XGBoost output
   * walked in pure TS at detect time. NULL when the bundle was
   * unreachable when this row was inserted (fail-open path).
   */
  takeitProb?: number | null;
  /**
   * SHAP top-3 green + top-3 red flags as JSON. NULL until the Phase 3d
   * SHAP fill cron has back-populated it (~2 min after fire).
   */
  takeitTopFeatures?: Record<string, unknown> | null;
  /** Bundle version string e.g. "v2026-05-23". NULL when no bundle was loaded. */
  takeitModelVersion?: string | null;
  /** Predicted peak-return range string for the tier (display-only). */
  forecastHighPeakPct: string;
  /** Per-ticker reliability stats; `null` when no row exists. */
  tickerStats: LotteryTickerStats | null;
  /**
   * Cohort-derived "typical exit window" hint — historical P75 of
   * minutes-to-peak among winners (peak_ceiling_pct >= 50) for the
   * fire's (tier, ticker) cohort. Always populated by
   * /api/lottery-finder. See api/_lib/lottery-hold.ts.
   *
   * NOTE: tier1 winners often run on slow tail moves (SNDK, RKLB)
   * so the typical hold can be LONGER than tier 2's. Don't read
   * tier1 = fast / tier3 = slow into the number.
   */
  avgHoldMinutes: number;
  /**
   * Number of fires collapsed onto this row by the API's chain-day
   * dedup CTE — partitioned on (ticker × strike × option_type × expiry)
   * scoped to the response's `date`. 1 means single fire today; higher
   * means the row represents the LATEST fire of a hot chain that
   * triggered repeatedly through the session (median 28+/day on
   * mega-cap names; TSLA-class chains can hit 300+).
   */
  fireCount: number;
  /**
   * UTC ISO timestamp of the FIRST fire on this chain today. Pairs
   * with `triggerTimeCt` (latest fire) so the UI can render the burst
   * span — e.g. "×42 · since 09:35 CT" — and a "still hot" indicator
   * when the latest fire is recent.
   */
  firstFireTimeCt: string;

  /**
   * Past-fire entry timestamps + prices for this chain-day, excluding
   * the latest fire (which is already represented by `triggerTimeCt` +
   * `entry.price`). Used by the expanded contract chart to render an
   * orange dashed line at each prior fire. Only populated when
   * `fireCount > 1`; `undefined` for single-fire chains to keep the
   * response compact.
   *
   * Spec: docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md
   * (Phase 1 / Task B).
   */
  historicalFires?: Array<{
    /** UTC ISO timestamp of the prior fire. */
    triggerTimeCt: string;
    /** Entry price ($/contract) snapshotted at that fire. */
    entryPrice: number;
  }>;

  /**
   * TRUE when this chain made the daily "REIGNITION" top-N — i.e. fired
   * >= REIGNITION_MIN_FIRES times today, has a quiet stretch >=
   * REIGNITION_MIN_GAP_MIN min somewhere in its fire history, has at
   * least REIGNITION_MIN_POST_GAP_FIRES fires after that gap, AND ranks
   * in the day's top REIGNITION_TOP_N_PER_DAY by (post_gap_fires,
   * fire_count). The UI promotes these rows out of their ticker group
   * into a pinned "Hot Right Now" section and renders a 🔥 REIGNITED
   * chip on the row.
   *
   * Spec: docs/superpowers/specs/lottery-reignition-ui-2026-05-17.md
   * (Phase 1 / Task A). Empirical basis: tuning v4 on 93 days, see
   * spec for thresholds and outcome lift.
   */
  reignited?: boolean;
  /**
   * TRUE when this fire's CT minute carried at least
   * MEGA_CLUSTER_MIN_DISTINCT_TICKERS (=12) distinct underlying tickers
   * firing simultaneously. Cross-ticker minute concentration is a
   * separate signal class from per-chain burst patterns — the 5/15
   * cluster analysis (docs/tmp/cluster-2026-05-15-1205ct-findings.md)
   * found ≥12-ticker minutes carry +16.3% median realized trail vs
   * +6-7% in the 5-11 middle range. Always emitted by the API as a
   * concrete boolean; typed optional to match the existing
   * fixture-tolerance convention (`reignited?`, `roundTripScoreDeduct?`).
   */
  megaCluster?: boolean;
  /**
   * Actual distinct-ticker count for this fire's CT minute. Only
   * present when `megaCluster === true`. Lets the UI render
   * "MEGA CLUSTER · 18 tickers" instead of a bare badge.
   */
  megaClusterSize?: number;
  /**
   * TRUE when this fire's chain-day appears in BOTH
   * `lottery_finder_fires` AND `silent_boom_alerts` for the same date
   * — i.e. the two independent detectors agreed. Per the LF vs SB
   * backtest (docs/tmp/lf-vs-sb-backtest-findings-2026-05-17.md), the
   * intersection cohort had 81% win rate on best fire / median best
   * peak 64% vs LF-only's 72% / 35%. Rare — ~39 chain-days/day across
   * the 25-day window. Always emitted by the API; typed optional to
   * match the existing fixture-tolerance convention.
   */
  dualFlag?: boolean;

  trigger: LotteryFireTrigger;
  entry: LotteryFireEntry;
  tags: LotteryFireTags;
  macro: LotteryFireMacro;
  outcomes: LotteryFireOutcomes;

  /**
   * Hours from the fire's `triggerTimeCt` to the next high-impact
   * economic event (FOMC / CPI / PCE / JOBS). `null` when no such
   * event is scheduled within 7 days of the fire. The UI renders a
   * "MACRO" badge when the value is in [24, 72] — the cohort that
   * showed 1.32× win50 / 1.56× win100 lift on N=17,465 in the
   * 2026-05-15 cross-section EDA. Display-only — not in the score.
   */
  hoursToNextMacroEvent: number | null;

  /**
   * Range Kill (#153). Position of `entry.spotAtFirst` within the
   * underlying's session range at trigger time ∈ [0, 1]. Drives the
   * "hide range-bottom" filter chip + a "TOP-RANGE" badge for fires
   * in the top 10%. The score-bonus layer applies a -3 penalty when
   * this value is < 0.10 (bottom-10% kill cohort: 2.4% win50, 0.07×
   * baseline lift per the 2026-05-15 EDA). Null on pre-#153 fires
   * and on fires whose UW candle fetch failed at insert time.
   */
  rangePosAtTrigger: number | null;

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
    minPremium?: number | null;
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
  /**
   * Top-N reignited chains for the day, returned independent of
   * pagination so the pinned "Hot Right Now" section stays visible on
   * every page. Honours the same server-side filters as `fires`; can be
   * empty when no chains qualify. Optional for back-compat with older
   * server builds that haven't shipped the field yet.
   */
  reignitedFires?: LotteryFire[];
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

// ============================================================
// /api/ticker-candles response
// ============================================================

/** One per-minute regular-session OHLCV candle for an underlying. */
export interface TickerCandle {
  /** UTC ISO timestamp at the start of the minute. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerCandlesResponse {
  ticker: string;
  date: string;
  /** Previous trading session's close — useful as a reference line. */
  previousClose: number;
  count: number;
  candles: TickerCandle[];
  marketOpen: boolean;
  asOf: string;
}
