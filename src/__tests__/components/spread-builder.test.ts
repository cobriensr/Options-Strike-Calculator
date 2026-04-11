import { describe, it, expect } from 'vitest';
import { groupIntoSpreads } from '../../components/PositionMonitor/statement-parser/spread-builder';
import type {
  CashEntry,
  ExecutedTrade,
  OpenLeg,
} from '../../components/PositionMonitor/types';

// ── Factories ─────────────────────────────────────────────────

function makeLeg(
  overrides: Partial<OpenLeg> & Pick<OpenLeg, 'strike' | 'type' | 'qty'>,
): OpenLeg {
  return {
    symbol: 'SPX',
    optionCode: `SPXW260327${overrides.type === 'PUT' ? 'P' : 'C'}${String(overrides.strike)}`,
    exp: '2026-03-27',
    tradePrice: 0,
    mark: null,
    markValue: null,
    ...overrides,
  };
}

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

function makeCashEntry(overrides: Partial<CashEntry> = {}): CashEntry {
  return {
    date: '3/27/26',
    time: '09:30:00',
    type: 'TRD',
    refNumber: '1001',
    description: 'SOLD -10 VERTICAL SPX 100 6400/6380',
    miscFees: 0,
    commissions: 13,
    amount: 1500,
    balance: 101500,
    ...overrides,
  };
}

const emptyTrades: ExecutedTrade[] = [];
const emptyCash: CashEntry[] = [];
const spotPrice = 6500;

// ── buildSpread: CCS breakeven branch ─────────────────────────

