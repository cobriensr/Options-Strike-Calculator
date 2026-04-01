// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn(),
  schwabTraderFetch: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/db.js', () => ({
  savePositions: vi.fn(),
  getDb: vi.fn(() => {
    const fn = async () => [];
    // Tagged template support for sql``
    fn.call = fn;
    return fn;
  }),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import handler from '../positions.js';
import { parseFullCSV, parseTosExpiration } from '../_lib/csv-parser.js';
import { rejectIfNotOwner, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { savePositions } from '../_lib/db.js';

// ── Sample CSV matching the real paperMoney export format ─────────
const SAMPLE_CSV = `\ufeffThis document was exported from the paperMoney platform.

Account Statement for D-70001650 (ira) since 3/16/26 through 3/16/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/17/26,00:00:00,BAL,,Cash balance at the start of business day,,,,202146.08

Futures Statements
Trade Date,Exec Date,Exec Time,Type,Ref #,Description,Misc Fees,Commissions & Fees,Amount,Balance

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P6660,17 MAR 26,6660,PUT,+20,.925,.225,$450.00
SPX,SPXW260317P6665,17 MAR 26,6665,PUT,+20,.85,.225,$450.00
SPX,SPXW260317P6670,17 MAR 26,6670,PUT,+20,.975,.275,$550.00
SPX,SPXW260317P6675,17 MAR 26,6675,PUT,+20,1.15,.275,$550.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
SPX,SPXW260317P6685,17 MAR 26,6685,PUT,-20,1.525,.375,($750.00)
SPX,SPXW260317P6690,17 MAR 26,6690,PUT,-20,1.775,.425,($850.00)
SPX,SPXW260317P6695,17 MAR 26,6695,PUT,-20,2.30,.525,"($1,050.00)"
,OVERALL TOTALS,,,,,,,"($1,300.00)"

Profits and Losses
Symbol,Description,P/L Open
`;

const MINIMAL_CSV = `Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
SPX,SPXW260317P5800,17 MAR 26,5800,PUT,-5,1.50,.50,($250.00)
SPX,SPXW260317P5780,17 MAR 26,5780,PUT,+5,.60,.20,$100.00
,OVERALL TOTALS,,,,,,,"($150.00)"
`;

// ── Sample CSV with all positions closed (no Options section) ─────
const CLOSED_POSITIONS_CSV = `This document was exported from the paperMoney platform.

Account Statement for D-70001650 (ira) since 3/24/26 through 3/24/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/25/26,00:00:00,BAL,,Cash balance at the start of business day 25.03 CST,,,,"265,519.61"
3/25/26,09:23:22,TRD,="5319289492",SOLD -20 VERTICAL SPX 100 (Weeklys) 25 MAR 26 6535/6515 PUT @1.05,-21.04,-26.00,"2,100.00","267,572.57"
3/25/26,14:20:49,TRD,="5319624867",BOT +20 VERTICAL SPX 100 (Weeklys) 25 MAR 26 6535/6515 PUT @.05,-17.44,-26.00,-100.00,"277,388.01"

Futures Statements
Trade Date,Exec Date,Exec Time,Type,Ref #,Description,Misc Fees,Commissions & Fees,Amount,Balance

Forex Statements
,Date,Time,Type,Ref #,Description,Commissions & Fees,Amount,Amount(USD),Balance

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/25/26 14:20:49,VERTICAL,BUY,+20,TO CLOSE,SPX,25 MAR 26,6535,PUT,.15,.05,LMT
,,,SELL,-20,TO CLOSE,SPX,25 MAR 26,6515,PUT,.10,DEBIT,
,3/25/26 09:23:22,VERTICAL,SELL,-20,TO OPEN,SPX,25 MAR 26,6535,PUT,2.65,1.05,LMT
,,,BUY,+20,TO OPEN,SPX,25 MAR 26,6515,PUT,1.60,CREDIT,

Profits and Losses
Symbol,Description,P/L Open
`;

// ── Larger closed CSV with multiple spreads (matches user's actual export) ─────
const CLOSED_MULTI_SPREAD_CSV = `This document was exported from the paperMoney platform.

Account Statement for D-70001650 (ira) since 3/24/26 through 3/24/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/25/26,00:00:00,BAL,,Cash balance at the start of business day 25.03 CST,,,,"265,519.61"

Futures Statements
Trade Date,Exec Date,Exec Time,Type,Ref #,Description,Misc Fees,Commissions & Fees,Amount,Balance

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/25/26 14:35:16,VERTICAL,BUY,+20,TO CLOSE,SPX,25 MAR 26,6550,PUT,.15,.05,LMT
,,,SELL,-20,TO CLOSE,SPX,25 MAR 26,6530,PUT,.10,DEBIT,
,3/25/26 14:27:54,VERTICAL,BUY,+20,TO CLOSE,SPX,25 MAR 26,6545,PUT,.15,.05,LMT
,,,SELL,-20,TO CLOSE,SPX,25 MAR 26,6525,PUT,.10,DEBIT,
,3/25/26 14:21:05,VERTICAL,BUY,+20,TO CLOSE,SPX,25 MAR 26,6540,PUT,.15,.05,LMT
,,,SELL,-20,TO CLOSE,SPX,25 MAR 26,6520,PUT,.10,DEBIT,
,3/25/26 14:20:49,VERTICAL,BUY,+20,TO CLOSE,SPX,25 MAR 26,6535,PUT,.15,.05,LMT
,,,SELL,-20,TO CLOSE,SPX,25 MAR 26,6515,PUT,.10,DEBIT,
,3/25/26 09:24:39,VERTICAL,SELL,-20,TO OPEN,SPX,25 MAR 26,6550,PUT,5.00,2.20,LMT
,,,BUY,+20,TO OPEN,SPX,25 MAR 26,6530,PUT,2.80,CREDIT,
,3/25/26 09:24:13,VERTICAL,SELL,-20,TO OPEN,SPX,25 MAR 26,6545,PUT,3.70,1.55,LMT
,,,BUY,+20,TO OPEN,SPX,25 MAR 26,6525,PUT,2.15,CREDIT,
,3/25/26 09:23:56,VERTICAL,SELL,-20,TO OPEN,SPX,25 MAR 26,6540,PUT,3.10,1.30,LMT
,,,BUY,+20,TO OPEN,SPX,25 MAR 26,6520,PUT,1.80,CREDIT,
,3/25/26 09:23:22,VERTICAL,SELL,-20,TO OPEN,SPX,25 MAR 26,6535,PUT,2.65,1.05,LMT
,,,BUY,+20,TO OPEN,SPX,25 MAR 26,6515,PUT,1.60,CREDIT,

Profits and Losses
Symbol,Description,P/L Open
`;

describe('parseTosExpiration', () => {
  it('parses "17 MAR 26" → "2026-03-17"', () => {
    expect(parseTosExpiration('17 MAR 26')).toBe('2026-03-17');
  });

  it('parses "5 JAN 27" → "2027-01-05"', () => {
    expect(parseTosExpiration('5 JAN 27')).toBe('2027-01-05');
  });

  it('handles 4-digit year', () => {
    expect(parseTosExpiration('17 MAR 2026')).toBe('2026-03-17');
  });

  it('returns raw input for unparseable dates', () => {
    expect(parseTosExpiration('bad')).toBe('bad');
  });
});

describe('parseFullCSV — Options section (open positions)', () => {
  it('extracts all 8 SPX legs with Options section present', () => {
    const parsed = parseFullCSV(SAMPLE_CSV);
    expect(parsed.openLegs).toHaveLength(8);
    expect(parsed.hasOptionsSection).toBe(true);
  });

  it('correctly parses short legs (negative quantity)', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    const shorts = openLegs.filter((l: { quantity: number }) => l.quantity < 0);
    expect(shorts).toHaveLength(4);
    expect(
      shorts
        .map((l: { strike: number }) => l.strike)
        .sort((a: number, b: number) => a - b),
    ).toEqual([6680, 6685, 6690, 6695]);
    for (const leg of shorts) {
      expect(leg.quantity).toBe(-20);
    }
  });

  it('correctly parses long legs (positive quantity)', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    const longs = openLegs.filter((l: { quantity: number }) => l.quantity > 0);
    expect(longs).toHaveLength(4);
    expect(
      longs
        .map((l: { strike: number }) => l.strike)
        .sort((a: number, b: number) => a - b),
    ).toEqual([6660, 6665, 6670, 6675]);
  });

  it('sets putCall to PUT for all legs', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    for (const leg of openLegs) {
      expect(leg.putCall).toBe('PUT');
    }
  });

  it('parses expiration dates correctly', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    for (const leg of openLegs) {
      expect(leg.expiration).toBe('2026-03-17');
    }
  });

  it('parses averagePrice (Trade Price) correctly', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    const leg6695 = openLegs.find((l: { strike: number }) => l.strike === 6695);
    expect(leg6695?.averagePrice).toBe(2.3);
  });

  it('parses marketValue (Mark Value) correctly including negatives', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    const long6660 = openLegs.find(
      (l: { strike: number; quantity: number }) =>
        l.strike === 6660 && l.quantity > 0,
    );
    expect(long6660?.marketValue).toBe(450);

    const short6695 = openLegs.find(
      (l: { strike: number; quantity: number }) =>
        l.strike === 6695 && l.quantity < 0,
    );
    expect(short6695?.marketValue).toBe(-1050);
  });

  it('sets symbol from Option Code column', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    const leg = openLegs.find((l: { strike: number }) => l.strike === 6660);
    expect(leg?.symbol).toBe('SPXW260317P6660');
  });

  it('ignores non-SPX rows', () => {
    const csvWithNonSPX = `Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value
AAPL,AAPL260317C150,17 MAR 26,150,CALL,+10,2.00,2.50,$2500.00
SPX,SPXW260317P6680,17 MAR 26,6680,PUT,-20,1.575,.325,($650.00)
,OVERALL TOTALS,,,,,,,$1850.00
`;
    const { openLegs } = parseFullCSV(csvWithNonSPX);
    expect(openLegs).toHaveLength(1);
    expect(openLegs[0]?.strike).toBe(6680);
  });

  it('returns empty legs if no Options or Trade History section found', () => {
    const noOptions = 'Cash Balance\nDATE,TIME,AMOUNT\n3/17/26,00:00:00,1000';
    const { openLegs } = parseFullCSV(noOptions);
    expect(openLegs).toEqual([]);
  });

  it('stops parsing at OVERALL TOTALS row', () => {
    const { openLegs } = parseFullCSV(SAMPLE_CSV);
    expect(openLegs).toHaveLength(8);
  });
});

