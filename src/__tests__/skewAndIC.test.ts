import { describe, it, expect } from 'vitest';
import {
  calcStrikes,
  calcTimeToExpiry,
  calcAllDeltas,
  buildIronCondor,
  calcPoP,
  isStrikeError,
} from '../calculator';
import type { DeltaRow } from '../types';

describe('Skew: put IV adjustment', () => {
  const spot = 5800;
  const sigma = 0.20;
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
  const sigma = 0.20;
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

describe('buildIronCondor', () => {
  const spot = 5800;
  const sigma = 0.20;
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
  const sigma = 0.20;
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
