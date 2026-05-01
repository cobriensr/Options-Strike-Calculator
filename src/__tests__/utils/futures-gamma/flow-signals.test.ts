/**
 * Pure-function tests for the shared drift-override predicate.
 *
 * Covers both directional axes (up / down), the consistency-floor edge
 * case (above and below `DRIFT_OVERRIDE_CONSISTENCY_MIN`), and the
 * graceful-fallback paths for missing `flowSignals` and `priceTrend`.
 */

import { describe, it, expect } from 'vitest';
import { evaluateDriftOverride } from '../../../utils/futures-gamma/flow-signals';
import { DRIFT_OVERRIDE_CONSISTENCY_MIN } from '../../../utils/futures-gamma/playbook';
import type { PlaybookFlowSignals } from '../../../utils/futures-gamma/types';
import type { PriceTrend } from '../../../utils/price-trend';

function makeFlow(trend: PriceTrend | null): PlaybookFlowSignals {
  return {
    upsideTargetCls: null,
    downsideTargetCls: null,
    ceilingTrend5m: null,
    floorTrend5m: null,
    priceTrend: trend,
  };
}

function makeTrend(
  direction: PriceTrend['direction'],
  consistency: number,
): PriceTrend {
  return { direction, changePct: 0, changePts: 0, consistency };
}

describe('evaluateDriftOverride', () => {
  it('returns up=true when trend is up and consistency clears the floor', () => {
    const flow = makeFlow(makeTrend('up', 0.7));
    expect(evaluateDriftOverride(flow)).toEqual({ up: true, down: false });
  });

  it('returns down=true when trend is down and consistency clears the floor', () => {
    const flow = makeFlow(makeTrend('down', 0.7));
    expect(evaluateDriftOverride(flow)).toEqual({ up: false, down: true });
  });

  it('fires exactly at the consistency threshold (>= boundary)', () => {
    const flow = makeFlow(makeTrend('up', DRIFT_OVERRIDE_CONSISTENCY_MIN));
    expect(evaluateDriftOverride(flow)).toEqual({ up: true, down: false });
  });

  it('does not fire just below the consistency threshold', () => {
    // Step well below to avoid floating-point boundary noise; the strict
    // boundary case is covered above.
    const flow = makeFlow(
      makeTrend('up', DRIFT_OVERRIDE_CONSISTENCY_MIN - 0.05),
    );
    expect(evaluateDriftOverride(flow)).toEqual({ up: false, down: false });
  });

  it('returns both false for a flat trend regardless of consistency', () => {
    const flow = makeFlow(makeTrend('flat', 0.95));
    expect(evaluateDriftOverride(flow)).toEqual({ up: false, down: false });
  });

  it('returns both false when priceTrend is null', () => {
    const flow = makeFlow(null);
    expect(evaluateDriftOverride(flow)).toEqual({ up: false, down: false });
  });

  it('returns both false when flowSignals is null', () => {
    expect(evaluateDriftOverride(null)).toEqual({ up: false, down: false });
  });

  it('returns both false when flowSignals is undefined', () => {
    expect(evaluateDriftOverride(undefined)).toEqual({
      up: false,
      down: false,
    });
  });

  it('never returns up=true and down=true simultaneously', () => {
    // Sanity check: the predicate is mutually exclusive by direction.
    for (const dir of ['up', 'down', 'flat'] as const) {
      const flow = makeFlow(makeTrend(dir, 0.99));
      const result = evaluateDriftOverride(flow);
      expect(result.up && result.down).toBe(false);
    }
  });
});
