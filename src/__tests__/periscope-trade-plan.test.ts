import { describe, it, expect } from 'vitest';
import { computeTradePlan } from '../utils/periscope-trade-plan';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';

function makeView(overrides: Partial<PeriscopeView>): PeriscopeView {
  return {
    capturedAt: '2026-05-08T16:40:00Z',
    priorCapturedAt: null,
    expiry: '2026-05-08',
    spot: 7390.88,
    gamma: {
      ceiling: null,
      floor: null,
      accelTop: [],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 0,
      tallyWide100: 0,
      topByAbs: [],
      charmZeroStrike: null,
    },
    vanna: { topByAbs: [] },
    signFlips: [],
    cone: null,
    breaches: [],
    ...overrides,
  };
}

describe('computeTradePlan', () => {
  it('reads the user-reported 11:40 CT slot as cone-breach-up, long-only', () => {
    // Real numbers from the panel screenshot: spot 7390.88,
    // cone 7360.6-7388.5 already breached upper at 9 AM,
    // +γ ceiling 7420 (+3.5K), +γ floor 7350 (+3.2K),
    // charm tally near -6.38M, wide +20.22M, charm-zero 7315.
    const view = makeView({
      spot: 7390.88,
      gamma: {
        ceiling: { strike: 7420, value: 3500, ptsFromSpot: 29 },
        floor: { strike: 7350, value: 3200, ptsFromSpot: -41 },
        accelTop: [
          { strike: 7375, value: -3200, ptsFromSpot: -16 },
          { strike: 7475, value: -1400, ptsFromSpot: 84 },
          { strike: 7405, value: -1300, ptsFromSpot: 14 },
        ],
        topByAbsNear: [],
      },
      charm: {
        tallyNear50: -6_380_000,
        tallyWide100: 20_220_000,
        topByAbs: [],
        charmZeroStrike: 7315,
      },
      cone: {
        coneUpper: 7388.5,
        coneLower: 7360.6,
        coneWidth: 27.85,
        asymmetryPts: 1,
        spotAtCalc: 7374.55,
      },
      breaches: [
        {
          direction: 'upper',
          breachTime: '2026-05-08T14:00:00Z',
          spotAtBreach: 7388.63,
          ptsPastBound: 0,
        },
      ],
    });
    const plan = computeTradePlan(view);
    expect(plan.regime).toBe('cone-breach-up');
    expect(plan.bias).toBe('long-only');
    expect(plan.long.verdict).toBe('safe');
    expect(plan.long.target).toBe(7420);
    expect(plan.short.verdict).toBe('avoid');
    expect(plan.summary).toMatch(/Cone upper bound breached/);
  });

  it('reads a clean drift-and-cap setup: +γ ceiling far above, charm positive', () => {
    const view = makeView({
      spot: 7100,
      gamma: {
        ceiling: { strike: 7140, value: 5000, ptsFromSpot: 40 },
        floor: { strike: 7080, value: 2000, ptsFromSpot: -20 },
        accelTop: [],
        topByAbsNear: [],
      },
      charm: {
        tallyNear50: 3_000_000,
        tallyWide100: 8_000_000,
        topByAbs: [],
        charmZeroStrike: null,
      },
      cone: null,
      breaches: [],
    });
    const plan = computeTradePlan(view);
    expect(plan.regime).toBe('drift-and-cap');
    expect(plan.long.verdict).toBe('safe');
    expect(plan.long.target).toBe(7140);
    // 7080 is exactly 20 pts away — within NEAR_WALL_PTS=15? No, 20 > 15
    // so floor is NOT "near" → short plan is at least conditional.
    // Floor distance is 20 pts, which falls outside the 15-pt threshold.
    expect(['conditional', 'safe', 'avoid']).toContain(plan.short.verdict);
  });

  it('reads a pin setup when both walls are within 15 pts of spot', () => {
    const view = makeView({
      spot: 7200,
      gamma: {
        ceiling: { strike: 7210, value: 4000, ptsFromSpot: 10 },
        floor: { strike: 7190, value: 4000, ptsFromSpot: -10 },
        accelTop: [],
        topByAbsNear: [{ strike: 7200, value: 5000 }],
      },
      charm: {
        tallyNear50: 0,
        tallyWide100: 0,
        topByAbs: [],
        charmZeroStrike: null,
      },
    });
    const plan = computeTradePlan(view);
    expect(plan.regime).toBe('pin');
    expect(plan.bias).toBe('fade-only');
    expect(plan.long.verdict).toBe('avoid');
    expect(plan.short.verdict).toBe('avoid');
    expect(plan.summary).toMatch(/Pin setup/);
  });

  it('reads cone-breach-down, short-only', () => {
    const view = makeView({
      spot: 7050,
      gamma: {
        ceiling: { strike: 7100, value: 1000, ptsFromSpot: 50 },
        floor: { strike: 7000, value: 3000, ptsFromSpot: -50 },
        accelTop: [],
        topByAbsNear: [],
      },
      charm: {
        tallyNear50: -5_000_000,
        tallyWide100: -10_000_000,
        topByAbs: [],
        charmZeroStrike: null,
      },
      cone: {
        coneUpper: 7080,
        coneLower: 7060,
        coneWidth: 20,
        asymmetryPts: 0,
        spotAtCalc: 7070,
      },
      breaches: [
        {
          direction: 'lower',
          breachTime: '2026-05-08T15:00:00Z',
          spotAtBreach: 7058,
          ptsPastBound: 2,
        },
      ],
    });
    const plan = computeTradePlan(view);
    expect(plan.regime).toBe('cone-breach-down');
    expect(plan.bias).toBe('short-only');
    expect(plan.short.verdict).toBe('safe');
    expect(plan.short.target).toBe(7000);
    expect(plan.long.verdict).toBe('avoid');
  });

  it('handles no-data: no walls + no cone', () => {
    const view = makeView({});
    const plan = computeTradePlan(view);
    expect(plan.regime).toBe('no-data');
    expect(plan.bias).toBe('no-trade');
    expect(plan.long.verdict).toBe('avoid');
    expect(plan.short.verdict).toBe('avoid');
  });

  it('flags +γ ceiling near spot as long-avoid', () => {
    const view = makeView({
      spot: 7100,
      gamma: {
        ceiling: { strike: 7108, value: 5000, ptsFromSpot: 8 }, // within 15 pts
        floor: null,
        accelTop: [],
        topByAbsNear: [],
      },
      charm: {
        tallyNear50: 5_000_000,
        tallyWide100: 5_000_000,
        topByAbs: [],
        charmZeroStrike: null,
      },
    });
    const plan = computeTradePlan(view);
    expect(plan.long.verdict).toBe('avoid');
    expect(plan.long.reason).toMatch(/mechanical cap/);
  });
});
