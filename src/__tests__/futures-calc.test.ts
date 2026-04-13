import { describe, expect, it } from 'vitest';

import {
  SPECS,
  feesPerSide,
  roundTripFees,
  grossPnl,
  netPnl,
  breakEvenPrice,
  calcTrade,
  calcTickRow,
  riskRewardRatio,
  maxContractsFromRisk,
} from '../components/FuturesCalculator/futures-calc';

// ── Contract specs ─────────────────────────────────────────────────────────

describe('SPECS', () => {
  it('ES has correct point value, tick value, and day margin', () => {
    expect(SPECS.ES.pointValue).toBe(50);
    expect(SPECS.ES.tickValue).toBe(12.5);
    expect(SPECS.ES.tickSize).toBe(0.25);
    expect(SPECS.ES.dayMargin).toBe(500);
  });

  it('NQ has correct point value, tick value, and day margin', () => {
    expect(SPECS.NQ.pointValue).toBe(20);
    expect(SPECS.NQ.tickValue).toBe(5.0);
    expect(SPECS.NQ.tickSize).toBe(0.25);
    expect(SPECS.NQ.dayMargin).toBe(1000);
  });

  it('MES has correct point value, tick value, and day margin', () => {
    expect(SPECS.MES.pointValue).toBe(5);
    expect(SPECS.MES.tickValue).toBe(1.25);
    expect(SPECS.MES.tickSize).toBe(0.25);
    expect(SPECS.MES.dayMargin).toBe(50);
  });

  it('MNQ has correct point value, tick value, and day margin', () => {
    expect(SPECS.MNQ.pointValue).toBe(2);
    expect(SPECS.MNQ.tickValue).toBe(0.5);
    expect(SPECS.MNQ.tickSize).toBe(0.25);
    expect(SPECS.MNQ.dayMargin).toBe(100);
  });

  it('MES and MNQ share the same per-side fee structure', () => {
    expect(SPECS.MES.exchangeFee).toBe(0.35);
    expect(SPECS.MES.nfaFee).toBe(0.02);
    expect(SPECS.MES.clearingFee).toBe(0.19);
    expect(SPECS.MES.brokerCommission).toBe(0.95);
    expect(SPECS.MNQ.exchangeFee).toBe(SPECS.MES.exchangeFee);
    expect(SPECS.MNQ.nfaFee).toBe(SPECS.MES.nfaFee);
    expect(SPECS.MNQ.clearingFee).toBe(SPECS.MES.clearingFee);
    expect(SPECS.MNQ.brokerCommission).toBe(SPECS.MES.brokerCommission);
  });

  it('ES and NQ share the same per-side fee structure', () => {
    expect(SPECS.ES.exchangeFee).toBe(1.38);
    expect(SPECS.ES.nfaFee).toBe(0.02);
    expect(SPECS.ES.clearingFee).toBe(0.19);
    expect(SPECS.ES.brokerCommission).toBe(1.29);
    expect(SPECS.NQ.exchangeFee).toBe(SPECS.ES.exchangeFee);
    expect(SPECS.NQ.nfaFee).toBe(SPECS.ES.nfaFee);
    expect(SPECS.NQ.clearingFee).toBe(SPECS.ES.clearingFee);
    expect(SPECS.NQ.brokerCommission).toBe(SPECS.ES.brokerCommission);
  });
});

// ── feesPerSide ────────────────────────────────────────────────────────────

describe('feesPerSide', () => {
  it('returns $2.88 for 1 ES contract (exchange + NFA + clearing + broker)', () => {
    expect(feesPerSide(SPECS.ES, 1)).toBeCloseTo(2.88, 10);
  });

  it('returns $1.51 for 1 MES contract', () => {
    // 0.35 + 0.02 + 0.19 + 0.95 = 1.51
    expect(feesPerSide(SPECS.MES, 1)).toBeCloseTo(1.51, 10);
  });

  it('returns $1.51 for 1 MNQ contract', () => {
    expect(feesPerSide(SPECS.MNQ, 1)).toBeCloseTo(1.51, 10);
  });

  it('scales linearly with contract count', () => {
    expect(feesPerSide(SPECS.ES, 3)).toBeCloseTo(8.64, 10);
    expect(feesPerSide(SPECS.MES, 2)).toBeCloseTo(3.02, 10);
  });
});

// ── roundTripFees ──────────────────────────────────────────────────────────

describe('roundTripFees', () => {
  it('returns $5.76 round-trip for 1 ES contract', () => {
    expect(roundTripFees(SPECS.ES, 1)).toBeCloseTo(5.76, 10);
  });

  it('is exactly twice the per-side fee', () => {
    expect(roundTripFees(SPECS.NQ, 2)).toBeCloseTo(
      feesPerSide(SPECS.NQ, 2) * 2,
      10,
    );
  });
});

// ── grossPnl ───────────────────────────────────────────────────────────────

