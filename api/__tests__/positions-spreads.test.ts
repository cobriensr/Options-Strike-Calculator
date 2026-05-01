// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildPositionResponse,
  buildSummary,
  groupIntoSpreads,
  type Spread,
} from '../_lib/positions-spreads.js';
import type { PositionLeg } from '../_lib/db.js';

// ============================================================
// Helpers
// ============================================================

function makeLeg(overrides: Partial<PositionLeg> = {}): PositionLeg {
  return {
    putCall: 'CALL',
    symbol: 'SPXW  240315C05800000',
    strike: 5800,
    expiration: '2024-03-15',
    quantity: -1,
    averagePrice: 1.5,
    marketValue: -100,
    delta: undefined,
    theta: undefined,
    gamma: undefined,
    ...overrides,
  };
}

// ============================================================
// groupIntoSpreads
// ============================================================

describe('groupIntoSpreads', () => {
  it('returns an empty array when there are no legs', () => {
    expect(groupIntoSpreads([])).toEqual([]);
  });

  it('pairs a short call with the closest long call (≤50pt distance)', () => {
    const short = makeLeg({
      putCall: 'CALL',
      strike: 5800,
      quantity: -1,
      averagePrice: 2.0,
      marketValue: -150,
    });
    const long = makeLeg({
      putCall: 'CALL',
      strike: 5810,
      quantity: 1,
      averagePrice: 1.0,
      marketValue: 80,
    });

    const spreads = groupIntoSpreads([short, long]);

    expect(spreads).toHaveLength(1);
    const s = spreads[0]!;
    expect(s.type).toBe('CALL CREDIT SPREAD');
    expect(s.shortLeg).toBe(short);
    expect(s.longLeg).toBe(long);
    // credit = |averagePrice short| - |averagePrice long| = 2 - 1 = 1.0
    expect(s.credit).toBe(1.0);
    // width = |5810 - 5800| = 10
    expect(s.width).toBe(10);
    // currentValue = |short marketValue| - |long marketValue| = 150 - 80 = 70
    expect(s.currentValue).toBe(70);
    // pnl = credit*100*qty - currentValue = 1*100*1 - 70 = 30
    expect(s.pnl).toBe(30);
  });

  it('pairs short and long PUTs into a put credit spread', () => {
    const short = makeLeg({
      putCall: 'PUT',
      strike: 5700,
      quantity: -2,
      averagePrice: 1.5,
      marketValue: -200,
    });
    const long = makeLeg({
      putCall: 'PUT',
      strike: 5680,
      quantity: 2,
      averagePrice: 0.5,
      marketValue: 60,
    });

    const spreads = groupIntoSpreads([short, long]);

    expect(spreads).toHaveLength(1);
    expect(spreads[0]!.type).toBe('PUT CREDIT SPREAD');
    expect(spreads[0]!.width).toBe(20);
  });

  it('does NOT pair when the closest long is more than 50 points away', () => {
    const short = makeLeg({
      putCall: 'CALL',
      strike: 5800,
      quantity: -1,
      averagePrice: 2.0,
      marketValue: -150,
    });
    const farLong = makeLeg({
      putCall: 'CALL',
      strike: 5900, // 100pt away
      quantity: 1,
      averagePrice: 0.1,
      marketValue: 10,
    });

    const spreads = groupIntoSpreads([short, farLong]);
    // Short becomes a SINGLE; the unmatched long is dropped (it is not
    // a short leg, and groupIntoSpreads only emits a row per short).
    expect(spreads).toHaveLength(1);
    expect(spreads[0]!.type).toBe('SINGLE');
    expect(spreads[0]!.longLeg).toBeUndefined();
    expect(spreads[0]!.width).toBe(0);
  });

  it('greedy-pairs each short with the nearest unused long (distance ≤50)', () => {
    // Two shorts at 5800 and 5810; two longs at 5810 and 5820.
    // Greedy by short order:
    //   short 5800 → nearest long is 5810 (dist 10) → paired
    //   short 5810 → nearest unused long is 5820 (dist 10) → paired
    const s1 = makeLeg({
      putCall: 'CALL',
      strike: 5800,
      quantity: -1,
      averagePrice: 2,
      marketValue: -150,
    });
    const s2 = makeLeg({
      putCall: 'CALL',
      strike: 5810,
      quantity: -1,
      averagePrice: 1.5,
      marketValue: -100,
    });
    const l1 = makeLeg({
      putCall: 'CALL',
      strike: 5810,
      quantity: 1,
      averagePrice: 1,
      marketValue: 80,
    });
    const l2 = makeLeg({
      putCall: 'CALL',
      strike: 5820,
      quantity: 1,
      averagePrice: 0.5,
      marketValue: 40,
    });

    const spreads = groupIntoSpreads([s1, s2, l1, l2]);

    expect(spreads).toHaveLength(2);
    const widths = spreads.map((s) => s.width).sort((a, b) => a - b);
    expect(widths).toEqual([10, 10]);
    expect(spreads.every((s) => s.type === 'CALL CREDIT SPREAD')).toBe(true);
  });

  it('emits a SINGLE spread when a short has no nearby long', () => {
    const naked = makeLeg({
      putCall: 'PUT',
      strike: 5500,
      quantity: -1,
      averagePrice: 0.5,
      marketValue: -25,
    });
    const spreads = groupIntoSpreads([naked]);

    expect(spreads).toHaveLength(1);
    const s = spreads[0]!;
    expect(s.type).toBe('SINGLE');
    expect(s.longLeg).toBeUndefined();
    expect(s.credit).toBe(0.5);
    expect(s.currentValue).toBe(25);
    // pnl for SINGLE = avgPx*100*qty - |marketValue| = 0.5*100*1 - 25 = 25
    expect(s.pnl).toBe(25);
    expect(s.pnlPct).toBe(0);
  });

  it('separates calls and puts so a put-long does not pair with a call-short', () => {
    const callShort = makeLeg({
      putCall: 'CALL',
      strike: 5800,
      quantity: -1,
      averagePrice: 2,
      marketValue: -150,
    });
    const putLong = makeLeg({
      putCall: 'PUT',
      strike: 5800,
      quantity: 1,
      averagePrice: 1,
      marketValue: 80,
    });

    const spreads = groupIntoSpreads([callShort, putLong]);
    // Call short remains unpaired (no call long available) → SINGLE.
    expect(spreads).toHaveLength(1);
    expect(spreads[0]!.type).toBe('SINGLE');
  });

  it('computes pnlPct from credit when credit > 0', () => {
    const short = makeLeg({
      putCall: 'CALL',
      strike: 5800,
      quantity: -1,
      averagePrice: 2.0,
      marketValue: -150,
    });
    const long = makeLeg({
      putCall: 'CALL',
      strike: 5810,
      quantity: 1,
      averagePrice: 1.0,
      marketValue: 80,
    });

    const spreads = groupIntoSpreads([short, long]);
    // credit*100*qty = 100; pnl = 30; pnlPct = 30/100*100 = 30%
    expect(spreads[0]!.pnlPct).toBe(30);
  });
});

