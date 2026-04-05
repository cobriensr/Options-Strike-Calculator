import { describe, expect, it } from 'vitest';

import {
  adjustPoPForKurtosis,
  adjustICPoPForKurtosis,
  calcPoP,
  calcSpreadPoP,
  buildIronCondor,
  calcThetaCurve,
} from '../utils/iron-condor';
import { DEFAULTS, DELTA_Z_SCORES } from '../constants';
import type { DeltaRow, DeltaTarget } from '../types';

// ── Test helpers ───────────────────────────────────────────────

/**
 * Builds a minimal DeltaRow for iron condor tests.
 * Uses realistic values for a 10-delta SPX 0DTE at 5800.
 */
function makeDeltaRow(overrides: Partial<DeltaRow> = {}): DeltaRow {
  return {
    delta: 10 as DeltaTarget,
    z: DELTA_Z_SCORES[10],
    putStrike: 5740,
    callStrike: 5860,
    putSnapped: 5740,
    callSnapped: 5860,
    putSpySnapped: 574,
    callSpySnapped: 586,
    spyPut: '574.00',
    spyCall: '586.00',
    putDistance: 60,
    callDistance: 60,
    putPct: '1.03',
    callPct: '1.03',
    putPremium: 1.2,
    callPremium: 0.8,
    putSigma: 0.155,
    callSigma: 0.145,
    basePutSigma: 0.155,
    baseCallSigma: 0.145,
    putActualDelta: 0.1,
    callActualDelta: 0.1,
    putGamma: 0.002,
    callGamma: 0.002,
    putTheta: -500,
    callTheta: -500,
    ivAccelMult: 1.0,
    ...overrides,
  };
}

// ── adjustPoPForKurtosis ───────────────────────────────────────

describe('adjustPoPForKurtosis', () => {
  it('returns the original PoP when kurtosis factor is 1', () => {
    expect(adjustPoPForKurtosis(0.85, { crash: 1, rally: 1 }, 'put')).toBe(
      0.85,
    );
    expect(adjustPoPForKurtosis(0.85, { crash: 1, rally: 1 }, 'call')).toBe(
      0.85,
    );
  });

  it('reduces PoP when crash factor > 1 (put side)', () => {
    const original = 0.9;
    const adjusted = adjustPoPForKurtosis(
      original,
      { crash: 2.5, rally: 1.5 },
      'put',
    );
    expect(adjusted).toBeLessThan(original);
  });

  it('reduces PoP when rally factor > 1 (call side)', () => {
    const original = 0.9;
    const adjusted = adjustPoPForKurtosis(
      original,
      { crash: 2.5, rally: 1.5 },
      'call',
    );
    expect(adjusted).toBeLessThan(original);
  });

  it('uses crash factor for put side, rally factor for call side', () => {
    const pop = 0.9;
    const kurtosis = { crash: 3.0, rally: 1.5 };
    const putAdjusted = adjustPoPForKurtosis(pop, kurtosis, 'put');
    const callAdjusted = adjustPoPForKurtosis(pop, kurtosis, 'call');
    // Higher crash factor means more PoP reduction for puts
    expect(putAdjusted).toBeLessThan(callAdjusted);
  });

  it('adjusted PoP is always between 0 and 1', () => {
    const extremeKurtosis = { crash: 10, rally: 10 };
    const adj = adjustPoPForKurtosis(0.95, extremeKurtosis, 'put');
    expect(adj).toBeGreaterThanOrEqual(0);
    expect(adj).toBeLessThanOrEqual(1);
  });

  it('PoP of 1.0 stays at 1.0 (no breach probability to inflate)', () => {
    const adj = adjustPoPForKurtosis(1.0, { crash: 5, rally: 5 }, 'put');
    expect(adj).toBe(1.0);
  });

  it('PoP of 0 stays at 0', () => {
    const adj = adjustPoPForKurtosis(0, { crash: 5, rally: 5 }, 'put');
    expect(adj).toBe(0);
  });

  it('uses default kurtosis when not specified', () => {
    const pop = 0.9;
    const withDefault = adjustPoPForKurtosis(pop);
    const withExplicit = adjustPoPForKurtosis(
      pop,
      DEFAULTS.KURTOSIS_FACTOR,
      'put',
    );
    expect(withDefault).toBeCloseTo(withExplicit, 8);
  });
});

// ── calcPoP ────────────────────────────────────────────────────

