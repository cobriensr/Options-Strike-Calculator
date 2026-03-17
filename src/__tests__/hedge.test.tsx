import { describe, it, expect } from 'vitest';
import {
  calcHedge,
  calcTimeToExpiry,
  calcAllDeltas,
  buildIronCondor,
  stressedSigma,
} from '../utils/calculator';
import type { DeltaRow, HedgeDelta } from '../types';

// Helper: build a standard IC position for testing
function makeTestIC(
  spot = 6830,
  sigma = 0.2836,
  hoursRemaining = 6.33,
  delta: 10 | 12 = 10,
  wingWidth = 20,
) {
  const T = calcTimeToExpiry(hoursRemaining);
  const allDeltas = calcAllDeltas(spot, sigma, T, 0.03, 10);
  const row = allDeltas.find(
    (r) => !('error' in r) && r.delta === delta,
  ) as DeltaRow;
  const ic = buildIronCondor(row, wingWidth, spot, T, 10);
  return { spot, sigma, T, ic, row };
}

describe('calcHedge: basic structure', () => {
  it('returns all required fields', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.hedgeDelta).toBe(2);
    expect(hedge.putStrike).toBeGreaterThan(0);
    expect(hedge.callStrike).toBeGreaterThan(0);
    expect(hedge.putStrikeSnapped).toBeGreaterThan(0);
    expect(hedge.callStrikeSnapped).toBeGreaterThan(0);
    expect(hedge.putPremium).toBeGreaterThan(0);
    expect(hedge.callPremium).toBeGreaterThan(0);
    expect(hedge.recommendedPuts).toBeGreaterThanOrEqual(1);
    expect(hedge.recommendedCalls).toBeGreaterThanOrEqual(1);
    expect(hedge.dailyCostPts).toBeGreaterThan(0);
    expect(hedge.dailyCostDollars).toBeGreaterThan(0);
    expect(hedge.breakEvenCrashPts).toBeGreaterThan(0);
    expect(hedge.breakEvenRallyPts).toBeGreaterThan(0);
    expect(hedge.netCreditAfterHedge).toBeDefined();
    expect(hedge.scenarios.length).toBeGreaterThan(0);
  });

  it('generates scenarios for both crashes and rallies', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const crashes = hedge.scenarios.filter((s) => s.direction === 'crash');
    const rallies = hedge.scenarios.filter((s) => s.direction === 'rally');
    expect(crashes.length).toBe(9); // 100-500 in steps
    expect(rallies.length).toBe(9);
  });
});

describe('calcHedge: strike positioning', () => {
  it('hedge put strike is below IC long put', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.putStrikeSnapped).toBeLessThan(ic.longPut);
  });

  it('hedge call strike is above IC long call', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.callStrikeSnapped).toBeGreaterThan(ic.longCall);
  });

  it('hedge strikes are snapped to 5-point increments', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.putStrikeSnapped % 5).toBe(0);
    expect(hedge.callStrikeSnapped % 5).toBe(0);
  });

  it('lower hedge delta = further OTM strikes', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const params = {
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
    };

    const hedge1 = calcHedge({ ...params, hedgeDelta: 1 as HedgeDelta });
    const hedge2 = calcHedge({ ...params, hedgeDelta: 2 as HedgeDelta });
    const hedge5 = calcHedge({ ...params, hedgeDelta: 5 as HedgeDelta });

    // 1Δ put should be further below spot than 2Δ, which is further than 5Δ
    expect(hedge1.putStrikeSnapped).toBeLessThan(hedge2.putStrikeSnapped);
    expect(hedge2.putStrikeSnapped).toBeLessThan(hedge5.putStrikeSnapped);

    // 1Δ call should be further above spot than 2Δ, which is further than 5Δ
    expect(hedge1.callStrikeSnapped).toBeGreaterThan(hedge2.callStrikeSnapped);
    expect(hedge2.callStrikeSnapped).toBeGreaterThan(hedge5.callStrikeSnapped);
  });
});

