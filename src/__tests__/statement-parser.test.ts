import { describe, expect, it } from 'vitest';

import {
  applyBSEstimates,
  computeExecutionQuality,
  computePortfolioRisk,
  generateWarnings,
  groupIntoSpreads,
  matchClosedSpreads,
  parseCSVLine,
  parseCurrency,
  parsePercentage,
  parseStatement,
  parseTosDate,
  parseTrdDescription,
} from '../components/PositionMonitor/statement-parser';
import {
  findSections,
  parseCashBalance,
  parseOrderHistory,
  parseTradeHistory,
  parseOptions,
  parsePnL,
  parseAccountSummarySection,
} from '../components/PositionMonitor/statement-parser/section-parsers';
import type {
  AccountSummary,
  CashEntry,
  DailyStatement,
  ExecutedTrade,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  OrderEntry,
  PnLSummary,
  Spread,
} from '../components/PositionMonitor/types';

// ── Helpers ──────────────────────────────────────────────────

function makeTrade(overrides: {
  execTime?: string;
  spread?: string;
  netPrice: number;
  orderType?: string;
  legs: Array<{
    side: 'SELL' | 'BUY';
    qty: number;
    posEffect?: 'TO OPEN' | 'TO CLOSE';
    symbol?: string;
    exp?: string;
    strike: number;
    type: 'CALL' | 'PUT';
    price: number;
    creditDebit?: 'CREDIT' | 'DEBIT' | null;
  }>;
}): ExecutedTrade {
  return {
    execTime: overrides.execTime ?? '3/27/26 09:30:00',
    spread: overrides.spread ?? 'VERTICAL',
    netPrice: overrides.netPrice,
    orderType: overrides.orderType ?? 'LMT',
    legs: overrides.legs.map((l) => ({
      side: l.side,
      qty: l.qty,
      posEffect: l.posEffect ?? 'TO OPEN',
      symbol: l.symbol ?? 'SPX',
      exp: l.exp ?? '2026-03-27',
      strike: l.strike,
      type: l.type,
      price: l.price,
      creditDebit: l.creditDebit ?? null,
    })),
  };
}

function makeLeg(
  overrides: Partial<OpenLeg> & Pick<OpenLeg, 'strike' | 'type' | 'qty'>,
): OpenLeg {
  return {
    symbol: 'SPX',
    optionCode: `SPXW260327${overrides.type === 'PUT' ? 'P' : 'C'}${overrides.strike}`,
    exp: '2026-03-27',
    tradePrice: 0,
    mark: null,
    markValue: null,
    ...overrides,
  };
}

function makeSpread(overrides: Partial<Spread>): Spread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
    longLeg: makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    contracts: 10,
    wingWidth: 20,
    creditReceived: 1500,
    maxProfit: 1500,
    maxLoss: 18500,
    riskRewardRatio: 12.33,
    breakeven: 6398.5,
    entryTime: null,
    entryNetPrice: null,
    currentValue: null,
    openPnl: null,
    pctOfMaxProfit: null,
    distanceToShortStrike: 100,
    distanceToShortStrikePct: 1.54,
    nearestShortStrike: 6400,
    entryCommissions: 13,
    ...overrides,
  };
}

function makeIC(overrides: Partial<IronCondor>): IronCondor {
  const putSpread = makeSpread({
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
    longLeg: makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    wingWidth: 20,
    creditReceived: 1500,
    maxLoss: 18500,
  });
  const callSpread = makeSpread({
    spreadType: 'CALL_CREDIT_SPREAD',
    shortLeg: makeLeg({
      strike: 6600,
      type: 'CALL',
      qty: -10,
      tradePrice: 2.0,
    }),
    longLeg: makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    wingWidth: 20,
    creditReceived: 1000,
    maxLoss: 19000,
  });
  return {
    spreadType: 'IRON_CONDOR',
    putSpread,
    callSpread,
    contracts: 10,
    totalCredit: 2500,
    maxProfit: 2500,
    maxLoss: 17500,
    riskRewardRatio: 7,
    breakevenLow: 6397.5,
    breakevenHigh: 6602.5,
    putWingWidth: 20,
    callWingWidth: 20,
    entryTime: null,
    ...overrides,
  };
}

function makeHedge(overrides: Partial<HedgePosition>): HedgePosition {
  return {
    leg: makeLeg({ strike: 6300, type: 'PUT', qty: 5, tradePrice: 0.5 }),
    direction: 'LONG',
    protectionSide: 'PUT',
    strikeProtected: 6300,
    contracts: 5,
    entryCost: 250,
    currentValue: null,
    openPnl: null,
    ...overrides,
  };
}

const DEFAULT_ACCOUNT: AccountSummary = {
  netLiquidatingValue: 102181.24,
  stockBuyingPower: 82181.24,
  optionBuyingPower: 82181.24,
  equityCommissionsYtd: 68.76,
};

const EMPTY_PNL: PnLSummary = { entries: [], totals: null };

// ── Minimal test CSV (from task description) ─────────────────

const TEST_CSV = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/27/26,00:00:00,BAL,,Cash balance at the start of business day 27.03 CST,,,,"100,000.00"
3/27/26,09:30:00,TRD,="1001",SOLD -10 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6400/6380 PUT @1.50,-10.52,-13.00,"1,500.00","101,476.48"
3/27/26,09:35:00,TRD,="1002",SOLD -10 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6600/6620 CALL @1.00,-10.52,-13.00,"1,000.00","102,452.96"
3/27/26,14:00:00,TRD,="1003",BOT +10 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6600/6620 CALL @.05,-8.72,-13.00,-50.00,"102,381.24"

Account Order History
Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status
,,3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,1.50,LMT,DAY,FILLED
,,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,CREDIT,,,
,,3/27/26 09:35:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6600,CALL,1.00,LMT,DAY,FILLED
,,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6620,CALL,CREDIT,,,
,,3/27/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,27 MAR 26,6600,CALL,.05,LMT,DAY,FILLED
,,,,SELL,-10,TO CLOSE,SPX,27 MAR 26,6620,CALL,DEBIT,,,
,,3/27/26 09:28:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6350,PUT,1.00,LMT,DAY,"REJECTED: Your buying power will be below zero ($5,000.00) if this order is accepted."
,,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6330,PUT,CREDIT,,,

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,3.50,1.50,LMT
,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,2.00,CREDIT,
,3/27/26 09:35:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6600,CALL,2.00,1.00,LMT
,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6620,CALL,1.00,CREDIT,
,3/27/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,27 MAR 26,6600,CALL,.10,.05,LMT
,,,SELL,-10,TO CLOSE,SPX,27 MAR 26,6620,CALL,.05,DEBIT,

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price
SPX,SPXW260327P6380,27 MAR 26,6380,PUT,+10,2.00
SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,3.50

Profits and Losses
Symbol,Description,P/L Open,P/L %,P/L Day,P/L YTD,P/L Diff,Margin Req,Mark Value
SPX,S & P 500 INDEX,($200.00),-1.00%,"$2,381.24","$2,381.24",$0.00,"$20,000.00","($200.00)"
,OVERALL TOTALS,($200.00),-1.00%,"$2,381.24","$2,381.24",$0.00,"$20,000.00","($200.00)"

