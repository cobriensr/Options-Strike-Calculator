/** Shared types for the FuturesGammaPlaybook module. */

export type RegimeVerdict = 'MEAN_REVERT' | 'TREND_FOLLOW' | 'STAND_ASIDE';

export type GexRegime = 'POSITIVE' | 'NEGATIVE' | 'TRANSITIONING';

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
