/**
 * Periscope MM-exposure types shared between `src/utils/periscope-trade-plan.ts`
 * (pure analyzer) and `src/hooks/usePeriscopeExposure.ts` + the Periscope
 * components (rendering).
 *
 * Lifted from `src/hooks/usePeriscopeExposure.ts` in Phase 3C to fix the
 * inverted dependency where the util imported a type from a hook.
 *
 * `src/hooks/usePeriscopeExposure.ts` re-exports these names so existing
 * callers (`from '../hooks/usePeriscopeExposure'`) continue to work
 * without churn.
 */

export interface RankedRow {
  strike: number;
  value: number;
  ptsFromSpot: number;
}

export interface RankedRowSimple {
  strike: number;
  value: number;
}

export interface PeriscopeView {
  capturedAt: string;
  priorCapturedAt: string | null;
  expiry: string;
  spot: number;
  gamma: {
    ceiling: RankedRow | null;
    floor: RankedRow | null;
    accelTop: RankedRow[];
    topByAbsNear: RankedRowSimple[];
  };
  charm: {
    tallyNear50: number;
    tallyWide100: number;
    topByAbs: RankedRowSimple[];
    charmZeroStrike: number | null;
  };
  vanna: {
    topByAbs: RankedRowSimple[];
  };
  signFlips: Array<{ strike: number; from: number; to: number }>;
  cone: {
    coneUpper: number;
    coneLower: number;
    coneWidth: number;
    asymmetryPts: number;
    spotAtCalc: number;
  } | null;
  breaches: Array<{
    direction: 'upper' | 'lower';
    breachTime: string;
    spotAtBreach: number;
    ptsPastBound: number;
  }>;
}