describe('grossPnl', () => {
  it('calculates correct ES long P&L for a 10-point gain', () => {
    // 10 pts × $50/pt × 1 contract = $500
    expect(grossPnl(SPECS.ES, 5500, 5510, 'long', 1)).toBeCloseTo(500, 10);
  });

  it('calculates correct ES short P&L for a 10-point gain', () => {
    // Short means we profit when price falls
    expect(grossPnl(SPECS.ES, 5510, 5500, 'short', 1)).toBeCloseTo(500, 10);
  });

  it('returns a loss when long and price falls', () => {
    expect(grossPnl(SPECS.ES, 5510, 5500, 'long', 1)).toBeCloseTo(-500, 10);
  });

  it('scales with contract count', () => {
    expect(grossPnl(SPECS.ES, 5500, 5510, 'long', 3)).toBeCloseTo(1500, 10);
  });

  it('calculates correct NQ long P&L for a 20-point gain', () => {
    // 20 pts × $20/pt × 1 contract = $400
    expect(grossPnl(SPECS.NQ, 21000, 21020, 'long', 1)).toBeCloseTo(400, 10);
  });

  it('is zero when entry equals exit', () => {
    expect(grossPnl(SPECS.ES, 5500, 5500, 'long', 1)).toBe(0);
    expect(grossPnl(SPECS.NQ, 21000, 21000, 'short', 2)).toBe(0);
  });
});

// ── netPnl ─────────────────────────────────────────────────────────────────

describe('netPnl', () => {
  it('subtracts fees from gross P&L', () => {
    expect(netPnl(500, 3.18)).toBeCloseTo(496.82, 10);
  });

  it('can return a negative net even on a gross winner if fees exceed gains', () => {
    // A 1-tick ES winner (gross +$12.50) minus $5.76 fees = +$6.74
    expect(netPnl(12.5, 5.76)).toBeCloseTo(6.74, 10);
  });

  it('is worse than gross when fees are positive', () => {
    expect(netPnl(100, 3.18)).toBeLessThan(100);
  });
});

// ── breakEvenPrice ─────────────────────────────────────────────────────────

describe('breakEvenPrice', () => {
  it('long: break-even is above entry by the fee amount in points', () => {
    const be = breakEvenPrice(SPECS.ES, 5500, 'long', 1);
    // $5.76 / $50 per point = 0.1152 pts
    expect(be).toBeCloseTo(5500 + 5.76 / 50, 8);
  });

  it('short: break-even is below entry', () => {
    const be = breakEvenPrice(SPECS.ES, 5500, 'short', 1);
    expect(be).toBeCloseTo(5500 - 5.76 / 50, 8);
  });

  it('break-even is independent of contract count (per-contract fees scale evenly)', () => {
    const be1 = breakEvenPrice(SPECS.ES, 5500, 'long', 1);
    const be5 = breakEvenPrice(SPECS.ES, 5500, 'long', 5);
    expect(be1).toBeCloseTo(be5, 10);
  });

  it('NQ break-even uses the correct NQ point value', () => {
    const be = breakEvenPrice(SPECS.NQ, 21000, 'long', 1);
    expect(be).toBeCloseTo(21000 + 5.76 / 20, 8);
  });
});

// ── calcTrade ──────────────────────────────────────────────────────────────

describe('calcTrade', () => {
  it('returns correct full result for an ES long 10-point winner', () => {
    const result = calcTrade(SPECS.ES, 5500, 5510, 'long', 1);
    expect(result.gross).toBeCloseTo(500, 10);
    expect(result.fees).toBeCloseTo(5.76, 10);
    expect(result.net).toBeCloseTo(494.24, 10);
    expect(result.points).toBeCloseTo(10, 10);
    expect(result.ticks).toBeCloseTo(40, 10);
    expect(result.marginRequired).toBe(500);
    // ROM = 494.24 / 500 * 100 = 98.848%
    expect(result.returnOnMarginPct).toBeCloseTo(98.848, 2);
  });

  it('returns negative net for an ES long loser', () => {
    const result = calcTrade(SPECS.ES, 5510, 5500, 'long', 1);
    expect(result.gross).toBeCloseTo(-500, 10);
    expect(result.net).toBeCloseTo(-505.76, 10);
    expect(result.returnOnMarginPct).toBeLessThan(0);
  });

  it('scales margin with contract count', () => {
    const result = calcTrade(SPECS.ES, 5500, 5510, 'long', 4);
    expect(result.marginRequired).toBe(2000);
    expect(result.gross).toBeCloseTo(2000, 10);
    expect(result.fees).toBeCloseTo(23.04, 10);
    expect(result.net).toBeCloseTo(1976.96, 10);
  });

  it('handles NQ correctly', () => {
    // 10 pts × $20/pt × 2 contracts = $400 gross
    const result = calcTrade(SPECS.NQ, 21000, 21010, 'long', 2);
    expect(result.gross).toBeCloseTo(400, 10);
    expect(result.fees).toBeCloseTo(11.52, 10);
    expect(result.net).toBeCloseTo(388.48, 10);
    expect(result.marginRequired).toBe(2000);
  });
});