describe('parseFullCSV — Account Trade History (closed positions)', () => {
  it('identifies closed spreads from trade history', () => {
    const parsed = parseFullCSV(CLOSED_POSITIONS_CSV);
    expect(parsed.hasOptionsSection).toBe(false);
    expect(parsed.closedSpreads).toHaveLength(1);
    // All legs closed — no remaining open legs
    expect(parsed.openLegs).toHaveLength(0);
  });

  it('parses TO OPEN trades with correct strikes and quantities', () => {
    const { allTrades } = parseFullCSV(CLOSED_POSITIONS_CSV);
    const opens = allTrades.filter(
      (t: { posEffect: string }) => t.posEffect === 'TO OPEN',
    );
    expect(opens).toHaveLength(2);
    const short = opens.find((t: { quantity: number }) => t.quantity < 0);
    const long = opens.find((t: { quantity: number }) => t.quantity > 0);
    expect(short?.strike).toBe(6535);
    expect(short?.quantity).toBe(-20);
    expect(long?.strike).toBe(6515);
    expect(long?.quantity).toBe(20);
  });

  it('sets price from the TO OPEN trade price', () => {
    const { allTrades } = parseFullCSV(CLOSED_POSITIONS_CSV);
    const opens = allTrades.filter(
      (t: { posEffect: string }) => t.posEffect === 'TO OPEN',
    );
    const short = opens.find((t: { strike: number }) => t.strike === 6535);
    const long = opens.find((t: { strike: number }) => t.strike === 6515);
    expect(short?.price).toBe(2.65);
    expect(long?.price).toBe(1.6);
  });

  it('captures TO CLOSE trades for P&L calculation', () => {
    const { allTrades } = parseFullCSV(CLOSED_POSITIONS_CSV);
    const closes = allTrades.filter(
      (t: { posEffect: string }) => t.posEffect === 'TO CLOSE',
    );
    expect(closes).toHaveLength(2);
    const closedShort = closes.find(
      (t: { strike: number }) => t.strike === 6535,
    );
    const closedLong = closes.find(
      (t: { strike: number }) => t.strike === 6515,
    );
    expect(closedShort?.price).toBe(0.15);
    expect(closedLong?.price).toBe(0.1);
  });

  it('parses expiration correctly from trade history', () => {
    const { allTrades } = parseFullCSV(CLOSED_POSITIONS_CSV);
    for (const trade of allTrades) {
      expect(trade.expiration).toBe('2026-03-25');
    }
  });

  it('extracts all 4 closed spreads from multi-spread CSV', () => {
    const parsed = parseFullCSV(CLOSED_MULTI_SPREAD_CSV);
    expect(parsed.hasOptionsSection).toBe(false);
    expect(parsed.closedSpreads).toHaveLength(4);
    // All closed — no remaining open legs
    expect(parsed.openLegs).toHaveLength(0);

    const shortStrikes = parsed.closedSpreads
      .map((s: { shortStrike: number }) => s.shortStrike)
      .sort((a: number, b: number) => a - b);
    const longStrikes = parsed.closedSpreads
      .map((s: { longStrike: number }) => s.longStrike)
      .sort((a: number, b: number) => a - b);
    expect(shortStrikes).toEqual([6535, 6540, 6545, 6550]);
    expect(longStrikes).toEqual([6515, 6520, 6525, 6530]);
  });
});

