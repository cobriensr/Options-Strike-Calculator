import { describe, it, expect } from 'vitest';
import {
  calcStrikes,
  calcTimeToExpiry,
  calcAllDeltas,
  buildIronCondor,
  calcPoP,
  calcSpreadPoP,
  calcScaledSkew,
  isStrikeError,
} from '../../utils/calculator';
import type { DeltaRow } from '../../types';

describe('Skew: put IV adjustment', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);

  it('skew = 0 gives symmetric strikes', () => {
    const r = calcStrikes(spot, sigma, T, 10, 0);
    if (!isStrikeError(r)) {
      const putDist = spot - r.putStrike;
      const callDist = r.callStrike - spot;
      expect(Math.abs(putDist - callDist)).toBeLessThan(spot * 0.005);
    }
  });

  it('positive skew pushes put further OTM than call', () => {
    const r = calcStrikes(spot, sigma, T, 10, 0.05);
    if (!isStrikeError(r)) {
      const putDist = spot - r.putStrike;
      const callDist = r.callStrike - spot;
      expect(putDist).toBeGreaterThan(callDist);
    }
  });

  it('higher skew = wider put distance', () => {
    const low = calcStrikes(spot, sigma, T, 10, 0.02);
    const high = calcStrikes(spot, sigma, T, 10, 0.08);
    if (!isStrikeError(low) && !isStrikeError(high)) {
      const lowPutDist = spot - low.putStrike;
      const highPutDist = spot - high.putStrike;
      expect(highPutDist).toBeGreaterThan(lowPutDist);
    }
  });

  it('higher skew = narrower call distance', () => {
    const low = calcStrikes(spot, sigma, T, 10, 0.02);
    const high = calcStrikes(spot, sigma, T, 10, 0.08);
    if (!isStrikeError(low) && !isStrikeError(high)) {
      const lowCallDist = low.callStrike - spot;
      const highCallDist = high.callStrike - spot;
      expect(highCallDist).toBeLessThan(lowCallDist);
    }
  });

  it('skew works across all deltas', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0.03);
    for (const row of rows) {
      if (!('error' in row)) {
        const putDist = spot - row.putStrike;
        const callDist = row.callStrike - spot;
        expect(putDist).toBeGreaterThan(callDist);
      }
    }
  });
});

describe('Independent put/call skew', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);

  it('callSkewOverride = 0 makes calls symmetric (no call skew)', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0.05, 10, 0);
    for (const row of rows) {
      if (!('error' in row)) {
        // Put side has skew, call side has none
        // Call sigma should be close to base sigma (no skew reduction)
        const accelSigma = sigma * row.ivAccelMult;
        expect(row.callSigma).toBeCloseTo(accelSigma, 4);
      }
    }
  });

  it('independent call skew produces different call strikes than shared skew', () => {
    const shared = calcStrikes(spot, sigma, T, 10, 0.05);
    const independent = calcStrikes(spot, sigma, T, 10, 0.05, 0.01);
    if (!isStrikeError(shared) && !isStrikeError(independent)) {
      // Same put strikes (put skew unchanged)
      expect(independent.putStrike).toBe(shared.putStrike);
      // Different call strikes (call skew changed)
      expect(independent.callStrike).not.toBe(shared.callStrike);
    }
  });

  it('higher independent call skew moves call strike closer to spot', () => {
    const lowCallSkew = calcStrikes(spot, sigma, T, 10, 0.05, 0.01);
    const highCallSkew = calcStrikes(spot, sigma, T, 10, 0.05, 0.08);
    if (!isStrikeError(lowCallSkew) && !isStrikeError(highCallSkew)) {
      // Higher call skew → lower callSigma → call strike closer to spot
      expect(highCallSkew.callStrike).toBeLessThan(lowCallSkew.callStrike);
    }
  });

  it('omitting callSkewOverride preserves original behavior', () => {
    const original = calcStrikes(spot, sigma, T, 10, 0.05);
    const withUndefined = calcStrikes(spot, sigma, T, 10, 0.05, undefined);
    if (!isStrikeError(original) && !isStrikeError(withUndefined)) {
      expect(withUndefined.putStrike).toBe(original.putStrike);
      expect(withUndefined.callStrike).toBe(original.callStrike);
    }
  });
});

