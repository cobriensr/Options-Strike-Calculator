import { describe, it, expect } from 'vitest';
import {
  computeEffectiveMaxLoss,
  computeAggregatePortfolioRisk,
} from '../../utils/portfolio-risk';
import type {
  IronCondor,
  OpenLeg,
  Spread,
  SpreadType,
} from '../../components/PositionMonitor/types';

// ── Factory helpers ─────────────────────────────────────────────

function makeLeg(
  overrides: Partial<OpenLeg> & Pick<OpenLeg, 'strike' | 'type'>,
): OpenLeg {
  return {
    symbol: '.SPXW',
    optionCode: `SPXW${overrides.type[0]}${overrides.strike}`,
    exp: '2026-04-09',
    qty: -1,
    tradePrice: 1,
    mark: 0.5,
    markValue: null,
    ...overrides,
  };
}

function makeSpread(
  spreadType: SpreadType,
  creditReceived: number,
  maxLoss: number,
  contracts = 1,
): Spread {
  const isCall = spreadType === 'CALL_CREDIT_SPREAD';
  return {
    spreadType,
    shortLeg: makeLeg({
      strike: isCall ? 5720 : 5680,
      type: isCall ? 'CALL' : 'PUT',
    }),
    longLeg: makeLeg({
      strike: isCall ? 5730 : 5670,
      type: isCall ? 'CALL' : 'PUT',
    }),
    contracts,
    wingWidth: 10,
    creditReceived,
    maxProfit: creditReceived,
    maxLoss,
    riskRewardRatio: maxLoss / creditReceived,
    breakeven: isCall
      ? 5720 + creditReceived / 100
      : 5680 - creditReceived / 100,
    entryTime: null,
    entryNetPrice: null,
    currentValue: null,
    openPnl: null,
    pctOfMaxProfit: null,
    distanceToShortStrike: null,
    distanceToShortStrikePct: null,
    nearestShortStrike: isCall ? 5720 : 5680,
    entryCommissions: 0,
  };
}

function makeIC(
  putCredit: number,
  putMaxLoss: number,
  callCredit: number,
  callMaxLoss: number,
): IronCondor {
  const putSpread = makeSpread('PUT_CREDIT_SPREAD', putCredit, putMaxLoss);
  const callSpread = makeSpread('CALL_CREDIT_SPREAD', callCredit, callMaxLoss);
  return {
    spreadType: 'IRON_CONDOR',
    putSpread,
    callSpread,
    contracts: 1,
    totalCredit: putCredit + callCredit,
    maxProfit: putCredit + callCredit,
    maxLoss: Math.max(putMaxLoss, callMaxLoss) - (putCredit + callCredit),
    riskRewardRatio: 1,
    breakevenLow: 5650,
    breakevenHigh: 5750,
    putWingWidth: 10,
    callWingWidth: 10,
    entryTime: null,
  };
}

// ── computeEffectiveMaxLoss ─────────────────────────────────────

describe('computeEffectiveMaxLoss', () => {
  it('returns 0 when there are no open positions', () => {
    expect(computeEffectiveMaxLoss([], [], 0)).toBe(0);
    expect(computeEffectiveMaxLoss([], [], 3)).toBe(0);
  });

  it('sums stand-alone PCS risk on the put side', () => {
    const spreads = [
      makeSpread('PUT_CREDIT_SPREAD', 100, 900),
      makeSpread('PUT_CREDIT_SPREAD', 50, 450),
    ];
    // multiplier = 0 ⇒ min(credit*0, maxLoss) = 0 per spread
    expect(computeEffectiveMaxLoss(spreads, [], 0)).toBe(0);
    // multiplier = 2 ⇒ cap each at 2x credit
    expect(computeEffectiveMaxLoss(spreads, [], 2)).toBe(200 + 100);
    // multiplier very high ⇒ clamped to theoretical max loss
    expect(computeEffectiveMaxLoss(spreads, [], 999)).toBe(900 + 450);
  });

  it('sums stand-alone CCS risk on the call side', () => {
    const spreads = [makeSpread('CALL_CREDIT_SPREAD', 80, 920)];
    expect(computeEffectiveMaxLoss(spreads, [], 3)).toBe(240);
    expect(computeEffectiveMaxLoss(spreads, [], 999)).toBe(920);
  });

  it('returns MAX of call and put sides, not the sum (IC convention)', () => {
    // Two stand-alone spreads: one call, one put. ICs cannot lose both
    // wings, but stand-alone verticals on opposite sides can. However,
    // the helper deliberately returns the conservative MAX to match the
    // iron-condor "can only lose one side" convention — this is the
    // tradeoff documented in the module header.
    const spreads = [
      makeSpread('PUT_CREDIT_SPREAD', 100, 900),
      makeSpread('CALL_CREDIT_SPREAD', 100, 900),
    ];
    // Both sides contribute 900 theoretically; MAX = 900, not 1800.
    expect(computeEffectiveMaxLoss(spreads, [], 999)).toBe(900);
  });

  it('adds IC put-wing and call-wing risk to their respective sides', () => {
    // Single IC, put wing loss 920, call wing loss 850 ⇒ MAX = 920
    const ics = [makeIC(80, 920, 150, 850)];
    expect(computeEffectiveMaxLoss([], ics, 999)).toBe(920);
  });

  it('combines stand-alone spreads and ICs on the same side via MAX', () => {
    // Put side:  PCS 500 + IC put wing 400 = 900
    // Call side: IC call wing 700 = 700
    // MAX = 900
    const spreads = [makeSpread('PUT_CREDIT_SPREAD', 50, 500)];
    const ics = [makeIC(40, 400, 30, 700)];
    expect(computeEffectiveMaxLoss(spreads, ics, 999)).toBe(900);
  });
});

