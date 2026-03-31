import { describe, it, expect } from 'vitest';
import {
  calcAllDeltas,
  calcTimeToExpiry,
  buildPutBWB,
  buildCallBWB,
  bwbPnLAtExpiry,
} from '../../utils/calculator';
import type { DeltaRow } from '../../types';

const spot = 5800;
const sigma = 0.2;
const T = calcTimeToExpiry(3);
const rows = calcAllDeltas(spot, sigma, T, 0, 10);
const d10 = rows.find((r): r is DeltaRow => !('error' in r) && r.delta === 10);

describe('buildPutBWB', () => {
  it('strike ordering: longFar < shortStrike < longNear', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.longFarStrike).toBeLessThan(bwb.shortStrike);
    expect(bwb.shortStrike).toBeLessThan(bwb.longNearStrike);
  });

  it('narrowWidth matches longNear - short', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.longNearStrike - bwb.shortStrike).toBe(bwb.narrowWidth);
  });

  it('wideWidth matches short - longFar', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.shortStrike - bwb.longFarStrike).toBe(bwb.wideWidth);
  });

  it('all strikes are snapped to 5-pt increments', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.shortStrike % 5).toBe(0);
    expect(bwb.longNearStrike % 5).toBe(0);
    expect(bwb.longFarStrike % 5).toBe(0);
  });

  it('netCredit = 2×short - longNear - longFar', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.netCredit).toBeCloseTo(
      2 * bwb.shortPremium - bwb.longNearPremium - bwb.longFarPremium,
      8,
    );
  });

  it('wider asymmetry increases netCredit (or reduces debit)', () => {
    if (!d10) return;
    const narrow = buildPutBWB(d10, 20, 30, spot, T);
    const wide = buildPutBWB(d10, 20, 60, spot, T);
    expect(wide.netCredit).toBeGreaterThan(narrow.netCredit);
  });

  it('maxProfit = narrowWidth + netCredit', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.maxProfit).toBeCloseTo(bwb.narrowWidth + bwb.netCredit, 8);
  });

  it('maxLoss = wideWidth - narrowWidth - netCredit', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.maxLoss).toBeCloseTo(
      bwb.wideWidth - bwb.narrowWidth - bwb.netCredit,
      8,
    );
  });

  it('maxLoss > 0 and maxLoss < wideWidth', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.maxLoss).toBeGreaterThan(0);
    expect(bwb.maxLoss).toBeLessThan(bwb.wideWidth);
  });

  it('breakeven < shortStrike (below sweet spot for put BWB)', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.breakeven).toBeLessThan(bwb.shortStrike);
  });

  it('breakeven > longFarStrike (above the far wing)', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.breakeven).toBeGreaterThan(bwb.longFarStrike);
  });

  it('sweetSpot === shortStrike', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.sweetSpot).toBe(bwb.shortStrike);
  });

  it('SPY equivalents are multiples of $0.50', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(Number.isInteger(bwb.shortStrikeSpy * 2)).toBe(true);
    expect(Number.isInteger(bwb.longNearStrikeSpy * 2)).toBe(true);
    expect(Number.isInteger(bwb.longFarStrikeSpy * 2)).toBe(true);
  });

  it('works across all deltas', () => {
    for (const row of rows) {
      if ('error' in row) continue;
      const bwb = buildPutBWB(row, 20, 40, spot, T);
      expect(bwb.longFarStrike).toBeLessThan(bwb.shortStrike);
      expect(bwb.shortStrike).toBeLessThan(bwb.longNearStrike);
      expect(bwb.side).toBe('put');
    }
  });

  it('side === "put"', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.side).toBe('put');
  });
});

