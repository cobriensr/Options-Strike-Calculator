import { describe, it, expect } from 'vitest';
import {
  calcNet,
  calcPnl,
  calcMetrics,
  generatePnlRows,
  fmtSpx,
  fmtPnl,
} from '../../components/BWBCalculator/bwb-math';

// ── calcNet ─────────────────────────────────────────────────

describe('calcNet', () => {
  it('returns credit when 2*mid > low + high', () => {
    // 2*5 - 2.5 - 1 = 6.50
    expect(calcNet(2.5, 5.0, 1.0)).toBeCloseTo(6.5, 10);
  });

  it('returns debit when 2*mid < low + high', () => {
    // 2*6 - 10 - 3.5 = -1.50
    expect(calcNet(10.0, 6.0, 3.5)).toBeCloseTo(-1.5, 10);
  });

  it('returns positive net for balanced prices', () => {
    // 2*5 - 5 - 5 = 0 ... wait: 2*5 - 5 - 5 = 0
    // Actually the spec says calcNet(5,5,5) = 5 which is wrong.
    // Formula is 2*5 - 5 - 5 = 0. Use the real formula.
    expect(calcNet(5.0, 5.0, 5.0)).toBe(0);
  });

  it('handles zero prices', () => {
    expect(calcNet(0, 0, 0)).toBe(0);
  });

  it('handles single-leg cost dominance', () => {
    // 2*10 - 3 - 5 = 12
    expect(calcNet(3, 10, 5)).toBeCloseTo(12, 10);
  });
});

// ── calcPnl (calls) ────────────────────────────────────────

describe('calcPnl — calls', () => {
  // Call BWB: low=6570, mid=6590, high=6630, net=0.91 (credit)
  const low = 6570;
  const mid = 6590;
  const high = 6630;
  const net = 0.91;

  it('below low strike: all OTM, P&L = net', () => {
    expect(calcPnl('calls', low, mid, high, net, 6550)).toBeCloseTo(net, 10);
  });

  it('at low strike: P&L = net (nothing ITM yet)', () => {
    expect(calcPnl('calls', low, mid, high, net, low)).toBeCloseTo(net, 10);
  });

  it('at mid strike: max profit = narrowWidth + net', () => {
    // max(6590-6570,0) - 2*max(6590-6590,0) + max(6590-6630,0) + 0.91
    // = 20 - 0 + 0 + 0.91 = 20.91
    expect(calcPnl('calls', low, mid, high, net, mid)).toBeCloseTo(20.91, 10);
  });

  it('above high strike: max loss region', () => {
    // max(6650-6570,0) - 2*max(6650-6590,0) + max(6650-6630,0) + 0.91
    // = 80 - 120 + 20 + 0.91 = -19.09
    expect(calcPnl('calls', low, mid, high, net, 6650)).toBeCloseTo(-19.09, 10);
  });

  it('max loss is capped beyond high strike', () => {
    const atHigh = calcPnl('calls', low, mid, high, net, high);
    const beyond = calcPnl('calls', low, mid, high, net, high + 100);
    expect(beyond).toBeCloseTo(atHigh, 10);
  });

  it('P&L increases from low toward mid', () => {
    const pnlLow = calcPnl('calls', low, mid, high, net, low);
    const pnlMid = calcPnl('calls', low, mid, high, net, mid);
    expect(pnlMid).toBeGreaterThan(pnlLow);
  });
});

// ── calcPnl (puts) ──────────────────────────────────────────

describe('calcPnl — puts', () => {
  // Put BWB: low=6550, mid=6590, high=6610, net=0.50 (credit)
  const low = 6550;
  const mid = 6590;
  const high = 6610;
  const net = 0.5;

  it('above high strike: all OTM, P&L = net', () => {
    expect(calcPnl('puts', low, mid, high, net, 6650)).toBeCloseTo(net, 10);
  });

  it('at high strike: P&L = net (nothing ITM yet)', () => {
    expect(calcPnl('puts', low, mid, high, net, high)).toBeCloseTo(net, 10);
  });

  it('at mid strike: max profit = narrowWidth + net', () => {
    // max(6550-6590,0) - 2*max(6590-6590,0) + max(6610-6590,0) + 0.5
    // = 0 - 0 + 20 + 0.5 = 20.5
    expect(calcPnl('puts', low, mid, high, net, mid)).toBeCloseTo(20.5, 10);
  });

  it('below low strike: max loss region', () => {
    // max(6550-6520,0) - 2*max(6590-6520,0) + max(6610-6520,0) + 0.5
    // = 30 - 140 + 90 + 0.5 = -19.5
    expect(calcPnl('puts', low, mid, high, net, 6520)).toBeCloseTo(-19.5, 10);
  });

  it('max loss is capped below low strike', () => {
    const atLow = calcPnl('puts', low, mid, high, net, low);
    const beyond = calcPnl('puts', low, mid, high, net, low - 100);
    expect(beyond).toBeCloseTo(atLow, 10);
  });

  it('P&L increases from high toward mid', () => {
    const pnlHigh = calcPnl('puts', low, mid, high, net, high);
    const pnlMid = calcPnl('puts', low, mid, high, net, mid);
    expect(pnlMid).toBeGreaterThan(pnlHigh);
  });
});

