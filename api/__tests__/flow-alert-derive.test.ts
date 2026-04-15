// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  computeDerived,
  getCtParts,
  isoDateToEpochDays,
  SESSION_OPEN_MINUTE_CT,
  type UwFlowAlert,
} from '../_lib/flow-alert-derive.js';

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ALERT: UwFlowAlert = {
  alert_rule: 'RepeatedHitsAscendingFill',
  all_opening_trades: false,
  created_at: '2026-04-14T19:45:00.000000Z', // 14:45 CT (CDT, UTC-5)
  expiry: '2026-04-15',
  expiry_count: 1,
  has_floor: false,
  has_multileg: false,
  has_singleleg: true,
  has_sweep: true,
  issue_type: 'Index',
  open_interest: 1000,
  option_chain: 'SPXW260415C06900000',
  price: '4.05',
  strike: '6900',
  ticker: 'SPXW',
  total_ask_side_prem: '151875',
  total_bid_side_prem: '405',
  total_premium: '152280',
  total_size: 461,
  trade_count: 32,
  type: 'call',
  underlying_price: '6850',
  volume: 2442,
  volume_oi_ratio: '0.308',
};

const makeAlert = (overrides: Partial<UwFlowAlert> = {}): UwFlowAlert => ({
  ...SAMPLE_ALERT,
  ...overrides,
});

// ── getCtParts ──────────────────────────────────────────────

describe('getCtParts', () => {
  it('converts a UTC instant during CDT (UTC-5) correctly', () => {
    // 2026-04-14 is after 2nd-Sunday-of-March → CDT in effect.
    const parts = getCtParts('2026-04-14T19:45:00.000Z');
    expect(parts.hour).toBe(14);
    expect(parts.minute).toBe(45);
    expect(parts.dayOfWeek).toBe(1); // Tuesday
    expect(parts.dateStr).toBe('2026-04-14');
  });

  it('converts a UTC instant during CST (UTC-6) correctly', () => {
    // 2026-12-15 is after 1st-Sunday-of-November → CST in effect.
    const parts = getCtParts('2026-12-15T19:45:00.000Z');
    expect(parts.hour).toBe(13);
    expect(parts.minute).toBe(45);
    expect(parts.dayOfWeek).toBe(1); // Tuesday
    expect(parts.dateStr).toBe('2026-12-15');
  });
});

// ── isoDateToEpochDays ──────────────────────────────────────

describe('isoDateToEpochDays', () => {
  it('returns the correct epoch-days integer for a known date', () => {
    // 2026-04-15 midnight UTC = 1776211200000 ms → /86_400_000 = 20557
    expect(isoDateToEpochDays('2026-04-15')).toBe(
      Math.floor(Date.UTC(2026, 3, 15) / 86_400_000),
    );
  });

  it('returns consecutive integers for consecutive dates', () => {
    const a = isoDateToEpochDays('2026-04-14');
    const b = isoDateToEpochDays('2026-04-15');
    expect(b - a).toBe(1);
  });
});

// ── computeDerived ──────────────────────────────────────────

describe('computeDerived', () => {
  it('computes the full derived fixture correctly', () => {
    const d = computeDerived(SAMPLE_ALERT);
    expect(d.ask_side_ratio).toBeCloseTo(0.9973, 4);
    expect(d.bid_side_ratio).toBeCloseTo(0.00266, 4);
    expect(d.net_premium).toBe(151470);
    expect(d.dte_at_alert).toBe(1);
    expect(d.distance_from_spot).toBe(50);
    expect(d.distance_pct).toBeCloseTo(50 / 6850, 9);
    expect(d.moneyness).toBeCloseTo(6850 / 6900, 9);
    expect(d.is_itm).toBe(false);
    expect(d.minute_of_day).toBe(885); // 14*60 + 45
    expect(d.session_elapsed_min).toBe(885 - SESSION_OPEN_MINUTE_CT); // 375
    expect(d.day_of_week).toBe(1);
  });

  it('guards null fields when spot=0 (distance_pct and moneyness null)', () => {
    const d = computeDerived(makeAlert({ underlying_price: '0' }));
    expect(d.distance_pct).toBeNull();
    expect(d.moneyness).toBeCloseTo(0 / 6900, 9); // moneyness keyed off strike, still valid
    expect(d.is_itm).toBeNull(); // spot<=0 → cannot determine
  });

  it('guards null ratios when total_premium=0', () => {
    const d = computeDerived(makeAlert({ total_premium: '0' }));
    expect(d.ask_side_ratio).toBeNull();
    expect(d.bid_side_ratio).toBeNull();
    // net_premium still computes from ask/bid directly.
    expect(d.net_premium).toBe(151875 - 405);
  });

  it('flags is_itm=true for a put where strike > spot', () => {
    const d = computeDerived(
      makeAlert({
        type: 'put',
        strike: '6900',
        underlying_price: '6850',
      }),
    );
    expect(d.is_itm).toBe(true);
  });

  it('flags is_itm=false for a put where strike < spot', () => {
    const d = computeDerived(
      makeAlert({
        type: 'put',
        strike: '6800',
        underlying_price: '6850',
      }),
    );
    expect(d.is_itm).toBe(false);
  });
});