describe('POST /api/positions (CSV upload)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(undefined as never);
    vi.mocked(savePositions).mockResolvedValue(1);
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: SAMPLE_CSV }), res);
    expect(res._status).toBe(401);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 400 for empty body', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: '' }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/empty/i);
  });

  it('returns 400 for CSV without Options section', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: 'no options here' }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/no spx options/i);
  });

  it('returns 400 for non-string body without csv field', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { notCsv: true } }), res);
    expect(res._status).toBe(400);
  });

  it('accepts JSON body with csv field', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { csv: MINIMAL_CSV } }),
      res,
    );
    expect(res._status).toBe(200);
    const data = res._json as {
      positions: { stats: { totalSpreads: number } };
      source: string;
    };
    expect(data.positions.stats.totalSpreads).toBe(1);
    expect(data.source).toBe('paperMoney');
  });

  it('parses full CSV and returns correct spread count', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: SAMPLE_CSV }), res);
    expect(res._status).toBe(200);
    const data = res._json as {
      positions: {
        legs: unknown[];
        spreads: unknown[];
        stats: {
          totalSpreads: number;
          putSpreads: number;
          callSpreads: number;
        };
        summary: string;
      };
      source: string;
    };
    expect(data.positions.legs).toHaveLength(8);
    expect(data.positions.stats.putSpreads).toBe(4);
    expect(data.positions.stats.callSpreads).toBe(0);
    expect(data.positions.summary).toContain('PUT CREDIT SPREADS');
    expect(data.source).toBe('paperMoney');
  });

  it('saves positions to DB with accountHash "paperMoney"', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect(savePositions).toHaveBeenCalledTimes(1);
    const call = vi.mocked(savePositions).mock.calls[0]![0];
    expect(call.accountHash).toBe('paperMoney');
    expect(call.legs).toHaveLength(2);
  });

  it('returns saved: true when DB save succeeds', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect((res._json as { saved: boolean }).saved).toBe(true);
  });

  it('returns saved: false when DB save fails', async () => {
    vi.mocked(savePositions).mockRejectedValueOnce(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: MINIMAL_CSV }), res);
    expect(res._status).toBe(200); // Still returns positions even if save fails
    expect((res._json as { saved: boolean }).saved).toBe(false);
  });

  it('passes SPX price from query param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: MINIMAL_CSV,
        query: { spx: '5850' },
      }),
      res,
    );
    const data = res._json as { positions: { summary: string } };
    expect(data.positions.summary).toContain('SPX at fetch time: 5850');
  });
});