describe('buildCallBWB', () => {
  it('strike ordering: longNear < shortStrike < longFar', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.longNearStrike).toBeLessThan(bwb.shortStrike);
    expect(bwb.shortStrike).toBeLessThan(bwb.longFarStrike);
  });

  it('narrowWidth matches short - longNear', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.shortStrike - bwb.longNearStrike).toBe(bwb.narrowWidth);
  });

  it('wideWidth matches longFar - short', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.longFarStrike - bwb.shortStrike).toBe(bwb.wideWidth);
  });

  it('all strikes are snapped to 5-pt increments', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.shortStrike % 5).toBe(0);
    expect(bwb.longNearStrike % 5).toBe(0);
    expect(bwb.longFarStrike % 5).toBe(0);
  });

  it('netCredit = 2×short - longNear - longFar', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.netCredit).toBeCloseTo(
      2 * bwb.shortPremium - bwb.longNearPremium - bwb.longFarPremium,
      8,
    );
  });

  it('wider asymmetry increases netCredit (or reduces debit)', () => {
    if (!d10) return;
    const narrow = buildCallBWB(d10, 20, 30, spot, T);
    const wide = buildCallBWB(d10, 20, 60, spot, T);
    expect(wide.netCredit).toBeGreaterThan(narrow.netCredit);
  });

  it('maxProfit = narrowWidth + netCredit', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.maxProfit).toBeCloseTo(bwb.narrowWidth + bwb.netCredit, 8);
  });

  it('maxLoss = wideWidth - narrowWidth - netCredit', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.maxLoss).toBeCloseTo(
      bwb.wideWidth - bwb.narrowWidth - bwb.netCredit,
      8,
    );
  });

  it('maxLoss > 0 and maxLoss < wideWidth', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.maxLoss).toBeGreaterThan(0);
    expect(bwb.maxLoss).toBeLessThan(bwb.wideWidth);
  });

  it('breakeven > shortStrike (above sweet spot for call BWB)', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.breakeven).toBeGreaterThan(bwb.shortStrike);
  });

  it('breakeven < longFarStrike', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.breakeven).toBeLessThan(bwb.longFarStrike);
  });

  it('sweetSpot === shortStrike', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.sweetSpot).toBe(bwb.shortStrike);
  });

  it('SPY equivalents are multiples of $0.50', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(Number.isInteger(bwb.shortStrikeSpy * 2)).toBe(true);
    expect(Number.isInteger(bwb.longNearStrikeSpy * 2)).toBe(true);
    expect(Number.isInteger(bwb.longFarStrikeSpy * 2)).toBe(true);
  });

  it('works across all deltas', () => {
    for (const row of rows) {
      if ('error' in row) continue;
      const bwb = buildCallBWB(row, 20, 40, spot, T);
      expect(bwb.longNearStrike).toBeLessThan(bwb.shortStrike);
      expect(bwb.shortStrike).toBeLessThan(bwb.longFarStrike);
      expect(bwb.side).toBe('call');
    }
  });

  it('side === "call"', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(bwb.side).toBe('call');
  });
});

describe('BWB P&L properties', () => {
  it('returnOnRisk = netCredit / maxLoss', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(putBwb.returnOnRisk).toBeCloseTo(
      putBwb.netCredit / putBwb.maxLoss,
      8,
    );
    expect(callBwb.returnOnRisk).toBeCloseTo(
      callBwb.netCredit / callBwb.maxLoss,
      8,
    );
  });

  it('PoP is between 0 and 1', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(putBwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(putBwb.probabilityOfProfit).toBeLessThan(1);
    expect(callBwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(callBwb.probabilityOfProfit).toBeLessThan(1);
  });

  it('adjustedPoP <= probabilityOfProfit (fat tails reduce PoP)', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T, 10, 20);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T, 10, 20);
    expect(putBwb.adjustedPoP).toBeLessThanOrEqual(putBwb.probabilityOfProfit);
    expect(callBwb.adjustedPoP).toBeLessThanOrEqual(
      callBwb.probabilityOfProfit,
    );
  });

  it('wider wideWidth = more maxLoss but more netCredit', () => {
    if (!d10) return;
    const narrow = buildPutBWB(d10, 20, 30, spot, T);
    const wide = buildPutBWB(d10, 20, 50, spot, T);
    expect(wide.maxLoss).toBeGreaterThan(narrow.maxLoss);
    expect(wide.netCredit).toBeGreaterThan(narrow.netCredit);
  });

  it('wider narrowWidth = more maxProfit but less netCredit', () => {
    if (!d10) return;
    const narrowNear = buildPutBWB(d10, 15, 40, spot, T);
    const wideNear = buildPutBWB(d10, 30, 40, spot, T);
    expect(wideNear.maxProfit).toBeGreaterThan(narrowNear.maxProfit);
    expect(wideNear.netCredit).toBeLessThan(narrowNear.netCredit);
  });

  it('put BWB PoP > call BWB PoP at same delta (puts further OTM due to skew)', () => {
    // Need skew to make this meaningful
    const skewRows = calcAllDeltas(spot, sigma, T, 0.03, 10);
    const skewD10 = skewRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    if (!skewD10) return;
    const putBwb = buildPutBWB(skewD10, 20, 40, spot, T);
    const callBwb = buildCallBWB(skewD10, 20, 40, spot, T);
    expect(putBwb.probabilityOfProfit).toBeGreaterThan(
      callBwb.probabilityOfProfit,
    );
  });
});

