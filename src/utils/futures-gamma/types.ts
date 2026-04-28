/** Shared types for the FuturesGammaPlaybook module. */

import type {
  GexClassification,
  PriceTrend,
} from '../../components/GexLandscape/types';

export type RegimeVerdict = 'MEAN_REVERT' | 'TREND_FOLLOW' | 'STAND_ASIDE';

export type GexRegime = 'POSITIVE' | 'NEGATIVE' | 'TRANSITIONING';

/**
 * Flow signals sourced from the same snapshot buffer that drives
 * `GexLandscape`'s BiasMetrics. Fed into `rulesForRegime` so the rule
 * engine can emit charm-aware conviction and drift-override rule
 * suppression without re-deriving the signals server-side.
 *
 * All fields are optional/nullable — upstream buffers take a few
 * minutes to fill. When a field is null the rule engine falls back to
 * today's pre-flow-signals behavior (standard conviction, no override).
 */
export interface PlaybookFlowSignals {
  /** Charm classification of the top upside target (highest |GEX| above spot). */
  upsideTargetCls: GexClassification | null;
  /** Charm classification of the top downside target. */
  downsideTargetCls: GexClassification | null;
  /** Avg 5m Δ% of above-spot strikes. Positive = ceiling strengthening. */
  ceilingTrend5m: number | null;
  /** Avg 5m Δ% of below-spot strikes. Positive = floor strengthening. */
  floorTrend5m: number | null;
  /** Direction + consistency of the price drift over the lookback window. */
  priceTrend: PriceTrend | null;
}

/**
 * Per-rule conviction driven by charm classification of the anchoring
 * wall. A fade-call rule at a `sticky-pin` wall is a high-conviction
 * setup (charm builds into close); the same rule at a `weakening-pin`
 * wall is low-conviction (charm draining). Breakout rules always
 * receive `standard` — charm doesn't map cleanly to trend-follow.
 */
export type RuleConviction = 'high' | 'standard' | 'low';

/**
 * Collapsed directional call synthesized from regime + rules +
 * conviction + drift-override + wall-flow. Rendered as a prominent
 * banner at the top of the playbook so the trader sees one decisive
 * direction instead of scanning six panels for the synthesis.
 *
 * `direction === 'NEUTRAL'` means "no directional edge right now" —
 * stand aside regardless of whether a rule technically exists.
 * Examples: TRANSITIONING regime, both walls BROKEN, or a
 * charm-drift-only ACTIVE rule (direction-agnostic by design).
 *
 * `conviction === 'strong'` implies multiple aligned signals
 * (rule ACTIVE + wall-flow aligned + conviction=high). `mild` is the
 * baseline "setup exists, take it if you like it". `neutral` is only
 * emitted with `direction === 'NEUTRAL'`.
 */
export interface TradeBias {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  conviction: 'strong' | 'mild' | 'neutral';
  /** Entry price (ES) when a specific rule is anchoring the bias; null otherwise. */
  entryEs: number | null;
  /** One-line justification (≤ 50 chars) surfaced under the badge. */
  reason: string;
}

export type SessionPhase =
  | 'PRE_OPEN'
  | 'OPEN'
  | 'MORNING'
  | 'LUNCH'
  | 'AFTERNOON'
  | 'POWER'
  | 'CLOSE'
  | 'POST_CLOSE';

/**
 * Per-rule execution status derived from the current ES price vs. entry.
 *
 * - ACTIVE     — |distance| ≤ RULE_ACTIVE_BAND_ES (5 pts). Enter now.
 * - ARMED      — RULE_ACTIVE_BAND_ES < |distance| ≤ RULE_ARMED_BAND_ES (15 pts).
 * - DISTANT    — |distance| > RULE_ARMED_BAND_ES or price is null.
 * - INVALIDATED — fade/lift rule where price already overshot the entry
 *   on the wrong side (e.g. SHORT fade but price is > wall + 5 pts). The
 *   structural thesis has failed; do not take the trade. Not emitted for
 *   EITHER-direction rules — those fall back to DISTANT instead.
 */
export type RuleStatus = 'ACTIVE' | 'ARMED' | 'DISTANT' | 'INVALIDATED';

export interface PlaybookRule {
  id: string;
  condition: string;
  direction: 'LONG' | 'SHORT' | 'EITHER';
  entryEs: number | null;
  targetEs: number | null;
  stopEs: number | null;
  sizingNote: string;
  /**
   * Signed ES points the current price must MOVE to reach `entryEs`.
   * - For LONG rules: positive when price must rally up to the entry.
   * - For SHORT rules: negative when price must fall down to the entry.
   * `null` when `esPrice` is unknown or `entryEs` is null.
   */
  distanceEsPoints: number | null;
  status: RuleStatus;
  /**
   * Conviction overlay — `high` for fade/lift rules anchored at a
   * `sticky-pin` wall, `low` for `weakening-pin`, else `standard`.
   * Breakout rules always resolve to `standard`.
   */
  conviction: RuleConviction;
}

export interface EsLevel {
  kind: 'CALL_WALL' | 'PUT_WALL' | 'ZERO_GAMMA' | 'MAX_PAIN';
  spxStrike: number;
  esPrice: number;
  /** Signed distance, positive when the level is above the ES price. */
  distanceEsPoints: number;
  status: 'APPROACHING' | 'REJECTED' | 'BROKEN' | 'IDLE';
}

/** Levels consumed by rule generation and rendered into the UI. */
export interface RuleLevels {
  esCallWall: number | null;
  esPutWall: number | null;
  esZeroGamma: number | null;
  esMaxPain: number | null;
  /**
   * ES price of the highest |netGamma| strike — the actual charm-drift
   * magnet. Distinct from `esMaxPain`: max-pain minimizes option-holder
   * payout at expiry (theoretical); gamma-pin is where dealer hedging
   * physically concentrates (mechanistic).
   */
  esGammaPin: number | null;
}

export interface PlaybookBias {
  regime: GexRegime;
  verdict: RegimeVerdict;
  esZeroGamma: number | null;
  esCallWall: number | null;
  esPutWall: number | null;
  sessionPhase: SessionPhase;
  firedTriggers: string[];
}

/**
 * One point on the intraday regime timeline. `spot` is the SPX price at
 * the instant; the timeline component translates to ES via the snapshot's
 * prevailing basis at render time.
 */
export interface RegimeTimelinePoint {
  ts: string;
  netGex: number;
  spot: number;
  regime: GexRegime;
}

/**
 * CT wall-clock boundaries for the five intraday session phases rendered
 * on the RegimeTimeline x-axis. Values are ISO-8601 instants on the
 * currently viewed trading date.
 */
export interface SessionPhaseBoundariesCt {
  open: string;
  lunch: string;
  power: string;
  close: string;
}
