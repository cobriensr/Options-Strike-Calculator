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