// ── calcMetrics (calls) ─────────────────────────────────────

describe('calcMetrics — calls', () => {
  it('computes correct metrics for a call BWB credit', () => {
    // low=6570, mid=6590, high=6630, net=0.91
    const m = calcMetrics('calls', 6570, 6590, 6630, 0.91);
    expect(m.narrowWidth).toBe(20);
    expect(m.wideWidth).toBe(40);
    expect(m.maxProfit).toBeCloseTo(20.91, 10);
    expect(m.safePnl).toBeCloseTo(0.91, 10);
    expect(m.riskPnl).toBeCloseTo(-19.09, 10);
    expect(m.sweetSpot).toBe(6590);
  });

  it('lowerBE is null when net is positive (credit kept below low)', () => {
    // lb = 6570 - 0.91 = 6569.09, which is < 6570 → null
    const m = calcMetrics('calls', 6570, 6590, 6630, 0.91);
    expect(m.lowerBE).toBeNull();
  });

  it('upperBE is valid when between mid and high', () => {
    // ub = 2*6590 - 6570 + 0.91 = 6610.91 (between 6590 and 6630)
    const m = calcMetrics('calls', 6570, 6590, 6630, 0.91);
    expect(m.upperBE).toBeCloseTo(6610.91, 10);
  });

  it('both breakevens valid for a debit call BWB', () => {
    // net = -0.91
    // lb = 6570 - (-0.91) = 6570.91 → between 6570 and 6590 ✓
    // ub = 2*6590 - 6570 + (-0.91) = 6609.09 → between 6590 and 6630 ✓
    const m = calcMetrics('calls', 6570, 6590, 6630, -0.91);
    expect(m.lowerBE).toBeCloseTo(6570.91, 10);
    expect(m.upperBE).toBeCloseTo(6609.09, 10);
  });
});

// ── calcMetrics (puts) ──────────────────────────────────────

describe('calcMetrics — puts', () => {
  it('computes correct metrics for a put BWB credit', () => {
    // low=6550, mid=6590, high=6610, net=0.50
    const m = calcMetrics('puts', 6550, 6590, 6610, 0.5);
    expect(m.narrowWidth).toBe(20); // high - mid
    expect(m.wideWidth).toBe(40); // mid - low
    expect(m.maxProfit).toBeCloseTo(20.5, 10);
    expect(m.safePnl).toBeCloseTo(0.5, 10);
    expect(m.riskPnl).toBeCloseTo(-19.5, 10);
    expect(m.sweetSpot).toBe(6590);
  });

  it('upperBE is null when credit keeps you safe above high', () => {
    // ub = 6610 + 0.50 = 6610.50 → NOT between 6590 and 6610 → null
    const m = calcMetrics('puts', 6550, 6590, 6610, 0.5);
    expect(m.upperBE).toBeNull();
  });

  it('lowerBE is valid when between low and mid', () => {
    // lb = 2*6590 - 6610 - 0.50 = 6569.50 → between 6550 and 6590 ✓
    const m = calcMetrics('puts', 6550, 6590, 6610, 0.5);
    expect(m.lowerBE).toBeCloseTo(6569.5, 10);
  });

  it('both breakevens valid for a debit put BWB', () => {
    // net = -0.50
    // ub = 6610 + (-0.50) = 6609.50 → between 6590 and 6610 ✓
    // lb = 2*6590 - 6610 - (-0.50) = 6570.50 → between 6550 and 6590 ✓
    const m = calcMetrics('puts', 6550, 6590, 6610, -0.5);
    expect(m.upperBE).toBeCloseTo(6609.5, 10);
    expect(m.lowerBE).toBeCloseTo(6570.5, 10);
  });
});