// ── computeAggregatePortfolioRisk ───────────────────────────────

describe('computeAggregatePortfolioRisk', () => {
  it('falls back to theoretical max loss when multiplier is 0', () => {
    const spreads = [makeSpread('PUT_CREDIT_SPREAD', 100, 900)];
    const result = computeAggregatePortfolioRisk(
      spreads,
      [],
      0,
      100_000,
      12,
      920, // caller-supplied theoretical total
    );
    expect(result.effectiveMaxLoss).toBe(920);
    expect(result.pctOfNlv).toBeCloseTo(0.92, 5);
    expect(result.isOverThreshold).toBe(false);
  });

  it('uses computeEffectiveMaxLoss when multiplier > 0', () => {
    const spreads = [makeSpread('PUT_CREDIT_SPREAD', 100, 900)];
    const result = computeAggregatePortfolioRisk(
      spreads,
      [],
      3,
      100_000,
      12,
      920,
    );
    // 3x credit = 300, < theoretical 900 ⇒ 300
    expect(result.effectiveMaxLoss).toBe(300);
  });

  it('returns pctOfNlv = 0 when NLV is 0 or negative', () => {
    const result = computeAggregatePortfolioRisk(
      [makeSpread('PUT_CREDIT_SPREAD', 100, 900)],
      [],
      999,
      0,
      12,
      900,
    );
    expect(result.pctOfNlv).toBe(0);
    expect(result.isOverThreshold).toBe(false);
  });

  it('isOverThreshold is false when pctOfNlv equals threshold (strict >)', () => {
    // Exactly 12% of 10_000 = 1200
    const spreads = [makeSpread('PUT_CREDIT_SPREAD', 9999, 1200)];
    const result = computeAggregatePortfolioRisk(
      spreads,
      [],
      999,
      10_000,
      12,
      1200,
    );
    expect(result.pctOfNlv).toBeCloseTo(12, 5);
    expect(result.isOverThreshold).toBe(false);
  });

  it('isOverThreshold flips true just past the threshold boundary', () => {
    // 12.01% of 10_000 = 1201
    const spreads = [makeSpread('PUT_CREDIT_SPREAD', 9999, 1201)];
    const result = computeAggregatePortfolioRisk(
      spreads,
      [],
      999,
      10_000,
      12,
      1201,
    );
    expect(result.pctOfNlv).toBeGreaterThan(12);
    expect(result.isOverThreshold).toBe(true);
  });

  it('flags over-threshold across stacked ICs using MAX-not-SUM semantics', () => {
    // Two ICs: each put wing 700 ⇒ combined put side 1400
    //          each call wing 600 ⇒ combined call side 1200
    // MAX = 1400; NLV 10_000 ⇒ 14% > 12% threshold
    const ics = [makeIC(50, 700, 60, 600), makeIC(50, 700, 60, 600)];
    const result = computeAggregatePortfolioRisk(
      [],
      ics,
      999,
      10_000,
      12,
      1400,
    );
    expect(result.effectiveMaxLoss).toBe(1400);
    expect(result.pctOfNlv).toBeCloseTo(14, 5);
    expect(result.isOverThreshold).toBe(true);
  });

  it('returns isOverThreshold as a primitive boolean (effect-dep safe)', () => {
    const result = computeAggregatePortfolioRisk([], [], 0, 100_000, 12, 0);
    expect(typeof result.isOverThreshold).toBe('boolean');
  });
});