describe('calcAllDeltas: SPY snapped strikes', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);

  it('includes putSpySnapped and callSpySnapped', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0, 10);
    for (const row of rows) {
      if (!('error' in row)) {
        expect(row.putSpySnapped).toBeDefined();
        expect(row.callSpySnapped).toBeDefined();
      }
    }
  });

  it('SPY snapped values are multiples of $0.50', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0, 10);
    for (const row of rows) {
      if (!('error' in row)) {
        // Multiply by 2 and check integer (e.g. 580.0 → 1160, 580.5 → 1161)
        expect(Number.isInteger(row.putSpySnapped * 2)).toBe(true);
        expect(Number.isInteger(row.callSpySnapped * 2)).toBe(true);
      }
    }
  });

  it('SPY snapped values respect the ratio', () => {
    const ratio = 10.02;
    const rows = calcAllDeltas(spot, sigma, T, 0, ratio);
    for (const row of rows) {
      if (!('error' in row)) {
        // SPY snapped should be within $0.25 of raw SPY (half-dollar rounding)
        const rawPutSpy = row.putStrike / ratio;
        expect(Math.abs(row.putSpySnapped - rawPutSpy)).toBeLessThanOrEqual(
          0.25,
        );
      }
    }
  });
});

describe('calcScaledSkew', () => {
  it('returns 0 when skew is 0', () => {
    expect(calcScaledSkew(0, 1.645)).toBe(0);
    expect(calcScaledSkew(0, 0.842)).toBe(0);
  });

  it('at reference z (1.28), scaled skew equals input skew', () => {
    expect(calcScaledSkew(0.03, 1.28)).toBeCloseTo(0.03, 6);
  });

  it('higher z (further OTM) gets more skew', () => {
    const atRef = calcScaledSkew(0.03, 1.28); // 10Δ
    const further = calcScaledSkew(0.03, 1.645); // 5Δ
    expect(further).toBeGreaterThan(atRef);
  });

  it('lower z (closer to ATM) gets less skew', () => {
    const atRef = calcScaledSkew(0.03, 1.28); // 10Δ
    const closer = calcScaledSkew(0.03, 0.842); // 20Δ
    expect(closer).toBeLessThan(atRef);
  });

  it('5Δ skew is convex — more than linear extrapolation from reference', () => {
    // With convexity 1.35: (1.645/1.28)^1.35 ≈ 1.40 (vs 1.29 linear)
    const scaled = calcScaledSkew(0.03, 1.645);
    const linear = (0.03 * 1.645) / 1.28;
    expect(scaled).toBeGreaterThan(linear); // convex > linear
    expect(scaled).toBeCloseTo(0.03 * Math.pow(1.645 / 1.28, 1.35), 6);
  });

  it('20Δ skew is less than reference (convex curve)', () => {
    // With convexity 1.35: (0.842/1.28)^1.35 ≈ 0.57 (vs 0.66 linear)
    const scaled = calcScaledSkew(0.03, 0.842);
    const linear = (0.03 * 0.842) / 1.28;
    expect(scaled).toBeLessThan(linear); // convex compresses near-ATM
    expect(scaled).toBeCloseTo(0.03 * Math.pow(0.842 / 1.28, 1.35), 6);
  });

  it('scaling is convex (superlinear) with z', () => {
    const s1 = calcScaledSkew(0.05, 1);
    const s2 = calcScaledSkew(0.05, 2);
    // With convexity 1.35: ratio = (2/1)^1.35 = 2^1.35 ≈ 2.55
    expect(s2 / s1).toBeGreaterThan(2); // convex > linear
    expect(s2 / s1).toBeCloseTo(Math.pow(2, 1.35), 4);
  });

  it('returns 0 when z is NaN', () => {
    expect(calcScaledSkew(0.03, Number.NaN)).toBe(0);
  });

  it('returns 0 when z is Infinity', () => {
    expect(calcScaledSkew(0.03, Infinity)).toBe(0);
    expect(calcScaledSkew(0.03, -Infinity)).toBe(0);
  });
});