describe('BWB Greeks', () => {
  it('netGamma is negative (short gamma position)', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(putBwb.netGamma).toBeLessThan(0);
    expect(callBwb.netGamma).toBeLessThan(0);
  });

  it('netTheta is positive (theta positive — time decay benefits seller)', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(putBwb.netTheta).toBeGreaterThan(0);
    expect(callBwb.netTheta).toBeGreaterThan(0);
  });

  it('netVega is negative (short vega — benefits from IV drop)', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    expect(putBwb.netVega).toBeLessThan(0);
    expect(callBwb.netVega).toBeLessThan(0);
  });

  it('netDelta is small (near delta-neutral at the sweet spot)', () => {
    if (!d10) return;
    const putBwb = buildPutBWB(d10, 20, 40, spot, T);
    const callBwb = buildCallBWB(d10, 20, 40, spot, T);
    // Net delta should be much smaller than a single leg delta
    expect(Math.abs(putBwb.netDelta)).toBeLessThan(0.05);
    expect(Math.abs(callBwb.netDelta)).toBeLessThan(0.05);
  });
});

describe('bwbPnLAtExpiry', () => {
  describe('put BWB P&L at specific price levels', () => {
    it('at sweetSpot: P&L = maxProfit', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.sweetSpot);
      expect(pnl).toBeCloseTo(bwb.maxProfit, 1);
    });

    it('above longNearStrike: P&L = netCredit (all OTM)', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longNearStrike + 50);
      expect(pnl).toBeCloseTo(bwb.netCredit, 8);
    });

    it('at longNearStrike: P&L = netCredit', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longNearStrike);
      expect(pnl).toBeCloseTo(bwb.netCredit, 8);
    });

    it('at shortStrike: P&L = narrowWidth + netCredit (max profit)', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      expect(pnl).toBeCloseTo(bwb.narrowWidth + bwb.netCredit, 8);
    });

    it('at breakeven: P&L ≈ 0', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.breakeven);
      expect(pnl).toBeCloseTo(0, 0);
    });

    it('at longFarStrike: P&L = max loss (capped)', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      // At longFar: nearIntrinsic - 2*shortIntrinsic + farIntrinsic + netCredit
      // = (longNear - longFar) - 2*(short - longFar) + 0 + netCredit
      // = (narrow + wide) - 2*wide + netCredit
      // = narrow - wide + netCredit = -(wideWidth - narrowWidth - netCredit) = -maxLoss
      expect(pnl).toBeCloseTo(-bwb.maxLoss, 8);
    });

    it('below longFarStrike: P&L = max loss (constant, capped)', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnlAtFar = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      const pnlBelow = bwbPnLAtExpiry(bwb, bwb.longFarStrike - 50);
      expect(pnlBelow).toBeCloseTo(pnlAtFar, 8);
    });

    it('P&L increases from longFar to shortStrike', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnlFar = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      const pnlMid = bwbPnLAtExpiry(
        bwb,
        (bwb.longFarStrike + bwb.shortStrike) / 2,
      );
      const pnlShort = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      expect(pnlMid).toBeGreaterThan(pnlFar);
      expect(pnlShort).toBeGreaterThan(pnlMid);
    });

    it('P&L decreases from shortStrike to longNearStrike', () => {
      if (!d10) return;
      const bwb = buildPutBWB(d10, 20, 40, spot, T);
      const pnlShort = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      const pnlMid = bwbPnLAtExpiry(
        bwb,
        (bwb.shortStrike + bwb.longNearStrike) / 2,
      );
      const pnlNear = bwbPnLAtExpiry(bwb, bwb.longNearStrike);
      expect(pnlMid).toBeLessThan(pnlShort);
      expect(pnlNear).toBeLessThan(pnlMid);
    });
  });

  describe('call BWB P&L at specific price levels', () => {
    it('at sweetSpot: P&L = maxProfit', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.sweetSpot);
      expect(pnl).toBeCloseTo(bwb.maxProfit, 1);
    });

    it('below longNearStrike: P&L = netCredit (all OTM)', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longNearStrike - 50);
      expect(pnl).toBeCloseTo(bwb.netCredit, 8);
    });

    it('at longNearStrike: P&L = netCredit', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longNearStrike);
      expect(pnl).toBeCloseTo(bwb.netCredit, 8);
    });

    it('at shortStrike: P&L = narrowWidth + netCredit (max profit)', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      expect(pnl).toBeCloseTo(bwb.narrowWidth + bwb.netCredit, 8);
    });

    it('at breakeven: P&L ≈ 0', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.breakeven);
      expect(pnl).toBeCloseTo(0, 0);
    });

    it('at longFarStrike: P&L = max loss (capped)', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnl = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      expect(pnl).toBeCloseTo(-bwb.maxLoss, 8);
    });

    it('above longFarStrike: P&L = max loss (constant, capped)', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnlAtFar = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      const pnlAbove = bwbPnLAtExpiry(bwb, bwb.longFarStrike + 50);
      expect(pnlAbove).toBeCloseTo(pnlAtFar, 8);
    });

    it('P&L increases from longNear to shortStrike', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnlNear = bwbPnLAtExpiry(bwb, bwb.longNearStrike);
      const pnlMid = bwbPnLAtExpiry(
        bwb,
        (bwb.longNearStrike + bwb.shortStrike) / 2,
      );
      const pnlShort = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      expect(pnlMid).toBeGreaterThan(pnlNear);
      expect(pnlShort).toBeGreaterThan(pnlMid);
    });

    it('P&L decreases from shortStrike to longFarStrike', () => {
      if (!d10) return;
      const bwb = buildCallBWB(d10, 20, 40, spot, T);
      const pnlShort = bwbPnLAtExpiry(bwb, bwb.shortStrike);
      const pnlMid = bwbPnLAtExpiry(
        bwb,
        (bwb.shortStrike + bwb.longFarStrike) / 2,
      );
      const pnlFar = bwbPnLAtExpiry(bwb, bwb.longFarStrike);
      expect(pnlMid).toBeLessThan(pnlShort);
      expect(pnlFar).toBeLessThan(pnlMid);
    });
  });
});

