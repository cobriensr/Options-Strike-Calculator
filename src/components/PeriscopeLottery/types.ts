/**
 * Shared types for the PeriscopeLotteryPanel UI.
 * Mirrors the API response from /api/periscope-lottery-feed.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

export type LotteryFireType = 'call_lottery' | 'put_lottery';

export type LotteryFireTypeFilter = LotteryFireType | 'both';

export interface PeriscopeLotteryFire {
  id: number;
  fireType: LotteryFireType;
  fireTime: string;
  expiry: string;
  eventStrike: number;
  tradeStrike: number;
  spotAtEvent: number;
  strikeDist: number;
  greekPost: number;
  greekDelta: number;
  /** Daily rank of |greek_post| within periscope_snapshots (0–1). */
  greekLvlRank: number | null;
  /** Daily rank of |delta to neighboring slice| within snapshots (0–1). */
  greekChgRank: number | null;
  /** Naive 0DTE GEX dollars at fire time. Null when scrub was unavailable. */
  gexDollars: number | null;
  /** Tide call-ratio at fire time. */
  callRatio: number | null;
  /** QQQ net-prem 30m balance at fire time (call lottery only). */
  qqqNetPremBalance30m: number | null;
  /** Entry price at fire time from option_trades. Null when no clean trade
   *  was within 60s of fire_time. */
  entryPx: number | null;
  /** VIX print closest to fire_time. Null when nothing was within 5min. */
  vix: number | null;
  /** True when the fire passed the strict v3 in-sample filter (top-1% Δγ
   *  AND top-10% |γ| AND strike_dist ≥ 15 AND deep-neg AND above-spot). */
  v3StrictPass: boolean;
  /** True when the fire also passed the QQQ-flow balance gate (call lot.)
   *  or entry_px ≤ $1.00 (put lot.). Surfaces a stronger UI badge. */
  v4Badge: boolean;
  /** Realized outcomes — filled by enrich-periscope-lottery-outcomes cron
   *  at the 15:30 ET (20:30 UTC standard / 21:30 UTC DST) daily run. */
  peakPx: number | null;
  peakPct: number | null;
  peakTime: string | null;
  eodClosePx: number | null;
  realizedRPeak: number | null;
  realizedREod: number | null;
  outcomeLocked: boolean;
  createdAt: string;
}

export interface PeriscopeLotteryFeedResponse {
  date: string;
  fireType: LotteryFireTypeFilter;
  count: number;
  fires: PeriscopeLotteryFire[];
}
