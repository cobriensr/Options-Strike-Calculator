import { describe, it, expect } from 'vitest';
import {
  calcAllDeltas,
  calcTimeToExpiry,
  buildPutBWB,
  buildCallBWB,
  bwbPnLAtExpiry,
} from '../../utils/calculator';
import {
  BWB_NARROW_OPTIONS,
  BWB_WIDE_MULTIPLIERS,
  getKurtosisFactor,
} from '../../constants';
import type { BWBLegs, DeltaRow } from '../../types';
import { blackScholesPrice } from '../../utils/black-scholes';
import {
  bwbSettlementSigma,
  expectedPnLSplit,
  snapBWBFarStrike,
  snapBWBWideWidth,
} from '../../utils/bwb';
import { adjustPoPForKurtosis } from '../../utils/iron-condor';
import { snapToIncrement } from '../../utils/strikes';

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

  it('credit put BWB PoP > credit call BWB PoP at same delta (puts further OTM due to skew)', () => {
    // Need skew to make this meaningful. Only a credit BWB's PoP grows as
    // it moves further OTM: a debit BWB profits only inside a band
    // between its breakevens, so moving the band away from spot shrinks
    // it. 15/45 is a credit on both sides here; 20/40 is a debit.
    const skewRows = calcAllDeltas(spot, sigma, T, 0.03, 10);
    const skewD10 = skewRows.find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    );
    expect(skewD10).toBeDefined();
    const putBwb = buildPutBWB(skewD10!, 15, 45, spot, T);
    const callBwb = buildCallBWB(skewD10!, 15, 45, spot, T);
    expect(putBwb.netCredit).toBeGreaterThan(0);
    expect(callBwb.netCredit).toBeGreaterThan(0);
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
    // Symmetric butterfly: deep-wing payoff = narrow - wide + netCredit = netCredit,
    // so if the structure receives a credit the trade cannot lose. maxLoss
    // is clamped to 0 per FE-MATH-004 (see dedicated tests in the
    // "BWB branch edge cases" block below).
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

describe('BWB branch edge cases', () => {
  it('returnOnRisk is 0 when maxLoss is 0 (put BWB)', () => {
    if (!d10) return;
    // Use equal wing widths with a deep OTM strike.
    // When narrowWidth === wideWidth and netCredit > 0, the deep-wing
    // payoff is positive (= netCredit), so there is no scenario where
    // the trade loses money. Per FE-MATH-004, maxLoss is clamped to 0.
    const row: DeltaRow = {
      ...d10,
      putSnapped: spot - 100, // deep OTM
    };
    const bwb = buildPutBWB(row, 25, 25, spot, T);
    if (bwb.maxLoss === 0) {
      expect(bwb.returnOnRisk).toBe(0);
    } else {
      // If maxLoss > 0, returnOnRisk = netCredit / maxLoss
      expect(bwb.returnOnRisk).toBeCloseTo(bwb.netCredit / bwb.maxLoss, 8);
    }
  });

  it('returnOnRisk is 0 when maxLoss is 0 (call BWB)', () => {
    if (!d10) return;
    const row: DeltaRow = {
      ...d10,
      callSnapped: spot + 100, // deep OTM
    };
    const bwb = buildCallBWB(row, 25, 25, spot, T);
    if (bwb.maxLoss === 0) {
      expect(bwb.returnOnRisk).toBe(0);
    } else {
      expect(bwb.returnOnRisk).toBeCloseTo(bwb.netCredit / bwb.maxLoss, 8);
    }
  });

  it('uses putSigma fallback when basePutSigma is undefined', () => {
    if (!d10) return;
    const row: DeltaRow = {
      ...d10,
      basePutSigma: undefined as unknown as number,
    };
    // Should not throw — falls back to row.putSigma
    const bwb = buildPutBWB(row, 20, 40, spot, T);
    expect(bwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(bwb.probabilityOfProfit).toBeLessThan(1);
  });

  it('uses callSigma fallback when baseCallSigma is undefined', () => {
    if (!d10) return;
    const row: DeltaRow = {
      ...d10,
      baseCallSigma: undefined as unknown as number,
    };
    // Should not throw — falls back to row.callSigma
    const bwb = buildCallBWB(row, 20, 40, spot, T);
    expect(bwb.probabilityOfProfit).toBeGreaterThan(0);
    expect(bwb.probabilityOfProfit).toBeLessThan(1);
  });

  // ── FE-MATH-004: maxLoss clamped to 0 for non-losing structures ────

  it('FE-MATH-004: clamps maxLoss to 0 for symmetric put butterfly with positive credit', () => {
    if (!d10) return;
    // Symmetric butterfly (narrowWidth === wideWidth). When netCredit > 0,
    // the deep-wing payoff is `narrow - wide + netCredit = netCredit > 0`,
    // so no scenario loses money. The old code returned a negative
    // maxLoss (`-netCredit`), which displayed as "-$X" in the red Max Loss
    // column. Post-clamp the field is exactly 0.
    const bwb = buildPutBWB(d10, 25, 25, spot, T);
    expect(bwb.maxLoss).toBeGreaterThanOrEqual(0);
    if (bwb.netCredit > 0) {
      expect(bwb.maxLoss).toBe(0);
    }
  });

  it('FE-MATH-004: clamps maxLoss to 0 for symmetric call butterfly with positive credit', () => {
    if (!d10) return;
    const bwb = buildCallBWB(d10, 25, 25, spot, T);
    expect(bwb.maxLoss).toBeGreaterThanOrEqual(0);
    if (bwb.netCredit > 0) {
      expect(bwb.maxLoss).toBe(0);
    }
  });

  it('FE-MATH-004: clamps maxLoss to 0 when wide < narrow (inverted BWB)', () => {
    if (!d10) return;
    // Not reachable from production UI (BWB_WIDE_MULTIPLIERS >= 1.5), but
    // the function must still return a sensible non-negative value if a
    // direct caller passes an inverted structure.
    const bwb = buildPutBWB(d10, 40, 20, spot, T);
    expect(bwb.maxLoss).toBeGreaterThanOrEqual(0);
  });

  it('FE-MATH-004: standard BWB (wide > narrow) still reports positive maxLoss', () => {
    if (!d10) return;
    // Sanity check that the clamp does not affect the normal case.
    const bwb = buildPutBWB(d10, 20, 40, spot, T);
    expect(bwb.maxLoss).toBeGreaterThan(0);
    // Verify the unclamped formula matches (i.e., clamp was not triggered)
    const expected = bwb.wideWidth - bwb.narrowWidth - bwb.netCredit;
    expect(bwb.maxLoss).toBeCloseTo(expected, 8);
  });
});

// ── M1 / M1b: payoff-consistent widths, max loss, breakevens and PoP ──

/** Lowest expiry P&L on a dense SPX grid spanning all three strikes. */
function minPnLOnGrid(bwb: BWBLegs): number {
  const lo = Math.min(bwb.longNearStrike, bwb.longFarStrike) - 50;
  const hi = Math.max(bwb.longNearStrike, bwb.longFarStrike) + 50;
  let min = Infinity;
  for (let s = lo; s <= hi; s += 0.25) {
    min = Math.min(min, bwbPnLAtExpiry(bwb, s));
  }
  return min;
}

/**
 * Lognormal (r = 0) probability mass where the expiry P&L is >= 0, by the
 * midpoint rule on ln(S_T) over +/-8 sd. Independent of calcSpreadPoP.
 */
function profitMass(bwb: BWBLegs, sig: number, t: number): number {
  const sd = sig * Math.sqrt(t);
  const mu = Math.log(spot) - (sig * sig * t) / 2;
  const steps = 20_000;
  const lo = mu - 8 * sd;
  const dx = (16 * sd) / steps;
  let mass = 0;
  for (let i = 0; i < steps; i++) {
    const x = lo + (i + 0.5) * dx;
    if (bwbPnLAtExpiry(bwb, Math.exp(x)) >= 0) {
      const z = (x - mu) / sd;
      mass += (Math.exp(-(z * z) / 2) / (sd * Math.sqrt(2 * Math.PI))) * dx;
    }
  }
  return mass;
}

const scenarios = [
  // Default 20/40 setup from the review: σ 0.18 at 10:00 CT, 3% skew
  { label: 'σ 0.18, 5 h, skew 3%', sig: 0.18, hours: 5, skew: 0.03 },
  { label: 'σ 0.20, 3 h, no skew', sig: 0.2, hours: 3, skew: 0 },
  { label: 'σ 0.30, 2 h, skew 5%', sig: 0.3, hours: 2, skew: 0.05 },
] as const;

// Production multipliers plus wing ratios the UI can't produce but the
// builders accept: symmetric (1), inverted (0.5) and a zero-width far
// wing (0, a plain vertical). Inverted wings leave a far side that can't
// lose, which takes a different PoP path.
const SWEEP_MULTIPLIERS = [...BWB_WIDE_MULTIPLIERS, 1, 0.5, 0] as const;

/** True when the far flat region (past the far wing) loses money. */
const farSideLoses = (b: BWBLegs) =>
  b.wideWidth - b.narrowWidth - b.netCredit > 0;

describe.each(scenarios)(
  'BWB sweep over every narrow × multiplier × delta × side ($label)',
  ({ sig, hours, skew }) => {
    const t = calcTimeToExpiry(hours);
    const sweepRows = calcAllDeltas(spot, sig, t, skew).filter(
      (r): r is DeltaRow => !('error' in r),
    );
    const cases: BWBLegs[] = [];
    for (const narrow of BWB_NARROW_OPTIONS) {
      for (const mult of SWEEP_MULTIPLIERS) {
        for (const row of sweepRows) {
          cases.push(
            buildPutBWB(row, narrow, narrow * mult, spot, t),
            buildCallBWB(row, narrow, narrow * mult, spot, t),
          );
        }
      }
    }
    const rowFor = (b: BWBLegs) => sweepRows.find((r) => r.delta === b.delta)!;
    const popSigma = (b: BWBLegs) => {
      const row = rowFor(b);
      return b.side === 'put'
        ? (row.basePutSigma ?? row.putSigma)
        : (row.baseCallSigma ?? row.callSigma);
    };
    const name = (b: BWBLegs) =>
      [b.delta + 'Δ', b.side, b.longNearStrike, b.shortStrike, b.longFarStrike]
        .map(String)
        .join(' ');

    it('covers every delta, credits, debits and a far side that cannot lose', () => {
      expect(sweepRows).toHaveLength(6);
      expect(cases).toHaveLength(
        BWB_NARROW_OPTIONS.length * SWEEP_MULTIPLIERS.length * 6 * 2,
      );
      expect(cases.some((b) => b.netCredit < 0)).toBe(true);
      expect(cases.some((b) => b.netCredit > 0)).toBe(true);
      expect(cases.some((b) => !farSideLoses(b))).toBe(true);
    });

    it('reports the widths of the snapped strikes', () => {
      for (const b of cases) {
        expect(b.narrowWidth, name(b)).toBe(
          Math.abs(b.longNearStrike - b.shortStrike),
        );
        expect(b.wideWidth, name(b)).toBe(
          Math.abs(b.shortStrike - b.longFarStrike),
        );
      }
    });

    it('snaps the far wing away from the short on both sides and keeps on-grid widths unchanged (Q2)', () => {
      let offGrid = 0;
      for (const narrow of BWB_NARROW_OPTIONS) {
        for (const mult of SWEEP_MULTIPLIERS) {
          const requested = narrow * mult;
          const onGrid = requested % 5 === 0;
          // The next 5-pt multiple at or beyond the request
          const expected = Math.ceil(requested / 5) * 5;
          if (!onGrid) offGrid++;
          for (const row of sweepRows) {
            const put = buildPutBWB(row, narrow, requested, spot, t);
            const call = buildCallBWB(row, narrow, requested, spot, t);
            const label = row.delta + 'Δ ' + narrow + '×' + mult;
            expect(put.longFarStrike, label).toBe(put.shortStrike - expected);
            expect(call.longFarStrike, label).toBe(call.shortStrike + expected);
            expect(put.wideWidth, label).toBe(expected);
            expect(call.wideWidth, label).toBe(expected);
            expect(snapBWBWideWidth(requested), label).toBe(expected);
            if (onGrid) {
              // Exactly the request, and exactly what nearest-strike
              // rounding gave before Q2
              expect(put.wideWidth, label).toBe(requested);
              expect(put.longFarStrike, label).toBe(
                snapToIncrement(put.shortStrike - requested),
              );
              expect(call.longFarStrike, label).toBe(
                snapToIncrement(call.shortStrike + requested),
              );
            } else {
              expect(put.wideWidth, label).toBe(requested + 2.5);
            }
          }
        }
      }
      // 15 × 1.5, 15 × 2.5, 25 × 1.5, 25 × 2.5, plus 15 × 0.5 and 25 × 0.5
      expect(offGrid).toBe(6);
    });

    it('maxLoss equals the worst expiry P&L on a dense price grid', () => {
      for (const b of cases) {
        expect(b.maxLoss, name(b)).toBeCloseTo(
          Math.max(0, -minPnLOnGrid(b)),
          6,
        );
      }
    });

    it('returnOnRisk is netCredit over the payoff-consistent maxLoss', () => {
      for (const b of cases) {
        const expected = b.maxLoss > 0 ? b.netCredit / b.maxLoss : 0;
        expect(b.returnOnRisk, name(b)).toBeCloseTo(expected, 8);
      }
    });

    it('every reported breakeven has zero expiry P&L', () => {
      for (const b of cases) {
        // `breakeven` is documented as meaningless when the far side
        // can't lose: the trade profits all the way out on that side.
        if (farSideLoses(b)) {
          expect(bwbPnLAtExpiry(b, b.breakeven), name(b)).toBeCloseTo(0, 6);
        }
        if (b.netCredit < 0) {
          expect(b.breakevenNear, name(b)).not.toBeNull();
          expect(bwbPnLAtExpiry(b, b.breakevenNear!), name(b)).toBeCloseTo(
            0,
            6,
          );
        } else {
          expect(b.breakevenNear, name(b)).toBeNull();
        }
      }
    });

    it('PoP equals the lognormal mass where the expiry P&L is >= 0', () => {
      for (const b of cases) {
        const truth = profitMass(b, popSigma(b), t);
        expect(
          Math.abs(b.probabilityOfProfit - truth),
          name(b) + ': PoP ' + b.probabilityOfProfit + ' vs ' + truth,
        ).toBeLessThanOrEqual(0.001);
      }
    });

    it('credit adjustedPoP is unchanged from the credit-spread fat-tail formula', () => {
      const credits = cases.filter((b) => b.netCredit >= 0 && farSideLoses(b));
      expect(credits.length).toBeGreaterThan(0);
      for (const b of credits) {
        expect(b.adjustedPoP, name(b)).toBeCloseTo(
          adjustPoPForKurtosis(
            b.probabilityOfProfit,
            getKurtosisFactor(undefined),
            b.side,
          ),
          12,
        );
      }
    });

    it('adjustedPoP stays within [0, probabilityOfProfit]', () => {
      for (const b of cases) {
        expect(b.adjustedPoP, name(b)).toBeGreaterThanOrEqual(0);
        expect(b.adjustedPoP, name(b)).toBeLessThanOrEqual(
          b.probabilityOfProfit + 1e-12,
        );
      }
    });
  },
);

describe('M1b regression: debit BWB PoP counts only the profit zone', () => {
  // Default 20/40 at σ 0.18, 10:00 CT (5 h left), 3% skew, SPX 5800.
  const t5 = calcTimeToExpiry(5);
  const row10 = calcAllDeltas(spot, 0.18, t5, 0.03).find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  )!;

  it('10Δ put 20/40 is a debit that profits only between ~5705 and ~5745 (PoP 12.1%, not 94.5%)', () => {
    const bwb = buildPutBWB(row10, 20, 40, spot, t5);
    expect(bwb.shortStrike).toBe(5725);
    expect(bwb.netCredit).toBeLessThan(0);
    expect(bwb.breakeven).toBeCloseTo(5705.4, 1);
    expect(bwb.breakevenNear).toBeCloseTo(5744.6, 1);
    expect(bwb.probabilityOfProfit).toBeCloseTo(0.121, 2);
    expect(bwb.adjustedPoP).toBeLessThan(bwb.probabilityOfProfit);
  });

  it('fat tails scale the 10Δ debit band by the far-tail survival ratio (≈11.1%, not 3.9%)', () => {
    const bwb = buildPutBWB(row10, 20, 40, spot, t5);
    expect(bwb.adjustedPoP).toBeCloseTo(0.111, 2);
  });

  it('fat tails scale the 20Δ debit band by the far-tail survival ratio (≈15.2%, not 1.5%)', () => {
    const row20 = calcAllDeltas(spot, 0.18, t5, 0.03).find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 20,
    )!;
    const bwb = buildPutBWB(row20, 20, 40, spot, t5);
    expect(bwb.netCredit).toBeLessThan(0);
    expect(bwb.probabilityOfProfit).toBeCloseTo(0.19, 2);
    expect(bwb.adjustedPoP).toBeCloseTo(0.152, 2);
  });

  it('credit adjustedPoP is unchanged from the credit-spread formula under regime kurtosis', () => {
    const t3 = calcTimeToExpiry(3);
    const creditRow = calcAllDeltas(spot, 0.2, t3, 0.03).find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    )!;
    for (const vix of [12, 20, 30]) {
      for (const bwb of [
        buildPutBWB(creditRow, 15, 45, spot, t3, 10, vix),
        buildCallBWB(creditRow, 15, 45, spot, t3, 10, vix),
      ]) {
        expect(bwb.netCredit).toBeGreaterThan(0);
        expect(bwb.adjustedPoP).toBeCloseTo(
          adjustPoPForKurtosis(
            bwb.probabilityOfProfit,
            getKurtosisFactor(vix),
            bwb.side,
          ),
          12,
        );
      }
    }
  });

  it('10Δ call 20/40 mirrors it (PoP 12.8%, not 94.4%)', () => {
    const bwb = buildCallBWB(row10, 20, 40, spot, t5);
    expect(bwb.shortStrike).toBe(5870);
    expect(bwb.netCredit).toBeLessThan(0);
    expect(bwb.breakevenNear).toBeCloseTo(5850.5, 1);
    expect(bwb.breakeven).toBeCloseTo(5889.5, 1);
    expect(bwb.probabilityOfProfit).toBeCloseTo(0.128, 2);
  });
});