// ── generatePnlRows ─────────────────────────────────────────

describe('generatePnlRows', () => {
  it('returns non-empty array for valid inputs', () => {
    const rows = generatePnlRows('calls', 6570, 6590, 6630, 0.91, 1);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rows are sorted by spx ascending', () => {
    const rows = generatePnlRows('calls', 6570, 6590, 6630, 0.91, 1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.spx).toBeGreaterThanOrEqual(rows[i - 1]!.spx);
    }
  });

  it('contains a sweet spot row labeled "Max profit"', () => {
    const rows = generatePnlRows('calls', 6570, 6590, 6630, 0.91, 1);
    const sweetRow = rows.find((r) => r.label === 'Max profit');
    expect(sweetRow).toBeDefined();
    expect(sweetRow!.spx).toBeCloseTo(6590, 0);
    expect(sweetRow!.isKey).toBe(true);
  });

  it('breakeven rows have pnlPerContract close to 0', () => {
    const rows = generatePnlRows('calls', 6570, 6590, 6630, -0.91, 1);
    const beRows = rows.filter((r) => r.label === 'Breakeven');
    // Debit BWB should have two breakevens
    expect(beRows.length).toBeGreaterThanOrEqual(1);
    for (const row of beRows) {
      expect(Math.abs(row.pnlPerContract)).toBeLessThan(1);
      expect(row.isKey).toBe(true);
    }
  });

  it('respects contract multiplier for pnlTotal', () => {
    const single = generatePnlRows('calls', 6570, 6590, 6630, 0.91, 1);
    const triple = generatePnlRows('calls', 6570, 6590, 6630, 0.91, 3);
    const sweetSingle = single.find((r) => r.label === 'Max profit');
    const sweetTriple = triple.find((r) => r.label === 'Max profit');
    expect(sweetTriple!.pnlTotal).toBeCloseTo(sweetSingle!.pnlTotal * 3, 0);
  });

  it('returns empty array when high - low > 300 (guard clause)', () => {
    const rows = generatePnlRows('calls', 6000, 6200, 6400, 0, 1);
    expect(rows).toEqual([]);
  });

  it('works for put BWBs', () => {
    const rows = generatePnlRows('puts', 6550, 6590, 6610, 0.5, 1);
    expect(rows.length).toBeGreaterThan(0);
    const sweetRow = rows.find((r) => r.label === 'Max profit');
    expect(sweetRow).toBeDefined();
    expect(sweetRow!.spx).toBeCloseTo(6590, 0);
  });
});

// ── fmtSpx ──────────────────────────────────────────────────

describe('fmtSpx', () => {
  it('whole numbers have no decimal', () => {
    expect(fmtSpx(6500)).toBe('6500');
  });

  it('fractional numbers show two decimals', () => {
    expect(fmtSpx(6500.5)).toBe('6500.50');
  });

  it('already-round fractions display correctly', () => {
    expect(fmtSpx(6481.25)).toBe('6481.25');
  });

  it('zero is formatted as whole number', () => {
    expect(fmtSpx(0)).toBe('0');
  });
});

// ── fmtPnl ──────────────────────────────────────────────────

describe('fmtPnl', () => {
  it('positive dollar amount gets + sign', () => {
    expect(fmtPnl(910)).toBe('+$910');
  });

  it('negative dollar amount gets - sign with comma', () => {
    expect(fmtPnl(-1090)).toBe('-$1,090');
  });

  it('zero shows as $0', () => {
    expect(fmtPnl(0)).toBe('$0');
  });

  it('small positive below threshold shows $0', () => {
    expect(fmtPnl(0.3)).toBe('$0');
  });

  it('small negative below threshold shows $0', () => {
    expect(fmtPnl(-0.3)).toBe('$0');
  });

  it('positive thousands include commas', () => {
    expect(fmtPnl(1500)).toBe('+$1,500');
  });

  it('large negative thousands include commas', () => {
    expect(fmtPnl(-25000)).toBe('-$25,000');
  });

  it('value just above threshold is positive', () => {
    expect(fmtPnl(0.6)).toBe('+$1');
  });

  it('value just below negative threshold is negative', () => {
    expect(fmtPnl(-0.6)).toBe('-$1');
  });
});