// ── calcTickRow ────────────────────────────────────────────────────────────

describe('calcTickRow', () => {
  it('1 tick on ES long = $12.50 gross', () => {
    const row = calcTickRow(SPECS.ES, 5500, 'long', 1, 1);
    expect(row.gross).toBeCloseTo(12.5, 10);
    expect(row.net).toBeCloseTo(12.5 - 5.76, 10);
    expect(row.exitPx).toBeCloseTo(5500.25, 10);
    expect(row.ticks).toBe(1);
    expect(row.points).toBeCloseTo(0.25, 10);
  });

  it('10 ticks on NQ long = $50 gross', () => {
    // 10 ticks × 0.25 pts/tick × $20/pt = $50
    const row = calcTickRow(SPECS.NQ, 21000, 'long', 1, 10);
    expect(row.gross).toBeCloseTo(50, 10);
    expect(row.net).toBeCloseTo(50 - 5.76, 10);
    expect(row.exitPx).toBeCloseTo(21002.5, 10);
  });

  it('exit price goes down for short direction', () => {
    const row = calcTickRow(SPECS.ES, 5500, 'short', 1, 4);
    expect(row.exitPx).toBeCloseTo(5499, 10);
    expect(row.gross).toBeCloseTo(50, 10); // 4 ticks × $12.50
  });

  it('scales gross linearly with contract count', () => {
    const row1 = calcTickRow(SPECS.ES, 5500, 'long', 1, 8);
    const row3 = calcTickRow(SPECS.ES, 5500, 'long', 3, 8);
    expect(row3.gross).toBeCloseTo(row1.gross * 3, 10);
  });
});

// ── riskRewardRatio ────────────────────────────────────────────────────────

describe('riskRewardRatio', () => {
  it('returns 2.0 for a long with 20-pt reward and 10-pt risk', () => {
    // entry 5500, target 5520 (+20 pts reward), stop 5490 (−10 pts risk)
    expect(riskRewardRatio(5500, 5520, 5490, 'long')).toBeCloseTo(2.0, 10);
  });

  it('returns 1.0 for equal reward and risk', () => {
    expect(riskRewardRatio(5500, 5510, 5490, 'long')).toBeCloseTo(1.0, 10);
  });

  it('returns < 1 when reward is smaller than risk', () => {
    // reward: 5 pts, risk: 10 pts → 0.5
    expect(riskRewardRatio(5500, 5505, 5490, 'long')).toBeCloseTo(0.5, 10);
  });

  it('works for short direction', () => {
    // short entry 5500, target 5480 (−20 pts = reward), stop 5510 (+10 pts = risk)
    expect(riskRewardRatio(5500, 5480, 5510, 'short')).toBeCloseTo(2.0, 10);
  });

  it('returns 0 when stop distance is zero', () => {
    expect(riskRewardRatio(5500, 5510, 5500, 'long')).toBe(0);
  });

  it('returns negative when trade exits on the wrong side of entry (loss)', () => {
    // long entry 5500, exit 5490 (below entry = loss), stop 5490
    // reward: −10, risk: 10 → −1.0
    expect(riskRewardRatio(5500, 5490, 5490, 'long')).toBeCloseTo(-1.0, 10);
  });
});

// ── maxContractsFromRisk ───────────────────────────────────────────────────

describe('maxContractsFromRisk', () => {
  it('MES: floors to 9 contracts with $500 budget and 10-point stop', () => {
    // riskPerContract = 10 * 5 + 3.02 = 53.02 → floor(500 / 53.02) = 9
    expect(maxContractsFromRisk(SPECS.MES, 5500, 5490, 'long', 500)).toBe(9);
  });

  it('ES: floors to 1 contract with $200 budget and 2-point stop', () => {
    // riskPerContract = 2 * 50 + 5.76 = 105.76 → floor(200 / 105.76) = 1
    expect(maxContractsFromRisk(SPECS.ES, 5500, 5498, 'long', 200)).toBe(1);
  });

  it('returns 0 when budget is smaller than one contract risk', () => {
    // riskPerContract = 10 * 50 + 5.76 = 505.76 → floor(200 / 505.76) = 0
    expect(maxContractsFromRisk(SPECS.ES, 5500, 5490, 'long', 200)).toBe(0);
  });

  it('works for short direction', () => {
    // short: stop is above entry. entry 5500, stop 5510 → 10-pt risk on MES
    expect(maxContractsFromRisk(SPECS.MES, 5500, 5510, 'short', 500)).toBe(9);
  });

  it('returns 0 for zero or negative stop distance', () => {
    // stop == entry → no risk distance
    expect(maxContractsFromRisk(SPECS.ES, 5500, 5500, 'long', 500)).toBe(0);
  });

  it('returns 0 for zero or negative budget', () => {
    expect(maxContractsFromRisk(SPECS.ES, 5500, 5490, 'long', 0)).toBe(0);
  });
});