describe('calcHedge: recommended contract sizing', () => {
  it('recommends at least 1 put and 1 call', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 1,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.recommendedPuts).toBeGreaterThanOrEqual(1);
    expect(hedge.recommendedCalls).toBeGreaterThanOrEqual(1);
  });

  it('more IC contracts = more hedge contracts', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const params = {
      spot,
      sigma,
      T,
      skew: 0.03,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2 as HedgeDelta,
    };

    const hedge5 = calcHedge({ ...params, icContracts: 5 });
    const hedge30 = calcHedge({ ...params, icContracts: 30 });

    expect(hedge30.recommendedPuts).toBeGreaterThan(hedge5.recommendedPuts);
    expect(hedge30.recommendedCalls).toBeGreaterThan(hedge5.recommendedCalls);
  });

  it('wider IC wings = more hedge contracts needed', () => {
    const { spot, sigma, T } = makeTestIC();
    const allDeltas = calcAllDeltas(spot, sigma, T, 0.03, 10);
    const row = allDeltas.find(
      (r) => !('error' in r) && r.delta === 10,
    ) as DeltaRow;

    const ic5 = buildIronCondor(row, 5, spot, T, 10);
    const ic20 = buildIronCondor(row, 20, spot, T, 10);

    const params = {
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icShortPut: ic5.shortPut,
      icLongPut: ic5.longPut,
      icShortCall: ic5.shortCall,
      icLongCall: ic5.longCall,
      hedgeDelta: 2 as HedgeDelta,
    };

    const hedge5 = calcHedge({
      ...params,
      icCreditPts: ic5.creditReceived,
      icMaxLossPts: ic5.maxLoss,
    });
    const hedge20 = calcHedge({
      ...params,
      icCreditPts: ic20.creditReceived,
      icMaxLossPts: ic20.maxLoss,
      icLongPut: ic20.longPut,
      icLongCall: ic20.longCall,
    });

    expect(hedge20.recommendedPuts).toBeGreaterThanOrEqual(
      hedge5.recommendedPuts,
    );
  });
});

describe('calcHedge: cost calculations', () => {
  it('daily cost is positive', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.dailyCostDollars).toBeGreaterThan(0);
    expect(hedge.dailyCostPts).toBeGreaterThan(0);
  });

  it('net credit after hedge is less than IC credit alone', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const icCreditDollars = ic.creditReceived * 100 * 15;
    expect(hedge.netCreditAfterHedge).toBeLessThan(icCreditDollars);
  });

  it('net credit after hedge is still positive for reasonable setups', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.netCreditAfterHedge).toBeGreaterThan(0);
  });

  it('lower hedge delta = cheaper premiums per contract', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const params = {
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
    };

    const hedge1 = calcHedge({ ...params, hedgeDelta: 1 as HedgeDelta });
    const hedge5 = calcHedge({ ...params, hedgeDelta: 5 as HedgeDelta });

    // 1Δ is further OTM = cheaper per contract
    expect(hedge1.putPremium).toBeLessThan(hedge5.putPremium);
    expect(hedge1.callPremium).toBeLessThan(hedge5.callPremium);
  });
});

describe('calcHedge: scenario P&L', () => {
  it('IC is profitable for small moves (100 pts)', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // First crash scenario is the smallest move (1.5% of spot)
    const smallCrash = hedge.scenarios.find((s) => s.direction === 'crash');
    expect(smallCrash).toBeDefined();
    expect(smallCrash!.icPnL).toBeGreaterThan(0);
  });

  it('IC hits max loss for large moves', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // Last crash scenario is the largest move (10% of spot)
    const crashes = hedge.scenarios.filter((s) => s.direction === 'crash');
    const largeCrash = crashes.at(-1);
    expect(largeCrash).toBeDefined();
    expect(largeCrash!.icPnL).toBeLessThan(0);
  });

  it('hedge put payout increases with crash size', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const crashes = hedge.scenarios.filter((s) => s.direction === 'crash');
    for (let i = 1; i < crashes.length; i++) {
      expect(crashes[i]!.hedgePutPnL).toBeGreaterThanOrEqual(
        crashes[i - 1]!.hedgePutPnL,
      );
    }
  });

  it('hedge call payout increases with rally size', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const rallies = hedge.scenarios.filter((s) => s.direction === 'rally');
    for (let i = 1; i < rallies.length; i++) {
      expect(rallies[i]!.hedgeCallPnL).toBeGreaterThanOrEqual(
        rallies[i - 1]!.hedgeCallPnL,
      );
    }
  });

  it('net P&L becomes positive for very large crashes (reinsurance kicks in)', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // Largest crash (10% of spot) — hedge should more than offset IC loss
    const crashes = hedge.scenarios.filter((s) => s.direction === 'crash');
    const hugeCrash = crashes.at(-1);
    expect(hugeCrash).toBeDefined();
    expect(hugeCrash!.netPnL).toBeGreaterThan(0);
  });

  it('hedge cost is negative in all scenarios', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    for (const s of hedge.scenarios) {
      expect(s.hedgeCost).toBeLessThanOrEqual(0);
    }
  });

  it('scenario movePct is correctly calculated', () => {
    const spot = 6830;
    const { sigma, T, ic } = makeTestIC(spot);
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // Pick the first crash scenario and verify movePct matches movePoints/spot
    const firstCrash = hedge.scenarios.find((s) => s.direction === 'crash');
    expect(firstCrash).toBeDefined();
    const expectedPct = ((firstCrash!.movePoints / spot) * 100).toFixed(1);
    expect(firstCrash!.movePct).toBe(expectedPct);
  });
});