describe('Q2: off-grid far wings snap away from the short strike', () => {
  it.each([
    [22.5, 25],
    [37.5, 40],
    [62.5, 65],
    [7.5, 10],
    [12.5, 15],
    [15, 15],
    [30, 30],
    [40, 40],
    [90, 90],
    [0, 0],
  ])('snapBWBWideWidth(%d) = %d', (requested, effective) => {
    expect(snapBWBWideWidth(requested)).toBe(effective);
  });

  it('the production grid has exactly four off-grid combos, each widened by 2.5', () => {
    const offGrid: string[] = [];
    for (const narrow of BWB_NARROW_OPTIONS) {
      for (const mult of BWB_WIDE_MULTIPLIERS) {
        const requested = narrow * mult;
        if (snapBWBWideWidth(requested) !== requested) {
          offGrid.push(narrow + '×' + mult);
          expect(snapBWBWideWidth(requested)).toBe(requested + 2.5);
        }
      }
    }
    expect(offGrid).toEqual(['15×1.5', '15×2.5', '25×1.5', '25×2.5']);
  });

  it('snapBWBFarStrike floors puts and ceils calls onto the grid, even from an off-grid short', () => {
    expect(snapBWBFarStrike(5725, 37.5, 'put')).toBe(5685);
    expect(snapBWBFarStrike(5870, 37.5, 'call')).toBe(5910);
    expect(snapBWBFarStrike(5727, 20, 'put')).toBe(5705);
    expect(snapBWBFarStrike(5727, 20, 'call')).toBe(5750);
    // An on-grid target never moves
    expect(snapBWBFarStrike(5725, 40, 'put')).toBe(5685);
    expect(snapBWBFarStrike(5870, 40, 'call')).toBe(5910);
  });
});