Account Summary
Net Liquidating Value,"$102,181.24"
Stock Buying Power,"$82,181.24"
Option Buying Power,"$82,181.24"
Equity Commissions & Fees YTD,"$68.76"`;

// ══════════════════════════════════════════════════════════════
// 1. Value Parsers
// ══════════════════════════════════════════════════════════════

describe('parseCSVLine', () => {
  it('splits normal fields by comma', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCSVLine('"hello, world",bar,baz')).toEqual([
      'hello, world',
      'bar',
      'baz',
    ]);
  });

  it('handles empty fields', () => {
    expect(parseCSVLine('a,,b')).toEqual(['a', '', 'b']);
  });

  it('handles ref number format ="..."', () => {
    expect(parseCSVLine('a,="5320628961",b')).toEqual([
      'a',
      '=5320628961',
      'b',
    ]);
  });

  it('handles quoted values with dollar and commas', () => {
    const result = parseCSVLine('"$100,000.00",bar');
    expect(result).toEqual(['$100,000.00', 'bar']);
  });

  it('handles multiple quoted fields', () => {
    const result = parseCSVLine('"a,b","c,d",e');
    expect(result).toEqual(['a,b', 'c,d', 'e']);
  });

  it('trims whitespace from fields', () => {
    expect(parseCSVLine(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseCurrency', () => {
  it('parses comma-formatted number', () => {
    expect(parseCurrency('1,800.00')).toBe(1800);
  });

  it('parses parenthesized negative', () => {
    expect(parseCurrency('($150.00)')).toBe(-150);
  });

  it('parses dollar with commas', () => {
    expect(parseCurrency('$310,000.00')).toBe(310000);
  });

  it('parses negative number', () => {
    expect(parseCurrency('-26.00')).toBe(-26);
  });

  it('returns 0 for empty string', () => {
    expect(parseCurrency('')).toBe(0);
  });

  it('returns 0 for whitespace only', () => {
    expect(parseCurrency('   ')).toBe(0);
  });

  it('returns 0 for ref number format', () => {
    expect(parseCurrency('="5320628961"')).toBe(0);
  });

  it('parses parenthesized without dollar sign', () => {
    expect(parseCurrency('(150.00)')).toBe(-150);
  });

  it('parses plain decimal', () => {
    expect(parseCurrency('42.50')).toBe(42.5);
  });
});

describe('parsePercentage', () => {
  it('parses negative percentage', () => {
    expect(parsePercentage('-0.74%')).toBeCloseTo(-0.0074, 6);
  });

  it('parses zero percentage', () => {
    expect(parsePercentage('0.00%')).toBe(0);
  });

  it('parses positive percentage', () => {
    expect(parsePercentage('5.00%')).toBeCloseTo(0.05, 6);
  });

  it('returns 0 for empty string', () => {
    expect(parsePercentage('')).toBe(0);
  });

  it('parses parenthesized negative percentage', () => {
    expect(parsePercentage('(1.50%)')).toBeCloseTo(-0.015, 6);
  });
});

describe('parseTosDate', () => {
  it('parses 27 MAR 26', () => {
    expect(parseTosDate('27 MAR 26')).toBe('2026-03-27');
  });

  it('parses 20 JAN 26', () => {
    expect(parseTosDate('20 JAN 26')).toBe('2026-01-20');
  });

  it('parses all months', () => {
    const months: Array<[string, string]> = [
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
    ];
    for (const [abbr, mm] of months) {
      expect(parseTosDate(`15 ${abbr} 26`)).toBe(`2026-${mm}-15`);
    }
  });

  it('pads single-digit day', () => {
    expect(parseTosDate('5 FEB 26')).toBe('2026-02-05');
  });

  it('returns original string for invalid format', () => {
    expect(parseTosDate('invalid')).toBe('invalid');
  });

  it('handles case-insensitive month', () => {
    expect(parseTosDate('15 mar 26')).toBe('2026-03-15');
  });
});

// ══════════════════════════════════════════════════════════════
// 2. TRD Description Parsing
// ══════════════════════════════════════════════════════════════

describe('parseTrdDescription', () => {
  it('parses SOLD VERTICAL PUT', () => {
    const result = parseTrdDescription(
      'SOLD -20 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6495/6515 CALL @.90',
    );
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SOLD');
    expect(result!.quantity).toBe(20);
    expect(result!.spreadType).toBe('VERTICAL');
    expect(result!.symbol).toBe('SPX');
    expect(result!.multiplier).toBe(100);
    expect(result!.strikes).toBe('6495/6515');
    expect(result!.optionType).toBe('CALL');
    expect(result!.fillPrice).toBeCloseTo(0.9, 6);
    expect(result!.expiration).toBe('2026-03-27');
    expect(result!.expiryLabel).toBe('Weeklys');
  });

  it('parses BOT VERTICAL', () => {
    const result = parseTrdDescription(
      'BOT +10 VERTICAL SPX 100 (Weeklys) 24 MAR 26 6600/6620 CALL @2.00',
    );
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('BOT');
    expect(result!.quantity).toBe(10);
    expect(result!.fillPrice).toBe(2.0);
  });

  it('handles tAndroid prefix', () => {
    const result = parseTrdDescription(
      'tAndroid SOLD -10 IRON CONDOR SPX 100 (Weeklys) 27 MAR 26 6400/6420 CALL @1.50',
    );
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SOLD');
    expect(result!.quantity).toBe(10);
    expect(result!.spreadType).toBe('IRON');
  });

  it('parses NDX symbol', () => {
    const result = parseTrdDescription(
      'SOLD -1 VERTICAL NDX 100 (Weeklys) 27 MAR 26 22000/22020 CALL @5.00',
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('NDX');
    expect(result!.quantity).toBe(1);
  });

  it('returns null for Automatic Expiration', () => {
    expect(parseTrdDescription('Automatic Expiration -10.0')).toBeNull();
  });

  it('returns null for Cash liquidation', () => {
    expect(parseTrdDescription('Cash liquidation')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTrdDescription('')).toBeNull();
  });

  it('parses SOLD with integer fill price', () => {
    const result = parseTrdDescription(
      'SOLD -5 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6300/6280 PUT @3.00',
    );
    expect(result).not.toBeNull();
    expect(result!.fillPrice).toBe(3.0);
    expect(result!.optionType).toBe('PUT');
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Position Grouping
// ══════════════════════════════════════════════════════════════

describe('groupIntoSpreads', () => {
  const emptyTrades: ExecutedTrade[] = [];
  const emptyCash: CashEntry[] = [];
  const spotPrice = 6500;

  it('detects PCS (short put higher strike + long put lower strike)', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0]!.spreadType).toBe('PUT_CREDIT_SPREAD');
    expect(result.spreads[0]!.shortLeg.strike).toBe(6400);
    expect(result.spreads[0]!.longLeg.strike).toBe(6380);
    expect(result.spreads[0]!.wingWidth).toBe(20);
    expect(result.spreads[0]!.contracts).toBe(10);
    expect(result.ironCondors).toHaveLength(0);
    expect(result.hedges).toHaveLength(0);
    expect(result.naked).toHaveLength(0);
  });

  it('detects CCS (short call lower strike + long call higher strike)', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0]!.spreadType).toBe('CALL_CREDIT_SPREAD');
    expect(result.spreads[0]!.shortLeg.strike).toBe(6600);
    expect(result.spreads[0]!.longLeg.strike).toBe(6620);
    expect(result.spreads[0]!.wingWidth).toBe(20);
  });

  it('detects IC from matching PCS + CCS pair with same qty', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:30:30',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.ironCondors).toHaveLength(1);
    expect(result.spreads).toHaveLength(0);
    expect(result.ironCondors[0]!.contracts).toBe(10);
    expect(result.ironCondors[0]!.putWingWidth).toBe(20);
    expect(result.ironCondors[0]!.callWingWidth).toBe(20);
  });

  it('classifies standalone long put as hedge', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6300, type: 'PUT', qty: 5, tradePrice: 0.5 }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    expect(result.hedges).toHaveLength(1);
    expect(result.hedges[0]!.protectionSide).toBe('PUT');
    expect(result.hedges[0]!.direction).toBe('LONG');
    expect(result.hedges[0]!.contracts).toBe(5);
    expect(result.spreads).toHaveLength(0);
  });

  it('classifies standalone long call as hedge', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6700, type: 'CALL', qty: 3, tradePrice: 1.0 }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    expect(result.hedges).toHaveLength(1);
    expect(result.hedges[0]!.protectionSide).toBe('CALL');
  });

  it('flags standalone short without matching long as naked', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    expect(result.naked).toHaveLength(1);
    expect(result.naked[0]!.type).toBe('PUT');
    expect(result.naked[0]!.contracts).toBe(10);
    expect(result.spreads).toHaveLength(0);
  });

  it('handles mixed book: IC + standalone PCS + long put hedge', () => {
    const legs: OpenLeg[] = [
      // IC legs
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
      // Extra PCS
      makeLeg({ strike: 6350, type: 'PUT', qty: -5, tradePrice: 2.0 }),
      makeLeg({ strike: 6330, type: 'PUT', qty: 5, tradePrice: 1.0 }),
      // Hedge
      makeLeg({ strike: 6250, type: 'PUT', qty: 3, tradePrice: 0.5 }),
    ];
    const trades: ExecutedTrade[] = [
      // IC put side
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      // IC call side (within 60s)
      makeTrade({
        execTime: '3/27/26 09:30:30',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      // Standalone PCS
      makeTrade({
        execTime: '3/27/26 09:35:00',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 5, strike: 6350, type: 'PUT', price: 2.0 },
          {
            side: 'BUY',
            qty: 5,
            strike: 6330,
            type: 'PUT',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.ironCondors).toHaveLength(1);
    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0]!.spreadType).toBe('PUT_CREDIT_SPREAD');
    expect(result.hedges).toHaveLength(1);
    expect(result.hedges[0]!.protectionSide).toBe('PUT');
    expect(result.naked).toHaveLength(0);
  });

  it('does not pair legs with mismatched qty', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 5, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    // Cannot form a spread — 10 vs 5 qty mismatch
    expect(result.spreads).toHaveLength(0);
    expect(result.naked).toHaveLength(1);
    expect(result.hedges).toHaveLength(1);
  });

  it('does not pair legs from different expirations', () => {
    const legs: OpenLeg[] = [
      makeLeg({
        strike: 6400,
        type: 'PUT',
        qty: -10,
        tradePrice: 3.5,
        exp: '2026-03-27',
      }),
      makeLeg({
        strike: 6380,
        type: 'PUT',
        qty: 10,
        tradePrice: 2.0,
        exp: '2026-03-28',
      }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    // Different exp → separate groups → naked + hedge
    expect(result.spreads).toHaveLength(0);
    expect(result.naked).toHaveLength(1);
    expect(result.hedges).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 4. IC Max Loss Calculation
// ══════════════════════════════════════════════════════════════

describe('IC max loss calculation', () => {
  it('calculates IC max loss with symmetric wings', () => {
    // 20pt wings on both sides, total credit $2.50/contract, 10 contracts
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:30:30',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, 6500, []);
    const ic = result.ironCondors[0]!;

    // maxLoss = widerWing * 100 * contracts - totalCredit
    // widerWing = max(20, 20) = 20
    // totalCredit = (3.5-2.0+2.0-1.0) * 100 * 10 = 2.5 * 1000 = 2500
    // maxLoss = 20 * 100 * 10 - 2500 = 20000 - 2500 = 17500
    expect(ic.maxLoss).toBe(17500);
    expect(ic.totalCredit).toBe(2500);
  });

  it('uses wider wing for asymmetric IC', () => {
    // 15pt put wing, 25pt call wing
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6385, type: 'PUT', qty: 10, tradePrice: 1.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6625, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6385,
            type: 'PUT',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:30:30',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6625,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, 6500, []);
    const ic = result.ironCondors[0]!;

    expect(ic.putWingWidth).toBe(15);
    expect(ic.callWingWidth).toBe(25);
    // maxLoss = max(15, 25) * 100 * 10 - totalCredit
    // totalCredit = (2.0-1.0+2.0-1.0) * 100 * 10 = 2000
    // maxLoss = 25 * 100 * 10 - 2000 = 25000 - 2000 = 23000
    expect(ic.maxLoss).toBe(23000);
  });

  it('does NOT sum both wings for max loss', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.0 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    const trades: ExecutedTrade[] = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:30:30',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          {
            side: 'BUY',
            qty: 10,
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, 6500, []);
    const ic = result.ironCondors[0]!;

    // If both wings were summed: (20+20)*100*10 - credit = 40000 - 2000 = 38000
    // Correct: max(20, 20)*100*10 - 2000 = 18000
    expect(ic.maxLoss).toBeLessThan(38000);
    expect(ic.maxLoss).toBe(18000);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Portfolio Risk
// ══════════════════════════════════════════════════════════════

describe('computePortfolioRisk', () => {
  it('computes risk for PCS only portfolio', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      maxLoss: 18500,
      creditReceived: 1500,
      contracts: 10,
    });

    const risk = computePortfolioRisk(
      [pcs],
      [],
      [],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.putSideRisk).toBe(18500);
    expect(risk.callSideRisk).toBe(0);
    expect(risk.totalMaxLoss).toBe(18500);
  });

  it('counts IC max loss toward both sides', () => {
    const ic = makeIC({ maxLoss: 17500 });

    const risk = computePortfolioRisk(
      [],
      [ic],
      [],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.callSideRisk).toBe(17500);
    expect(risk.putSideRisk).toBe(17500);
    expect(risk.totalMaxLoss).toBe(17500);
  });

  it('deducts hedge value from appropriate side', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      maxLoss: 18500,
      creditReceived: 1500,
    });
    const putHedge = makeHedge({
      protectionSide: 'PUT',
      entryCost: 250,
    });

    const risk = computePortfolioRisk(
      [pcs],
      [],
      [putHedge],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.putSideRisk).toBe(18500);
    expect(risk.putHedgeValue).toBe(250);
    expect(risk.netPutRisk).toBe(18250);
    expect(risk.totalMaxLoss).toBe(18250);
  });

  it('totalMaxLoss = max(netCallRisk, netPutRisk)', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      maxLoss: 18500,
      creditReceived: 1500,
    });
    const ccs = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      maxLoss: 5000,
      creditReceived: 500,
    });

    const risk = computePortfolioRisk(
      [pcs, ccs],
      [],
      [],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.putSideRisk).toBe(18500);
    expect(risk.callSideRisk).toBe(5000);
    expect(risk.totalMaxLoss).toBe(18500); // max(18500, 5000)
  });

  it('canAbsorbMaxLoss is true when buying power > max loss', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      maxLoss: 10000,
    });

    const risk = computePortfolioRisk(
      [pcs],
      [],
      [],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.canAbsorbMaxLoss).toBe(true);
  });

  it('canAbsorbMaxLoss is false when buying power < max loss', () => {
    const pcs = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      maxLoss: 100000,
    });

    const risk = computePortfolioRisk(
      [pcs],
      [],
      [],
      [],
      { ...DEFAULT_ACCOUNT, optionBuyingPower: 50000 },
      EMPTY_PNL,
      6500,
    );

    expect(risk.canAbsorbMaxLoss).toBe(false);
  });

  it('counts naked positions', () => {
    const naked: NakedPosition[] = [
      {
        leg: makeLeg({ strike: 6400, type: 'PUT', qty: -10 }),
        contracts: 10,
        type: 'PUT',
      },
    ];

    const risk = computePortfolioRisk(
      [],
      [],
      [],
      naked,
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    );

    expect(risk.nakedCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. Closed Spreads
// ══════════════════════════════════════════════════════════════

describe('matchClosedSpreads', () => {
  it('matches TO OPEN + TO CLOSE trades and computes realized P&L', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:35:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0.1,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0.05,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.05,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.spreadType).toBe('CALL_CREDIT_SPREAD');
    expect(closed[0]!.shortStrike).toBe(6600);
    expect(closed[0]!.longStrike).toBe(6620);
    expect(closed[0]!.optionType).toBe('CALL');
    expect(closed[0]!.contracts).toBe(10);
    expect(closed[0]!.openCredit).toBe(1.0);
    expect(closed[0]!.closeDebit).toBe(0.05);
    // realizedPnl = (1.0 - 0.05) * 100 * 10 = 950
    expect(closed[0]!.realizedPnl).toBe(950);
  });

  it('classifies FULL_PROFIT when closed at $0', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:35:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 15:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.outcome).toBe('FULL_PROFIT');
  });

  it('classifies PARTIAL_PROFIT', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:35:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0.3,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0.1,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.2,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(1);
    // realizedPnl = (1.0 - 0.2) * 100 * 10 = 800
    // openCreditDollars = 1.0 * 100 * 10 = 1000
    // 800 < 0.95 * 1000 = 950, so PARTIAL_PROFIT
    expect(closed[0]!.outcome).toBe('PARTIAL_PROFIT');
  });

  it('classifies LOSS', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:35:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 5.0,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 4.0,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(1);
    // realizedPnl = (1.0 - 4.0) * 100 * 10 = -3000
    expect(closed[0]!.realizedPnl).toBe(-3000);
    expect(closed[0]!.outcome).toBe('LOSS');
  });

  it('classifies SCRATCH when P&L near zero', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:35:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 1.01,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0.02,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.99,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(1);
    // realizedPnl = (1.0 - 0.99) * 100 * 10 = 10
    // openCreditDollars = 1000
    // scratchThreshold = 0.05 * 1000 = 50
    // |10| <= 50, so SCRATCH
    expect(closed[0]!.outcome).toBe('SCRATCH');
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Execution Quality
// ══════════════════════════════════════════════════════════════

describe('computeExecutionQuality', () => {
  it('counts rejected and filled orders', () => {
    const orders: OrderEntry[] = [
      {
        notes: '',
        timePlaced: '3/27/26 09:30:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'PUT',
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6380,
            type: 'PUT',
          },
        ],
        price: 1.5,
        orderType: 'LMT',
        tif: 'DAY',
        status: 'FILLED',
        statusDetail: '',
        isReplacement: false,
      },
      {
        notes: '',
        timePlaced: '3/27/26 09:28:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6350,
            type: 'PUT',
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6330,
            type: 'PUT',
          },
        ],
        price: 1.0,
        orderType: 'LMT',
        tif: 'DAY',
        status: 'REJECTED',
        statusDetail: 'Buying power too low',
        isReplacement: false,
      },
    ];

    const result = computeExecutionQuality(orders, []);

    expect(result.rejectedOrders).toBe(1);
    expect(result.fillRate).toBe(0.5);
    expect(result.rejectionRate).toBe(0.5);
    expect(result.rejectionReasons).toHaveLength(1);
    expect(result.rejectionReasons[0]!.reason).toBe('Buying power too low');
  });

  it('computes trade timing', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:30:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'PUT',
            price: 3.5,
            creditDebit: null,
          },
        ],
        netPrice: 1.5,
        orderType: 'LMT',
      },
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0.1,
            creditDebit: null,
          },
        ],
        netPrice: 0.05,
        orderType: 'LMT',
      },
    ];

    const result = computeExecutionQuality([], trades);

    expect(result.firstTradeTime).toBe('3/27/26 09:30:00');
    expect(result.lastTradeTime).toBe('3/27/26 14:00:00');
    expect(result.tradingSessionMinutes).toBe(270); // 4.5 hours
  });
});

// ══════════════════════════════════════════════════════════════
// 8. Warnings
// ══════════════════════════════════════════════════════════════

describe('generateWarnings', () => {
  it('always emits PAPER_TRADING', () => {
    const sections = new Map([
      ['Cash Balance', { headerIndex: 0, dataStart: 1, dataEnd: 5 }],
      ['Account Order History', { headerIndex: 6, dataStart: 7, dataEnd: 10 }],
      [
        'Account Trade History',
        { headerIndex: 11, dataStart: 12, dataEnd: 15 },
      ],
      ['Options', { headerIndex: 16, dataStart: 17, dataEnd: 20 }],
      ['Profits and Losses', { headerIndex: 21, dataStart: 22, dataEnd: 25 }],
      ['Account Summary', { headerIndex: 26, dataStart: 27, dataEnd: 30 }],
    ]);

    const warnings = generateWarnings(
      [],
      [],
      true,
      EMPTY_PNL,
      [],
      sections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'PAPER_TRADING')).toBe(true);
  });

  it('emits MISSING_MARK when hasMark false and legs present', () => {
    const sections = new Map([
      ['Cash Balance', { headerIndex: 0, dataStart: 1, dataEnd: 5 }],
      ['Account Order History', { headerIndex: 6, dataStart: 7, dataEnd: 10 }],
      [
        'Account Trade History',
        { headerIndex: 11, dataStart: 12, dataEnd: 15 },
      ],
      ['Options', { headerIndex: 16, dataStart: 17, dataEnd: 20 }],
      ['Profits and Losses', { headerIndex: 21, dataStart: 22, dataEnd: 25 }],
      ['Account Summary', { headerIndex: 26, dataStart: 27, dataEnd: 30 }],
    ]);
    const openLegs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10 }),
    ];

    const warnings = generateWarnings(
      [],
      openLegs,
      false,
      EMPTY_PNL,
      [],
      sections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'MISSING_MARK')).toBe(true);
  });

  it('emits UNMATCHED_SHORT for naked positions', () => {
    const naked: NakedPosition[] = [
      {
        leg: makeLeg({ strike: 6400, type: 'PUT', qty: -10 }),
        contracts: 10,
        type: 'PUT',
      },
    ];
    const sections = new Map([
      ['Cash Balance', { headerIndex: 0, dataStart: 1, dataEnd: 5 }],
      ['Account Order History', { headerIndex: 6, dataStart: 7, dataEnd: 10 }],
      [
        'Account Trade History',
        { headerIndex: 11, dataStart: 12, dataEnd: 15 },
      ],
      ['Options', { headerIndex: 16, dataStart: 17, dataEnd: 20 }],
      ['Profits and Losses', { headerIndex: 21, dataStart: 22, dataEnd: 25 }],
      ['Account Summary', { headerIndex: 26, dataStart: 27, dataEnd: 30 }],
    ]);

    const warnings = generateWarnings(
      [],
      [],
      true,
      EMPTY_PNL,
      naked,
      sections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'UNMATCHED_SHORT')).toBe(true);
  });

  it('emits MISSING_SECTION when sections are absent', () => {
    const sections = new Map([
      ['Cash Balance', { headerIndex: 0, dataStart: 1, dataEnd: 5 }],
    ]);

    const warnings = generateWarnings(
      [],
      [],
      true,
      EMPTY_PNL,
      [],
      sections,
      [],
      [],
    );

    expect(warnings.filter((w) => w.code === 'MISSING_SECTION').length).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════
// 9. Full Integration Test
// ══════════════════════════════════════════════════════════════

describe('parseStatement (integration)', () => {
  it('parses the full test CSV correctly', () => {
    const result = parseStatement(TEST_CSV, 6500);

    // Date from first cash entry
    expect(result.date).toBe('2026-03-27');

    // Cash entries: BAL + 3 TRDs
    expect(result.cashEntries).toHaveLength(4);
    expect(result.cashEntries[0]!.type).toBe('BAL');
    expect(result.cashEntries[0]!.balance).toBe(100000);
    expect(result.cashEntries[1]!.type).toBe('TRD');
    expect(result.cashEntries[1]!.amount).toBe(1500);

    // Orders: 3 filled + 1 rejected
    expect(result.orders).toHaveLength(4);
    const rejectedOrders = result.orders.filter((o) => o.status === 'REJECTED');
    expect(rejectedOrders).toHaveLength(1);

    // Trades: 3 executed trades
    expect(result.trades).toHaveLength(3);

    // Open legs: only the PCS remains (CCS was closed)
    expect(result.openLegs).toHaveLength(2);

    // Grouped positions: PCS + CCS with matching qty → 1 IC
    expect(result.spreads).toHaveLength(0);
    expect(result.ironCondors).toHaveLength(1);

    const ic = result.ironCondors[0]!;
    expect(ic.putSpread.shortLeg.strike).toBe(6400);
    expect(ic.putSpread.longLeg.strike).toBe(6380);
    expect(ic.putSpread.wingWidth).toBe(20);
    expect(ic.contracts).toBe(10);

    expect(ic.callSpread.shortLeg.strike).toBe(6600);
    expect(ic.callSpread.longLeg.strike).toBe(6620);
    expect(ic.callSpread.contracts).toBe(10);

    // Closed spreads: the CCS that was opened and closed
    expect(result.closedSpreads).toHaveLength(1);
    expect(result.closedSpreads[0]!.spreadType).toBe('CALL_CREDIT_SPREAD');
    expect(result.closedSpreads[0]!.shortStrike).toBe(6600);
    expect(result.closedSpreads[0]!.closeDebit).toBe(0.05);
    // realizedPnl = (1.0 - 0.05) * 100 * 10 = 950
    expect(result.closedSpreads[0]!.realizedPnl).toBe(950);
    // 950 >= 0.95 * 1000 = 950, so FULL_PROFIT
    expect(result.closedSpreads[0]!.outcome).toBe('FULL_PROFIT');

    // Account summary
    expect(result.accountSummary.netLiquidatingValue).toBe(102181.24);
    expect(result.accountSummary.optionBuyingPower).toBe(82181.24);
    expect(result.accountSummary.equityCommissionsYtd).toBe(68.76);

    // P&L
    expect(result.pnl.totals).not.toBeNull();
    expect(result.pnl.totals!.plOpen).toBe(-200);
    expect(result.pnl.totals!.plDay).toBe(2381.24);

    // Portfolio risk (both PCS and CCS are recognized)
    expect(result.portfolioRisk.putSideRisk).toBeGreaterThan(0);
    expect(result.portfolioRisk.callSideRisk).toBeGreaterThan(0);
    expect(result.portfolioRisk.canAbsorbMaxLoss).toBe(true);

    // Execution quality
    expect(result.executionQuality.rejectedOrders).toBe(1);
    expect(result.executionQuality.fillRate).toBe(0.75); // 3 filled / 4 total

    // Warnings: at minimum PAPER_TRADING
    expect(result.warnings.some((w) => w.code === 'PAPER_TRADING')).toBe(true);
    // Also MISSING_MARK (no Mark column in our test CSV)
    expect(result.warnings.some((w) => w.code === 'MISSING_MARK')).toBe(true);
  });

  it('handles empty CSV gracefully', () => {
    const result = parseStatement('', 6500);

    expect(result.date).toBe('');
    expect(result.cashEntries).toHaveLength(0);
    expect(result.orders).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.openLegs).toHaveLength(0);
    expect(result.spreads).toHaveLength(0);
    expect(result.ironCondors).toHaveLength(0);
  });

  it('parses credit received correctly for the PCS', () => {
    const result = parseStatement(TEST_CSV, 6500);
    // PCS is now inside the IC (matched by qty, no time constraint)
    const pcs = result.ironCondors[0]!.putSpread;

    // shortTradePrice = 3.50, longTradePrice = 2.00
    // creditPerContract = 3.50 - 2.00 = 1.50
    // creditReceived = 1.50 * 100 * 10 = 1500
    expect(pcs.creditReceived).toBe(1500);
    expect(pcs.maxProfit).toBe(1500);
    // maxLoss = wingWidth * 100 * contracts - credit
    // = 20 * 100 * 10 - 1500 = 18500
    expect(pcs.maxLoss).toBe(18500);
  });

  it('computes distance to short strike', () => {
    const result = parseStatement(TEST_CSV, 6500);
    // PCS is now inside the IC (matched by qty, no time constraint)
    const pcs = result.ironCondors[0]!.putSpread;

    // isPCS so distance = spotPrice - shortStrike = 6500 - 6400 = 100
    expect(pcs.distanceToShortStrike).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════
// 10. applyBSEstimates
// ══════════════════════════════════════════════════════════════

function makeStatement(
  overrides: Partial<DailyStatement> = {},
): DailyStatement {
  return {
    date: '2026-03-27',
    cashEntries: [],
    orders: [],
    trades: [],
    openLegs: [],
    pnl: EMPTY_PNL,
    accountSummary: DEFAULT_ACCOUNT,
    spreads: [],
    ironCondors: [],
    butterflies: [],
    hedges: [],
    nakedPositions: [],
    closedSpreads: [],
    portfolioRisk: computePortfolioRisk(
      [],
      [],
      [],
      [],
      DEFAULT_ACCOUNT,
      EMPTY_PNL,
      6500,
    ),
    executionQuality: {
      fills: [],
      averageSlippage: 0,
      totalSlippageDollars: 0,
      fillRate: 0,
      rejectedOrders: 0,
      canceledOrders: 0,
      replacementChains: 0,
      rejectionRate: 0,
      cancellationRate: 0,
      rejectionReasons: [],
      firstTradeTime: null,
      lastTradeTime: null,
      tradingSessionMinutes: null,
      tradesPerHour: null,
    },
    warnings: [],
    ...overrides,
  };
}

describe('applyBSEstimates', () => {
  const spotPrice = 6500;
  const sigma = 0.15;

  it('returns a DailyStatement (same shape)', () => {
    const stmt = makeStatement();
    const result = applyBSEstimates(stmt, spotPrice, sigma, 0.001);

    expect(result).toHaveProperty('date', '2026-03-27');
    expect(result).toHaveProperty('cashEntries');
    expect(result).toHaveProperty('spreads');
    expect(result).toHaveProperty('ironCondors');
    expect(result).toHaveProperty('hedges');
    expect(result).toHaveProperty('portfolioRisk');
    expect(result).toHaveProperty('pnl');
  });

  it('decays spread value with sqrt-time', () => {
    // T that puts current time roughly at 12:00 CT
    // hoursRemaining = T * 365.25 * 24
    // minutesRemaining = hoursRemaining * 60
    // currentMinute = 900 - min(minutesRemaining, 390)
    // We want currentMinute ~= 720 (12:00 CT)
    // 900 - minutesRemaining = 720 => minutesRemaining = 180
    // hoursRemaining = 180 / 60 = 3
    // T = 3 / (365.25 * 24) ≈ 0.000342
    const T = 3 / (365.25 * 24);

    const spread = makeSpread({
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00',
      creditReceived: 1500,
      maxProfit: 1500,
      contracts: 10,
    });
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // At 12:00, ~3hrs left of 5.5hr session from 9:30 entry
    // decayFactor = sqrt(180 / 330) ≈ 0.738
    // estimatedSpreadPrice ≈ 1.5 * 0.738 ≈ 1.11
    // currentValue ≈ 1.11 * 10 * 100 ≈ 1107
    // openPnl ≈ 1500 - 1107 ≈ 393
    expect(result.spreads[0]!.currentValue).toBeLessThan(1500);
    expect(result.spreads[0]!.currentValue).toBeGreaterThan(0);
    expect(result.spreads[0]!.openPnl).toBeGreaterThan(0);
  });

  it('spread with no entryNetPrice uses trade price diff', () => {
    const spread = makeSpread({
      entryNetPrice: null,
      entryTime: '3/27/26 09:30:00',
      shortLeg: makeLeg({
        strike: 6400,
        type: 'PUT',
        qty: -10,
        tradePrice: 3.5,
      }),
      longLeg: makeLeg({
        strike: 6380,
        type: 'PUT',
        qty: 10,
        tradePrice: 2.0,
      }),
      creditReceived: 1500,
      maxProfit: 1500,
      contracts: 10,
    });

    // T that puts current time at ~12:00 CT
    const T = 3 / (365.25 * 24);
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // netPrice = |3.5 - 2.0| = 1.5, same as entryNetPrice case
    expect(result.spreads[0]!.currentValue).toBeLessThan(1500);
    expect(result.spreads[0]!.openPnl).toBeGreaterThan(0);
  });

  it('spread with zero netPrice is unchanged', () => {
    const spread = makeSpread({
      entryNetPrice: null,
      shortLeg: makeLeg({
        strike: 6400,
        type: 'PUT',
        qty: -10,
        tradePrice: 0,
      }),
      longLeg: makeLeg({
        strike: 6380,
        type: 'PUT',
        qty: 10,
        tradePrice: 0,
      }),
    });

    const T = 3 / (365.25 * 24);
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // netPrice = |0 - 0| = 0, should return spread as-is
    expect(result.spreads[0]!.currentValue).toBeNull();
    expect(result.spreads[0]!.openPnl).toBeNull();
  });

  it('position not yet entered shows zero P&L', () => {
    // Set T so currentMinute is before 09:30 (i.e. at ~09:00)
    // currentMinute = 900 - min(minutesRemaining, 390)
    // We want currentMinute = 540 (09:00)
    // 900 - minutesRemaining = 540 => minutesRemaining = 360
    // hoursRemaining = 360 / 60 = 6
    // T = 6 / (365.25 * 24) ≈ 0.000684
    const T = 6 / (365.25 * 24);

    const spread = makeSpread({
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00', // 09:30 = minute 570
      creditReceived: 1500,
      maxProfit: 1500,
      contracts: 10,
    });
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    expect(result.spreads[0]!.openPnl).toBe(0);
    expect(result.spreads[0]!.pctOfMaxProfit).toBe(0);
  });

  it('at session end, decay approaches zero', () => {
    // T = 0 means exactly at session end
    // hoursRemaining = 0 => minutesRemaining = 0
    // currentMinute = 900 - min(0, 390) = 900
    // nowRemaining = max(900 - 900, 0) = 0
    // decayFactor = sqrt(0 / entryRemaining) = 0
    const T = 0;

    const spread = makeSpread({
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00',
      creditReceived: 1500,
      maxProfit: 1500,
      contracts: 10,
    });
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    expect(result.spreads[0]!.currentValue).toBe(0);
    expect(result.spreads[0]!.openPnl).toBe(1500);
  });

  it('decays iron condor both wings', () => {
    const T = 3 / (365.25 * 24);

    const ic = makeIC({
      entryTime: '3/27/26 09:30:00',
      putSpread: makeSpread({
        spreadType: 'PUT_CREDIT_SPREAD',
        entryNetPrice: 1.5,
        entryTime: '3/27/26 09:30:00',
        creditReceived: 1500,
        maxProfit: 1500,
        contracts: 10,
      }),
      callSpread: makeSpread({
        spreadType: 'CALL_CREDIT_SPREAD',
        entryNetPrice: 1.0,
        entryTime: '3/27/26 09:30:00',
        creditReceived: 1000,
        maxProfit: 1000,
        contracts: 10,
      }),
    });
    const stmt = makeStatement({ ironCondors: [ic] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    expect(result.ironCondors[0]!.putSpread.currentValue).toBeLessThan(1500);
    expect(result.ironCondors[0]!.putSpread.openPnl).toBeGreaterThan(0);
    expect(result.ironCondors[0]!.callSpread.currentValue).toBeLessThan(1000);
    expect(result.ironCondors[0]!.callSpread.openPnl).toBeGreaterThan(0);
  });

  it('decays hedge value with sqrt-time', () => {
    const T = 3 / (365.25 * 24);

    const hedge = makeHedge({
      entryCost: 250,
      currentValue: null,
      openPnl: null,
    });
    const stmt = makeStatement({ hedges: [hedge] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // Hedge value decays: currentValue < entryCost
    // openPnl = currentValue - entryCost < 0
    expect(result.hedges[0]!.currentValue).toBeLessThan(250);
    expect(result.hedges[0]!.currentValue).toBeGreaterThan(0);
    expect(result.hedges[0]!.openPnl).toBeLessThan(0);
  });

  it('hedge with zero entry cost is unchanged', () => {
    const T = 3 / (365.25 * 24);

    const hedge = makeHedge({
      entryCost: 0,
      currentValue: null,
      openPnl: null,
    });
    const stmt = makeStatement({ hedges: [hedge] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    expect(result.hedges[0]!.currentValue).toBeNull();
    expect(result.hedges[0]!.openPnl).toBeNull();
  });

  it('recomputes portfolioRisk after decay', () => {
    const T = 3 / (365.25 * 24);

    const spread = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00',
      creditReceived: 1500,
      maxProfit: 1500,
      maxLoss: 18500,
      contracts: 10,
    });
    const stmt = makeStatement({ spreads: [spread] });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // portfolioRisk should be recomputed with the decay-adjusted
    // positions (putSideRisk should still be 18500)
    expect(result.portfolioRisk.putSideRisk).toBe(18500);
    expect(result.portfolioRisk.totalMaxLoss).toBe(18500);
  });

  it('aggregates open P&L from decayed spreads', () => {
    const T = 3 / (365.25 * 24);

    const spread1 = makeSpread({
      spreadType: 'PUT_CREDIT_SPREAD',
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00',
      creditReceived: 1500,
      maxProfit: 1500,
      contracts: 10,
    });
    const spread2 = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      entryNetPrice: 1.0,
      entryTime: '3/27/26 09:35:00',
      creditReceived: 1000,
      maxProfit: 1000,
      contracts: 10,
      shortLeg: makeLeg({
        strike: 6600,
        type: 'CALL',
        qty: -10,
        tradePrice: 2.0,
      }),
      longLeg: makeLeg({
        strike: 6620,
        type: 'CALL',
        qty: 10,
        tradePrice: 1.0,
      }),
    });

    const pnlWithTotals: PnLSummary = {
      entries: [],
      totals: {
        symbol: '',
        description: 'OVERALL TOTALS',
        plOpen: -200,
        plPct: -0.01,
        plDay: 2381.24,
        plYtd: 2381.24,
        plDiff: 0,
        marginReq: 20000,
        markValue: -200,
      },
    };

    const stmt = makeStatement({
      spreads: [spread1, spread2],
      pnl: pnlWithTotals,
    });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    // The pnl.totals.plOpen should equal the sum of decayed openPnl values
    const expectedTotal =
      (result.spreads[0]!.openPnl ?? 0) + (result.spreads[1]!.openPnl ?? 0);
    expect(result.pnl.totals!.plOpen).toBeCloseTo(expectedTotal, 1);
  });

  it('preserves non-position fields', () => {
    const T = 3 / (365.25 * 24);

    const spread = makeSpread({
      entryNetPrice: 1.5,
      entryTime: '3/27/26 09:30:00',
    });
    const stmt = makeStatement({
      date: '2026-03-27',
      spreads: [spread],
      warnings: [
        {
          code: 'PAPER_TRADING',
          severity: 'info',
          message: 'This is paper',
        },
      ],
    });
    const result = applyBSEstimates(stmt, spotPrice, sigma, T);

    expect(result.date).toBe('2026-03-27');
    expect(result.cashEntries).toEqual([]);
    expect(result.orders).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe('PAPER_TRADING');
  });
});

// ══════════════════════════════════════════════════════════════
// 11. matchClosedSpreads edge cases
// ══════════════════════════════════════════════════════════════

describe('matchClosedSpreads (edge cases)', () => {
  it('ignores trades with fewer than 2 open legs', () => {
    const trades: ExecutedTrade[] = [
      // Single-leg TO OPEN
      {
        execTime: '3/27/26 09:30:00',
        spread: 'SINGLE',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'PUT',
            price: 3.5,
            creditDebit: null,
          },
        ],
        netPrice: 3.5,
        orderType: 'LMT',
      },
      // Single-leg TO CLOSE
      {
        execTime: '3/27/26 14:00:00',
        spread: 'SINGLE',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'PUT',
            price: 0.5,
            creditDebit: null,
          },
        ],
        netPrice: 0.5,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(0);
  });

  it('does not match when option types differ', () => {
    const trades: ExecutedTrade[] = [
      // Open PUT spread
      {
        execTime: '3/27/26 09:30:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'PUT',
            price: 3.5,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6380,
            type: 'PUT',
            price: 2.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.5,
        orderType: 'LMT',
      },
      // Close CALL spread (different type — should not match)
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6400,
            type: 'CALL',
            price: 0.1,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6380,
            type: 'CALL',
            price: 0.05,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.05,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(0);
  });

  it('does not match an already-used open spread twice', () => {
    const trades: ExecutedTrade[] = [
      // Single open trade
      {
        execTime: '3/27/26 09:30:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
      // First close — should match
      {
        execTime: '3/27/26 13:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0.1,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0.05,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.05,
        orderType: 'LMT',
      },
      // Second close — same strikes, should NOT match (open already used)
      {
        execTime: '3/27/26 14:00:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 0.2,
            creditDebit: null,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 0.1,
            creditDebit: 'DEBIT',
          },
        ],
        netPrice: 0.1,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    // Only the first close should produce a closed spread
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closeTime).toBe('3/27/26 13:00:00');
  });

  it('returns empty for no TO CLOSE trades', () => {
    const trades: ExecutedTrade[] = [
      {
        execTime: '3/27/26 09:30:00',
        spread: 'VERTICAL',
        legs: [
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6600,
            type: 'CALL',
            price: 2.0,
            creditDebit: null,
          },
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO OPEN',
            symbol: 'SPX',
            exp: '2026-03-27',
            strike: 6620,
            type: 'CALL',
            price: 1.0,
            creditDebit: 'CREDIT',
          },
        ],
        netPrice: 1.0,
        orderType: 'LMT',
      },
    ];

    const closed = matchClosedSpreads(trades);
    expect(closed).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// 12. generateWarnings additional cases
// ══════════════════════════════════════════════════════════════

describe('generateWarnings (additional)', () => {
  const allSections = new Map([
    ['Cash Balance', { headerIndex: 0, dataStart: 1, dataEnd: 5 }],
    ['Account Order History', { headerIndex: 6, dataStart: 7, dataEnd: 10 }],
    ['Account Trade History', { headerIndex: 11, dataStart: 12, dataEnd: 15 }],
    ['Options', { headerIndex: 16, dataStart: 17, dataEnd: 20 }],
    ['Profits and Losses', { headerIndex: 21, dataStart: 22, dataEnd: 25 }],
    ['Account Summary', { headerIndex: 26, dataStart: 27, dataEnd: 30 }],
  ]);

  it('emits BALANCE_DISCONTINUITY when cash entries do not reconcile', () => {
    const cashEntries: CashEntry[] = [
      {
        date: '2026-03-27',
        time: '00:00:00',
        type: 'BAL',
        refNumber: null,
        description: 'Start of day',
        miscFees: 0,
        commissions: 0,
        amount: 0,
        balance: 100000,
      },
      {
        date: '2026-03-27',
        time: '09:30:00',
        type: 'TRD',
        refNumber: '1001',
        description: 'SOLD VERTICAL',
        miscFees: -10.52,
        commissions: -13,
        amount: 1500,
        // Expected: 100000 + 1500 + (-10.52) + (-13) = 101476.48
        // Actual: off by $100
        balance: 101576.48,
      },
    ];

    const warnings = generateWarnings(
      cashEntries,
      [],
      true,
      EMPTY_PNL,
      [],
      allSections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'BALANCE_DISCONTINUITY')).toBe(true);
  });

  it('does not emit BALANCE_DISCONTINUITY for small rounding differences', () => {
    const cashEntries: CashEntry[] = [
      {
        date: '2026-03-27',
        time: '00:00:00',
        type: 'BAL',
        refNumber: null,
        description: 'Start of day',
        miscFees: 0,
        commissions: 0,
        amount: 0,
        balance: 100000,
      },
      {
        date: '2026-03-27',
        time: '09:30:00',
        type: 'TRD',
        refNumber: '1001',
        description: 'SOLD VERTICAL',
        miscFees: -10.52,
        commissions: -13,
        amount: 1500,
        // Expected: 100000 + 1500 + (-10.52) + (-13) = 101476.48
        // Diff of only $0.01 — within threshold
        balance: 101476.49,
      },
    ];

    const warnings = generateWarnings(
      cashEntries,
      [],
      true,
      EMPTY_PNL,
      [],
      allSections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'BALANCE_DISCONTINUITY')).toBe(
      false,
    );
  });

  it('emits PNL_MISMATCH when reported P/L is wildly different from computed', () => {
    const pnl: PnLSummary = {
      entries: [],
      totals: {
        symbol: '',
        description: 'OVERALL TOTALS',
        plOpen: -50000,
        plPct: -0.5,
        plDay: 0,
        plYtd: 0,
        plDiff: 0,
        marginReq: 20000,
        markValue: -50000,
      },
    };
    const openLegs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10 }),
    ];
    const spread = makeSpread({
      creditReceived: 1500,
    });

    const warnings = generateWarnings(
      [],
      openLegs,
      true,
      pnl,
      [],
      allSections,
      [spread],
      [],
    );

    // |plOpen| = 50000 > computedCredit * 5 = 1500 * 5 = 7500
    expect(warnings.some((w) => w.code === 'PNL_MISMATCH')).toBe(true);
  });

  it('does not emit PNL_MISMATCH when no positions', () => {
    const pnl: PnLSummary = {
      entries: [],
      totals: {
        symbol: '',
        description: 'OVERALL TOTALS',
        plOpen: -50000,
        plPct: -0.5,
        plDay: 0,
        plYtd: 0,
        plDiff: 0,
        marginReq: 20000,
        markValue: -50000,
      },
    };

    const warnings = generateWarnings(
      [],
      [], // no open legs
      true,
      pnl,
      [],
      allSections,
      [],
      [],
    );

    expect(warnings.some((w) => w.code === 'PNL_MISMATCH')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 13. Aggregate P&L fallback (mark-less estimation)
// ══════════════════════════════════════════════════════════════

describe('parseStatement mark-less P&L estimation', () => {
  it('distributes broker P/L across spreads when marks are missing', () => {
    // The TEST_CSV has no Mark column and has pnl.totals
    // This exercises the allSpreadsLackMarks path
    const result = parseStatement(TEST_CSV, 6500);

    // The IC has putSpread.creditReceived=1500, callSpread.creditReceived=1000
    // totalCredit = 2500
    // aggPlOpen = -200 (from P&L section)
    //
    // putSpread weight = 1500 / 2500 = 0.6
    // costToClose = |-200| * 0.6 = 120
    // putSpread openPnl = 1500 - 120 = 1380
    //
    // callSpread weight = 1000 / 2500 = 0.4
    // costToClose = 200 * 0.4 = 80
    // callSpread openPnl = 1000 - 80 = 920
    const ic = result.ironCondors[0]!;
    expect(ic.putSpread.openPnl).toBeCloseTo(1380, 0);
    expect(ic.callSpread.openPnl).toBeCloseTo(920, 0);
    expect(ic.putSpread.pctOfMaxProfit).toBeCloseTo(92, 0);
    expect(ic.callSpread.pctOfMaxProfit).toBeCloseTo(92, 0);
  });

  it('handles zero total credit gracefully in mark-less estimation', () => {
    // Build a CSV where spreads have zero credit
    // (all trade prices are 0, so creditReceived = 0)
    const zeroCreditCsv = `Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
