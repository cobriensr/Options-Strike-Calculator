import { describe, it, expect } from 'vitest';
import {
  classify,
  REGIME_CONSTANTS,
  type DealerRegimeInput,
} from '../classify';

const NOW = Date.parse('2026-05-04T18:00:00Z'); // Mon 2026-05-04, 13:00 CT

function input(overrides: Partial<DealerRegimeInput> = {}): DealerRegimeInput {
  // Defaults pass every gate: fresh, high confidence, spot far from zg,
  // positive net gamma → long-γ.
  return {
    spot: 7240,
    zeroGamma: 7180,
    confidence: 0.4,
    netGammaAtSpot: 3_500_000_000,
    ts: '2026-05-04T17:55:00Z',
    ...overrides,
  };
}

describe('classify — long-γ / short-γ branches', () => {
  it('returns long-γ when net gamma is positive and gates pass', () => {
    expect(classify(input(), { now: NOW })).toBe('long-γ');
  });

  it('returns short-γ when net gamma is negative and gates pass', () => {
    expect(
      classify(input({ netGammaAtSpot: -2_500_000_000 }), { now: NOW }),
    ).toBe('short-γ');
  });

  it('returns uncertain when net gamma is exactly zero (defensive fallthrough)', () => {
    expect(classify(input({ netGammaAtSpot: 0 }), { now: NOW })).toBe(
      'uncertain',
    );
  });
});

describe('classify — confidence gate', () => {
  it('returns uncertain when confidence is below the gate', () => {
    expect(
      classify(input({ confidence: REGIME_CONSTANTS.confidenceGate - 0.01 }), {
        now: NOW,
      }),
    ).toBe('uncertain');
  });

  it('returns long-γ when confidence is exactly at the gate', () => {
    expect(
      classify(input({ confidence: REGIME_CONSTANTS.confidenceGate }), {
        now: NOW,
      }),
    ).toBe('long-γ');
  });

  it('returns uncertain when confidence is null', () => {
    expect(classify(input({ confidence: null }), { now: NOW })).toBe(
      'uncertain',
    );
  });
});

describe('classify — boundary buffer', () => {
  it('returns transition when spot sits within boundary buffer of zero-gamma', () => {
    // 7240 vs 7239 = 0.0138% < 0.3% buffer
    expect(
      classify(input({ spot: 7240, zeroGamma: 7239 }), { now: NOW }),
    ).toBe('transition');
  });

  it('returns long-γ when spot is just outside the boundary buffer', () => {
    // 7240 vs 7218 = 0.30% — at the edge; classify as long-γ since strict <
    expect(
      classify(input({ spot: 7240, zeroGamma: 7218 }), { now: NOW }),
    ).toBe('long-γ');
  });

  it('skips the boundary check when zero-gamma is null', () => {
    // SPX commonly has zero_gamma=null when calculator can't find a crossing
    // (low confidence). Classifier should fall through to sign read.
    expect(
      classify(input({ zeroGamma: null, netGammaAtSpot: 5_000_000_000 }), {
        now: NOW,
      }),
    ).toBe('long-γ');
  });
});

describe('classify — staleness gate', () => {
  it('returns uncertain when the row is older than 15 minutes', () => {
    // ts is 16 minutes before NOW
    const stale = new Date(NOW - 16 * 60 * 1000).toISOString();
    expect(classify(input({ ts: stale }), { now: NOW })).toBe('uncertain');
  });

  it('returns long-γ when the row is exactly 14 minutes old (within window)', () => {
    const fresh = new Date(NOW - 14 * 60 * 1000).toISOString();
    expect(classify(input({ ts: fresh }), { now: NOW })).toBe('long-γ');
  });

  it('returns uncertain when ts is malformed', () => {
    expect(classify(input({ ts: 'not-a-date' }), { now: NOW })).toBe(
      'uncertain',
    );
  });
});

describe('classify — gate ordering (first-match-wins)', () => {
  it('uncertain (low confidence) takes precedence over transition (boundary)', () => {
    expect(
      classify(
        input({
          spot: 7240,
          zeroGamma: 7239,
          confidence: 0.05,
        }),
        { now: NOW },
      ),
    ).toBe('uncertain');
  });

  it('transition takes precedence over sign read', () => {
    expect(
      classify(
        input({
          spot: 7240,
          zeroGamma: 7239,
          netGammaAtSpot: 3_500_000_000, // positive sign would say long-γ
        }),
        { now: NOW },
      ),
    ).toBe('transition');
  });
});

describe('classify — custom constants for tuning', () => {
  it('honors a relaxed confidence gate', () => {
    // The audit caveat — most rows have conf < 0.10. Tuning to 0.05 should
    // let those through.
    expect(
      classify(input({ confidence: 0.07 }), {
        now: NOW,
        constants: { ...REGIME_CONSTANTS, confidenceGate: 0.05 },
      }),
    ).toBe('long-γ');
  });
});