describe('calcStrikes: drift correction', () => {
  const spot = 6850;
  const sigma = 0.2;
  const T = calcTimeToExpiry(4);

  it('put strike with drift is slightly higher (closer to spot) than without', () => {
    // The drift term (σ²/2)T pushes puts closer to spot
    const result = calcStrikes(spot, sigma, T, 10, 0);
    if ('error' in result) throw new Error('unexpected');

    // Manual calculation without drift
    const z = 1.28;
    const sqrtT = Math.sqrt(T);
    const withoutDrift = Math.round(spot * Math.exp(-z * sigma * sqrtT));

    // With drift, put strike should be >= without drift (closer to spot)
    expect(result.putStrike).toBeGreaterThanOrEqual(withoutDrift);
  });

  it('call strike with drift is slightly lower (closer to spot) than without', () => {
    const result = calcStrikes(spot, sigma, T, 10, 0);
    if ('error' in result) throw new Error('unexpected');

    const z = 1.28;
    const sqrtT = Math.sqrt(T);
    const withoutDrift = Math.round(spot * Math.exp(z * sigma * sqrtT));

    // Drift correction brings call strike closer to spot (- sign)
    expect(result.callStrike).toBeLessThanOrEqual(withoutDrift);
  });
});

describe('calcAllDeltas: Greeks (actual delta & gamma)', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(4);
  const rows = calcAllDeltas(spot, sigma, T, 0.03, 10);
  const validRows = rows.filter((r): r is DeltaRow => !('error' in r));

  it('actual delta is close to target delta', () => {
    for (const r of validRows) {
      // Snapping shifts the strike, so actual delta won't match exactly
      // but should be within a few delta points
      expect(r.putActualDelta * 100).toBeGreaterThan(r.delta * 0.3);
      expect(r.putActualDelta * 100).toBeLessThan(r.delta * 3);
      expect(r.callActualDelta * 100).toBeGreaterThan(r.delta * 0.3);
      expect(r.callActualDelta * 100).toBeLessThan(r.delta * 3);
    }
  });

  it('all gammas are positive', () => {
    for (const r of validRows) {
      expect(r.putGamma).toBeGreaterThan(0);
      expect(r.callGamma).toBeGreaterThan(0);
    }
  });

  it('higher delta (closer to ATM) → higher gamma', () => {
    const d5 = validRows.find((r) => r.delta === 5)!;
    const d20 = validRows.find((r) => r.delta === 20)!;
    expect(d20.putGamma).toBeGreaterThan(d5.putGamma);
    expect(d20.callGamma).toBeGreaterThan(d5.callGamma);
  });

  it('put delta + call delta < 1 (both are OTM)', () => {
    for (const r of validRows) {
      expect(r.putActualDelta + r.callActualDelta).toBeLessThan(1);
    }
  });

  it('with skew, put and call deltas differ for same target delta', () => {
    for (const r of validRows) {
      // Skew makes put sigma higher and call sigma lower
      // so the actual deltas won't be exactly symmetric
      // Use 4 decimal places — at far OTM the difference is small but nonzero
      expect(r.putActualDelta).not.toBeCloseTo(r.callActualDelta, 4);
    }
  });

  it('all thetas are negative (time decay)', () => {
    for (const r of validRows) {
      expect(r.putTheta).toBeLessThan(0);
      expect(r.callTheta).toBeLessThan(0);
    }
  });

  it('higher delta (closer to ATM) → larger theta magnitude', () => {
    const d5 = validRows.find((r) => r.delta === 5)!;
    const d20 = validRows.find((r) => r.delta === 20)!;
    expect(Math.abs(d20.putTheta)).toBeGreaterThan(Math.abs(d5.putTheta));
    expect(Math.abs(d20.callTheta)).toBeGreaterThan(Math.abs(d5.callTheta));
  });

  it('less time → higher gamma at same strike', () => {
    const earlyRows = calcAllDeltas(spot, sigma, calcTimeToExpiry(5), 0, 10);
    const lateRows = calcAllDeltas(spot, sigma, calcTimeToExpiry(2), 0, 10);
    const early10 = earlyRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    const late10 = lateRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    if (early10 && late10) {
      // Note: strikes move closer with less time, so we compare gamma at the respective snapped strikes
      // Late gamma at its (closer) snapped strike should be higher
      expect(late10.putGamma).toBeGreaterThan(early10.putGamma);
    }
  });
});

