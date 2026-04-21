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

export interface PlaybookRule {
  id: string;
  condition: string;
  direction: 'LONG' | 'SHORT' | 'EITHER';
  entryEs: number | null;
  targetEs: number | null;
  stopEs: number | null;
  sizingNote: string;
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