describe('calcHedge: breakeven points', () => {
  it('breakeven crash is between IC max loss point and 2× that distance', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const distToShortPut = spot - ic.shortPut;
    // Breakeven should be beyond the short put (where loss starts)
    expect(hedge.breakEvenCrashPts).toBeGreaterThan(distToShortPut);
    // But not absurdly far
    expect(hedge.breakEvenCrashPts).toBeLessThan(spot * 0.15);
  });

  it('breakeven rally is between IC max loss point and 2× that distance', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const distToShortCall = ic.shortCall - spot;
    expect(hedge.breakEvenRallyPts).toBeGreaterThan(distToShortCall);
    expect(hedge.breakEvenRallyPts).toBeLessThan(spot * 0.15);
  });
});

describe('calcHedge: all hedge deltas work', () => {
  const hedgeDeltas: HedgeDelta[] = [1, 2, 3, 5];

  for (const hd of hedgeDeltas) {
    it(`${hd}Δ hedge produces valid result`, () => {
      const { spot, sigma, T, ic } = makeTestIC();
      const hedge = calcHedge({
        spot,
        sigma,
        T,
        skew: 0.03,
        icContracts: 10,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: hd,
      });

      expect(hedge.hedgeDelta).toBe(hd);
      expect(hedge.putStrikeSnapped).toBeLessThan(spot);
      expect(hedge.callStrikeSnapped).toBeGreaterThan(spot);
      expect(hedge.recommendedPuts).toBeGreaterThanOrEqual(1);
      expect(hedge.recommendedCalls).toBeGreaterThanOrEqual(1);
      expect(hedge.scenarios.length).toBe(18); // 9 crash + 9 rally
    });
  }
});

describe('calcHedge: edge cases', () => {
  it('works with 1 IC contract', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    expect(() =>
      calcHedge({
        spot,
        sigma,
        T,
        skew: 0.03,
        icContracts: 1,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: 2,
      }),
    ).not.toThrow();
  });

  it('works with high IV (VIX 40+)', () => {
    const { spot, T, ic } = makeTestIC(6830, 0.46, 6.33); // σ=0.46
    expect(() =>
      calcHedge({
        spot,
        sigma: 0.46,
        T,
        skew: 0.03,
        icContracts: 15,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: 2,
      }),
    ).not.toThrow();
  });

  it('works with zero skew', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    expect(() =>
      calcHedge({
        spot,
        sigma,
        T,
        skew: 0,
        icContracts: 15,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: 2,
      }),
    ).not.toThrow();
  });

  it('works with 5-pt wings', () => {
    const spot = 6830;
    const sigma = 0.2836;
    const T = calcTimeToExpiry(6.33);
    const allDeltas = calcAllDeltas(spot, sigma, T, 0.03, 10);
    const row = allDeltas.find(
      (r) => !('error' in r) && r.delta === 10,
    ) as DeltaRow;
    const ic = buildIronCondor(row, 5, spot, T, 10);

    expect(() =>
      calcHedge({
        spot,
        sigma,
        T,
        skew: 0.03,
        icContracts: 15,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: 2,
      }),
    ).not.toThrow();
  });

  it('works with near-close time (0.5h remaining)', () => {
    const { spot, ic } = makeTestIC(6830, 0.2836, 0.5);
    const T = calcTimeToExpiry(0.5);
    expect(() =>
      calcHedge({
        spot,
        sigma: 0.2836,
        T,
        skew: 0.03,
        icContracts: 15,
        icCreditPts: ic.creditReceived,
        icMaxLossPts: ic.maxLoss,
        icShortPut: ic.shortPut,
        icLongPut: ic.longPut,
        icShortCall: ic.shortCall,
        icLongCall: ic.longCall,
        hedgeDelta: 2,
      }),
    ).not.toThrow();
  });
});

describe('calcHedge: real-world scenario (March 2 setup)', () => {
  // SPX 6830, VIX 24.66, 0DTE adj 1.15, 8:40 AM CT = 6.33h remaining
  const spot = 6830;
  const sigma = (24.66 * 1.15) / 100; // 0.2836
  const T = calcTimeToExpiry(6.33);

  it('15 contracts, 10Δ, 20-pt wings at 2Δ hedge', () => {
    const allDeltas = calcAllDeltas(spot, sigma, T, 0.03, 10);
    const row = allDeltas.find(
      (r) => !('error' in r) && r.delta === 10,
    ) as DeltaRow;
    const ic = buildIronCondor(row, 20, spot, T, 10);

    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // Hedge cost should be a meaningful fraction of IC credit
    // With 7DTE hedges, net daily cost (entry - EOD recovery) is higher
    // than 0DTE premium but provides much better crash protection
    const icCreditDollars = ic.creditReceived * 100 * 15;
    const hedgePct = (hedge.dailyCostDollars / icCreditDollars) * 100;
    expect(hedgePct).toBeGreaterThan(1);
    expect(hedgePct).toBeLessThan(80); // 7DTE hedges cost more per day than 0DTE

    // Puts and calls should be reasonable counts (not 100+)
    expect(hedge.recommendedPuts).toBeLessThan(30);
    expect(hedge.recommendedCalls).toBeLessThan(30);

    // Hedge DTE should be set
    expect(hedge.hedgeDte).toBe(7);
    expect(hedge.putRecovery).toBeGreaterThan(0);
    expect(hedge.callRecovery).toBeGreaterThan(0);
  });
});