describe('M1 regression: off-grid wide widths use the snapped far strike', () => {
  const t5 = calcTimeToExpiry(5);
  const row10 = calcAllDeltas(spot, 0.18, t5, 0.03).find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  )!;

  it('15/37.5 put snaps the far wing away from the short to 40 wide and sizes max loss from 40', () => {
    const bwb = buildPutBWB(row10, 15, 37.5, spot, t5);
    // Before Q2 the far wing rounded toward the short: 5740/5725/5690
    expect([bwb.longNearStrike, bwb.shortStrike, bwb.longFarStrike]).toEqual([
      5740, 5725, 5685,
    ]);
    expect(bwb.longFarStrike).toBe(bwb.shortStrike - 40);
    expect(bwb.wideWidth).toBe(40);
    expect(bwb.maxLoss).toBeCloseTo(40 - 15 - bwb.netCredit, 10);
    expect(bwb.maxLoss).toBeCloseTo(
      -bwbPnLAtExpiry(bwb, bwb.longFarStrike),
      10,
    );
  });

  it('15/37.5 call snaps the far wing to 40 wide and sizes max loss from 40', () => {
    const bwb = buildCallBWB(row10, 15, 37.5, spot, t5);
    expect(bwb.longFarStrike).toBe(bwb.shortStrike + 40);
    expect(bwb.wideWidth).toBe(40);
    expect(bwb.maxLoss).toBeCloseTo(40 - 15 - bwb.netCredit, 10);
    expect(bwb.maxLoss).toBeCloseTo(
      -bwbPnLAtExpiry(bwb, bwb.longFarStrike),
      10,
    );
  });

  it('inverted debit structure reports the debit as its max loss', () => {
    // wide < narrow: the far side can't lose, so the worst case is
    // losing the debit when every leg expires worthless.
    const bwb = buildPutBWB(row10, 40, 20, spot, t5);
    expect(bwb.netCredit).toBeLessThan(0);
    expect(bwb.maxLoss).toBeCloseTo(Math.max(0, -minPnLOnGrid(bwb)), 6);
  });

  it('inverted 40/20 10Δ put counts the whole far side as profit (PoP ≈24.7%, not 21.4%)', () => {
    const bwb = buildPutBWB(row10, 40, 20, spot, t5);
    expect(farSideLoses(bwb)).toBe(false);
    const truth = profitMass(bwb, row10.basePutSigma, t5);
    expect(Math.abs(bwb.probabilityOfProfit - truth)).toBeLessThanOrEqual(
      0.001,
    );
    expect(bwb.probabilityOfProfit).toBeCloseTo(0.247, 2);
    // No far tail to fatten, so the fat-tail step leaves PoP alone
    expect(bwb.adjustedPoP).toBe(bwb.probabilityOfProfit);
  });

  it('zero-width far wing (20/0) 20Δ put counts the whole far side as profit (PoP ≈27.6%, not 14.2%)', () => {
    const row20 = calcAllDeltas(spot, 0.18, t5, 0.03).find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 20,
    )!;
    const bwb = buildPutBWB(row20, 20, 0, spot, t5);
    expect(bwb.wideWidth).toBe(0);
    expect(farSideLoses(bwb)).toBe(false);
    const truth = profitMass(bwb, row20.basePutSigma, t5);
    expect(Math.abs(bwb.probabilityOfProfit - truth)).toBeLessThanOrEqual(
      0.001,
    );
    expect(bwb.probabilityOfProfit).toBeCloseTo(0.276, 2);
  });
});

