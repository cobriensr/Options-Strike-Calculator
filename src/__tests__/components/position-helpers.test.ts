import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatPct,
  formatTime,
  pnlColor,
  spreadStrikeLabel,
  spreadTypeLabel,
  cushionPct,
  formatPositionSummaryForClaude,
} from '../../components/PositionMonitor/position-helpers';
import type {
  DailyStatement,
  OpenLeg,
  Spread,
} from '../../components/PositionMonitor/types';

// ── Helpers ───────────────────────────────────────────

function makeLeg(overrides: Partial<OpenLeg> = {}): OpenLeg {
  return {
    symbol: 'SPX',
    optionCode: '',
    exp: '2026-04-06',
    strike: 6500,
    type: 'PUT',
    qty: -10,
    tradePrice: 2.5,
    mark: null,
    markValue: null,
    ...overrides,
  };
}

function makeSpread(overrides: Partial<Spread> = {}): Spread {
  return {
    spreadType: 'PUT_CREDIT_SPREAD',
    shortLeg: makeLeg({ strike: 6545, qty: -10 }),
    longLeg: makeLeg({ strike: 6525, qty: 10 }),
    contracts: 10,
    wingWidth: 20,
    creditReceived: 1250,
    maxProfit: 1250,
    maxLoss: 18750,
    riskRewardRatio: 15,
    breakeven: 6543.75,
    entryTime: '10:00:39',
    entryNetPrice: 1.25,
    currentValue: null,
    openPnl: null,
    pctOfMaxProfit: null,
    distanceToShortStrike: 62,
    distanceToShortStrikePct: 0.94,
    nearestShortStrike: 6545,
    entryCommissions: 13,
    ...overrides,
  };
}

