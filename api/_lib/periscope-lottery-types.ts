/**
 * Shared types for the Periscope-event-driven lottery alerts.
 *
 * Two filter variants live in periscope_lottery_fires keyed by fire_type:
 *   - 'call_lottery' (Filter I) — gamma event at OTM call strike + deep_neg
 *     + strike_dist >= 15 + gex_dollars < 1e9. Hold to peak ≥ 600% (TP=5R).
 *   - 'put_lottery'  (Filter L) — charm event at OTM put strike + strike_dist
 *     >= 10 + call_ratio < 1.5 (or entry_px <= 1.0). Hold to peak ≥ 600%.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 *
 * In-sample (26 days, 2026-04-13 → 2026-05-18 ex-5/18 outlier):
 *
 *   Filter I v3 strict (n=5):   hit150=100% hit200=60%  realR_TP5=+1.40
 *   Filter I v3 broad  (n=12):  hit150=92%  hit200=42%  realR_TP5=+0.50  (catches 4/23 75x)
 *   Filter L v3 strict (n=7):   hit150=100% hit200=100% realR_TP5=+0.71
 *   Filter L v3 alt    (n=10):  hit150=90%  hit200=90%  realR_TP5=+2.00  (catches 4/23 57x)
 */

export type PeriscopeLotteryFireType = 'call_lottery' | 'put_lottery';

export interface PeriscopeLotteryFire {
  /** call_lottery (Filter I) | put_lottery (Filter L) */
  fireType: PeriscopeLotteryFireType;
  /** Periscope slice captured_at — the canonical event time */
  fireTime: Date;
  /** 0DTE expiry (SPX) — equals fire_time's trading-day date */
  expiry: string; // YYYY-MM-DD
  /** Strike at which the gamma/charm event fired */
  eventStrike: number;
  /** Recommended trade strike: event_strike +/- 50 pts */
  tradeStrike: number;
  /** SPX spot at event time (from index_candles_1m) */
  spotAtEvent: number;
  /** |event_strike - spot_at_event|. Filter requires >=15 (I) / >=10 (L). */
  strikeDist: number;
  /** Latest periscope value (gamma_post for I, charm_post for L) */
  greekPost: number;
  /** Slice-over-slice change in periscope value */
  greekDelta: number;
  /** Per-day percentile rank within top-1% events on |value| */
  greekLvlRank: number | null;
  /** Per-day percentile rank within top-1% events on |delta| */
  greekChgRank: number | null;
  /** gex_target_features.gex_dollars at event_strike, mode='oi' */
  gexDollars: number | null;
  /** gex_target_features.call_ratio at event_strike */
  callRatio: number | null;
  /** Sum(QQQ net_call_prem - net_put_prem) / |total| over (T-30min, T]. I only. */
  qqqNetPremBalance30m: number | null;
  /** First observed trade price at trade_strike within +5 min of fire */
  entryPx: number | null;
  /** VIX at event time from market_snapshots */
  vix: number | null;
  /** TRUE when full v3 strict filter passes (display green badge) */
  v3StrictPass: boolean;
  /** TRUE when v4 confirmation passes (display gold badge). For I:
   *  |QQQ_net_prem_balance_30m| >= 0.5. For L: entry_px <= 1.0. */
  v4Badge: boolean;
  /** Realized peak price within the hold horizon (filled by enrichment cron) */
  peakPx: number | null;
  /** peak_px / entry_px — user-preferred metric */
  peakPct: number | null;
  /** Wall-clock time of peak observation */
  peakTime: Date | null;
  /** EOD close price at trade_strike — secondary realized outcome */
  eodClosePx: number | null;
  /** (peak_px - entry_px) / entry_px */
  realizedRPeak: number | null;
  /** (eod_close_px - entry_px) / entry_px */
  realizedREod: number | null;
  /** Set TRUE by enrichment cron once outcomes are stable */
  outcomeLocked: boolean;
}

/** Filter thresholds — single source of truth. Mirror in SQL CTEs verbatim. */
export const PERISCOPE_LOTTERY_THRESHOLDS = {
  // Filter I (call lottery, gamma panel)
  CALL: {
    /** Stage 1: top-N% per-day filter on |gamma_delta| */
    DAY_TOP_PCT: 0.01,
    /** Stage 2: top-N% rank within top-1% subset (both axes, AND) */
    RANK_FLOOR: 0.9,
    /** Sign filter: gamma_post must be strictly negative */
    SIGN_NEGATIVE: true,
    /** Strike must be at least this many points above spot */
    STRIKE_DIST_MIN_PTS: 15,
    /** gex_dollars at event strike must be below this magnitude */
    GEX_DOLLARS_MAX: 1_000_000_000,
    /** OTM offset for trade strike */
    TRADE_OFFSET_PTS: 50,
    /** Hold horizon */
    HOLD_MINUTES: 120,
    /** Take-profit target as multiple of entry premium */
    TP_MULTIPLE: 5,
    /** v4 badge: |QQQ_net_prem_balance_30m| at-or-above this is "confirmed" */
    QQQ_BALANCE_BADGE_MIN_ABS: 0.5,
  },
  // Filter L (put lottery, charm panel)
  PUT: {
    DAY_TOP_PCT: 0.05,
    /** No nested AND-rank for L — single-axis on |Δ_charm| is enough */
    RANK_FLOOR: null,
    /** No sign filter on L (post_pos and post_neg both produce wins) */
    SIGN_NEGATIVE: null,
    /** Spot must be at least this many points above strike */
    STRIKE_DIST_MIN_PTS: 10,
    /** Max call_ratio at strike (call_gex / put_gex). Lower = put-dominated. */
    CALL_RATIO_MAX: 1.5,
    TRADE_OFFSET_PTS: 50,
    HOLD_MINUTES: 180,
    TP_MULTIPLE: 5,
    /**
     * Hard filter — fires only when the trade strike's first observed
     * tick within +5min of fire_time is ≤ this price. Promoted from a
     * "cheap-lottery" badge to a filter on 2026-05-19 after the 26-day
     * backfill showed entry_px ≤ $1.00 has a 7.6× lift on peak ≥ +50%
     * (55.6% win rate vs 7.3% baseline), cutting put volume from
     * ~110/day to ~14/day with no winners lost.
     */
    ENTRY_PX_MAX: 1.0,
  },
} as const;