describe('calcPoP', () => {
  const spot = 5800;
  const putSigma = 0.155;
  const callSigma = 0.145;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(calcPoP(spot, 5700, 5900, putSigma, callSigma, 0)).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcPoP(spot, 5700, 5900, 0, callSigma, T)).toBe(0);
    expect(calcPoP(spot, 5700, 5900, putSigma, 0, T)).toBe(0);
  });

  it('returns 0 when breakeven levels are invalid', () => {
    expect(calcPoP(spot, 0, 5900, putSigma, callSigma, T)).toBe(0);
    expect(calcPoP(spot, 5700, 0, putSigma, callSigma, T)).toBe(0);
  });

  it('PoP is between 0 and 1', () => {
    const pop = calcPoP(spot, 5740, 5860, putSigma, callSigma, T);
    expect(pop).toBeGreaterThan(0);
    expect(pop).toBeLessThan(1);
  });

  it('wider breakevens give higher PoP', () => {
    const narrow = calcPoP(spot, 5780, 5820, putSigma, callSigma, T);
    const wide = calcPoP(spot, 5700, 5900, putSigma, callSigma, T);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('higher sigma gives lower PoP (more uncertainty)', () => {
    const lowVol = calcPoP(spot, 5740, 5860, 0.1, 0.1, T);
    const highVol = calcPoP(spot, 5740, 5860, 0.3, 0.3, T);
    expect(lowVol).toBeGreaterThan(highVol);
  });

  it('PoP approaches 1 for very wide breakevens', () => {
    const pop = calcPoP(spot, 5000, 6600, putSigma, callSigma, T);
    expect(pop).toBeGreaterThan(0.99);
  });
});

// ── calcSpreadPoP ──────────────────────────────────────────────

describe('calcSpreadPoP', () => {
  const spot = 5800;
  const sigma = 0.15;
  const T = 1 / 252;

  it('returns 0 when T <= 0', () => {
    expect(calcSpreadPoP(spot, 5740, sigma, 0, 'put')).toBe(0);
  });

  it('returns 0 when sigma <= 0', () => {
    expect(calcSpreadPoP(spot, 5740, 0, T, 'put')).toBe(0);
  });

  it('put spread PoP is between 0 and 1', () => {
    const pop = calcSpreadPoP(spot, 5740, sigma, T, 'put');
    expect(pop).toBeGreaterThan(0);
    expect(pop).toBeLessThan(1);
  });

  it('call spread PoP is between 0 and 1', () => {
    const pop = calcSpreadPoP(spot, 5860, sigma, T, 'call');
    expect(pop).toBeGreaterThan(0);
    expect(pop).toBeLessThan(1);
  });

  it('further OTM breakeven gives higher PoP for put spreads', () => {
    const close = calcSpreadPoP(spot, 5780, sigma, T, 'put');
    const far = calcSpreadPoP(spot, 5700, sigma, T, 'put');
    expect(far).toBeGreaterThan(close);
  });

  it('further OTM breakeven gives higher PoP for call spreads', () => {
    const close = calcSpreadPoP(spot, 5820, sigma, T, 'call');
    const far = calcSpreadPoP(spot, 5900, sigma, T, 'call');
    expect(far).toBeGreaterThan(close);
  });
});

// ── adjustICPoPForKurtosis ─────────────────────────────────────

describe('adjustICPoPForKurtosis', () => {
  const spot = 5800;
  const putSigma = 0.155;
  const callSigma = 0.145;
  const T = 1 / 252;
  const beLow = 5740;
  const beHigh = 5860;

  it('matches calcPoP when kurtosis factors are both <= 1', () => {
    const pop = calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);
    const adj = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      { crash: 1, rally: 1 },
    );
    expect(adj).toBeCloseTo(pop, 8);
  });

  it('reduces PoP compared to unadjusted when kurtosis > 1', () => {
    const pop = calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);
    const adj = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      { crash: 2.5, rally: 1.5 },
    );
    expect(adj).toBeLessThan(pop);
  });

  it('adjusted PoP is between 0 and 1', () => {
    const adj = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      T,
      { crash: 4, rally: 3 },
    );
    expect(adj).toBeGreaterThanOrEqual(0);
    expect(adj).toBeLessThanOrEqual(1);
  });

  it('falls back to calcPoP when T <= 0', () => {
    const adj = adjustICPoPForKurtosis(
      spot,
      beLow,
      beHigh,
      putSigma,
      callSigma,
      0,
      { crash: 2.5, rally: 1.5 },
    );
    expect(adj).toBe(0); // calcPoP returns 0 for T <= 0
  });
});

// ── buildIronCondor ────────────────────────────────────────────