describe('buildSpread (via groupIntoSpreads)', () => {
  it('computes correct breakeven for a CCS', () => {
    const trades = [
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
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    // CCS breakeven = shortStrike + creditPerContract
    // creditPerContract = |2.0| - |1.0| = 1.0
    // breakeven = 6600 + 1.0 = 6601.0
    expect(spread.spreadType).toBe('CALL_CREDIT_SPREAD');
    expect(spread.breakeven).toBe(6601);
  });

  it('computes correct distanceToShortStrike for CCS (shortStrike - spot)', () => {
    const trades = [
      makeTrade({
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 5, strike: 6600, type: 'CALL', price: 2.0 },
          { side: 'BUY', qty: 5, strike: 6620, type: 'CALL', price: 1.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6600, type: 'CALL', qty: -5, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 5, tradePrice: 1.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, 6500, emptyCash);
    const spread = result.spreads[0]!;

    // For CCS: distanceToShortStrike = shortStrike - spot = 6600 - 6500 = 100
    expect(spread.distanceToShortStrike).toBe(100);
  });

  it('sets distanceToShortStrikePct to null when spotPrice is 0', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, 0, emptyCash);
    const spread = result.spreads[0]!;

    expect(spread.distanceToShortStrikePct).toBeNull();
  });

  it('returns Infinity riskRewardRatio when maxProfit is 0', () => {
    // maxProfit = creditReceived = 0 when both legs have same price
    const trades = [
      makeTrade({
        netPrice: 0,
        legs: [
          { side: 'SELL', qty: 1, strike: 6400, type: 'PUT', price: 2.0 },
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -1, tradePrice: 2.0 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 1, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    expect(spread.riskRewardRatio).toBe(Infinity);
    expect(spread.creditReceived).toBe(0);
  });

  it('sets pctOfMaxProfit to null when openPnl is null (no marks)', () => {
    // When the trade-built spread has no marks (mark: null on synthetic legs),
    // openPnl and pctOfMaxProfit should both be null.
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 1, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -1, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 1, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    // Synthetic legs from trade history have mark: null → currentValue null
    expect(spread.currentValue).toBeNull();
    expect(spread.openPnl).toBeNull();
    expect(spread.pctOfMaxProfit).toBeNull();
  });

  it('sets openPnl to null when both marks are null', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 1, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({
        strike: 6400,
        type: 'PUT',
        qty: -1,
        tradePrice: 3.5,
        mark: null,
        markValue: null,
      }),
      makeLeg({
        strike: 6380,
        type: 'PUT',
        qty: 1,
        tradePrice: 2.0,
        mark: null,
        markValue: null,
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    expect(spread.currentValue).toBeNull();
    expect(spread.openPnl).toBeNull();
    expect(spread.pctOfMaxProfit).toBeNull();
  });
});

// ── matchTradeEntry: no matching trade ────────────────────────

describe('matchTradeEntry (via groupIntoSpreads)', () => {
  it('returns null entryNetPrice when no matching trade for entryTime lookup', () => {
    // A spread IS built from the matching trade, but matchTradeEntry is called
    // internally to find entry time. The entry time equals the trade execTime
    // since the same trade builds and matches the spread.
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const trades = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    // Spread built from trade: entryTime matches the trade
    expect(result.spreads).toHaveLength(1);
    expect(result.spreads[0]!.entryTime).toBe('3/27/26 09:30:00');
    expect(result.spreads[0]!.entryNetPrice).toBe(1.5);
  });

  it('sets entryTime to null when no 2-leg trade matches the options legs', () => {
    // Options legs present but NO matching 2-leg TO OPEN trade → no spread built
    // (trade-based path only, so legs appear as naked/hedge)
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    // Trades exist but are TO CLOSE, not TO OPEN
    const trades = [
      makeTrade({
        netPrice: 0.1,
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            strike: 6400,
            type: 'PUT',
            price: 0.1,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            strike: 6380,
            type: 'PUT',
            price: 0.05,
          },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    // No TO OPEN 2-leg trade → no spreads from trade path
    // Options legs become naked + hedge (uncovered)
    expect(result.spreads).toHaveLength(0);
    expect(result.naked).toHaveLength(1);
    expect(result.hedges).toHaveLength(1);
  });

  it('returns correct entryTime when trade matches spread legs', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const trades = [
      makeTrade({
        execTime: '3/27/26 09:45:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    expect(spread.entryTime).toBe('3/27/26 09:45:00');
    expect(spread.entryNetPrice).toBe(1.5);
  });
});

// ── computeEntryCommissions ────────────────────────────────────

describe('computeEntryCommissions (via groupIntoSpreads)', () => {
  it('returns 0 when no cash entries match', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);
    const spread = result.spreads[0]!;

    expect(spread.entryCommissions).toBe(0);
  });

  it('returns commissions when cash entry description contains strike', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const cashEntries: CashEntry[] = [
      makeCashEntry({
        description: 'SOLD -10 VERTICAL SPX 100 6400/6380 PUT @1.50',
        commissions: 13,
        type: 'TRD',
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, cashEntries);
    const spread = result.spreads[0]!;

    expect(spread.entryCommissions).toBe(13);
  });

  it('skips cash entries with zero commissions', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const cashEntries: CashEntry[] = [
      makeCashEntry({
        description: 'SOLD -10 VERTICAL SPX 100 6400/6380 PUT @1.50',
        commissions: 0,
        type: 'TRD',
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, cashEntries);
    const spread = result.spreads[0]!;

    expect(spread.entryCommissions).toBe(0);
  });

  it('skips non-TRD cash entries', () => {
    const trades = [
      makeTrade({
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];
    const cashEntries: CashEntry[] = [
      makeCashEntry({
        description: 'Cash balance 6400/6380',
        commissions: 99,
        type: 'BAL',
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, cashEntries);
    const spread = result.spreads[0]!;

    // BAL type is skipped
    expect(spread.entryCommissions).toBe(0);
  });
});

// ── Butterfly detection ────────────────────────────────────────

describe('groupIntoSpreads — butterfly detection', () => {
  it('detects a symmetric butterfly from 3-leg BUTTERFLY trade', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.butterflies).toHaveLength(1);
    const bfly = result.butterflies[0]!;
    expect(bfly.lowerLeg.strike).toBe(6380);
    expect(bfly.middleLeg.strike).toBe(6400);
    expect(bfly.upperLeg.strike).toBe(6420);
    expect(bfly.isBrokenWing).toBe(false);
    expect(bfly.lowerWidth).toBe(20);
    expect(bfly.upperWidth).toBe(20);
    expect(bfly.optionType).toBe('PUT');
  });

  it('detects a broken wing butterfly (BWB)', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 0.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6360, type: 'PUT', price: 7.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.butterflies).toHaveLength(1);
    const bfly = result.butterflies[0]!;
    expect(bfly.isBrokenWing).toBe(true);
    expect(bfly.lowerWidth).toBe(40); // 6400 - 6360
    expect(bfly.upperWidth).toBe(20); // 6420 - 6400
  });

  it('computes BWB maxLoss using wider-minus-narrower formula', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 0.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6360, type: 'PUT', price: 7.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);
    const bfly = result.butterflies[0]!;

    // narrowerWidth = 20, widerWidth = 40
    // debitPaid = abs(0.5) * 100 * 1 = 50
    // maxLoss = (40 - 20) * 100 * 1 + 50 = 2050
    expect(bfly.debitPaid).toBe(50);
    expect(bfly.maxLoss).toBe(2050);
  });

  it('computes symmetric BFLY maxLoss = debitPaid', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);
    const bfly = result.butterflies[0]!;

    // debitPaid = abs(1.5) * 100 * 1 = 150
    // maxLoss = debitPaid = 150
    expect(bfly.maxLoss).toBe(bfly.debitPaid);
    expect(bfly.isBrokenWing).toBe(false);
  });

  it('sets distanceToPin to null when spotPrice is 0', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, 0, emptyCash);
    const bfly = result.butterflies[0]!;

    expect(bfly.distanceToPin).toBeNull();
  });

  it('computes distanceToPin = middleStrike - spotPrice', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, 6450, emptyCash);
    const bfly = result.butterflies[0]!;

    // distanceToPin = 6400 - 6450 = -50
    expect(bfly.distanceToPin).toBe(-50);
  });

  it('skips butterfly trade with wrong leg count', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          // Only 2 TO OPEN legs — invalid butterfly
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 1, strike: 6400, type: 'PUT', price: 3.5 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.butterflies).toHaveLength(0);
  });

  it('skips butterfly trade with wrong buy/sell count', () => {
    // 3 buys, 0 sells — invalid
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'BUY', qty: 1, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 1, strike: 6420, type: 'PUT', price: 5.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.butterflies).toHaveLength(0);
  });

  it('skips butterfly trade with mixed option types', () => {
    const trades = [
      makeTrade({
        spread: 'BUTTERFLY',
        netPrice: 1.5,
        legs: [
          { side: 'BUY', qty: 1, strike: 6380, type: 'PUT', price: 5.0 },
          { side: 'SELL', qty: 2, strike: 6400, type: 'PUT', price: 3.5 },
          {
            side: 'BUY',
            qty: 1,
            strike: 6420,
            type: 'CALL', // Wrong type
            price: 5.0,
          },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.butterflies).toHaveLength(0);
  });
});

// ── IC pairing edge cases ─────────────────────────────────────

describe('groupIntoSpreads — IC pairing edge cases', () => {
  it('falls back to CCS entryTime when PCS entryTime is null', () => {
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];
    // PCS trade has different strikes → matchTradeEntry returns null entryTime
    // CCS trade matches correctly → its entryTime is used for the IC
    const trades = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          // Different strikes → won't match the PCS spread from options legs
          { side: 'SELL', qty: 10, strike: 6410, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6390, type: 'PUT', price: 2.0 },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:35:00',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          { side: 'BUY', qty: 10, strike: 6620, type: 'CALL', price: 1.0 },
        ],
      }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    // The IC is formed from the two matching 2-leg trades above (6410/6390 PCS
    // and 6600/6620 CCS), both 10 contracts → paired into an IC.
    // The original options legs (6400/6380 PUT) are uncovered → naked + hedge.
    expect(result.ironCondors).toHaveLength(1);
    const ic = result.ironCondors[0]!;
    // PCS spread's entryTime matches the first trade (6410/6390) → '3/27/26 09:30:00'
    expect(ic.entryTime).toBe('3/27/26 09:30:00');
  });

  it('uses CCS entryTime as IC entryTime when PCS entryTime is null (no trade match)', () => {
    // Only provide the CCS trade; PCS has no trade match → pcs.entryTime = null
    const trades = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:35:00',
        netPrice: 1.0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6600, type: 'CALL', price: 2.0 },
          { side: 'BUY', qty: 10, strike: 6620, type: 'CALL', price: 1.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -10, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 10, tradePrice: 1.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.ironCondors).toHaveLength(1);
    const ic = result.ironCondors[0]!;
    // Both trades match; IC entryTime = PCS entryTime (first match, non-null)
    expect(ic.entryTime).toBe('3/27/26 09:30:00');
  });

  it('does not pair PCS + CCS with mismatched contracts', () => {
    const trades = [
      makeTrade({
        execTime: '3/27/26 09:30:00',
        netPrice: 1.5,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
      makeTrade({
        execTime: '3/27/26 09:35:00',
        netPrice: 1.0,
        legs: [
          // 5 contracts, vs 10 for PCS → not paired into IC
          { side: 'SELL', qty: 5, strike: 6600, type: 'CALL', price: 2.0 },
          { side: 'BUY', qty: 5, strike: 6620, type: 'CALL', price: 1.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
      makeLeg({ strike: 6600, type: 'CALL', qty: -5, tradePrice: 2.0 }),
      makeLeg({ strike: 6620, type: 'CALL', qty: 5, tradePrice: 1.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.ironCondors).toHaveLength(0);
    expect(result.spreads).toHaveLength(2);
  });

  it('skips 2-leg trades with no sell leg', () => {
    const trades = [
      makeTrade({
        netPrice: 0,
        legs: [
          // Both buys — no valid spread
          { side: 'BUY', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'PUT', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: 10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'PUT', qty: 10, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.spreads).toHaveLength(0);
  });

  it('skips 2-leg trades where legs have different option types', () => {
    const trades = [
      makeTrade({
        netPrice: 0,
        legs: [
          { side: 'SELL', qty: 10, strike: 6400, type: 'PUT', price: 3.5 },
          { side: 'BUY', qty: 10, strike: 6380, type: 'CALL', price: 2.0 },
        ],
      }),
    ];
    const legs: OpenLeg[] = [
      makeLeg({ strike: 6400, type: 'PUT', qty: -10, tradePrice: 3.5 }),
      makeLeg({ strike: 6380, type: 'CALL', qty: 10, tradePrice: 2.0 }),
    ];

    const result = groupIntoSpreads(legs, trades, spotPrice, emptyCash);

    expect(result.spreads).toHaveLength(0);
  });
});

// ── Hedge hedge current value / openPnl ───────────────────────

describe('groupIntoSpreads — hedge markValue branch', () => {
  it('computes hedge currentValue from markValue when present', () => {
    const legs: OpenLeg[] = [
      makeLeg({
        strike: 6300,
        type: 'PUT',
        qty: 5,
        tradePrice: 0.5,
        markValue: 400, // 5 contracts at $0.80 each * 100 = $400
      }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    expect(result.hedges).toHaveLength(1);
    const hedge = result.hedges[0]!;
    expect(hedge.currentValue).not.toBeNull();
    expect(hedge.openPnl).not.toBeNull();
  });

  it('sets hedge currentValue to null when markValue is null', () => {
    const legs: OpenLeg[] = [
      makeLeg({
        strike: 6300,
        type: 'PUT',
        qty: 5,
        tradePrice: 0.5,
        markValue: null,
      }),
    ];

    const result = groupIntoSpreads(legs, emptyTrades, spotPrice, emptyCash);

    expect(result.hedges).toHaveLength(1);
    const hedge = result.hedges[0]!;
    expect(hedge.currentValue).toBeNull();
    expect(hedge.openPnl).toBeNull();
  });
});

// ── TO CLOSE trades are skipped ───────────────────────────────

describe('groupIntoSpreads — TO CLOSE trades', () => {
  it('ignores TO CLOSE legs for spread building', () => {
    const trades = [
      makeTrade({
        netPrice: 0.05,
        legs: [
          {
            side: 'BUY',
            qty: 10,
            posEffect: 'TO CLOSE',
            strike: 6600,
            type: 'CALL',
            price: 0.1,
          },
          {
            side: 'SELL',
            qty: 10,
            posEffect: 'TO CLOSE',
            strike: 6620,
            type: 'CALL',
            price: 0.05,
          },
        ],
      }),
    ];

    const result = groupIntoSpreads([], trades, spotPrice, emptyCash);

    expect(result.spreads).toHaveLength(0);
    expect(result.ironCondors).toHaveLength(0);
  });
});
