// @vitest-environment node

/**
 * planDateStore: the store-or-refuse rules of scripts/backfill-strike-all.ts.
 * logger and sentry are mocked at their module boundaries because
 * roundTo5Min lives in api/_lib/uw-fetch.ts, which imports them (R3).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../api/_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: { increment: vi.fn(), uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));

import type { StrikeAllRow } from '../../api/_lib/strike-all-fetch.js';
import { planDateStore } from './strike-all-backfill.js';

const DATE = '2026-10-22';
// 2026-10-22 is EDT (UTC-4): the end-of-day board is stamped 16:15 ET.
const EOD = '2026-10-22T20:15:00Z';
const SPOT = { price: 7385.5, time: '2026-10-22T20:00:58Z' };

function row(overrides: Partial<StrikeAllRow> = {}): StrikeAllRow {
  return {
    strike: '7385',
    price: '7380',
    time: EOD,
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_ask: '1',
    call_gamma_bid: '1',
    put_gamma_ask: '1',
    put_gamma_bid: '1',
    call_charm_oi: '1',
    put_charm_oi: '1',
    call_charm_ask: '1',
    call_charm_bid: '1',
    put_charm_ask: '1',
    put_charm_bid: '1',
    call_delta_oi: '1',
    put_delta_oi: '1',
    call_vanna_oi: '1',
    put_vanna_oi: '1',
    ...overrides,
  };
}

describe('planDateStore', () => {
  it('stores the in-range rows at the spot price and the 5-minute bucket of the newest row', () => {
    const rows = [
      row({ strike: '7100' }), // below spot - 200
      row({ strike: '7186', time: '2026-10-22T20:04:30Z' }),
      row({ strike: '7385' }),
      row({ strike: '7585' }),
      row({ strike: '7600' }), // above spot + 200
    ];

    const plan = planDateStore(rows, SPOT, DATE);

    expect(plan).toEqual({
      ok: true,
      rows: [rows[1], rows[2], rows[3]],
      // The stored price is the spot, not the rows' own 7380.
      price: 7385.5,
      // Newest row 20:15:00 floors to 20:15.
      timestamp: '2026-10-22T20:15:00.000Z',
      strikeMin: 7186,
      strikeMax: 7585,
    });
  });

  it('floors the timestamp to the 5-minute bucket', () => {
    const plan = planDateStore(
      [row({ time: '2026-10-22T20:14:59Z' })],
      SPOT,
      DATE,
    );
    expect(plan).toMatchObject({
      ok: true,
      timestamp: '2026-10-22T20:10:00.000Z',
    });
  });

  it.each([
    ['empty', [] as StrikeAllRow[], SPOT, 'empty', /no strike rows/],
    [
      'malformed',
      [row({ time: 'garbage' })],
      SPOT,
      'malformed',
      /parseable time/,
    ],
    [
      'stale (a ladder from the day before)',
      [row({ time: '2026-10-21T20:15:00Z' })],
      SPOT,
      'stale',
      /from 2026-10-21/,
    ],
    [
      'wrong_day (a ladder from the day after)',
      [row({ time: '2026-10-23T20:15:00Z' })],
      SPOT,
      'wrong_day',
      /from 2026-10-23/,
    ],
    [
      'outside_window',
      [row({ strike: '5000' }), row({ strike: '9000' })],
      SPOT,
      'outside_window',
      /none of 2 strike rows/,
    ],
    [
      'all_zero',
      [row({ call_gamma_oi: '0', put_gamma_oi: '0' })],
      SPOT,
      'all_zero',
      /zero gamma OI/,
    ],
    [
      'stale_spot (a spot row from the day before)',
      [row()],
      { price: 7385.5, time: '2026-10-21T20:00:58Z' },
      'stale_spot',
      /spot row is from 2026-10-21/,
    ],
    [
      'wrong_day (a spot row from the day after)',
      [row()],
      { price: 7385.5, time: '2026-10-23T14:00:00Z' },
      'wrong_day',
      /spot row is from 2026-10-23/,
    ],
  ])(
    'refuses %s, naming the date and the kind',
    (_name, rows, spot, kind, message) => {
      const plan = planDateStore(rows, spot, DATE);

      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.kind).toBe(kind);
      expect(plan.message).toMatch(message);
      expect(plan.message).toContain(DATE);
    },
  );

  it('judges the ET day, not the UTC one', () => {
    // 2026-10-23 02:00Z is still 2026-10-22 22:00 ET: the same ET day.
    const plan = planDateStore(
      [row({ time: '2026-10-23T02:00:00Z' })],
      { price: 7385.5, time: '2026-10-23T01:00:00Z' },
      DATE,
    );
    expect(plan.ok).toBe(true);
  });
});