function makeStatement(
  spreads: Spread[] = [],
  overrides: Partial<DailyStatement> = {},
): DailyStatement {
  const totalCredit = spreads.reduce((s, sp) => s + sp.creditReceived, 0);
  return {
    date: '2026-04-06',
    cashEntries: [],
    orders: [],
    trades: [],
    openLegs: [],
    pnl: { entries: [], totals: null },
    accountSummary: {
      netLiquidatingValue: 350000,
      stockBuyingPower: 150000,
      optionBuyingPower: 150000,
      equityCommissionsYtd: 8000,
    },
    spreads,
    ironCondors: [],
    hedges: [],
    nakedPositions: [],
    closedSpreads: [],
    portfolioRisk: {
      callSideRisk: 0,
      putSideRisk: spreads.reduce((s, sp) => s + sp.maxLoss, 0),
      callHedgeValue: 0,
      putHedgeValue: 0,
      netCallRisk: 0,
      netPutRisk: spreads.reduce((s, sp) => s + sp.maxLoss, 0),
      totalMaxLoss: spreads.reduce((s, sp) => s + sp.maxLoss, 0),
      totalCredit,
      totalContracts: spreads.reduce((s, sp) => s + sp.contracts, 0),
      spotPrice: 6607,
      nearestShortStrikeDistance: 62,
      nakedCount: 0,
      breakevenLow: 6530,
      breakevenHigh: null,
      buyingPowerUsed: 200000,
      buyingPowerAvailable: 150000,
      buyingPowerUtilization: 0.57,
      canAbsorbMaxLoss: true,
      concentration: 0.25,
    },
    executionQuality: {
      fills: [],
      averageSlippage: 0,
      totalSlippageDollars: 0,
      fillRate: 1,
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

// ── formatCurrency ────────────────────────────────────

describe('formatCurrency', () => {
  it('formats positive values', () => {
    expect(formatCurrency(1250)).toBe('$1,250.00');
  });

  it('formats negative values with parentheses', () => {
    expect(formatCurrency(-500)).toBe('($500.00)');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });
});

// ── formatPct ─────────────────────────────────────────

describe('formatPct', () => {
  it('formats percentage', () => {
    expect(formatPct(0.94)).toBe('0.9%');
  });

  it('returns dash for null', () => {
    expect(formatPct(null)).toBe('\u2014');
  });
});

// ── formatTime ────────────────────────────────────────

describe('formatTime', () => {
  it('returns time string', () => {
    expect(formatTime('10:00:39')).toBe('10:00:39');
  });

  it('returns dash for null', () => {
    expect(formatTime(null)).toBe('\u2014');
  });
});

// ── pnlColor ──────────────────────────────────────────

describe('pnlColor', () => {
  it('returns success for positive', () => {
    expect(pnlColor(100)).toBe('text-success');
  });

  it('returns danger for negative', () => {
    expect(pnlColor(-50)).toBe('text-danger');
  });

  it('returns muted for null', () => {
    expect(pnlColor(null)).toBe('text-muted');
  });

  it('returns primary for zero', () => {
    expect(pnlColor(0)).toBe('text-primary');
  });
});

// ── spreadStrikeLabel ─────────────────────────────────

describe('spreadStrikeLabel', () => {
  it('formats short/long strikes', () => {
    const s = makeSpread();
    expect(spreadStrikeLabel(s)).toBe('6545/6525');
  });
});

// ── spreadTypeLabel ───────────────────────────────────

describe('spreadTypeLabel', () => {
  it('returns PCS for put credit spread', () => {
    expect(spreadTypeLabel(makeSpread())).toBe('PCS');
  });

  it('returns CCS for call credit spread', () => {
    expect(
      spreadTypeLabel(makeSpread({ spreadType: 'CALL_CREDIT_SPREAD' })),
    ).toBe('CCS');
  });
});

// ── cushionPct ────────────────────────────────────────

describe('cushionPct', () => {
  it('returns distance pct when available', () => {
    expect(cushionPct(makeSpread(), 6607)).toBe(0.94);
  });

  it('returns null when spot is zero', () => {
    expect(cushionPct(makeSpread(), 0)).toBeNull();
  });

  it('returns null when pct is null', () => {
    expect(
      cushionPct(makeSpread({ distanceToShortStrikePct: null }), 6607),
    ).toBeNull();
  });
});

// ── formatPositionSummaryForClaude ────────────────────

describe('formatPositionSummaryForClaude', () => {
  it('formats a single PCS spread', () => {
    const spread = makeSpread();
    const statement = makeStatement([spread]);
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('1 defined-risk positions');
    expect(result).toContain('NO naked legs');
    expect(result).toContain('PCS 6545/6525 x10');
    expect(result).toContain('credit $1250.00');
    expect(result).toContain('62 pts cushion');
  });

  it('formats multiple spreads sorted by strike', () => {
    const spreads = [
      makeSpread({
        shortLeg: makeLeg({ strike: 6560 }),
        longLeg: makeLeg({ strike: 6520 }),
        distanceToShortStrike: 47,
      }),
      makeSpread({
        shortLeg: makeLeg({ strike: 6530 }),
        longLeg: makeLeg({ strike: 6510 }),
        distanceToShortStrike: 77,
      }),
    ];
    const statement = makeStatement(spreads);
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('2 defined-risk positions');
    // 6530 should come before 6560 (sorted by short strike)
    const idx6530 = result.indexOf('6530/6510');
    const idx6560 = result.indexOf('6560/6520');
    expect(idx6530).toBeLessThan(idx6560);
  });

  it('includes total credit and max loss in header', () => {
    const spreads = [
      makeSpread({ creditReceived: 1250 }),
      makeSpread({ creditReceived: 1000 }),
    ];
    const statement = makeStatement(spreads);
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('Total credit: $2250.00');
  });

  it('returns empty string for no positions', () => {
    const statement = makeStatement([]);
    const result = formatPositionSummaryForClaude(statement, 6607);
    expect(result).toBe('');
  });

  it('includes CCS spreads with correct label', () => {
    const spread = makeSpread({
      spreadType: 'CALL_CREDIT_SPREAD',
      shortLeg: makeLeg({ strike: 6700, type: 'CALL' }),
      longLeg: makeLeg({ strike: 6720, type: 'CALL' }),
    });
    const statement = makeStatement([spread]);
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('CCS 6700/6720');
  });

  it('includes pctOfMaxProfit when available', () => {
    const spread = makeSpread({ pctOfMaxProfit: 85 });
    const statement = makeStatement([spread]);
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('85% max');
  });

  it('includes hedge positions', () => {
    const statement = makeStatement([], {
      hedges: [
        {
          leg: makeLeg({ strike: 6500, qty: 5 }),
          direction: 'LONG',
          protectionSide: 'PUT',
          strikeProtected: 6500,
          contracts: 5,
          entryCost: 500,
          currentValue: null,
          openPnl: null,
        },
      ],
    });
    const result = formatPositionSummaryForClaude(statement, 6607);

    expect(result).toContain('HEDGE: Long 6500 PUT x5');
    expect(result).toContain('cost $500.00');
  });
});
