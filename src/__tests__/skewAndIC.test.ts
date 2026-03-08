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
} from '../utils/calculator';
import type { DeltaRow } from '../types';

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

  it('SPY snapped values are integers (nearest $1)', () => {
    const rows = calcAllDeltas(spot, sigma, T, 0, 10);
    for (const row of rows) {
      if (!('error' in row)) {
        expect(Number.isInteger(row.putSpySnapped)).toBe(true);
        expect(Number.isInteger(row.callSpySnapped)).toBe(true);
      }
    }
  });

  it('SPY snapped values respect the ratio', () => {
    const ratio = 10.02;
    const rows = calcAllDeltas(spot, sigma, T, 0, ratio);
    for (const row of rows) {
      if (!('error' in row)) {
        // SPY snapped should be within $1 of raw SPY
        const rawPutSpy = row.putStrike / ratio;
        expect(Math.abs(row.putSpySnapped - rawPutSpy)).toBeLessThanOrEqual(0.5);
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
    const atRef = calcScaledSkew(0.03, 1.28);    // 10Δ
    const further = calcScaledSkew(0.03, 1.645);  // 5Δ
    expect(further).toBeGreaterThan(atRef);
  });

  it('lower z (closer to ATM) gets less skew', () => {
    const atRef = calcScaledSkew(0.03, 1.28);   // 10Δ
    const closer = calcScaledSkew(0.03, 0.842);  // 20Δ
    expect(closer).toBeLessThan(atRef);
  });

  it('5Δ skew is about 29% more than reference', () => {
    // 1.645 / 1.28 = 1.285
    const scaled = calcScaledSkew(0.03, 1.645);
    expect(scaled).toBeCloseTo(0.03 * 1.645 / 1.28, 6);
  });

  it('20Δ skew is about 34% less than reference', () => {
    // 0.842 / 1.28 = 0.658
    const scaled = calcScaledSkew(0.03, 0.842);
    expect(scaled).toBeCloseTo(0.03 * 0.842 / 1.28, 6);
  });

  it('scaling is proportional to z', () => {
    const s1 = calcScaledSkew(0.05, 1);
    const s2 = calcScaledSkew(0.05, 2);
    expect(s2 / s1).toBeCloseTo(2, 6);
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

  it('call strike with drift is slightly higher than without', () => {
    const result = calcStrikes(spot, sigma, T, 10, 0);
    if ('error' in result) throw new Error('unexpected');

    const z = 1.28;
    const sqrtT = Math.sqrt(T);
    const withoutDrift = Math.round(spot * Math.exp(z * sigma * sqrtT));

    expect(result.callStrike).toBeGreaterThanOrEqual(withoutDrift);
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

  it('less time → higher gamma at same strike', () => {
    const earlyRows = calcAllDeltas(spot, sigma, calcTimeToExpiry(5), 0, 10);
    const lateRows = calcAllDeltas(spot, sigma, calcTimeToExpiry(2), 0, 10);
    const early10 = earlyRows.find((r): r is DeltaRow => !('error' in r) && r.delta === 10);
    const late10 = lateRows.find((r): r is DeltaRow => !('error' in r) && r.delta === 10);
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
  const deltaRow = rows.find((r): r is DeltaRow => !('error' in r) && r.delta === 10);

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

  it('SPY legs are snapped to nearest $1', () => {
    if (!deltaRow) return;
    const ic = buildIronCondor(deltaRow, 25, spot, T, 10);
    expect(Number.isInteger(ic.shortPutSpy)).toBe(true);
    expect(Number.isInteger(ic.longPutSpy)).toBe(true);
    expect(Number.isInteger(ic.shortCallSpy)).toBe(true);
    expect(Number.isInteger(ic.longCallSpy)).toBe(true);
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
    const d5 = rows.find((r): r is DeltaRow => !('error' in r) && r.delta === 5);
    const d20 = rows.find((r): r is DeltaRow => !('error' in r) && r.delta === 20);
    if (!d5 || !d20) return;
    const ic5 = buildIronCondor(d5, 25, spot, T, 10);
    const ic20 = buildIronCondor(d20, 25, spot, T, 10);
    expect(ic5.probabilityOfProfit).toBeGreaterThan(ic20.probabilityOfProfit);
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
  const d10 = rows.find((r): r is DeltaRow => !('error' in r) && r.delta === 10);

  it('put spread + call spread credits = total IC credit', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    expect(ic.putSpreadCredit + ic.callSpreadCredit).toBeCloseTo(ic.creditReceived, 8);
  });

  it('put and call spread credits differ when skew is applied', () => {
    if (!d10) return;
    const ic = buildIronCondor(d10, 25, spot, T, 10);
    // With 3% skew, the two sides should not be equal
    expect(Math.abs(ic.putSpreadCredit - ic.callSpreadCredit)).toBeGreaterThan(0);
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