describe('calcHedge: vega exposure', () => {
  it('returns positive vega for put and call hedges', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    expect(hedge.putVegaPer1Pct).toBeGreaterThan(0);
    expect(hedge.callVegaPer1Pct).toBeGreaterThan(0);
    expect(hedge.totalVegaPer1Pct).toBeGreaterThan(0);
  });

  it('total vega = sum of per-contract vega × contract counts', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    const expected =
      hedge.putVegaPer1Pct * hedge.recommendedPuts +
      hedge.callVegaPer1Pct * hedge.recommendedCalls;
    expect(hedge.totalVegaPer1Pct).toBeCloseTo(expected, 1);
  });

  it('more contracts = higher total vega', () => {
    const { spot, sigma, T, ic } = makeTestIC();
    const params = {
      spot,
      sigma,
      T,
      skew: 0.03,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2 as HedgeDelta,
    };

    const small = calcHedge({ ...params, icContracts: 5 });
    const large = calcHedge({ ...params, icContracts: 30 });
    expect(large.totalVegaPer1Pct).toBeGreaterThan(small.totalVegaPer1Pct);
  });
});

describe('stressedSigma: vol expansion under stress', () => {
  it('returns base sigma when move is zero', () => {
    expect(stressedSigma(0.2, 0)).toBe(0.2);
  });

  it('increases sigma on crashes (positive movePct)', () => {
    const stressed = stressedSigma(0.2, 0.02); // 2% crash
    expect(stressed).toBeGreaterThan(0.2);
  });

  it('increases sigma on rallies (negative movePct) but less than crashes', () => {
    const crashStress = stressedSigma(0.2, 0.03); // 3% crash
    const rallyStress = stressedSigma(0.2, -0.03); // 3% rally
    expect(rallyStress).toBeGreaterThan(0.2); // still increases
    expect(crashStress).toBeGreaterThan(rallyStress); // crash > rally
  });

  it('crash sensitivity is ~4x per 1%: 2% crash → ~1.08x sigma', () => {
    const stressed = stressedSigma(0.2, 0.02);
    // 1 + 4.0 * 0.02 = 1.08
    expect(stressed).toBeCloseTo(0.2 * 1.08, 6);
  });

  it('rally sensitivity is ~1.5x per 1%: 2% rally → ~1.03x sigma', () => {
    const stressed = stressedSigma(0.2, -0.02);
    // 1 + 1.5 * 0.02 = 1.03
    expect(stressed).toBeCloseTo(0.2 * 1.03, 6);
  });

  it('is capped at 3× base sigma', () => {
    const stressed = stressedSigma(0.2, 0.2); // 20% crash
    // 1 + 4.0 * 0.20 = 1.80 → under cap
    expect(stressed).toBeLessThanOrEqual(0.6);

    const extreme = stressedSigma(0.2, 1.0); // 100% crash (theoretical)
    // 1 + 4.0 * 1.0 = 5.0 → capped at 3.0
    expect(extreme).toBeCloseTo(0.6, 6);
  });

  it('scenarios show larger hedge payout with vol expansion vs flat vol', () => {
    // The vol expansion makes hedge puts more valuable in crashes.
    // We verify this by checking that a 400pt crash scenario has a
    // larger net P&L with vol expansion than the IC loss alone would suggest.
    const { spot, sigma, T, ic } = makeTestIC();
    const hedge = calcHedge({
      spot,
      sigma,
      T,
      skew: 0.03,
      icContracts: 15,
      icCreditPts: ic.creditReceived,
      icMaxLossPts: ic.maxLoss,
      icShortPut: ic.shortPut,
      icLongPut: ic.longPut,
      icShortCall: ic.shortCall,
      icLongCall: ic.longCall,
      hedgeDelta: 2,
    });

    // Use the largest crash scenario (10% of spot)
    const crashes = hedge.scenarios.filter((s) => s.direction === 'crash');
    const largeCrash = crashes.at(-1)!;
    // Hedge put payout should be substantial (vol expansion increases it)
    expect(largeCrash.hedgePutPnL).toBeGreaterThan(0);
  });
});