describe('buildIronCondor', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);
  const rows = calcAllDeltas(spot, sigma, T, 0, 10);
  const deltaRow = rows.find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  );

  it('builds valid iron condor legs for 10 delta', () => {
    expect(deltaRow).toBeDefined();
    if (!deltaRow) return;

    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.delta).toBe(10);
    expect(ic.shortPut).toBe(deltaRow.putSnapped);
    expect(ic.shortCall).toBe(deltaRow.callSnapped);
    expect(ic.longPut).toBe(deltaRow.putSnapped - 25);
    expect(ic.longCall).toBe(deltaRow.callSnapped + 25);
  });

  it('long put < short put < short call < long call', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.longPut).toBeLessThan(ic.shortPut);
    expect(ic.shortPut).toBeLessThan(ic.shortCall);
    expect(ic.shortCall).toBeLessThan(ic.longCall);
  });

  it('max loss = wing width - credit', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 30, spot, T, 10);
    expect(ic.wingWidthSpx).toBe(30);
    expect(ic.maxLoss).toBeCloseTo(30 - ic.creditReceived, 6);
  });

  it('SPY legs are snapped to nearest $0.50', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(Number.isInteger(ic.shortPutSpy * 2)).toBe(true);
    expect(Number.isInteger(ic.longPutSpy * 2)).toBe(true);
    expect(Number.isInteger(ic.shortCallSpy * 2)).toBe(true);
    expect(Number.isInteger(ic.longCallSpy * 2)).toBe(true);
  });

  it('works with all wing widths', () => {
    if (!deltaRow) return;
    for (const w of [5, 10, 15, 20, 25, 30, 50]) {
      const ic = buildIronCondor(deltaRow, w, spot, T, 10);
      expect(ic.shortPut - ic.longPut).toBe(w);
      expect(ic.longCall - ic.shortCall).toBe(w);
    }
  });

  it('works across all deltas', () => {
    for (const row of rows) {
      if ('error' in row) continue;
      const ic = buildIronCondor(row, 25, spot, T, 10);
      expect(ic.longPut).toBeLessThan(ic.shortPut);
      expect(ic.shortCall).toBeLessThan(ic.longCall);
    }
  });

  it('credit received is positive', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.creditReceived).toBeGreaterThan(0);
  });

  it('max profit equals credit received', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.maxProfit).toBe(ic.creditReceived);
  });

  it('max loss is positive and less than wing width', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.maxLoss).toBeGreaterThan(0);
    expect(ic.maxLoss).toBeLessThan(25);
  });

  it('return on risk is between 0 and 1', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.returnOnRisk).toBeGreaterThan(0);
    expect(ic.returnOnRisk).toBeLessThan(1);
  });

  it('breakeven low < short put and breakeven high > short call', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.breakEvenLow).toBeLessThan(ic.shortPut);
    expect(ic.breakEvenHigh).toBeGreaterThan(ic.shortCall);
  });

  it('breakevens use per-side credit, not total IC credit', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    // breakEvenLow = shortPut - putSpreadCredit (NOT shortPut - totalCredit)
    expect(ic.breakEvenLow).toBeCloseTo(ic.shortPut - ic.putSpreadCredit, 8);
    // breakEvenHigh = shortCall + callSpreadCredit (NOT shortCall + totalCredit)
    expect(ic.breakEvenHigh).toBeCloseTo(ic.shortCall + ic.callSpreadCredit, 8);
    // The total credit is larger than each per-side credit,
    // so per-side breakevens are narrower (more conservative)
    expect(ic.breakEvenLow).toBeGreaterThan(ic.shortPut - ic.creditReceived);
    expect(ic.breakEvenHigh).toBeLessThan(ic.shortCall + ic.creditReceived);
  });

  it('wider wings = more credit but more risk', () => {
    if (!deltaRow) return;
    const narrow = buildIronCondor(deltaRow, 10, spot, T, 10);
    const wide = buildIronCondor(deltaRow, 50, spot, T, 10);
    expect(wide.creditReceived).toBeGreaterThan(narrow.creditReceived);
    expect(wide.maxLoss).toBeGreaterThan(narrow.maxLoss);
  });

  it('PoP is between 0 and 1', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(ic.probabilityOfProfit).toBeGreaterThan(0);
    expect(ic.probabilityOfProfit).toBeLessThan(1);
  });

  it('lower delta IC has higher PoP (wider profit zone)', () => {
    const d5 = rows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 5,
    );
    const d20 = rows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 20,
    );
    if (!d5 || !d20) return;
    const ic5 = buildIronCondor(d5, 25, spot, T, 10);
    const ic20 = buildIronCondor(d20, 25, spot, T, 10);
    expect(ic5.probabilityOfProfit).toBeGreaterThan(ic20.probabilityOfProfit);
  });
});

