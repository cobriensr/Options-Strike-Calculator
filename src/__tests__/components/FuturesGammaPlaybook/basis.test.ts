import { describe, it, expect } from 'vitest';
import {
  classifyLevelStatus,
  distanceInEsPoints,
  esTickRound,
  translateSpxToEs,
} from '../../../components/FuturesGammaPlaybook/basis';

describe('esTickRound', () => {
  // Nearest-tick rounding on a 0.25 grid. Boundary convention: Math.round
  // rounds half away from zero, so 6.125 (midpoint) → 6.25. The following
  // cases pick values that are unambiguously closer to one tick.
  it('rounds 6.10 down to 6.00 (0.10 < 0.125 half-tick)', () => {
    expect(esTickRound(6.1)).toBeCloseTo(6.0, 10);
  });
  it('rounds 6.13 up to 6.25 (0.13 > 0.125 half-tick)', () => {
    expect(esTickRound(6.13)).toBeCloseTo(6.25, 10);
  });
  it('leaves 6.25 unchanged', () => {
    expect(esTickRound(6.25)).toBeCloseTo(6.25, 10);
  });
  it('rounds 6.38 up to 6.50', () => {
    expect(esTickRound(6.38)).toBeCloseTo(6.5, 10);
  });
  it('handles negative inputs symmetrically', () => {
    expect(esTickRound(-6.38)).toBeCloseTo(-6.5, 10);
  });
  it('rounds 0.10 to 0.00 (inside half-tick)', () => {
    expect(esTickRound(0.1)).toBeCloseTo(0.0, 10);
  });
});

describe('translateSpxToEs', () => {
  it('applies a positive basis', () => {
    // 5800 SPX + 12.32 basis = 5812.32 → round to 5812.25.
    expect(translateSpxToEs(5800, 12.32)).toBeCloseTo(5812.25, 10);
  });

  it('applies a negative basis', () => {
    // 5800 − 6.77 = 5793.23 → round to 5793.25.
    expect(translateSpxToEs(5800, -6.77)).toBeCloseTo(5793.25, 10);
  });

  it('zero basis just rounds the SPX level to the ES tick', () => {
    expect(translateSpxToEs(5800.1, 0)).toBeCloseTo(5800.0, 10);
    expect(translateSpxToEs(5800.38, 0)).toBeCloseTo(5800.5, 10);
  });
});

describe('distanceInEsPoints', () => {
  it('positive when the level is above price', () => {
    expect(distanceInEsPoints(5800, 5810)).toBe(10);
  });
  it('negative when the level is below price', () => {
    expect(distanceInEsPoints(5800, 5790)).toBe(-10);
  });
  it('zero at the level', () => {
    expect(distanceInEsPoints(5800, 5800)).toBe(0);
  });
});

describe('classifyLevelStatus', () => {
  it('returns APPROACHING within the proximity band (no history)', () => {
    expect(classifyLevelStatus(3, undefined)).toBe('APPROACHING');
    expect(classifyLevelStatus(-5, undefined)).toBe('APPROACHING');
  });

  it('returns IDLE outside the band with no history', () => {
    expect(classifyLevelStatus(10, undefined)).toBe('IDLE');
    expect(classifyLevelStatus(-7, undefined)).toBe('IDLE');
  });

  it('returns BROKEN when the sign has flipped across the history window', () => {
    // Was +6 (above), now -3 (below) — price walked through the level.
    expect(classifyLevelStatus(-3, [6, 4, 2, -1])).toBe('BROKEN');
  });

  it('returns REJECTED when price approached and is now moving away', () => {
    // History shows a dip inside the proximity band (3), now at 8 and
    // |8| > |previous 6| — moved away after touching.
    expect(classifyLevelStatus(8, [10, 7, 3, 6])).toBe('REJECTED');
  });

  it('returns APPROACHING when currently inside the band regardless of history', () => {
    expect(classifyLevelStatus(2, [8, 6, 4, 2])).toBe('APPROACHING');
  });

  it('falls back to proximity-only when history has only one point', () => {
    expect(classifyLevelStatus(3, [3])).toBe('APPROACHING');
    expect(classifyLevelStatus(10, [10])).toBe('IDLE');
  });

  // ── Wrong-side (taken-out) detection ─────────────────────────────────
  //
  // When the call wall is below price (negative distance) or the put wall
  // is above price (positive distance), the wall has been structurally
  // taken out — it's on the wrong side of price given its role. This
  // fires WITHOUT any history so freshly-loaded sessions render the
  // correct BROKEN status instead of IDLE.

  it('CALL_WALL with negative distance beyond proximity → BROKEN (taken out)', () => {
    // Price is 22 pts above a call wall at 7077.75. Distance = −22.
    // Without kind-based detection this rendered as IDLE — the screenshot
    // bug at 2:50 PM 2026-04-21.
    expect(classifyLevelStatus(-22, undefined, 'CALL_WALL')).toBe('BROKEN');
    expect(classifyLevelStatus(-22, [-20, -21, -22], 'CALL_WALL')).toBe(
      'BROKEN',
    );
  });

  it('PUT_WALL with positive distance beyond proximity → BROKEN (taken out)', () => {
    expect(classifyLevelStatus(12, undefined, 'PUT_WALL')).toBe('BROKEN');
  });

  it('CALL_WALL within proximity is APPROACHING regardless of sign', () => {
    expect(classifyLevelStatus(-3, undefined, 'CALL_WALL')).toBe('APPROACHING');
    expect(classifyLevelStatus(3, undefined, 'CALL_WALL')).toBe('APPROACHING');
  });

  it('ZERO_GAMMA without sign-flip history falls through to IDLE', () => {
    // ZG has no preferred side — kind-based taken-out check must not fire.
    expect(classifyLevelStatus(-15, undefined, 'ZERO_GAMMA')).toBe('IDLE');
  });

  it('ZERO_GAMMA detects BROKEN via sign-flip history', () => {
    expect(classifyLevelStatus(-3, [6, 4, 2, -1], 'ZERO_GAMMA')).toBe('BROKEN');
  });

  it('omitting kind preserves pre-fix behavior (history-only detection)', () => {
    // Back-compat: callers that don't pass kind get the original semantics.
    expect(classifyLevelStatus(-22, undefined)).toBe('IDLE');
  });
});
