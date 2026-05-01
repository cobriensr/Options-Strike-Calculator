// @vitest-environment node

/**
 * Unit tests for api/_lib/csv-parser.ts.
 *
 * Focus: the three audit items from docs/superpowers/specs/
 * principal-engineer-audit-2026-04-07.md that landed together —
 *   CSV-002 — 200pt spread cap (vs. old 50pt)
 *   CSV-003 — FIFO close matching for duplicate opens
 *   CSV-004 — TOS label brittleness via extracted constants
 *
 * These tests exercise behavior through the public `parseFullCSV` entry
 * point so the private parsers and label constants all get covered.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFullCSV,
  parseTosExpiration,
  parseCSVLine,
  buildFullSummary,
  pairShortsWithLongs,
} from '../_lib/csv-parser.js';
import type { PositionLeg } from '../_lib/db.js';

// ── CSV-002: wide-spread recognition ────────────────────────

describe('parseFullCSV — CSV-002 wide-spread cap', () => {
  it('recognizes a 100pt put credit spread as a spread (not naked legs)', () => {
    // 100pt PCS — would previously be dropped under the old 50pt cap and
    // reclassified as two naked legs. After the fix the options section
    // still parses them as legs, but the closed-spread matcher in trade
    // history must pair them as a single VERTICAL.
    const csv = `This document was exported from the paperMoney platform.

Account Statement for D-70001650 (ira) since 4/07/26 through 4/07/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day,,,,100000.00

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6500,PUT,.10,.05,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6400,PUT,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6400,PUT,1.00,CREDIT,

Profits and Losses
Symbol,Description,P/L Open
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.closedSpreads).toHaveLength(1);
    const spread = parsed.closedSpreads[0]!;
    expect(spread.type).toBe('PUT CREDIT SPREAD');
    expect(spread.shortStrike).toBe(6500);
    expect(spread.longStrike).toBe(6400);
    expect(spread.width).toBe(100);
  });

  it('recognizes a 200pt spread at the cap boundary', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+5,TO CLOSE,SPX,7 APR 26,6500,PUT,.10,.05,LMT
,,,SELL,-5,TO CLOSE,SPX,7 APR 26,6300,PUT,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,6500,PUT,4.00,3.00,LMT
,,,BUY,+5,TO OPEN,SPX,7 APR 26,6300,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.closedSpreads).toHaveLength(1);
    expect(parsed.closedSpreads[0]!.width).toBe(200);
  });

  it('does NOT recognize a 250pt spread (beyond cap — treated as parse noise)', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+5,TO CLOSE,SPX,7 APR 26,6500,PUT,.10,.05,LMT
,,,SELL,-5,TO CLOSE,SPX,7 APR 26,6250,PUT,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,6500,PUT,5.00,4.00,LMT
,,,BUY,+5,TO OPEN,SPX,7 APR 26,6250,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    // Legs not paired as a closed spread because width > 200
    expect(parsed.closedSpreads).toHaveLength(0);
  });
});

// ── CSV-003: FIFO close matching ────────────────────────────

describe('parseFullCSV — CSV-003 FIFO close matching', () => {
  it('matches the earliest open with the earliest close when two identical spreads exist', () => {
    // Two identical PCS opened at different times, then two identical closes
    // at different times. FIFO means first open pairs with first close.
    // We verify by checking the open-time / close-time pairings.
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6500,PUT,.20,.10,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6480,PUT,.10,DEBIT,
,4/07/26 13:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6500,PUT,.30,.20,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6480,PUT,.10,DEBIT,
,4/07/26 10:00:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,2.00,1.50,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6480,PUT,.50,CREDIT,
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6480,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.closedSpreads).toHaveLength(2);

    // Expect FIFO pairing: earliest open (09:30) ↔ earliest close (13:00),
    // then next open (10:00) ↔ next close (14:00).
    const sorted = [...parsed.closedSpreads].sort((a, b) =>
      a.openTime.localeCompare(b.openTime),
    );

    // First spread: opened 09:30, closed 13:00
    expect(sorted[0]!.openTime).toContain('09:30');
    expect(sorted[0]!.closeTime).toContain('13:00');

    // Second spread: opened 10:00, closed 14:00
    expect(sorted[1]!.openTime).toContain('10:00');
    expect(sorted[1]!.closeTime).toContain('14:00');
  });

  it('matches only the first open when only one close exists for two identical opens', () => {
    // Two identical opens, only one close — the EARLIER open should be
    // marked closed. The second open remains unmatched (no closed spread
    // record produced for it).
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 13:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6500,PUT,.20,.10,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6480,PUT,.10,DEBIT,
,4/07/26 10:00:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,2.00,1.50,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6480,PUT,.50,CREDIT,
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6500,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6480,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.closedSpreads).toHaveLength(1);
    // Should be the EARLIER open (09:30), not the 10:00 one
    expect(parsed.closedSpreads[0]!.openTime).toContain('09:30');
  });
});

// ── CSV-004: TOS label parsing ──────────────────────────────

describe('parseFullCSV — CSV-004 TOS label parsing', () => {
  it('extracts starting balance from "Cash balance at the start of business day" row', () => {
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day,,,,"123,456.78"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.startingBalance).toBe(123_456.78);
  });

  it('extracts starting balance when TOS appends a CST suffix to the label', () => {
    // Real TOS exports sometimes append " 25.03 CST" or similar to the
    // description string. `includes()` (not exact match) keeps this robust.
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day 07.04 CST,,,,"99,000.00"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.startingBalance).toBe(99_000);
  });

  it('returns null startingBalance when the label row is missing', () => {
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.startingBalance).toBeNull();
  });

  it('extracts dayPnl and ytdPnl from the "SPX," row in the PnL section', () => {
    const csv = `Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
SPX,SPX INDEX,,,"1,250.00","4,500.00",
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.dayPnl).toBe(1250);
    expect(parsed.ytdPnl).toBe(4500);
  });

  it('returns null dayPnl/ytdPnl when no SPX PnL row is present', () => {
    const csv = `Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.dayPnl).toBeNull();
    expect(parsed.ytdPnl).toBeNull();
  });

  it('extracts net liquidating value from "Net Liquidating Value," row', () => {
    const csv = `Account Summary
Net Liquidating Value,"267,572.57"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.netLiquidatingValue).toBe(267_572.57);
  });

  it('returns null netLiquidatingValue when the row is missing', () => {
    const csv = `Account Summary
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.netLiquidatingValue).toBeNull();
  });

  it('full end-to-end: all non-SPX-row labels parse in a single CSV', () => {
    const csv = `This document was exported from the paperMoney platform.

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day,,,,"200,000.00"

Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
SPX,SPX INDEX,,,"500.00","1,500.00",

Account Summary
Net Liquidating Value,"201,000.00"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.startingBalance).toBe(200_000);
    expect(parsed.dayPnl).toBe(500);
    expect(parsed.ytdPnl).toBe(1500);
    expect(parsed.netLiquidatingValue).toBe(201_000);
  });

  it('regression: SPX collision — Options section before Profits and Losses', () => {
    // Real TOS exports usually have the Options position section BEFORE
    // Profits and Losses. Option position rows also start with "SPX,".
    // Pre-fix, parsePnLSection would scan the whole file, match the
    // option row first, and parse fields[4]=strike (e.g. 5700) as a
    // dollar value — returning 5700 as dayPnl when the trader is
    // actually flat at +500. This corrupted Claude's analyze context
    // on every CSV upload with an open SPX position.
    //
    // Fix: parsePnLSection now anchors its SPX search to lines AFTER
    // the "Profits and Losses" section header.
    const csv = `This document was exported from the paperMoney platform.

Position Statement
Instrument,Qty,Days,Trade Price,Mark,Mrk Chng,P/L Open,P/L Day,BP Effect
SPX,100% SPX INDEX,,,,,,,
SPX,.SPXW260407C5700,APR 07 26,5700,CALL,-1,12.50,8.20,430.00,-15.00,
SPX,.SPXW260407P5650,APR 07 26,5650,PUT,-1,10.00,6.40,360.00,-8.00,

Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
SPX,SPX INDEX,,,"500.00","1,500.00",

Account Summary
Net Liquidating Value,"201,000.00"
`;
    const parsed = parseFullCSV(csv);
    // CRITICAL: dayPnl must be 500 (the real PnL row), NOT 5700 (the
    // strike on the first option row). Pre-fix this returned 5700.
    expect(parsed.dayPnl).toBe(500);
    expect(parsed.ytdPnl).toBe(1500);
    expect(parsed.netLiquidatingValue).toBe(201_000);
  });

  it('returns null dayPnl when the "Profits and Losses" section is missing entirely', () => {
    // Without the section anchor, an Options-only CSV (no PnL section)
    // must NOT mistakenly return a strike as dayPnl.
    const csv = `Position Statement
Instrument,Qty,Days,Trade Price,Mark,Mrk Chng,P/L Open,P/L Day,BP Effect
SPX,.SPXW260407C5700,APR 07 26,5700,CALL,-1,12.50,8.20,430.00,-15.00,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.dayPnl).toBeNull();
    expect(parsed.ytdPnl).toBeNull();
  });
});

// ── parseTosExpiration ──────────────────────────────────────────────

describe('parseTosExpiration', () => {
  it('converts "27 MAR 26" → "2026-03-27"', () => {
    expect(parseTosExpiration('27 MAR 26')).toBe('2026-03-27');
  });

  it('converts "7 APR 26" with single-digit day → "2026-04-07"', () => {
    expect(parseTosExpiration('7 APR 26')).toBe('2026-04-07');
  });

  it('handles all 12 months correctly', () => {
    const months = [
      ['JAN', '01'],
      ['FEB', '02'],
      ['MAR', '03'],
      ['APR', '04'],
      ['MAY', '05'],
      ['JUN', '06'],
      ['JUL', '07'],
      ['AUG', '08'],
      ['SEP', '09'],
      ['OCT', '10'],
      ['NOV', '11'],
      ['DEC', '12'],
    ] as const;
    for (const [abbr, num] of months) {
      expect(parseTosExpiration(`15 ${abbr} 26`)).toBe(`2026-${num}-15`);
    }
  });

  it('returns raw string when not 3 parts (wrong format)', () => {
    expect(parseTosExpiration('APR 26')).toBe('APR 26');
    expect(parseTosExpiration('')).toBe('');
    expect(parseTosExpiration('7 APR 26 EXTRA')).toBe('7 APR 26 EXTRA');
  });

  it('returns raw string when month abbreviation is unrecognized', () => {
    expect(parseTosExpiration('07 XYZ 26')).toBe('07 XYZ 26');
  });

  it('handles 4-digit year without prepending "20"', () => {
    expect(parseTosExpiration('15 MAR 2026')).toBe('2026-03-15');
  });

  it('is case-insensitive for month abbreviation', () => {
    expect(parseTosExpiration('15 mar 26')).toBe('2026-03-15');
    expect(parseTosExpiration('15 Mar 26')).toBe('2026-03-15');
  });
});

// ── parseCSVLine ────────────────────────────────────────────────────

describe('parseCSVLine', () => {
  it('splits a simple unquoted CSV line', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseCSVLine('"hello, world",foo,bar')).toEqual([
      'hello, world',
      'foo',
      'bar',
    ]);
  });

  it('trims whitespace from unquoted fields', () => {
    expect(parseCSVLine('  a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('handles a quoted field with an embedded comma AND surrounding fields', () => {
    const fields = parseCSVLine('DATE,"1,234.56",END');
    expect(fields).toEqual(['DATE', '1,234.56', 'END']);
  });

  it('handles empty fields (consecutive commas)', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('handles a line with a single field (no commas)', () => {
    expect(parseCSVLine('hello')).toEqual(['hello']);
  });

  it('handles an empty string', () => {
    expect(parseCSVLine('')).toEqual(['']);
  });

  it('toggles quote state correctly across multiple quoted fields', () => {
    // Two quoted fields in one line
    expect(parseCSVLine('"foo","bar"')).toEqual(['foo', 'bar']);
  });
});

// ── parseFullCSV — options section edge cases ──────────────────────

describe('parseFullCSV — options section', () => {
  it('parses open legs from the Options section with mark value column', () => {
    // The options section includes a "Mark Value" column (9th column)
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,.SPXW260407P6480,7 APR 26,6480,PUT,-10,1.50,0.80,"(800.00)"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.hasOptionsSection).toBe(true);
    expect(parsed.openLegs).toHaveLength(1);
    const leg = parsed.openLegs[0]!;
    expect(leg.putCall).toBe('PUT');
    expect(leg.strike).toBe(6480);
    expect(leg.quantity).toBe(-10);
    expect(leg.averagePrice).toBe(1.5);
  });

  it('skips non-SPX rows in the options section', () => {
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
QQQ,.QQQ260407P350,7 APR 26,350,PUT,-5,1.00,0.50
SPX,.SPXW260407C6600,7 APR 26,6600,CALL,-5,2.00,1.00
`;
    const parsed = parseFullCSV(csv);
    // Only SPX leg should be included
    expect(parsed.openLegs).toHaveLength(1);
    expect(parsed.openLegs[0]!.putCall).toBe('CALL');
  });

  it('skips rows with invalid put/call type in options section', () => {
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
SPX,.SPXW260407X6500,7 APR 26,6500,UNKNOWN,-5,1.00,0.50
SPX,.SPXW260407C6600,7 APR 26,6600,CALL,-5,2.00,1.00
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.openLegs).toHaveLength(1);
    expect(parsed.openLegs[0]!.putCall).toBe('CALL');
  });

  it('skips rows where strike is NaN', () => {
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
SPX,.SPXW260407P,7 APR 26,NOTANUMBER,PUT,-5,1.00,0.50
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.openLegs).toHaveLength(0);
  });

  it('stops parsing options at OVERALL TOTALS line', () => {
    const csv = `Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark
SPX,.SPXW260407P6480,7 APR 26,6480,PUT,-10,1.50,0.80
,OVERALL TOTALS,,,,,,,
SPX,.SPXW260407C6600,7 APR 26,6600,CALL,-5,2.00,1.00
`;
    const parsed = parseFullCSV(csv);
    // Only the PUT before OVERALL TOTALS should be included
    expect(parsed.openLegs).toHaveLength(1);
    expect(parsed.openLegs[0]!.putCall).toBe('PUT');
  });

  it('returns empty openLegs when options section header is missing', () => {
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.openLegs).toHaveLength(0);
    expect(parsed.hasOptionsSection).toBe(false);
  });
});

// ── parseFullCSV — CALL credit spreads ────────────────────────────

describe('parseFullCSV — CALL credit spreads', () => {
  it('recognizes a closed CALL credit spread', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,SELL,-5,TO CLOSE,SPX,7 APR 26,6600,CALL,.15,.08,LMT
,,,BUY,+5,TO CLOSE,SPX,7 APR 26,6650,CALL,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,BUY,+5,TO OPEN,SPX,7 APR 26,6600,CALL,3.00,2.00,LMT
,,,SELL,-5,TO OPEN,SPX,7 APR 26,6650,CALL,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.closedSpreads).toHaveLength(1);
    const spread = parsed.closedSpreads[0]!;
    expect(spread.type).toBe('CALL CREDIT SPREAD');
    expect(spread.shortStrike).toBe(6650);
    expect(spread.longStrike).toBe(6600);
    expect(spread.width).toBe(50);
  });
});

// ── parseFullCSV — fallback open legs from trade history ────────────

describe('parseFullCSV — fallback open legs from trade history', () => {
  it('derives open legs from trade history when no options section is present', () => {
    // No "Symbol,Option Code,Exp,Strike..." options header → no options section.
    // Trades: 10 opens of 6480 PUT, 0 closes → 10 remain open.
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6480,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6430,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.hasOptionsSection).toBe(false);
    // Both legs should be reflected as open positions
    expect(parsed.openLegs.length).toBeGreaterThan(0);
  });

  it('nets out fully-closed legs from the fallback open list', () => {
    // 10 opens, 10 closes → net 0 remaining for the short leg
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,7 APR 26,6480,PUT,.10,.05,LMT
,,,SELL,-10,TO CLOSE,SPX,7 APR 26,6430,PUT,.05,DEBIT,
,4/07/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,7 APR 26,6480,PUT,3.00,2.00,LMT
,,,BUY,+10,TO OPEN,SPX,7 APR 26,6430,PUT,1.00,CREDIT,
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.hasOptionsSection).toBe(false);
    // After netting, no legs should remain open (spread was fully closed)
    expect(parsed.openLegs).toHaveLength(0);
  });
});

// ── parseFullCSV — trade history parsing edge cases ─────────────────

describe('parseFullCSV — trade history edge cases', () => {
  it('returns empty allTrades when Account Trade History section is missing', () => {
    const csv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
4/07/26,00:00:00,BAL,,Cash balance at the start of business day,,,,"100,000.00"
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('returns empty allTrades when trade history header row is missing', () => {
    // Section marker exists but no "Exec Time,Strike" header within 5 lines
    const csv = `Account Trade History
This is some other content
More content
More
More
More
More content past look-ahead
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('skips trade rows for non-SPX symbols', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,QQQ,7 APR 26,350,PUT,1.00,0.50,LMT
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('skips trade rows with missing strike or price', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,,PUT,,0.50,LMT
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('skips trade rows with NaN strike', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,BADSTRIKE,PUT,1.00,0.50,LMT
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('skips trade rows with zero quantity', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,0,TO OPEN,SPX,7 APR 26,6480,PUT,1.00,0.50,LMT
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.allTrades).toHaveLength(0);
  });

  it('defaults posEffect to TO OPEN when value is neither TO OPEN nor TO CLOSE', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-5,UNKNOWN_EFFECT,SPX,7 APR 26,6480,PUT,1.00,0.50,LMT
`;
    const parsed = parseFullCSV(csv);
    // The row should still be parsed and treated as TO OPEN
    expect(parsed.allTrades).toHaveLength(1);
    expect(parsed.allTrades[0]!.posEffect).toBe('TO OPEN');
  });

  it('stops parsing trade history rows when a non-comma-leading line is encountered', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,4/07/26 09:30:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,6480,PUT,3.00,2.00,LMT
This line does not start with comma — ends the section
,4/07/26 10:00:00,VERTICAL,SELL,-5,TO OPEN,SPX,7 APR 26,6500,PUT,2.00,1.50,LMT
`;
    const parsed = parseFullCSV(csv);
    // Only the first trade row should be parsed (section ends at non-comma line)
    expect(parsed.allTrades).toHaveLength(1);
    expect(parsed.allTrades[0]!.strike).toBe(6480);
  });
});

// ── parseFullCSV — negative/parenthetical dollar values ─────────────

describe('parseFullCSV — negative dollar value parsing', () => {
  it('parses negative P&L in parenthetical format', () => {
    const csv = `Profits and Losses
Symbol,Description,Qty,Trade Price,P/L Day,P/L YTD,Mark Value
SPX,SPX INDEX,,,"(1,250.00)","(4,500.00)",
`;
    const parsed = parseFullCSV(csv);
    expect(parsed.dayPnl).toBe(-1250);
    expect(parsed.ytdPnl).toBe(-4500);
  });
});

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
});
