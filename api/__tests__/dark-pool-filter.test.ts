// @vitest-environment node

/**
 * Unit tests for api/_lib/dark-pool-filter.ts (Phase 1e).
 *
 * Each filter rule has its own dedicated test so a regression on any
 * one of them is immediately attributable. The filter is the single
 * source of truth feeding both pagination call sites in darkpool.ts —
 * a silent change here would corrupt every dark-pool aggregate.
 */

import { describe, it, expect } from 'vitest';
import {
  passesDarkPoolQualityFilter,
  isIntradayCT,
  DARK_POOL_FILTER_VERSION,
  INTRADAY_START_MIN_CT,
  INTRADAY_END_MIN_CT,
  type DarkPoolFilterableTrade,
} from '../_lib/dark-pool-filter.js';

function makeTrade(
  overrides: Partial<DarkPoolFilterableTrade> = {},
): DarkPoolFilterableTrade {
  return {
    canceled: false,
    // 09:30 CT (14:30 UTC) — middle of the regular session
    executed_at: '2025-01-15T15:30:00Z',
    ext_hour_sold_codes: null,
    sale_cond_codes: null,
    trade_code: null,
    trade_settlement: 'regular_settlement',
    ...overrides,
  };
}

describe('passesDarkPoolQualityFilter', () => {
  it('keeps a clean regular-session trade', () => {
    expect(passesDarkPoolQualityFilter(makeTrade())).toBe(true);
  });

  it('drops canceled trades', () => {
    expect(passesDarkPoolQualityFilter(makeTrade({ canceled: true }))).toBe(
      false,
    );
  });

  it('drops trades with non-null ext_hour_sold_codes', () => {
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ ext_hour_sold_codes: 'FORM_T' }),
      ),
    ).toBe(false);
  });

  it('drops non-regular trade_settlement', () => {
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ trade_settlement: 'cash_settlement' }),
      ),
    ).toBe(false);
  });

  it('keeps both "regular" and "regular_settlement"', () => {
    expect(
      passesDarkPoolQualityFilter(makeTrade({ trade_settlement: 'regular' })),
    ).toBe(true);
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ trade_settlement: 'regular_settlement' }),
      ),
    ).toBe(true);
  });

  it('drops average_price_trade prints', () => {
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ sale_cond_codes: 'average_price_trade' }),
      ),
    ).toBe(false);
  });

  it('drops contingent_trade prints', () => {
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ sale_cond_codes: 'contingent_trade' }),
      ),
    ).toBe(false);
  });

  it('drops derivative_priced trades', () => {
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ trade_code: 'derivative_priced' }),
      ),
    ).toBe(false);
  });

  it('drops pre-session prints (before 08:30 CT)', () => {
    // 06:15 CT = 12:15 UTC (winter, CST)
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ executed_at: '2025-01-15T12:15:00Z' }),
      ),
    ).toBe(false);
  });

  it('drops post-close prints (15:00 CT or later)', () => {
    // 15:00 CT = 21:00 UTC (winter, CST) — exclusive
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ executed_at: '2025-01-15T21:00:00Z' }),
      ),
    ).toBe(false);
    // 15:30 CT
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ executed_at: '2025-01-15T21:30:00Z' }),
      ),
    ).toBe(false);
  });

  it('keeps the 08:30 CT boundary inclusively', () => {
    // 08:30 CT = 14:30 UTC (winter)
    expect(
      passesDarkPoolQualityFilter(
        makeTrade({ executed_at: '2025-01-15T14:30:00Z' }),
      ),
    ).toBe(true);
  });

  it('drops trades whose ET date does not match opts.date', () => {
    // 14:30 UTC on 01-15 → 09:30 ET on 01-15
    const trade = makeTrade({ executed_at: '2025-01-15T14:30:00Z' });
    expect(passesDarkPoolQualityFilter(trade, { date: '2025-01-15' })).toBe(
      true,
    );
    expect(passesDarkPoolQualityFilter(trade, { date: '2025-01-16' })).toBe(
      false,
    );
  });

  it('drops trades with unparseable executed_at', () => {
    expect(
      passesDarkPoolQualityFilter(makeTrade({ executed_at: 'not-a-date' })),
    ).toBe(false);
  });
});

describe('isIntradayCT', () => {
  it('returns false for unparseable dates', () => {
    expect(isIntradayCT('garbage')).toBe(false);
  });

  it('uses the documented boundaries', () => {
    expect(INTRADAY_START_MIN_CT).toBe(8 * 60 + 30);
    expect(INTRADAY_END_MIN_CT).toBe(15 * 60);
  });
});

describe('DARK_POOL_FILTER_VERSION', () => {
  it('exports a versioned date string for drift detection', () => {
    expect(DARK_POOL_FILTER_VERSION).toBe('2026-05-02');
  });
});