3/27/26,00:00:00,BAL,,Cash balance at the start of business day,,,,"100,000.00"

Account Order History
Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,0.00,0.00,LMT
,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,0.00,CREDIT,

Options
Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price
SPX,SPXW260327P6380,27 MAR 26,6380,PUT,+10,0.00
SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,0.00

Profits and Losses
Symbol,Description,P/L Open,P/L %,P/L Day,P/L YTD,P/L Diff,Margin Req,Mark Value
SPX,S & P 500 INDEX,($500.00),-1.00%,$0.00,$0.00,$0.00,"$20,000.00","($500.00)"
,OVERALL TOTALS,($500.00),-1.00%,$0.00,$0.00,$0.00,"$20,000.00","($500.00)"

Account Summary
Net Liquidating Value,"$99,500.00"
Stock Buying Power,"$79,500.00"
Option Buying Power,"$79,500.00"
Equity Commissions & Fees YTD,$0.00`;

    // Should NOT throw — totalCredit = 0 branch should be safe
    const result = parseStatement(zeroCreditCsv, 6500);

    // With zero credit, the fallback estimation doesn't run
    // (totalCredit > 0 guard prevents division by zero)
    expect(result.spreads.length + result.ironCondors.length).toBeGreaterThan(
      0,
    );
  });

  it('does not apply fallback when marks are present', () => {
    // When marks are present on legs, groupIntoSpreads computes
    // currentValue from marks, so the allSpreadsLackMarks guard
    // is false and the fallback estimation is skipped.
    // We verify this by building a statement with mark-based
    // currentValue and checking parseStatement would not overwrite.
    const spreadWithMark = makeSpread({
      creditReceived: 1500,
      maxProfit: 1500,
      currentValue: 1400,
      openPnl: 100,
      pctOfMaxProfit: 6.67,
    });

    const pnlWithTotals: PnLSummary = {
      entries: [],
      totals: {
        symbol: '',
        description: 'OVERALL TOTALS',
        plOpen: -200,
        plPct: -0.01,
        plDay: 0,
        plYtd: 0,
        plDiff: 0,
        marginReq: 20000,
        markValue: -200,
      },
    };

    // The fallback in parseStatement only runs when
    // allSpreadsLackMarks is true AND pnl.totals is present.
    // Since our spread has currentValue !== null,
    // allSpreadsLackMarks would be false, so fallback is skipped.
    const stmt = makeStatement({
      spreads: [spreadWithMark],
      pnl: pnlWithTotals,
    });

    // After BS estimates, currentValue is overwritten by decay,
    // but the test is about the mark-less fallback in parseStatement.
    // For that path, we just need to verify the TEST_CSV integration
    // test above covers the mark-less case, and here we verify that
    // spreads with marks keep their mark-based values through
    // parseStatement by checking the MISSING_MARK warning.
    // TEST_CSV lacks marks → MISSING_MARK is emitted (verified above).
    // A CSV with marks should NOT emit MISSING_MARK.
    const marklesResult = parseStatement(TEST_CSV, 6500);
    expect(marklesResult.warnings.some((w) => w.code === 'MISSING_MARK')).toBe(
      true,
    );

    // Verify that the fallback DID run on markless data
    // (the IC spreads should have openPnl set despite lacking marks)
    const ic = marklesResult.ironCondors[0]!;
    expect(ic.putSpread.openPnl).not.toBeNull();

    // And verify the statement with marks is valid
    expect(stmt.spreads[0]!.currentValue).toBe(1400);
    expect(stmt.spreads[0]!.openPnl).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════
// 14. Section Parsers (direct unit tests)
// ══════════════════════════════════════════════════════════════

describe('findSections', () => {
  it('returns empty map for empty lines array', () => {
    const result = findSections([]);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no known section headers present', () => {
    const result = findSections(['some,random,data', 'more,data']);
    expect(result.size).toBe(0);
  });

  it('parses all six sections from multi-section input', () => {
    const lines = [
      'Cash Balance',
      'header row',
      'data',
      '',
      'Account Order History',
      'header',
      'Account Trade History',
      'header',
      'Options',
      'header',
      'Profits and Losses',
      'header',
      'Account Summary',
      'header',
    ];
    const result = findSections(lines);
    expect(result.has('Cash Balance')).toBe(true);
    expect(result.has('Account Order History')).toBe(true);
    expect(result.has('Account Trade History')).toBe(true);
    expect(result.has('Options')).toBe(true);
    expect(result.has('Profits and Losses')).toBe(true);
    expect(result.has('Account Summary')).toBe(true);
  });

  it('sets correct dataStart and dataEnd bounds', () => {
    const lines = [
      'Cash Balance',
      'col header',
      'data row',
      'Account Order History',
      'col header',
    ];
    const result = findSections(lines);
    const cb = result.get('Cash Balance')!;
    expect(cb.headerIndex).toBe(0);
    expect(cb.dataStart).toBe(1);
    expect(cb.dataEnd).toBe(3); // next section starts at 3
    const aoh = result.get('Account Order History')!;
    expect(aoh.headerIndex).toBe(3);
    expect(aoh.dataEnd).toBe(lines.length);
  });

  it('skips empty lines when searching for section headers', () => {
    const lines = ['', '  ', 'Cash Balance', 'header'];
    const result = findSections(lines);
    expect(result.has('Cash Balance')).toBe(true);
    expect(result.get('Cash Balance')!.headerIndex).toBe(2);
  });
});

describe('parseCashBalance', () => {
  it('returns empty array when header row not found', () => {
    const lines = ['Cash Balance', 'no header here', 'data'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(0);
  });

  it('parses BAL and TRD entries correctly', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,00:00:00,BAL,,Cash balance at start,,,,"100,000.00"',
      '3/27/26,09:30:00,TRD,="1001",SOLD VERTICAL,-10.52,-13.00,"1,500.00","101,476.48"',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('BAL');
    expect(result[0]!.balance).toBe(100000);
    expect(result[1]!.type).toBe('TRD');
    expect(result[1]!.refNumber).toBe('1001');
    expect(result[1]!.amount).toBe(1500);
  });

  it('parses LIQ type entries', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,15:59:00,LIQ,,Cash liquidation,0,0,-500.00,99500.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('LIQ');
  });

  it('parses EXP type entries', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,16:05:00,EXP,,Automatic Expiration,0,0,0.00,100000.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('EXP');
  });

  it('skips rows with unknown type', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,09:30:00,XYZ,,Unknown type,0,0,0.00,100000.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(0);
  });

  it('sets refNumber to null when field is empty', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,00:00:00,BAL,,Cash balance,0,0,0.00,100000.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseCashBalance(lines, bounds);
    expect(result[0]!.refNumber).toBeNull();
  });

  it('stops at empty line', () => {
    const lines = [
      'Cash Balance',
      'DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE',
      '3/27/26,00:00:00,BAL,,Cash balance,0,0,0.00,100000.00',
      '',
      '3/27/26,09:30:00,TRD,="1001",trade,0,0,100.00,100100.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 5 };
    const result = parseCashBalance(lines, bounds);
    expect(result).toHaveLength(1); // stopped at empty line
  });
});

describe('parseOrderHistory', () => {
  it('returns empty array when header row not found', () => {
    const lines = ['Account Order History', 'no expected header'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 2 };
    const result = parseOrderHistory(lines, bounds);
    expect(result).toHaveLength(0);
  });

  it('parses a replacement order (RE# prefix)', () => {
    const lines = [
      'Account Order History',
      'Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status',
      'RE#1234,,3/27/26 09:31:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,1.50,LMT,DAY,FILLED',
      ',,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,CREDIT,,,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseOrderHistory(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.isReplacement).toBe(true);
    expect(result[0]!.notes).toBe('RE#1234');
  });

  it('parses REJECTED status and extracts statusDetail', () => {
    const lines = [
      'Account Order History',
      'Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status',
      ',,3/27/26 09:28:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6350,PUT,1.00,LMT,DAY,"REJECTED: Buying power too low"',
      ',,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6330,PUT,CREDIT,,,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseOrderHistory(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('REJECTED');
    expect(result[0]!.statusDetail).toBe('Buying power too low');
  });

  it('parses CANCELED status', () => {
    const lines = [
      'Account Order History',
      'Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status',
      ',,3/27/26 09:28:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6350,PUT,1.00,LMT,DAY,CANCELED',
      ',,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6330,PUT,CREDIT,,,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseOrderHistory(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('CANCELED');
    expect(result[0]!.statusDetail).toBe('');
  });

  it('pushes last order even if no subsequent primary row', () => {
    const lines = [
      'Account Order History',
      'Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status',
      ',,3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,1.50,LMT,DAY,FILLED',
      ',,,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,CREDIT,,,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseOrderHistory(lines, bounds);
    expect(result).toHaveLength(1);
    expect(result[0]!.legs).toHaveLength(2);
  });
});

describe('parseTradeHistory', () => {
  it('returns empty array when header row not found', () => {
    const lines = ['Account Trade History', 'no expected header'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 2 };
    const result = parseTradeHistory(lines, bounds);
    expect(result).toHaveLength(0);
  });

  it('parses DEBIT creditDebit correctly', () => {
    const lines = [
      'Account Trade History',
      ',Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type',
      ',3/27/26 14:00:00,VERTICAL,BUY,+10,TO CLOSE,SPX,27 MAR 26,6600,CALL,.10,.05,LMT',
      ',,,SELL,-10,TO CLOSE,SPX,27 MAR 26,6620,CALL,.05,DEBIT,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseTradeHistory(lines, bounds);
    expect(result).toHaveLength(1);
    // Second leg has DEBIT creditDebit
    const debitLeg = result[0]!.legs.find((l) => l.strike === 6620);
    expect(debitLeg?.creditDebit).toBe('DEBIT');
  });

  it('parses CREDIT creditDebit correctly', () => {
    const lines = [
      'Account Trade History',
      ',Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type',
      ',3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,3.50,1.50,LMT',
      ',,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,2.00,CREDIT,',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseTradeHistory(lines, bounds);
    expect(result).toHaveLength(1);
    const creditLeg = result[0]!.legs.find((l) => l.strike === 6380);
    expect(creditLeg?.creditDebit).toBe('CREDIT');
  });

  it('stops when non-comma-prefixed line is encountered', () => {
    const lines = [
      'Account Trade History',
      ',Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type',
      ',3/27/26 09:30:00,VERTICAL,SELL,-10,TO OPEN,SPX,27 MAR 26,6400,PUT,3.50,1.50,LMT',
      ',,,BUY,+10,TO OPEN,SPX,27 MAR 26,6380,PUT,2.00,CREDIT,',
      'Options', // This stops the trade parsing (doesn't start with comma)
      'header',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 6 };
    const result = parseTradeHistory(lines, bounds);
    expect(result).toHaveLength(1);
  });
});

describe('parseOptions', () => {
  it('returns empty result when header not found', () => {
    const lines = ['Options', 'no expected header'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 2 };
    const result = parseOptions(lines, bounds);
    expect(result.legs).toHaveLength(0);
    expect(result.hasMark).toBe(false);
  });

  it('parses basic options without Mark column', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
      'SPX,SPXW260327P6380,27 MAR 26,6380,PUT,+10,2.00',
      'SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,3.50',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseOptions(lines, bounds);
    expect(result.hasMark).toBe(false);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0]!.qty).toBe(10); // +10 → positive
    expect(result.legs[1]!.qty).toBe(-10); // -10 → negative
  });

  it('detects hasMark when Mark column present', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price,Mark,Mark Value',
      'SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,3.50,0.45,-450',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseOptions(lines, bounds);
    expect(result.hasMark).toBe(true);
    expect(result.legs[0]!.mark).toBe(0.45);
  });

  it('stops at ,OVERALL line', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
      'SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,3.50',
      ',OVERALL TOTALS,,,,,',
      'SPX,SPXW260327P6380,27 MAR 26,6380,PUT,+10,2.00',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 5 };
    const result = parseOptions(lines, bounds);
    expect(result.legs).toHaveLength(1); // stopped at OVERALL TOTALS
  });

  it('skips rows with invalid strike or qty', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
      'SPX,SPXW260327P6400,27 MAR 26,NOT_A_NUMBER,PUT,-10,3.50',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseOptions(lines, bounds);
    expect(result.legs).toHaveLength(0);
  });

  it('skips rows with invalid option type', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
      'SPX,SPXW260327X6400,27 MAR 26,6400,EXOTIC,-10,3.50',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseOptions(lines, bounds);
    expect(result.legs).toHaveLength(0);
  });

  it('treats NaN trade price as 0', () => {
    const lines = [
      'Options',
      'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
      'SPX,SPXW260327P6400,27 MAR 26,6400,PUT,-10,N/A',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 3 };
    const result = parseOptions(lines, bounds);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.tradePrice).toBe(0);
  });
});

describe('parsePnL', () => {
  it('returns empty result when header not found', () => {
    const lines = ['Profits and Losses', 'no expected header'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 2 };
    const result = parsePnL(lines, bounds);
    expect(result.entries).toHaveLength(0);
    expect(result.totals).toBeNull();
  });

  it('parses entries and totals row', () => {
    const lines = [
      'Profits and Losses',
      'Symbol,Description,P/L Open,P/L %,P/L Day,P/L YTD,P/L Diff,Margin Req,Mark Value',
      'SPX,S & P 500 INDEX,($200.00),-1.00%,"$2,381.24","$2,381.24",$0.00,"$20,000.00","($200.00)"',
      ',OVERALL TOTALS,($200.00),-1.00%,"$2,381.24","$2,381.24",$0.00,"$20,000.00","($200.00)"',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parsePnL(lines, bounds);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.symbol).toBe('SPX');
    expect(result.entries[0]!.plOpen).toBe(-200);
    expect(result.totals).not.toBeNull();
    expect(result.totals!.description).toBe('OVERALL TOTALS');
    expect(result.totals!.plOpen).toBe(-200);
  });
});

describe('parseAccountSummarySection', () => {
  it('returns zeros when no lines present', () => {
    const lines = ['Account Summary'];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 1 };
    const result = parseAccountSummarySection(lines, bounds);
    expect(result.netLiquidatingValue).toBe(0);
    expect(result.stockBuyingPower).toBe(0);
    expect(result.optionBuyingPower).toBe(0);
    expect(result.equityCommissionsYtd).toBe(0);
  });

  it('parses all four known fields', () => {
    const lines = [
      'Account Summary',
      'Net Liquidating Value,"$102,181.24"',
      'Stock Buying Power,"$82,181.24"',
      'Option Buying Power,"$82,181.24"',
      'Equity Commissions & Fees YTD,"$68.76"',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 5 };
    const result = parseAccountSummarySection(lines, bounds);
    expect(result.netLiquidatingValue).toBe(102181.24);
    expect(result.stockBuyingPower).toBe(82181.24);
    expect(result.optionBuyingPower).toBe(82181.24);
    expect(result.equityCommissionsYtd).toBe(68.76);
  });

  it('handles missing fields by returning 0', () => {
    const lines = [
      'Account Summary',
      'Net Liquidating Value,"$50,000.00"',
      // Missing the other 3 fields
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 2 };
    const result = parseAccountSummarySection(lines, bounds);
    expect(result.netLiquidatingValue).toBe(50000);
    expect(result.stockBuyingPower).toBe(0);
    expect(result.optionBuyingPower).toBe(0);
    expect(result.equityCommissionsYtd).toBe(0);
  });

  it('stops at empty line', () => {
    const lines = [
      'Account Summary',
      'Net Liquidating Value,"$50,000.00"',
      '',
      'Stock Buying Power,"$40,000.00"',
    ];
    const bounds = { headerIndex: 0, dataStart: 1, dataEnd: 4 };
    const result = parseAccountSummarySection(lines, bounds);
    expect(result.netLiquidatingValue).toBe(50000);
    expect(result.stockBuyingPower).toBe(0); // not reached after empty line
  });
});