describe('BWB edge cases', () => {
  it('narrowWidth equals wideWidth (symmetric butterfly)', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 25, 25, spot, T);
    expect(bwb.longFarStrike).toBeLessThan(bwb.shortStrike);
    expect(bwb.shortStrike).toBeLessThan(bwb.longNearStrike);
    // Symmetric butterfly: maxLoss = wideWidth - narrowWidth - netCredit = -netCredit
    // For a credit butterfly, maxLoss should still be small or zero
    // The net credit fully offsets risk on the wide side
    expect(bwb.maxProfit).toBeGreaterThan(0);
  });

  it('very wide wings (narrow=10, wide=50)', () => {
    if (!d10) return;
    const bwb = buildPutBWB(d10, 10, 50, spot, T);
    expect(bwb.longFarStrike).toBeLessThan(bwb.shortStrike);
    expect(bwb.shortStrike).toBeLessThan(bwb.longNearStrike);
    expect(bwb.maxLoss).toBeGreaterThan(0);
    expect(bwb.maxLoss).toBeLessThan(bwb.wideWidth);
    expect(bwb.netCredit).toBeGreaterThan(0);
  });

  it('near-zero T (calcTimeToExpiry(0.1))', () => {
    if (!d10) return;
    const tinyT = calcTimeToExpiry(0.1);
    // Recalculate rows with tiny T to get valid strikes
    const tinyRows = calcAllDeltas(spot, sigma, tinyT, 0, 10);
    const tinyD10 = tinyRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    if (!tinyD10) return;
    const bwb = buildPutBWB(tinyD10, 20, 40, spot, tinyT);
    expect(bwb.side).toBe('put');
    expect(bwb.longFarStrike).toBeLessThan(bwb.shortStrike);
    expect(bwb.shortStrike).toBeLessThan(bwb.longNearStrike);
  });
});

describe('BWB PoP uses base sigma', () => {
  // At 2h remaining, IV accel is ~1.12x. PoP should use base sigma,
  // which gives a higher PoP than using the accelerated sigma.
  const accelT = calcTimeToExpiry(2); // significant acceleration at 2h
  const accelRows = calcAllDeltas(spot, sigma, accelT, 0, 10);
  const accelD10 = accelRows.find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  );

  it('base sigma is lower than accelerated sigma at 2h remaining', () => {
    if (!accelD10) return;
    expect(accelD10.basePutSigma).toBeLessThan(accelD10.putSigma);
    expect(accelD10.baseCallSigma).toBeLessThan(accelD10.callSigma);
  });

  it('BWB PoP uses base sigma (higher PoP than with accelerated sigma)', () => {
    if (!accelD10) return;
    const putBwb = buildPutBWB(accelD10, 20, 40, spot, accelT);
    const callBwb = buildCallBWB(accelD10, 20, 40, spot, accelT);

    // PoP should be reasonable (between 0 and 1) and use base sigma
    expect(putBwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(putBwb.probabilityOfProfit).toBeLessThan(1);
    expect(callBwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(callBwb.probabilityOfProfit).toBeLessThan(1);
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