describe('buildIronCondor: PoP uses base sigma (not accelerated)', () => {
  // At 2h remaining, IV accel is ~1.12x. PoP should use base σ,
  // which gives a higher PoP than using the accelerated σ.
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(2); // significant acceleration at 2h
  const rows = calcAllDeltas(spot, sigma, T, 0, 10);
  const d10 = rows.find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  );

  it('base sigma is lower than accelerated sigma at 2h remaining', () => {
    if (!d10) return;
    expect(d10.basePutSigma).toBeLessThan(d10.putSigma);
    expect(d10.baseCallSigma).toBeLessThan(d10.callSigma);
  });

  it('IC PoP with base sigma is higher than with accelerated sigma', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    // Manually compute PoP with accelerated sigma for comparison
    const accelPoP = calcPoP(
      spot,
      ic.breakEvenLow,
      ic.breakEvenHigh,
      d10.putSigma,
      d10.callSigma,
      T,
    );
    // IC PoP should use base sigma → higher PoP
    expect(ic.probabilityOfProfit).toBeGreaterThan(accelPoP);
  });

  it('at market open (no acceleration), base and accel sigma are equal', () => {
    const openT = calcTimeToExpiry(6.5);
    const openRows = calcAllDeltas(spot, sigma, openT, 0, 10);
    const open10 = openRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    if (!open10) return;
    expect(open10.basePutSigma).toBeCloseTo(open10.putSigma, 10);
    expect(open10.baseCallSigma).toBeCloseTo(open10.callSigma, 10);
  });
});

describe('calcPoP', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);

  it('wide breakevens → high PoP', () => {
    const pop = calcPoP(spot, 5500, 6100, sigma, sigma, T);
    expect(pop).toBeGreaterThan(0.95);
  });

  it('narrow breakevens → lower PoP', () => {
    const pop = calcPoP(spot, 5790, 5810, sigma, sigma, T);
    expect(pop).toBeLessThan(0.5);
  });

  it('symmetric breakevens with no skew → PoP close to symmetric', () => {
    const pop = calcPoP(spot, 5700, 5900, sigma, sigma, T);
    // Just verify it's reasonable
    expect(pop).toBeGreaterThan(0.5);
    expect(pop).toBeLessThan(1);
  });

  it('higher skew on puts shifts PoP', () => {
    const noSkew = calcPoP(spot, 5700, 5900, sigma, sigma, T);
    const withSkew = calcPoP(spot, 5700, 5900, sigma * 1.05, sigma * 0.95, T);
    // Should be different (skew changes the probability distribution)
    expect(Math.abs(noSkew - withSkew)).toBeGreaterThan(0);
  });

  it('returns 0 for T=0', () => {
    expect(calcPoP(spot, 5700, 5900, sigma, sigma, 0)).toBe(0);
  });

  it('returns 0 for σ=0', () => {
    expect(calcPoP(spot, 5700, 5900, 0, 0, T)).toBe(0);
  });

  it('spot === beLow → PoP well below 1 (not degenerate)', () => {
    const pop = calcPoP(spot, spot, 6100, sigma, sigma, T);
    // When spot is right at the lower breakeven, roughly 50% chance of finishing above
    expect(pop).toBeGreaterThan(0.3);
    expect(pop).toBeLessThan(0.7);
  });

  it('spot === beHigh → PoP well below 1 (not degenerate)', () => {
    const pop = calcPoP(spot, 5500, spot, sigma, sigma, T);
    expect(pop).toBeGreaterThan(0.3);
    expect(pop).toBeLessThan(0.7);
  });

  it('spot === both breakevens → PoP near 0', () => {
    const pop = calcPoP(spot, spot, spot, sigma, sigma, T);
    // Both breakevens at spot = zero-width range, ~0% chance
    expect(pop).toBeLessThan(0.05);
  });

  it('very small T (near expiry) with wide breakevens → high PoP', () => {
    const tinyT = calcTimeToExpiry(0.1); // 6 minutes left
    const pop = calcPoP(spot, 5500, 6100, sigma, sigma, tinyT);
    expect(pop).toBeGreaterThan(0.99);
  });

  it('returns value in [0, 1] for extreme sigma', () => {
    const pop = calcPoP(spot, 5700, 5900, 2.0, 2.0, T);
    expect(pop).toBeGreaterThanOrEqual(0);
    expect(pop).toBeLessThanOrEqual(1);
  });
});

