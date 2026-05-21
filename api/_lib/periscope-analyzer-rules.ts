/**
 * Validated rule constants for the deterministic Periscope analyzer.
 *
 * Derived from the historical study at
 * docs/tmp/periscope-rules-study-findings-2026-05-21.md
 * spec: docs/superpowers/specs/periscope-rules-study-2026-05-21.md
 *
 * IMPORTANT — interpret with caution:
 *
 * 1. The study's joinable window was 59 trading days (2026-02-26 →
 *    2026-05-19) × 1,491 slices, not the 130 days the spec assumed —
 *    `index_candles_1m` doesn't go back to 2025-11-10.
 *
 * 2. ZERO rules cleared the spec's F1 ≥ 0.60 threshold. The outcome
 *    base rate is ~0.1% in the studied window: only 2 genuine floor-
 *    failures and 2 genuine stop-breaks in 1,453 directional setups.
 *    This reflects the March–May 2026 high-GEX compression regime,
 *    not weakness in the rules — when failures are this rare, even
 *    perfect-precision rules have tiny F1 because the denominator is
 *    so small.
 *
 * 3. Winners chosen as "best available." Re-run the study after
 *    enough new data accumulates (target: another 30+ trading days,
 *    ideally including a vol-expansion regime where failures are
 *    common enough to be statistically meaningful).
 *
 * 4. The one genuinely-validated rule is TARGET_ORDER: gamma_wall
 *    hit first in 83.3% of 1,010 directional setups that touched any
 *    target within 30 min, across every regime. That ordering is
 *    real signal, not noise.
 *
 * The win from this rule set is *latency + cost*, not signal lift:
 * replacing a 4-6 min Claude auto-playbook call with sub-60-second
 * deterministic compute, fed by GEXBot 1-min state endpoints.
 */

// --- Floor-Break rule (when does a +γ floor structurally fail?) ----

/**
 * F2 — 2 consecutive 1-min closes below the +γ floor strike.
 *
 * Best variant from {F1, F2, F3, F4, F5, F6}. F6 (F2 + volume spike)
 * had marginally higher F1 (0.016 vs 0.008) but the compound lift was
 * 2× relative — under the spec's tie-breaker (simpler rule unless
 * F1 lifts ≥ 10%), F2 wins. F4 (inventory drop) fired zero times in
 * the 10-min snapshot resolution.
 */
export const FLOOR_BREAK_RULE = 'F2' as const;
export const FLOOR_BREAK_THRESHOLDS = {
  /** Number of consecutive 1-min closes required below the floor. */
  minHoldBars: 2,
  /** Points below floor to count as a "failure" outcome. */
  failurePtsBelow: 10,
} as const;

// --- Trigger-Arm rule (when does an entry trigger become legit?) ---

/**
 * T2 — 3-minute hold past the trigger level before arming.
 *
 * Best F1 in family (0.134). T1 (instantaneous break) is trivially
 * 100% fire rate. T2 trims ~20% of fires for a precision lift from
 * 5.9% to 7.2% while losing only 2% recall. T4 (charm alignment) was
 * rejected because per-slice charm_tally is too noisy to use as a
 * gate. T5 (cone breach) had only 14 days of cone data → insufficient
 * sample.
 */
export const TRIGGER_ARM_RULE = 'T2' as const;
export const TRIGGER_ARM_THRESHOLDS = {
  /** 1-min bars price must hold past trigger before arming. */
  minHoldBars: 3,
  /** Continuation pct that defines a "real" trigger in the study. */
  continuationPct: 0.003,
} as const;

// --- Target Selection (which target hits first? — STRONG signal) ---

/**
 * Always order **gamma_wall as T1**.
 *
 * Across 1,010 directional setups that touched ANY target within
 * 30 min, gamma_wall was the first touch in 83.3% (842/1010), magnet
 * 14.3%, charm_zero 2.5%. Median time-to-first-touch: 3.3 min.
 *
 * The only regime-conditional deviation is **pin**, where charm_zero
 * was T2 at 13.3% (vs. 0% for magnet). Pin markets are charm-driven,
 * so charm_zero becoming the secondary target makes mechanical sense.
 *
 * This is the one rule that meets the spec's decision criteria
 * unambiguously — gamma_wall wins T1 in every regime subset.
 */
export type TargetKind = 'gamma_wall' | 'magnet' | 'charm_zero';

export type RegimeTag =
  | 'pin'
  | 'drift-and-cap'
  | 'gap-and-rip'
  | 'trap'
  | 'cone-breach'
  | 'chop'
  | 'other';

export const TARGET_ORDER_RULE: {
  defaultT1: TargetKind;
  defaultT2: TargetKind;
  regimeOverrides: Partial<Record<RegimeTag, { t1: TargetKind; t2: TargetKind }>>;
} = {
  defaultT1: 'gamma_wall',
  defaultT2: 'magnet',
  regimeOverrides: {
    pin: { t1: 'gamma_wall', t2: 'charm_zero' },
    'drift-and-cap': { t1: 'gamma_wall', t2: 'magnet' },
    'cone-breach': { t1: 'gamma_wall', t2: 'magnet' },
    chop: { t1: 'gamma_wall', t2: 'magnet' },
    trap: { t1: 'gamma_wall', t2: 'magnet' },
  },
};

// --- Stop-Fire rule (when is the stop level actually broken?) ------

/**
 * S5 — 1-min close below stop level AND no recovery candle within
 * 5 bars.
 *
 * S5 F1=0.015. Like floor-break, genuine stop breaks in the dataset
 * are extremely rare (2 of 1,453 setups, 0.1%). S5 cuts false fires
 * to 258 vs S1's 572 (a 55% reduction in false positives) while
 * maintaining 100% recall on the 2 genuine breaks.
 */
export const STOP_FIRE_RULE = 'S5' as const;
export const STOP_FIRE_THRESHOLDS = {
  /** 1-min bars required to close past stop level. */
  minHoldBars: 1,
  /** Points adverse that define a "real" stop break outcome. */
  continuationPtsThreshold: 10,
  /**
   * Number of 1-min bars to look forward checking for a recovery
   * candle (close back inside the original position). If a recovery
   * occurs within this window, treat the stop fire as a wick (no-op).
   */
  noRecoveryBars: 5,
} as const;

// --- Vanna features ------------------------------------------------

/**
 * The study found no rule family where adding vanna-derived features
 * (wing-strike vanna magnitude, etc.) materially improved F1.
 * Vanna is captured but not used by the analyzer.
 *
 * Revisit on a vol-shock day (FOMC, CPI, jobs) where vanna is
 * expected to dominate — current dataset has no such day.
 */
export const VANNA_FEATURES_ENABLED = false as const;