// ============================================================
// buildSummary
// ============================================================

describe('buildSummary', () => {
  it('returns the no-positions placeholder for an empty spreads list', () => {
    expect(buildSummary([], [])).toBe('No open SPX 0DTE positions.');
  });

  it('formats call + put credit spreads with cushions', () => {
    const callShort = makeLeg({
      putCall: 'CALL',
      strike: 5825,
      quantity: -1,
      averagePrice: 2,
      marketValue: -150,
    });
    const callLong = makeLeg({
      putCall: 'CALL',
      strike: 5835,
      quantity: 1,
      averagePrice: 1,
      marketValue: 80,
    });
    const putShort = makeLeg({
      putCall: 'PUT',
      strike: 5775,
      quantity: -1,
      averagePrice: 1.5,
      marketValue: -100,
    });
    const putLong = makeLeg({
      putCall: 'PUT',
      strike: 5765,
      quantity: 1,
      averagePrice: 0.5,
      marketValue: 40,
    });
    const legs = [callShort, callLong, putShort, putLong];
    const spreads = groupIntoSpreads(legs);

    const summary = buildSummary(spreads, legs, 5800);

    expect(summary).toContain('Open SPX 0DTE Positions');
    expect(summary).toContain('SPX at fetch time: 5800');
    expect(summary).toContain('CALL CREDIT SPREADS (1):');
    expect(summary).toContain('Short 5825C / Long 5835C');
    expect(summary).toContain('Cushion: 25 pts above SPX');
    expect(summary).toContain('PUT CREDIT SPREADS (1):');
    expect(summary).toContain('Short 5775P / Long 5765P');
    expect(summary).toContain('Cushion: 25 pts below SPX');
    expect(summary).toContain('AGGREGATE:');
  });

  it('omits the SPX line when no spxPrice is given', () => {
    const callShort = makeLeg({ quantity: -1 });
    const spread: Spread = {
      type: 'CALL CREDIT SPREAD',
      shortLeg: callShort,
      longLeg: makeLeg({ strike: 5810, quantity: 1 }),
      credit: 1,
      currentValue: 50,
      pnl: 50,
      pnlPct: 50,
      width: 10,
    };
    const summary = buildSummary([spread], [callShort]);
    expect(summary).not.toContain('SPX at fetch time');
    expect(summary).not.toContain('Cushion:');
  });
});

// ============================================================
// buildPositionResponse
// ============================================================

describe('buildPositionResponse', () => {
  it('aggregates net Greeks and totals across spreads', () => {
    const callShort = makeLeg({
      putCall: 'CALL',
      strike: 5825,
      quantity: -2,
      averagePrice: 2,
      marketValue: -300,
      delta: -0.1,
      theta: 5,
      gamma: 0.02,
    });
    const callLong = makeLeg({
      putCall: 'CALL',
      strike: 5835,
      quantity: 2,
      averagePrice: 1,
      marketValue: 160,
      delta: 0.05,
      theta: -2,
      gamma: 0.01,
    });

    const r = buildPositionResponse([callShort, callLong], 5800);

    expect(r.callSpreadsCount).toBe(1);
    expect(r.putSpreadsCount).toBe(0);
    expect(r.spreads).toHaveLength(1);
    // netDelta = sum(delta * quantity) — quantity carries sign
    // = -0.1 * -2 + 0.05 * 2 = 0.2 + 0.1 = 0.3
    expect(r.netDelta).toBeCloseTo(0.3, 6);
    // netTheta = sum(theta * |quantity|) = 5*2 + -2*2 = 6
    expect(r.netTheta).toBeCloseTo(6, 6);
    // netGamma = sum(gamma * |quantity|) = 0.02*2 + 0.01*2 = 0.06
    expect(r.netGamma).toBeCloseTo(0.06, 6);
    // totalPnl = sum spread pnl
    expect(r.totalPnl).toBe(r.spreads[0]!.pnl);
  });
});