describe('buildIronCondor', () => {
  const spot = 5800;
  const T = 1 / 252;
  const wingWidth = 25;

  it('constructs correct leg positions', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.shortPut).toBe(row.putSnapped);
    expect(ic.longPut).toBe(row.putSnapped - wingWidth);
    expect(ic.shortCall).toBe(row.callSnapped);
    expect(ic.longCall).toBe(row.callSnapped + wingWidth);
  });

  it('credit received > 0', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.creditReceived).toBeGreaterThan(0);
  });

  it('maxProfit equals credit received', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.maxProfit).toBe(ic.creditReceived);
  });

  it('maxLoss = wingWidth - creditReceived', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.maxLoss).toBeCloseTo(wingWidth - ic.creditReceived, 6);
  });

  it('breakEvenLow < shortPut', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.breakEvenLow).toBeLessThan(ic.shortPut);
  });

  it('breakEvenHigh > shortCall', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.breakEvenHigh).toBeGreaterThan(ic.shortCall);
  });

  it('returnOnRisk is positive', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.returnOnRisk).toBeGreaterThan(0);
  });

  it('returnOnRisk = creditReceived / maxLoss', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.returnOnRisk).toBeCloseTo(ic.creditReceived / ic.maxLoss, 6);
  });

  it('probabilityOfProfit is between 0 and 1', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.probabilityOfProfit).toBeGreaterThan(0);
    expect(ic.probabilityOfProfit).toBeLessThan(1);
  });

  it('per-side credits sum to total credit', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.putSpreadCredit + ic.callSpreadCredit).toBeCloseTo(
      ic.creditReceived,
      6,
    );
  });

  it('per-side max losses are positive', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.putSpreadMaxLoss).toBeGreaterThan(0);
    expect(ic.callSpreadMaxLoss).toBeGreaterThan(0);
  });

  it('per-side PoPs are between 0 and 1', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.putSpreadPoP).toBeGreaterThan(0);
    expect(ic.putSpreadPoP).toBeLessThan(1);
    expect(ic.callSpreadPoP).toBeGreaterThan(0);
    expect(ic.callSpreadPoP).toBeLessThan(1);
  });

  it('adjusted PoP <= unadjusted PoP (fat tails reduce probability)', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T, 10, 18);
    expect(ic.adjustedPoP).toBeLessThanOrEqual(ic.probabilityOfProfit + 0.001);
  });

  it('adjusted per-side PoPs <= unadjusted', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T, 10, 18);
    expect(ic.adjustedPutSpreadPoP).toBeLessThanOrEqual(
      ic.putSpreadPoP + 0.001,
    );
    expect(ic.adjustedCallSpreadPoP).toBeLessThanOrEqual(
      ic.callSpreadPoP + 0.001,
    );
  });

  it('wider wings = lower credit per wing width (more risk)', () => {
    const row = makeDeltaRow();
    const narrow = buildIronCondor(row, 15, spot, T);
    const wide = buildIronCondor(row, 30, spot, T);
    // Both use the same short strikes, so credit should be similar
    // but max loss is higher for wider wings
    expect(wide.maxLoss).toBeGreaterThan(narrow.maxLoss);
  });

  it('SPY equivalents are computed', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.shortPutSpy).toBeGreaterThan(0);
    expect(ic.longPutSpy).toBeGreaterThan(0);
    expect(ic.shortCallSpy).toBeGreaterThan(0);
    expect(ic.longCallSpy).toBeGreaterThan(0);
  });

  it('wingWidthSpx matches input', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, wingWidth, spot, T);
    expect(ic.wingWidthSpx).toBe(wingWidth);
  });

  it('handles zero-width spreads gracefully', () => {
    const row = makeDeltaRow();
    const ic = buildIronCondor(row, 0, spot, T);
    // 0-width means long = short strike, so all premiums cancel
    expect(ic.creditReceived).toBeCloseTo(0, 2);
  });
});

// ── calcThetaCurve ─────────────────────────────────────────────

describe('calcThetaCurve', () => {
  const spot = 5800;
  const sigma = 0.15;
  const strikeDistance = 60;

  it('returns an array of entries for put side', () => {
    const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put');
    expect(curve.length).toBeGreaterThan(0);
  });

  it('returns an array of entries for call side', () => {
    const curve = calcThetaCurve(spot, sigma, strikeDistance, 'call');
    expect(curve.length).toBeGreaterThan(0);
  });

  it('premium percentage starts at 100% (6.5h)', () => {
    const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put');
    const first = curve[0];
    expect(first).toBeDefined();
    expect(first!.hoursRemaining).toBe(6.5);
    expect(first!.premiumPct).toBeCloseTo(100, 0);
  });

  it('premium percentage decreases over time', () => {
    const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put');
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.premiumPct).toBeLessThanOrEqual(
        curve[i - 1]!.premiumPct,
      );
    }
  });

  it('theta per hour values are non-negative', () => {
    const curve = calcThetaCurve(spot, sigma, strikeDistance, 'put');
    for (const entry of curve) {
      expect(entry.thetaPerHour).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns empty array when option has no premium', () => {
    // Very deep OTM: 500 points away on 0DTE with low vol
    const curve = calcThetaCurve(spot, 0.01, 500, 'put');
    expect(curve).toHaveLength(0);
  });
});
