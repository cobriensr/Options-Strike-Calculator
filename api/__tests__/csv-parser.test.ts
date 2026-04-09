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
import { parseFullCSV } from '../_lib/csv-parser.js';

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
