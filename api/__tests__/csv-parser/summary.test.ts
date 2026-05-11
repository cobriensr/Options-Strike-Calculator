// @vitest-environment node

/**
 * Unit tests for api/_lib/csv-parser/summary.ts.
 *
 * Focus: the summary-string builder and the greedy short-to-long matcher.
 * Most cases drive `buildFullSummary` through a parsed CSV produced by
 * `parseFullCSV` so the test exercises the end-to-end positions path,
 * not just the summary in isolation.
 *
 * Parsing-only tests live in `./parse.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { parseFullCSV } from '../../_lib/csv-parser/parse.js';
import {
  buildFullSummary,
  pairShortsWithLongs,
} from '../../_lib/csv-parser/summary.js';
import type { PositionLeg } from '../../_lib/db.js';

// ── buildFullSummary ─────────────────────────────────────────────────

describe('buildFullSummary', () => {
  it('shows NO OPEN positions message when flat', () => {
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day,,,,"100,000.00"
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed);
    expect(summary).toContain('NO OPEN SPX 0DTE POSITIONS');
  });

  it('shows NO OPEN positions message when openLegs is empty (synthetic ParsedCSV)', () => {
    // Direct fixture — parsed.openLegs.length === 0 and parsed.allTrades is
    // empty too. This is the "trader is flat and uploaded a thin CSV"
    // path that buildFullSummary needs to handle without crashing.
    const summary = buildFullSummary({
      openLegs: [],
      closedSpreads: [],
      allTrades: [],
      dayPnl: null,
      ytdPnl: null,
      netLiquidatingValue: null,
      startingBalance: null,
      hasOptionsSection: false,
    });
    expect(summary).toContain('NO OPEN SPX 0DTE POSITIONS');
    // No P&L section either since dayPnl is null
    expect(summary).not.toContain("Today's P&L");
  });

  it('includes closed spread P&L when spreads were closed today', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6500,PUT,.10,.05,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6400,PUT,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6400,PUT,1.00,CREDIT,

Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
SPX,SPX INDEX,,,"1,900.00","1,900.00",
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed);
    expect(summary).toContain('Closed Today');
    expect(summary).toContain('PCS closed');
    expect(summary).toContain("Today's P&L");
  });

  it('shows open VERTICAL spreads from trade history', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6400,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed, 6600);
    expect(summary).toContain('OPEN SPX 0DTE Positions');
    expect(summary).toContain('PCS');
    expect(summary).toContain('6500');
    // SPX price provided → should show cushion
    expect(summary).toContain('pts cushion');
  });

  it('falls back to flat legs display when allTrades is empty but openLegs exist', () => {
    // Build a parsed object manually with openLegs but no allTrades
    // (simulates importing a positions-only CSV with no trade history)
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
SPX,.SPXW260407P6480,7 APR 26,6480,PUT,-10,1.50,0.80
SPX,.SPXW260407P6430,7 APR 26,6430,PUT,+10,0.50,0.20
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed, 6600);
    // Should show PUT CREDIT SPREADS in the fallback display
    expect(summary).toContain('OPEN SPX 0DTE Positions');
    expect(summary).toContain('PUT CREDIT SPREADS');
  });

  it('shows Max Risk section when open legs exist', () => {
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
SPX,.SPXW260407P6480,7 APR 26,6480,PUT,-10,1.50,0.80
SPX,.SPXW260407P6430,7 APR 26,6430,PUT,+10,0.50,0.20
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed);
    expect(summary).toContain('Max Risk');
  });

  it('shows closed CCS spreads section', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,SELL,-5,TO CLOSE,SPX,7 APR 26,6600,CALL,.10,.05,LMT
,,,BUY,+5,TO CLOSE,SPX,7 APR 26,6650,CALL,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,BUY,+5,TO OPEN,SPX,7 APR 26,6600,CALL,3.00,2.00,LMT
,,,SELL,-5,TO OPEN,SPX,7 APR 26,6650,CALL,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    const summary = buildFullSummary(parsed);
    expect(summary).toContain('CCS closed');
  });
});

// ── pairShortsWithLongs (extracted helper) ──────────────────

describe('pairShortsWithLongs', () => {
  // Build a minimal PositionLeg fixture — only the fields the matcher
  // actually reads (quantity sign for short/long classification, strike
  // for the distance gate). All other PositionLeg fields are filler so
  // the test focuses on the matching algorithm.
  function leg(
    quantity: number,
    strike: number,
    putCall: 'PUT' | 'CALL' = 'CALL',
  ): PositionLeg {
    return {
      putCall,
      symbol: `SPX_${strike}${putCall[0]}`,
      strike,
      expiration: '2026-04-07',
      quantity,
      averagePrice: 1.0,
      marketValue: 0,
      delta: undefined,
      theta: undefined,
      gamma: undefined,
    };
  }

  it('returns no entries when there are no shorts', () => {
    const out = pairShortsWithLongs([leg(+1, 6500), leg(+2, 6400)]);
    expect(out.results).toEqual([]);
    expect(out.hasShorts).toBe(false);
  });

  it('returns unmatched entries when there are no longs', () => {
    const shorts = [leg(-1, 6500), leg(-1, 6510)];
    const out = pairShortsWithLongs(shorts);
    expect(out.hasShorts).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.long).toBeNull();
    expect(out.results[1]?.long).toBeNull();
  });

  it('pairs each short with its nearest unused long (perfect pairing)', () => {
    // Two PCS at different strikes — each short pairs with its own long
    // 50pt away.
    const legs = [
      leg(-1, 6500, 'PUT'),
      leg(+1, 6450, 'PUT'),
      leg(-1, 6300, 'PUT'),
      leg(+1, 6250, 'PUT'),
    ];
    const out = pairShortsWithLongs(legs);
    expect(out.hasShorts).toBe(true);
    expect(out.results).toHaveLength(2);
    // Sorted ascending by short strike: 6300 first, then 6500.
    const r0 = out.results[0];
    if (!r0?.long) throw new Error('expected r0 paired');
    expect(r0.short.strike).toBe(6300);
    expect(r0.long.strike).toBe(6250);
    expect(r0.width).toBe(50);
    const r1 = out.results[1];
    if (!r1?.long) throw new Error('expected r1 paired');
    expect(r1.short.strike).toBe(6500);
    expect(r1.long.strike).toBe(6450);
  });

  it('leaves a short unpaired when no long is within the width cap', () => {
    // Width cap default = 200. 6500 short / 6000 long is 500 wide → reject.
    const legs = [leg(-1, 6500, 'PUT'), leg(+1, 6000, 'PUT')];
    const out = pairShortsWithLongs(legs);
    expect(out.hasShorts).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.long).toBeNull();
  });

  it('honors a custom maxWidth override', () => {
    // Same fixture as above, but pass maxWidth: 1000 to widen the cap so
    // the 500-pt gap pairs cleanly.
    const legs = [leg(-1, 6500, 'PUT'), leg(+1, 6000, 'PUT')];
    const out = pairShortsWithLongs(legs, { maxWidth: 1000 });
    expect(out.results[0]?.long?.strike).toBe(6000);
    expect(out.results[0]?.width).toBe(500);
  });

  it('greedy: first short by strike-asc grabs the only in-range long, second short stays unpaired', () => {
    // Two shorts at 6500 and 6510, one long at 6450.
    // Sort: short 6500 first → grabs long 6450 (50pt).
    // Short 6510 has no remaining long → unpaired.
    const legs = [
      leg(-1, 6500, 'PUT'),
      leg(-1, 6510, 'PUT'),
      leg(+1, 6450, 'PUT'),
    ];
    const out = pairShortsWithLongs(legs);
    expect(out.results).toHaveLength(2);
    const first = out.results[0];
    if (!first?.long) throw new Error('expected first paired');
    expect(first.short.strike).toBe(6500);
    expect(first.long.strike).toBe(6450);
    expect(out.results[1]?.long).toBeNull();
    expect(out.results[1]?.short.strike).toBe(6510);
  });

  it('symmetric: 1 short + 1 long at identical strike pair to a zero-width spread', () => {
    // Spread-builder fills can land both legs at the same strike when a
    // hedge is rolled to the same level. The matcher must still pair
    // them (0 distance is the closest possible) — the result is a
    // degenerate zero-width "spread", which downstream consumers
    // (computeSideMaxRisk) safely treat as zero risk via `Math.max(0, …)`.
    const legs = [leg(-1, 6500, 'PUT'), leg(+1, 6500, 'PUT')];
    const out = pairShortsWithLongs(legs);
    expect(out.hasShorts).toBe(true);
    expect(out.results).toHaveLength(1);
    const r = out.results[0];
    if (!r?.long) throw new Error('expected paired');
    expect(r.short.strike).toBe(6500);
    expect(r.long.strike).toBe(6500);
    expect(r.width).toBe(0);
  });
});