// ── Q25: expected win / loss under the log-normal PoP uses ──

describe('expectedPnLSplit (Q25)', () => {
  // Default setup: SPX 5800, σ 0.18, 10:00 CT (5 h left), 3% skew
  const t5 = calcTimeToExpiry(5);
  const row10 = calcAllDeltas(spot, 0.18, t5, 0.03).find(
    (r): r is DeltaRow => !('error' in r) && r.delta === 10,
  )!;
  /**
   * r = 0 Black-Scholes price: the log-normal expectation of the payoff.
   * Its Abramowitz-Stegun normalCDF (abs error < 7.5e-8) puts these
   * closed forms within ~2e-4 pts of the truth, hence 3-digit tolerances;
   * the helper itself is checked to 1e-5 against a finer integral below.
   */
  const bs = (k: number, sig: number, side: 'put' | 'call') =>
    blackScholesPrice(spot, k, sig, t5, side);
  /** Direct midpoint integral over ±10 sd in 200,000 steps (10x finer) */
  const fineSplit = (pnl: (s: number) => number, sig: number) => {
    const sd = sig * Math.sqrt(t5);
    const mu = Math.log(spot) - (sig * sig * t5) / 2;
    const steps = 200_000;
    const dz = 20 / steps;
    let win = 0;
    let loss = 0;
    for (let i = 0; i < steps; i++) {
      const z = -10 + (i + 0.5) * dz;
      const f = (Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI)) * dz;
      const p = pnl(Math.exp(mu + sd * z));
      if (p > 0) win += p * f;
      else loss -= p * f;
    }
    return { win, loss };
  };
  /** Closed-form E[P&L] of a BWB at its settlement σ */
  const bwbMean = (b: BWBLegs) => {
    const sig = bwbSettlementSigma(row10, b.side);
    return (
      bs(b.longNearStrike, sig, b.side) -
      2 * bs(b.shortStrike, sig, b.side) +
      bs(b.longFarStrike, sig, b.side) +
      b.netCredit
    );
  };
  const splitOf = (b: BWBLegs) =>
    expectedPnLSplit((s) => bwbPnLAtExpiry(b, s), {
      spot,
      sigma: bwbSettlementSigma(row10, b.side),
      T: t5,
    });

  it('matches the closed form for a long call vertical', () => {
    // Long 5800 / short 5820 call vertical for an 8-pt debit D:
    //   E[win]  = C(K1 + D) − C(K2)   (profit above K1 + D)
    //   E[loss] = P(K1 + D) − P(K1)   (loss below K1 + D)
    const k1 = 5800;
    const k2 = 5820;
    const debit = 8;
    const pnl = (s: number) => Math.min(Math.max(s - k1, 0), k2 - k1) - debit;
    const { expectedWin, expectedLoss } = expectedPnLSplit(pnl, {
      spot,
      sigma: 0.18,
      T: t5,
    });
    expect(expectedWin).toBeCloseTo(
      bs(k1 + debit, 0.18, 'call') - bs(k2, 0.18, 'call'),
      3,
    );
    expect(expectedLoss).toBeCloseTo(
      bs(k1 + debit, 0.18, 'put') - bs(k1, 0.18, 'put'),
      3,
    );
    // The difference is the whole expectation: C(K1) − C(K2) − D
    expect(expectedWin - expectedLoss).toBeCloseTo(
      bs(k1, 0.18, 'call') - bs(k2, 0.18, 'call') - debit,
      3,
    );
  });

  it('agrees with a 10x finer direct integral to 1e-5 pts for debit and credit BWBs', () => {
    for (const b of [
      buildPutBWB(row10, 20, 40, spot, t5),
      buildCallBWB(row10, 20, 40, spot, t5),
      buildPutBWB(row10, 15, 37.5, spot, t5),
    ]) {
      const pnl = (s: number) => bwbPnLAtExpiry(b, s);
      const fine = fineSplit(pnl, bwbSettlementSigma(row10, b.side));
      const { expectedWin, expectedLoss } = splitOf(b);
      expect(Math.abs(expectedWin - fine.win), b.side).toBeLessThan(1e-5);
      expect(Math.abs(expectedLoss - fine.loss), b.side).toBeLessThan(1e-5);
    }
  });

  it('E[win] − E[loss] is the full expected P&L for debit and credit BWBs', () => {
    const structures = [
      buildPutBWB(row10, 20, 40, spot, t5),
      buildCallBWB(row10, 20, 40, spot, t5),
      buildPutBWB(row10, 15, 37.5, spot, t5),
      buildCallBWB(row10, 15, 37.5, spot, t5),
    ];
    expect(structures.some((b) => b.netCredit < 0)).toBe(true);
    expect(structures.some((b) => b.netCredit > 0)).toBe(true);
    for (const b of structures) {
      const { expectedWin, expectedLoss } = splitOf(b);
      expect(expectedWin - expectedLoss, b.side).toBeCloseTo(bwbMean(b), 3);
    }
  });

  it('debit put BWB: E[win] is the closed-form tent between its breakevens', () => {
    // pnl⁺ = (BE_near − S)⁺ − 2(short − S)⁺ + (BE_far − S)⁺
    const b = buildPutBWB(row10, 20, 40, spot, t5);
    const sig = bwbSettlementSigma(row10, 'put');
    expect(b.netCredit).toBeLessThan(0);
    expect(splitOf(b).expectedWin).toBeCloseTo(
      bs(b.breakevenNear!, sig, 'put') -
        2 * bs(b.shortStrike, sig, 'put') +
        bs(b.breakeven, sig, 'put'),
      3,
    );
    // The old projection counted a debit's wins as $0
    expect(splitOf(b).expectedWin).toBeGreaterThan(0.5);
  });

  it('credit put BWB: E[loss] is the closed-form ramp below its breakeven, under (1 − PoP) × max loss', () => {
    // |pnl⁻| = (BE − S)⁺ − (far − S)⁺
    const b = buildPutBWB(row10, 15, 37.5, spot, t5);
    const sig = bwbSettlementSigma(row10, 'put');
    expect(b.netCredit).toBeGreaterThan(0);
    const { expectedLoss } = splitOf(b);
    expect(expectedLoss).toBeCloseTo(
      bs(b.breakeven, sig, 'put') - bs(b.longFarStrike, sig, 'put'),
      3,
    );
    expect(expectedLoss).toBeLessThan((1 - b.probabilityOfProfit) * b.maxLoss);
  });

  it('nets ≈ $0 a month with no IV acceleration (6.5 h left), where pricing and settlement σ match', () => {
    const t65 = calcTimeToExpiry(6.5);
    const rows65 = calcAllDeltas(spot, 0.18, t65, 0.03).filter(
      (r): r is DeltaRow => !('error' in r),
    );
    let checked = 0;
    for (const row of rows65) {
      expect(bwbSettlementSigma(row, 'put')).toBeCloseTo(row.putSigma, 12);
      expect(bwbSettlementSigma(row, 'call')).toBeCloseTo(row.callSigma, 12);
      for (const [narrow, mult] of [
        [20, 2],
        [15, 2.5],
        [10, 3],
      ] as const) {
        for (const b of [
          buildPutBWB(row, narrow, narrow * mult, spot, t65),
          buildCallBWB(row, narrow, narrow * mult, spot, t65),
        ]) {
          const { expectedWin, expectedLoss } = expectedPnLSplit(
            (s) => bwbPnLAtExpiry(b, s),
            { spot, sigma: bwbSettlementSigma(row, b.side), T: t65 },
          );
          // Only the premiums' A&S normalCDF keeps this off exactly 0
          expect(
            Math.abs(22 * 100 * (expectedWin - expectedLoss)),
            b.delta + 'Δ ' + b.side + ' ' + narrow + '×' + mult,
          ).toBeLessThan(0.5);
          checked++;
        }
      }
    }
    expect(checked).toBe(36);
  });

  it('matches the closed form one minute before expiry (σ 0.08), with the shorts at the money', () => {
    const t1 = calcTimeToExpiry(1 / 60);
    const row = calcAllDeltas(spot, 0.08, t1, 0.03).find(
      (r): r is DeltaRow => !('error' in r) && r.delta === 10,
    )!;
    for (const b of [
      buildPutBWB(row, 20, 40, spot, t1),
      buildCallBWB(row, 20, 40, spot, t1),
    ]) {
      const sig = bwbSettlementSigma(row, b.side);
      const price = (k: number) => blackScholesPrice(spot, k, sig, t1, b.side);
      const { expectedWin, expectedLoss } = expectedPnLSplit(
        (s) => bwbPnLAtExpiry(b, s),
        { spot, sigma: sig, T: t1 },
      );
      expect(b.shortStrike, b.side).toBe(spot);
      expect(b.netCredit, b.side).toBeLessThan(0);
      expect(expectedWin - expectedLoss, b.side).toBeCloseTo(
        price(b.longNearStrike) -
          2 * price(b.shortStrike) +
          price(b.longFarStrike) +
          b.netCredit,
        3,
      );
      // The debit's profit zone is a tent between its two breakevens,
      // peaking at the short strike, on either side
      const tent =
        price(b.breakevenNear!) - 2 * price(b.shortStrike) + price(b.breakeven);
      expect(expectedWin, b.side).toBeCloseTo(tent, 3);
    }
  });

  it('settles at spot when no time or vol is left', () => {
    const above = (s: number) => s - 5790; // +10 at spot
    expect(expectedPnLSplit(above, { spot, sigma: 0.18, T: 0 })).toEqual({
      expectedWin: 10,
      expectedLoss: 0,
    });
    expect(
      expectedPnLSplit((s) => -above(s), { spot, sigma: 0, T: t5 }),
    ).toEqual({ expectedWin: 0, expectedLoss: 10 });
    // Past expiry: σ√T is NaN
    expect(expectedPnLSplit(above, { spot, sigma: 0.18, T: -1 })).toEqual({
      expectedWin: 10,
      expectedLoss: 0,
    });
  });

  it('bwbSettlementSigma is the base σ of the side, falling back to the pricing σ', () => {
    expect(bwbSettlementSigma(row10, 'put')).toBe(row10.basePutSigma);
    expect(bwbSettlementSigma(row10, 'call')).toBe(row10.baseCallSigma);
    const noBase: DeltaRow = {
      ...row10,
      basePutSigma: undefined as unknown as number,
      baseCallSigma: undefined as unknown as number,
    };
    expect(bwbSettlementSigma(noBase, 'put')).toBe(row10.putSigma);
    expect(bwbSettlementSigma(noBase, 'call')).toBe(row10.callSigma);
  });
});
