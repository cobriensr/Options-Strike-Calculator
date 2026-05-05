// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  computeLotteryScore,
  lotteryScoreTier,
  LOTTERY_TICKER_WEIGHTS,
  LOTTERY_TIER_THRESHOLDS,
} from '../_lib/lottery-score-weights.js';

describe('computeLotteryScore', () => {
  it('returns the maximum score for a top-tier 0DTE call', () => {
    // USAR (10) + 0DTE (5) + price ≤ $0.50 (5) + AM_open (3) + call (2)
    expect(
      computeLotteryScore({
        ticker: 'USAR',
        mode: 'A_intraday_0DTE',
        entryPrice: 0.4,
        tod: 'AM_open',
        optionType: 'C',
      }),
    ).toBe(25);
  });

  it('respects the price threshold ladder (≤$0.50 wins over ≤$1.00)', () => {
    // SNDK (10) + 0DTE (5) + price ≤ $0.50 (5, NOT 3) + MID (2) + call (2) = 24
    expect(
      computeLotteryScore({
        ticker: 'SNDK',
        mode: 'A_intraday_0DTE',
        entryPrice: 0.5,
        tod: 'MID',
        optionType: 'C',
      }),
    ).toBe(24);
  });

  it('zeroes price weight when entry price exceeds $1.00', () => {
    // SNDK (10) + 0DTE (5) + price > $1.00 (0) + MID (2) + call (2) = 19
    expect(
      computeLotteryScore({
        ticker: 'SNDK',
        mode: 'A_intraday_0DTE',
        entryPrice: 2.5,
        tod: 'MID',
        optionType: 'C',
      }),
    ).toBe(19);
  });

  it('returns 0 for an unweighted ticker / multi-day put / lunch / pricey', () => {
    // unknown ticker (0) + multi-day (0) + price > $1.00 (0) + LUNCH (0) + put (0)
    expect(
      computeLotteryScore({
        ticker: 'AAPL',
        mode: 'B_multi_day_DTE1_3',
        entryPrice: 4.5,
        tod: 'LUNCH',
        optionType: 'P',
      }),
    ).toBe(0);
  });

  it('does not give 0DTE credit to OUT_OF_UNIVERSE mode', () => {
    expect(
      computeLotteryScore({
        ticker: 'TSLA',
        mode: 'OUT_OF_UNIVERSE',
        entryPrice: 0.3,
        tod: 'AM_open',
        optionType: 'C',
      }),
    ).toBe(0 + 0 + 5 + 3 + 2);
  });

  it('matches the weights table for known tickers', () => {
    expect(LOTTERY_TICKER_WEIGHTS.USAR).toBe(10);
    expect(LOTTERY_TICKER_WEIGHTS.RDDT).toBe(7);
    expect(LOTTERY_TICKER_WEIGHTS.RUTW).toBe(5);
    expect(LOTTERY_TICKER_WEIGHTS.AAPL).toBeUndefined();
  });
});

describe('lotteryScoreTier', () => {
  it('classifies score ≥18 as tier1', () => {
    expect(lotteryScoreTier(LOTTERY_TIER_THRESHOLDS.tier1MinScore)).toBe(
      'tier1',
    );
    expect(lotteryScoreTier(25)).toBe('tier1');
  });

  it('classifies 12 ≤ score < 18 as tier2', () => {
    expect(lotteryScoreTier(LOTTERY_TIER_THRESHOLDS.tier2MinScore)).toBe(
      'tier2',
    );
    expect(lotteryScoreTier(17)).toBe('tier2');
  });

  it('classifies score <12 as tier3', () => {
    expect(lotteryScoreTier(11)).toBe('tier3');
    expect(lotteryScoreTier(0)).toBe('tier3');
  });

  it('treats null score as tier3', () => {
    expect(lotteryScoreTier(null)).toBe('tier3');
  });
});