import { buildFullSummary } from '../_lib/csv-parser.js';

describe('pairForDisplay — unpaired short leg (via buildFullSummary)', () => {
  it('displays short as unpaired when long is more than 50 points away', () => {
    const parsed: ReturnType<typeof parseFullCSV> = {
      openLegs: [
        {
          putCall: 'PUT',
          symbol: 'SPX_5800P',
          strike: 5800,
          expiration: '2026-03-27',
          quantity: -5,
          averagePrice: 1.5,
          marketValue: -750,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
        {
          putCall: 'PUT',
          symbol: 'SPX_5700P',
          strike: 5700,
          expiration: '2026-03-27',
          quantity: 5,
          averagePrice: 0.3,
          marketValue: 150,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
      ],
      closedSpreads: [],
      allTrades: [],
      dayPnl: null,
      ytdPnl: null,
      netLiquidatingValue: null,
      startingBalance: null,
      hasOptionsSection: true,
    };

    const summary = buildFullSummary(parsed);
    expect(summary).toContain('(unpaired)');
    expect(summary).toContain('Short 5800P (unpaired)');
  });

  it('pairs short with long when within 50 points', () => {
    const parsed: ReturnType<typeof parseFullCSV> = {
      openLegs: [
        {
          putCall: 'PUT',
          symbol: 'SPX_5800P',
          strike: 5800,
          expiration: '2026-03-27',
          quantity: -5,
          averagePrice: 1.5,
          marketValue: -750,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
        {
          putCall: 'PUT',
          symbol: 'SPX_5780P',
          strike: 5780,
          expiration: '2026-03-27',
          quantity: 5,
          averagePrice: 0.6,
          marketValue: 300,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
      ],
      closedSpreads: [],
      allTrades: [],
      dayPnl: null,
      ytdPnl: null,
      netLiquidatingValue: null,
      startingBalance: null,
      hasOptionsSection: true,
    };

    const summary = buildFullSummary(parsed);
    expect(summary).not.toContain('(unpaired)');
    expect(summary).toContain('Short 5800P / Long 5780P');
  });

  it('displays call short as unpaired when long is more than 50 points away', () => {
    const parsed: ReturnType<typeof parseFullCSV> = {
      openLegs: [
        {
          putCall: 'CALL',
          symbol: 'SPX_5900C',
          strike: 5900,
          expiration: '2026-03-27',
          quantity: -5,
          averagePrice: 1.5,
          marketValue: -750,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
        {
          putCall: 'CALL',
          symbol: 'SPX_5960C',
          strike: 5960,
          expiration: '2026-03-27',
          quantity: 5,
          averagePrice: 0.3,
          marketValue: 150,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        },
      ],
      closedSpreads: [],
      allTrades: [],
      dayPnl: null,
      ytdPnl: null,
      netLiquidatingValue: null,
      startingBalance: null,
      hasOptionsSection: true,
    };

    const summary = buildFullSummary(parsed);
    expect(summary).toContain('Short 5900C (unpaired)');
  });
});

describe('buildFullSummary — P&L null rendering', () => {
  const baseParsed: ReturnType<typeof parseFullCSV> = {
    openLegs: [],
    closedSpreads: [],
    allTrades: [],
    dayPnl: null,
    ytdPnl: null,
    netLiquidatingValue: null,
    startingBalance: null,
    hasOptionsSection: false,
  };

  it('omits P&L section entirely when dayPnl is null', () => {
    const parsed = { ...baseParsed, dayPnl: null, ytdPnl: 500 };
    const summary = buildFullSummary(parsed);
    expect(summary).not.toContain("Today's P&L");
    expect(summary).not.toContain('Day P&L');
  });

  it('renders Day P&L when dayPnl is non-null', () => {
    const parsed = { ...baseParsed, dayPnl: 250, ytdPnl: null };
    const summary = buildFullSummary(parsed);
    expect(summary).toContain("Today's P&L");
    expect(summary).toContain('Day P&L (SPX): $250');
  });

  it('renders Day P&L when both dayPnl and ytdPnl are non-null', () => {
    const parsed = { ...baseParsed, dayPnl: 300, ytdPnl: 1200 };
    const summary = buildFullSummary(parsed);
    expect(summary).toContain("Today's P&L");
    expect(summary).toContain('Day P&L (SPX): $300');
  });

  it('renders negative Day P&L correctly', () => {
    const parsed = { ...baseParsed, dayPnl: -150, ytdPnl: null };
    const summary = buildFullSummary(parsed);
    expect(summary).toContain('Day P&L (SPX): $-150');
  });

  it('renders NO OPEN POSITIONS when openLegs is empty', () => {
    const summary = buildFullSummary(baseParsed);
    expect(summary).toContain('NO OPEN SPX 0DTE POSITIONS');
  });

  it('does not include netLiquidatingValue in summary output', () => {
    const parsed = {
      ...baseParsed,
      netLiquidatingValue: 200000,
      dayPnl: null,
    };
    const summary = buildFullSummary(parsed);
    // netLiquidatingValue is parsed but not rendered in the summary
    expect(summary).not.toContain('200000');
    expect(summary).not.toContain('Net Liquidating');
  });
});

describe('parseFullCSV — Trade History fallback with fully closed positions', () => {
  it('returns empty openLegs when TO OPEN and TO CLOSE quantities match', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/27/26 14:20:49,VERTICAL,BUY,+10,TO CLOSE,SPX,27 MAR 26,5800,PUT,.15,.05,LMT
,,,SELL,-10,TO CLOSE,SPX,27 MAR 26,5780,PUT,.10,DEBIT,
,3/27/26 09:23:22,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,5800,PUT,2.00,0.80,LMT
,,,BUY,+10,TO OPEN,SPX,27 MAR 26,5780,PUT,1.20,CREDIT,

Profits and Losses
Symbol,Description,P/L Open
`;

    const parsed = parseFullCSV(csv);
    expect(parsed.hasOptionsSection).toBe(false);
    expect(parsed.allTrades).toHaveLength(4);
    expect(parsed.openLegs).toHaveLength(0);
  });

  it('returns remaining open legs when TO CLOSE quantity is less than TO OPEN', () => {
    const csv = `Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/27/26 14:20:49,VERTICAL,BUY,+5,TO CLOSE,SPX,27 MAR 26,5800,PUT,.15,.05,LMT
,,,SELL,-5,TO CLOSE,SPX,27 MAR 26,5780,PUT,.10,DEBIT,
,3/27/26 09:23:22,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,5800,PUT,2.00,0.80,LMT
,,,BUY,+10,TO OPEN,SPX,27 MAR 26,5780,PUT,1.20,CREDIT,

Profits and Losses
Symbol,Description,P/L Open
`;

    const parsed = parseFullCSV(csv);
    expect(parsed.hasOptionsSection).toBe(false);
    // 5 of each leg still open
    expect(parsed.openLegs).toHaveLength(2);
    const shortLeg = parsed.openLegs.find((l) => l.quantity < 0);
    const longLeg = parsed.openLegs.find((l) => l.quantity > 0);
    expect(shortLeg?.strike).toBe(5800);
    expect(shortLeg?.quantity).toBe(-5);
    expect(longLeg?.strike).toBe(5780);
    expect(longLeg?.quantity).toBe(5);
  });

  it('returns no open legs from multi-spread CSV when all are closed', () => {
    const parsed = parseFullCSV(CLOSED_MULTI_SPREAD_CSV);
    expect(parsed.hasOptionsSection).toBe(false);
    expect(parsed.openLegs).toHaveLength(0);
    expect(parsed.closedSpreads).toHaveLength(4);
  });
});