describe('calcSpreadPoP', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);

  it('put spread PoP: far OTM → high PoP', () => {
    const pop = calcSpreadPoP(spot, 5500, sigma, T, 'put');
    expect(pop).toBeGreaterThan(0.95);
  });

  it('call spread PoP: far OTM → high PoP', () => {
    const pop = calcSpreadPoP(spot, 6100, sigma, T, 'call');
    expect(pop).toBeGreaterThan(0.95);
  });

  it('ATM spread → ~50% PoP', () => {
    const pop = calcSpreadPoP(spot, spot, sigma, T, 'put');
    expect(pop).toBeGreaterThan(0.4);
    expect(pop).toBeLessThan(0.6);
  });

  it('returns 0 for T=0', () => {
    expect(calcSpreadPoP(spot, 5700, sigma, 0, 'put')).toBe(0);
  });

  it('returns 0 for σ=0', () => {
    expect(calcSpreadPoP(spot, 5700, 0, T, 'put')).toBe(0);
  });

  it('put spread PoP > call spread PoP for same distance when skew applied', () => {
    // With put skew, the put-side distribution is fatter-tailed
    const putPop = calcSpreadPoP(spot, spot - 100, sigma * 1.03, T, 'put');
    const callPop = calcSpreadPoP(spot, spot + 100, sigma * 0.97, T, 'call');
    // Call side has lower IV → higher PoP for same distance
    expect(callPop).toBeGreaterThan(putPop);
  });
});

describe('buildIronCondor: per-side breakdown', () => {
  const spot = 5800;
  const sigma = 0.2;
  const T = calcTimeToExpiry(3);
  const rows = calcAllDeltas(spot, sigma, T, 0.03, 10);
  const d10 = rows.find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  );

  it('put spread + call spread credits = total IC credit', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadCredit + ic.callSpreadCredit).toBeCloseTo(
      ic.creditReceived,
      8,
    );
  });

  it('put and call spread credits differ when skew is applied', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    // With 3% skew, the two sides should not be equal
    expect(Math.abs(ic.putSpreadCredit - ic.callSpreadCredit)).toBeGreaterThan(
      0,
    );
  });

  it('individual spread max losses are positive and < wing width', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadMaxLoss).toBeGreaterThan(0);
    expect(ic.putSpreadMaxLoss).toBeLessThan(25);
    expect(ic.callSpreadMaxLoss).toBeGreaterThan(0);
    expect(ic.callSpreadMaxLoss).toBeLessThan(25);
  });

  it('spread BEs are between long and short strikes', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadBE).toBeGreaterThan(ic.longPut);
    expect(ic.putSpreadBE).toBeLessThan(ic.shortPut);
    expect(ic.callSpreadBE).toBeGreaterThan(ic.shortCall);
    expect(ic.callSpreadBE).toBeLessThan(ic.longCall);
  });

  it('individual spread PoPs > IC PoP (single tail vs double)', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadPoP).toBeGreaterThan(ic.probabilityOfProfit);
    expect(ic.callSpreadPoP).toBeGreaterThan(ic.probabilityOfProfit);
  });

  it('spread RoRs are positive', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadRoR).toBeGreaterThan(0);
    expect(ic.callSpreadRoR).toBeGreaterThan(0);
  });

  it('put and call spread RoRs differ when skew is applied', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(Math.abs(ic.putSpreadRoR - ic.callSpreadRoR)).toBeGreaterThan(0);
  });
});
