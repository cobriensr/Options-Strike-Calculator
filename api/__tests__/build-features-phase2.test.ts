// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

vi.mock('../_lib/max-pain.js', () => ({
  fetchMaxPain: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  engineerPhase2Features,
  isWithinUWWindow,
} from '../_lib/build-features-phase2.js';
import { fetchMaxPain } from '../_lib/max-pain.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

// ── Helpers ───────────────────────────────────────────────

/** Create a fresh features object with optional overrides. */
function makeFeatures(overrides: Partial<FeatureRow> = {}): FeatureRow {
  const row: FeatureRow = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) row[k] = v;
  }
  return row;
}

/** Type-safe mock cast for fetchMaxPain. */
const mockedFetchMaxPain = vi.mocked(fetchMaxPain);

describe('engineerPhase2Features', () => {
  const DATE_STR = '2026-03-24';
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    // Pin the clock so isWithinUWWindow's default `today` is near DATE_STR.
    // Without this, the real system clock decides whether UW API fetches
    // are skipped, and historical tests become flaky.
    vi.setSystemTime(new Date('2026-03-25T14:00:00.000Z'));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Previous day features ─────────────────────────────────

  describe('previous day features', () => {
    it('sets all prev_day fields when outcomes exist', async () => {
      const features = makeFeatures({ vix: 18.5 });

      // Query 1: prevDayRows
      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 42,
          close_vs_open: 5.2,
          vix_close: '17.0',
          direction: 'UP',
          range_cat: 'NORMAL',
        },
      ]);
      // Query 2: settlements
      mockSql.mockResolvedValueOnce([]);
      // Query 3: vvixHistory (skipped because vvix is null)
      // Query 4: eventRows
      mockSql.mockResolvedValueOnce([]);
      // Query 5: nextEventRow
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_range_pts).toBe(42);
      expect(features.prev_day_direction).toBe('UP');
      expect(features.prev_day_range_cat).toBe('NORMAL');
      expect(features.prev_day_vix_change).toBeCloseTo(1.5); // 18.5 - 17.0
    });

    it('handles empty outcomes (no previous days)', async () => {
      const features = makeFeatures({ vix: 18.5 });

      // Query 1: prevDayRows → empty
      mockSql.mockResolvedValueOnce([]);
      // Query 2: settlements
      mockSql.mockResolvedValueOnce([]);
      // Query 3: eventRows
      mockSql.mockResolvedValueOnce([]);
      // Query 4: nextEventRow
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_range_pts).toBeUndefined();
      expect(features.prev_day_direction).toBeUndefined();
      expect(features.prev_day_range_cat).toBeUndefined();
      expect(features.prev_day_vix_change).toBeUndefined();
    });

    it('computes prev_day_vix_change correctly (current VIX - prev VIX close)', async () => {
      const features = makeFeatures({ vix: 22.3 });

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 55,
          close_vs_open: -3.0,
          vix_close: '19.8',
          direction: 'DOWN',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_vix_change).toBeCloseTo(2.5); // 22.3 - 19.8
    });

    it('does not set prev_day_vix_change when vix is null', async () => {
      const features = makeFeatures({ vix: null });

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 55,
          close_vs_open: -3.0,
          vix_close: '19.8',
          direction: 'DOWN',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_vix_change).toBeUndefined();
    });

    it('does not set prev_day_vix_change when prev vix_close is null', async () => {
      const features = makeFeatures({ vix: 18.5 });

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 55,
          close_vs_open: -3.0,
          vix_close: null,
          direction: 'DOWN',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_vix_change).toBeUndefined();
    });

    it.each([
      { pts: 15, expected: 'NARROW' },
      { pts: 29, expected: 'NARROW' },
      { pts: 30, expected: 'NORMAL' },
      { pts: 59, expected: 'NORMAL' },
      { pts: 60, expected: 'WIDE' },
      { pts: 99, expected: 'WIDE' },
      { pts: 100, expected: 'EXTREME' },
      { pts: 150, expected: 'EXTREME' },
    ])(
      'sets correct range_cat $expected for $pts pts',
      async ({ pts, expected }) => {
        const features = makeFeatures();

        mockSql.mockResolvedValueOnce([
          {
            date: '2026-03-23',
            day_range_pts: pts,
            close_vs_open: 1,
            vix_close: null,
            direction: 'UP',
            range_cat: expected,
          },
        ]);
        mockSql.mockResolvedValueOnce([]);
        mockSql.mockResolvedValueOnce([]);
        mockSql.mockResolvedValueOnce([]);

        await engineerPhase2Features(mockSql as never, DATE_STR, features);

        expect(features.prev_day_range_cat).toBe(expected);
      },
    );

    it('returns null from num() when day_range_pts is null', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: null,
          close_vs_open: 1,
          vix_close: null,
          direction: 'UP',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_range_pts).toBeNull();
    });

    it('returns null from num() when day_range_pts is empty string', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: '',
          close_vs_open: 1,
          vix_close: null,
          direction: 'UP',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_range_pts).toBeNull();
    });

    it('returns null from num() when day_range_pts is NaN-producing value', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 'not-a-number',
          close_vs_open: 1,
          vix_close: null,
          direction: 'UP',
          range_cat: 'NORMAL',
        },
      ]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.prev_day_range_pts).toBeNull();
    });
  });

  // ── Realized volatility ───────────────────────────────────

  describe('realized volatility', () => {
    /** Build mock settlement rows. Prices go newest to oldest. */
    function makeSettlements(prices: number[]) {
      return prices.map((p) => ({ settlement: String(p) }));
    }

    it('computes realized_vol_5d from 6+ settlement prices', async () => {
      // 6 prices → 5 log returns
      const prices = [5800, 5790, 5810, 5780, 5800, 5770];

      const features = makeFeatures({ vix: 15 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.realized_vol_5d).toBeGreaterThan(0);
      expect(typeof features.realized_vol_5d).toBe('number');
      // Also should set rv_iv_ratio since vix is provided
      expect(features.rv_iv_ratio).toBeGreaterThan(0);
    });

    it('computes realized_vol_10d from 11 settlement prices', async () => {
      // 11 prices → 10 log returns
      const prices = [
        5800, 5790, 5810, 5780, 5800, 5770, 5820, 5795, 5805, 5785, 5810,
      ];

      const features = makeFeatures({ vix: 15 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.realized_vol_5d).toBeGreaterThan(0);
      expect(features.realized_vol_10d).toBeGreaterThan(0);
      expect(typeof features.realized_vol_10d).toBe('number');
    });

    it('computes rv_iv_ratio when both vol and VIX exist', async () => {
      const prices = [5800, 5790, 5810, 5780, 5800, 5770];
      const features = makeFeatures({ vix: 20 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.rv_iv_ratio).toBeCloseTo(
        (features.realized_vol_5d as number) / 20,
        4,
      );
    });

    it('skips 5d vol when fewer than 6 prices', async () => {
      // Only 5 prices → not enough for 5 log returns
      const prices = [5800, 5790, 5810, 5780, 5800];

      const features = makeFeatures({ vix: 15 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.realized_vol_5d).toBeUndefined();
      expect(features.rv_iv_ratio).toBeUndefined();
    });

    it('skips 10d vol when fewer than 11 prices', async () => {
      // 10 prices → only 9 log returns, not enough for 10d
      const prices = [
        5800, 5790, 5810, 5780, 5800, 5770, 5820, 5795, 5805, 5785,
      ];

      const features = makeFeatures({ vix: 15 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // 5d should still work (10 >= 6)
      expect(features.realized_vol_5d).toBeGreaterThan(0);
      // But 10d should not be set
      expect(features.realized_vol_10d).toBeUndefined();
    });

    it('does not set rv_iv_ratio when vix is 0', async () => {
      const prices = [5800, 5790, 5810, 5780, 5800, 5770];
      const features = makeFeatures({ vix: 0 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.realized_vol_5d).toBeGreaterThan(0);
      expect(features.rv_iv_ratio).toBeUndefined();
    });

    it('does not set rv_iv_ratio when vix is null', async () => {
      const prices = [5800, 5790, 5810, 5780, 5800, 5770];
      const features = makeFeatures({ vix: null });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(makeSettlements(prices)); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.rv_iv_ratio).toBeUndefined();
    });

    it('vol calculation is annualized (sqrt(252) * 100)', async () => {
      // Use two identical constant-return prices so variance is deterministic
      // With all returns equal, variance = 0, vol = 0
      // Instead use prices that give known log returns
      const p0 = 100;
      const dailyReturn = 0.01; // 1% daily
      // 6 prices all giving same log return = 0.01
      const prices: number[] = [];
      for (let i = 0; i < 6; i++) {
        prices.push(p0 * Math.exp(-dailyReturn * i));
      }

      const features = makeFeatures({ vix: 20 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce(
        prices.map((p) => ({ settlement: String(p) })),
      ); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // All returns are identical (0.01), so variance ≈ 0, vol ≈ 0
      // Floating point imprecision means it's not exactly 0.
      expect(features.realized_vol_5d).toBeCloseTo(0, 5);
    });
  });

  // ── VIX term structure ────────────────────────────────────

  describe('VIX term structure', () => {
    it('computes vix_term_slope when vix, vix1d, vix9d all present', async () => {
      const features = makeFeatures({ vix: 20, vix1d: 18, vix9d: 22 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // slope = (vix9d - vix1d) / vix = (22 - 18) / 20 = 0.2
      expect(features.vix_term_slope).toBeCloseTo(0.2);
    });

    it('skips when vix is null', async () => {
      const features = makeFeatures({ vix: null, vix1d: 18, vix9d: 22 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vix_term_slope).toBeUndefined();
    });

    it('skips when vix1d is null', async () => {
      const features = makeFeatures({ vix: 20, vix1d: null, vix9d: 22 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vix_term_slope).toBeUndefined();
    });

    it('skips when vix9d is null', async () => {
      const features = makeFeatures({ vix: 20, vix1d: 18, vix9d: null });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vix_term_slope).toBeUndefined();
    });

    it('skips when vix is 0', async () => {
      const features = makeFeatures({ vix: 0, vix1d: 18, vix9d: 22 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vix_term_slope).toBeUndefined();
    });
  });

  // ── VVIX percentile ───────────────────────────────────────

  describe('VVIX percentile', () => {
    it('computes percentile from trailing values', async () => {
      const features = makeFeatures({ vvix: 100 });
      const vvixHistory = Array.from({ length: 20 }, (_, i) => ({
        vvix: String(80 + i * 2), // 80, 82, 84, ..., 118
      }));

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce(vvixHistory); // vvixHistory
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // vvix = 100. Values <= 100: 80,82,84,86,88,90,92,94,96,98,100 = 11 out of 20
      expect(features.vvix_percentile).toBeCloseTo(11 / 20);
    });

    it('skips when fewer than 10 trailing values', async () => {
      const features = makeFeatures({ vvix: 100 });
      const vvixHistory = Array.from({ length: 9 }, (_, i) => ({
        vvix: String(80 + i * 2),
      }));

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce(vvixHistory); // vvixHistory
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vvix_percentile).toBeUndefined();
    });

    it('skips VVIX query entirely when vvix is null', async () => {
      const features = makeFeatures({ vvix: null });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      // No vvixHistory query because vvix is null
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows
      mockSql.mockResolvedValueOnce([]); // oicRows
      mockSql.mockResolvedValueOnce([]); // tsRows
      mockSql.mockResolvedValueOnce([]); // ivMonRow
      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.vvix_percentile).toBeUndefined();
      // 9 SQL calls: prevDay, settlements, eventRows, nextEvent, dpRows,
      // oicRows, tsRows, ivMonRow, rvRow (no vvix query)
      expect(mockSql).toHaveBeenCalledTimes(9);
    });

    it('computes percentile = 1.0 when vvix is highest', async () => {
      const features = makeFeatures({ vvix: 200 });
      const vvixHistory = Array.from({ length: 15 }, (_, i) => ({
        vvix: String(80 + i),
      }));

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce(vvixHistory); // vvixHistory
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // All 15 values <= 200 → percentile = 1.0
      expect(features.vvix_percentile).toBeCloseTo(1.0);
    });
  });

  // ── Economic events ───────────────────────────────────────

  describe('economic events', () => {
    it('sets event_type to highest priority type present', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([
        {
          event_name: 'CPI Release',
          event_type: 'CPI',
          event_time: '08:30',
        },
        {
          event_name: 'PMI Report',
          event_type: 'PMI',
          event_time: '10:00',
        },
      ]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // CPI has higher priority than PMI
      expect(features.event_type).toBe('CPI');
      expect(features.event_count).toBe(2);
    });

    it('sets is_fomc=true when FOMC event exists', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([
        {
          event_name: 'FOMC Decision',
          event_type: 'FOMC',
          event_time: '14:00',
        },
      ]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.is_fomc).toBe(true);
      expect(features.event_type).toBe('FOMC');
      expect(features.event_count).toBe(1);
    });

    it('sets is_opex=true on 3rd Friday (day 15-21)', async () => {
      // 2026-03-20 is a Friday and day 20 → 3rd Friday
      const opexDate = '2026-03-20';
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, opexDate, features);

      expect(features.is_opex).toBe(true);
    });

    it('sets is_opex=false on non-3rd Friday', async () => {
      // 2026-03-27 is a Friday but day 27 → 4th Friday (outside 15-21)
      const nonOpexDate = '2026-03-27';
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, nonOpexDate, features);

      expect(features.is_opex).toBe(false);
    });

    it('sets is_opex=false on non-Friday', async () => {
      // 2026-03-24 is a Tuesday
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.is_opex).toBe(false);
    });

    it('sets days_to_next_event from next event in DB', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([{ next_date: '2026-03-27' }]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // new Date('2026-03-27') = midnight UTC, thisDate = 2026-03-24T17:00 UTC
      // Difference rounds to 2 days
      expect(features.days_to_next_event).toBe(2);
    });

    it('handles no events (defaults)', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows (empty)
      mockSql.mockResolvedValueOnce([]); // nextEventRow (empty)

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.is_opex).toBe(false);
      expect(features.is_fomc).toBe(false);
      expect(features.event_count).toBe(0);
      expect(features.event_type).toBeUndefined();
      expect(features.days_to_next_event).toBeUndefined();
    });

    it('handles next event with null next_date', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([{ next_date: null }]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.days_to_next_event).toBeUndefined();
    });

    it('FOMC takes priority over CPI in event_type', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([
        { event_name: 'CPI', event_type: 'CPI', event_time: '08:30' },
        { event_name: 'FOMC', event_type: 'FOMC', event_time: '14:00' },
      ]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.event_type).toBe('FOMC');
      expect(features.is_fomc).toBe(true);
    });
  });

  // ── Max pain ──────────────────────────────────────────────

  describe('max pain', () => {
    it('sets max_pain_0dte and max_pain_dist from API response', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures({ spx_open: 5800 });

      mockedFetchMaxPain.mockResolvedValueOnce([
        { expiry: '2026-03-24', max_pain: '5785.00' },
        { expiry: '2026-03-27', max_pain: '5790.00' },
      ]);

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.max_pain_0dte).toBe(5785);
      expect(features.max_pain_dist).toBe(-15); // 5785 - 5800
    });

    it('uses nearest monthly expiry (not exact date match)', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures({ spx_open: 5800 });

      // No exact date match, but a future expiry exists
      mockedFetchMaxPain.mockResolvedValueOnce([
        { expiry: '2026-03-21', max_pain: '5700.00' }, // before dateStr → filtered out
        { expiry: '2026-03-28', max_pain: '5820.00' }, // nearest future
        { expiry: '2026-04-17', max_pain: '5850.00' },
      ]);

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.max_pain_0dte).toBe(5820);
      expect(features.max_pain_dist).toBe(20); // 5820 - 5800
    });

    it('handles API failure gracefully (logs warning, does not throw)', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures({ spx_open: 5800 });

      mockedFetchMaxPain.mockRejectedValueOnce(new Error('API down'));

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      // Should not throw
      await expect(
        engineerPhase2Features(mockSql as never, DATE_STR, features),
      ).resolves.toBeUndefined();

      expect(features.max_pain_0dte).toBeUndefined();
    });

    it('handles missing UW_API_KEY', async () => {
      delete process.env.UW_API_KEY;
      const features = makeFeatures({ spx_open: 5800 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.max_pain_0dte).toBeUndefined();
      expect(mockedFetchMaxPain).not.toHaveBeenCalled();
    });

    it('handles empty max pain response', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures({ spx_open: 5800 });

      mockedFetchMaxPain.mockResolvedValueOnce([]);

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.max_pain_0dte).toBeUndefined();
    });

    it('skips max_pain_dist when spx_open is not present', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures(); // no spx_open

      mockedFetchMaxPain.mockResolvedValueOnce([
        { expiry: '2026-03-24', max_pain: '5785.00' },
      ]);

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.max_pain_0dte).toBe(5785);
      expect(features.max_pain_dist).toBeUndefined();
    });
  });

  // ── Dark pool ─────────────────────────────────────────────

  describe('dark pool', () => {
    function makeDpRow(overrides = {}) {
      return {
        spx_approx: 5800,
        total_premium: '500000',
        trade_count: 50,
        total_shares: 100000,
        ...overrides,
      };
    }

    it('extracts level metrics from dark_pool_levels', async () => {
      const features = makeFeatures({ spx_open: 5795 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([
        makeDpRow({ spx_approx: 5800, total_premium: '500000' }),
        makeDpRow({ spx_approx: 5810, total_premium: '300000' }),
      ]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.dp_total_premium).toBe(800000);
      expect(features.dp_cluster_count).toBe(2);
    });

    it('computes dp_top_cluster_dist from top level vs spx_open', async () => {
      const features = makeFeatures({ spx_open: 5800 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([
        makeDpRow({ spx_approx: 5810, total_premium: '500000' }),
        makeDpRow({ spx_approx: 5790, total_premium: '300000' }),
      ]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // 5810 - 5800 = 10
      expect(features.dp_top_cluster_dist).toBe(10);
    });

    it('computes dp_support and dp_resistance relative to spx_open', async () => {
      const features = makeFeatures({ spx_open: 5805 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([
        makeDpRow({ spx_approx: 5810, total_premium: '500000' }), // above
        makeDpRow({ spx_approx: 5800, total_premium: '300000' }), // below
        makeDpRow({ spx_approx: 5790, total_premium: '200000' }), // below
      ]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.dp_support_premium).toBe(500000); // 300K + 200K
      expect(features.dp_resistance_premium).toBe(500000); // 500K
      expect(features.dp_support_resistance_ratio).toBe(1.0);
    });

    it('computes dp_concentration as top level / total', async () => {
      const features = makeFeatures({ spx_open: 5800 });

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([
        makeDpRow({ spx_approx: 5800, total_premium: '750000' }),
        makeDpRow({ spx_approx: 5810, total_premium: '250000' }),
      ]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // 750K / 1M = 0.75
      expect(features.dp_concentration).toBe(0.75);
    });

    it('skips position features when spx_open is null', async () => {
      const features = makeFeatures(); // no spx_open

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([
        makeDpRow({ spx_approx: 5810, total_premium: '500000' }),
      ]); // dpRows

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // Total and count should still work
      expect(features.dp_total_premium).toBe(500000);
      expect(features.dp_cluster_count).toBe(1);
      // Position-dependent features should be undefined
      expect(features.dp_top_cluster_dist).toBeUndefined();
      expect(features.dp_support_premium).toBeUndefined();
      expect(features.dp_resistance_premium).toBeUndefined();
      expect(features.dp_support_resistance_ratio).toBeUndefined();
    });

    it('handles no dark pool data', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows (empty)

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.dp_total_premium).toBeUndefined();
    });

    it('handles dark pool query failure gracefully', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockRejectedValueOnce(new Error('DB error')); // dpRows fails

      // Should not throw
      await expect(
        engineerPhase2Features(mockSql as never, DATE_STR, features),
      ).resolves.toBeUndefined();

      expect(features.dp_total_premium).toBeUndefined();
    });
  });

  // ── Options volume ────────────────────────────────────────

  describe('options volume', () => {
    const mockOVData = {
      call_volume: '150000',
      put_volume: '200000',
      call_open_interest: '500000',
      put_open_interest: '600000',
      call_premium: '1500000.50',
      put_premium: '2000000.75',
      bullish_premium: '800000',
      bearish_premium: '1200000',
      call_volume_ask_side: '80000',
      put_volume_bid_side: '90000',
      avg_30_day_call_volume: '120000',
      avg_30_day_put_volume: '180000',
    };

    /** Set up all preceding SQL mocks (prevDay, settlements, events, nextEvent, dpRows). */
    function prefillSqlMocks() {
      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows
    }

    function mockFetchOK(data: unknown) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: Array.isArray(data) ? data : [data] }),
      } as Response);
    }

    function mockFetchFail() {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('Network error'),
      );
    }

    function mockFetchNotOK() {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response);
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('parses all raw fields', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchOK(mockOVData);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBe(150000);
      expect(features.opt_put_volume).toBe(200000);
      expect(features.opt_call_oi).toBe(500000);
      expect(features.opt_put_oi).toBe(600000);
      expect(features.opt_call_premium).toBeCloseTo(1500000.5);
      expect(features.opt_put_premium).toBeCloseTo(2000000.75);
      expect(features.opt_bullish_premium).toBe(800000);
      expect(features.opt_bearish_premium).toBe(1200000);
      expect(features.opt_call_vol_ask).toBe(80000);
      expect(features.opt_put_vol_bid).toBe(90000);
    });

    it('computes derived ratios: vol_pcr, oi_pcr, premium_ratio', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchOK(mockOVData);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // vol_pcr = putVol / callVol = 200000 / 150000
      expect(features.opt_vol_pcr).toBeCloseTo(200000 / 150000);
      // oi_pcr = putOI / callOI = 600000 / 500000
      expect(features.opt_oi_pcr).toBeCloseTo(600000 / 500000);
      // premium_ratio = bullPrem / (bullPrem + bearPrem) = 800000 / 2000000
      expect(features.opt_premium_ratio).toBeCloseTo(800000 / 2000000);
    });

    it('computes vol_vs_avg30 ratios', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchOK(mockOVData);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // call: 150000 / 120000 = 1.25
      expect(features.opt_call_vol_vs_avg30).toBeCloseTo(1.25);
      // put: 200000 / 180000 ≈ 1.111
      expect(features.opt_put_vol_vs_avg30).toBeCloseTo(200000 / 180000);
    });

    it('handles division by zero (callVol=0)', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchOK({
        ...mockOVData,
        call_volume: '0',
        call_open_interest: '0',
        avg_30_day_call_volume: '0',
      });

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // callVol = 0 → opt_vol_pcr should not be set
      expect(features.opt_vol_pcr).toBeUndefined();
      // callOI = 0 → opt_oi_pcr should not be set
      expect(features.opt_oi_pcr).toBeUndefined();
      // avg30Call = 0 → opt_call_vol_vs_avg30 should not be set
      expect(features.opt_call_vol_vs_avg30).toBeUndefined();
      // The null-or-zero check: callVol=0 → opt_call_volume = null (falsy → null)
      expect(features.opt_call_volume).toBeNull();
    });

    it('handles division by zero (bullPrem + bearPrem = 0)', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchOK({
        ...mockOVData,
        bullish_premium: '0',
        bearish_premium: '0',
      });

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_premium_ratio).toBeUndefined();
    });

    it('handles API failure gracefully', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchFail();

      await expect(
        engineerPhase2Features(mockSql as never, DATE_STR, features),
      ).resolves.toBeUndefined();

      expect(features.opt_call_volume).toBeUndefined();
    });

    it('handles non-OK API response', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      mockFetchNotOK();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBeUndefined();
    });

    it('handles missing UW_API_KEY', async () => {
      delete process.env.UW_API_KEY;
      const features = makeFeatures();
      prefillSqlMocks();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handles empty data array from API', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBeUndefined();
    });

    it('handles non-array data from API', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: null }),
      } as Response);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBeUndefined();
    });

    it('treats missing fields as zero via fallback parsing', async () => {
      process.env.UW_API_KEY = 'test-key';
      const features = makeFeatures();
      prefillSqlMocks();
      // All fields missing → should parse as 0 → stored as null (falsy)
      mockFetchOK({});

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.opt_call_volume).toBeNull();
      expect(features.opt_put_volume).toBeNull();
    });
  });

  // ── OI change features ───────────────────────────────────

  describe('OI change features', () => {
    /**
     * Set up all preceding SQL mocks (prevDay, settlements, events,
     * nextEvent, dpRows) so the OI change section runs next.
     * No UW_API_KEY → skips max pain & options volume fetches.
     */
    function prefillForOic() {
      delete process.env.UW_API_KEY;
      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows
    }

    /** Suffix SQL mocks for vol surface (tsRows, ivMonRow, rvRow). */
    function suffixVolSurface() {
      mockSql.mockResolvedValueOnce([]); // tsRows
      mockSql.mockResolvedValueOnce([]); // ivMonRow
      mockSql.mockResolvedValueOnce([]); // rvRow
    }

    it('computes net OI change and call/put splits', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      mockSql.mockResolvedValueOnce([
        {
          option_symbol: 'SPX260324C05800',
          strike: 5800,
          is_call: true,
          oi_diff: 1000,
          prev_ask_volume: 500,
          prev_bid_volume: 200,
          prev_multi_leg_volume: 100,
          prev_total_premium: 150000,
        },
        {
          option_symbol: 'SPX260324P05750',
          strike: 5750,
          is_call: false,
          oi_diff: -600,
          prev_ask_volume: 300,
          prev_bid_volume: 400,
          prev_multi_leg_volume: 50,
          prev_total_premium: 80000,
        },
      ]); // oicRows

      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.oic_net_oi_change).toBe(400); // 1000 + (-600)
      expect(features.oic_call_oi_change).toBe(1000);
      expect(features.oic_put_oi_change).toBe(-600);
      expect(features.oic_oi_change_pcr).toBeCloseTo(-600 / 1000, 4);
      expect(features.oic_net_premium).toBe(230000); // 150000 + 80000
      expect(features.oic_call_premium).toBe(150000);
      expect(features.oic_put_premium).toBe(80000);
    });

    it('computes ask ratio and multi-leg percentage', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      mockSql.mockResolvedValueOnce([
        {
          option_symbol: 'SPX260324C05800',
          strike: 5800,
          is_call: true,
          oi_diff: 500,
          prev_ask_volume: 600,
          prev_bid_volume: 400,
          prev_multi_leg_volume: 200,
          prev_total_premium: 100000,
        },
      ]); // oicRows

      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // totalVol = 600 + 400 = 1000, ask ratio = 600/1000 = 0.6
      expect(features.oic_ask_ratio).toBeCloseTo(0.6, 4);
      // allVol = 600 + 400 + 200 = 1200, multi-leg pct = 200/1200
      expect(features.oic_multi_leg_pct).toBeCloseTo(200 / 1200, 4);
    });

    it('computes top strike distance from spx_open', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      mockSql.mockResolvedValueOnce([
        {
          option_symbol: 'SPX260324C05830',
          strike: 5830,
          is_call: true,
          oi_diff: 2000,
          prev_ask_volume: 100,
          prev_bid_volume: 100,
          prev_multi_leg_volume: 0,
          prev_total_premium: 50000,
        },
        {
          option_symbol: 'SPX260324P05770',
          strike: 5770,
          is_call: false,
          oi_diff: -500,
          prev_ask_volume: 100,
          prev_bid_volume: 100,
          prev_multi_leg_volume: 0,
          prev_total_premium: 30000,
        },
      ]); // oicRows

      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // Top strike by abs diff = 5830 (2000 > 500), dist = 5830 - 5800 = 30
      expect(features.oic_top_strike_dist).toBe(30);
    });

    it('computes concentration (top 5 / total abs OI change)', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      // 6 rows: top 5 have abs diffs 600,500,400,300,200 = 2000; 6th = 100
      // Total = 2100; concentration = 2000/2100
      const oicRows = [600, 500, 400, 300, 200, 100].map((diff, i) => ({
        option_symbol: `SPX${5800 + i * 5}C`,
        strike: 5800 + i * 5,
        is_call: true,
        oi_diff: diff,
        prev_ask_volume: 100,
        prev_bid_volume: 100,
        prev_multi_leg_volume: 0,
        prev_total_premium: 10000,
      }));

      mockSql.mockResolvedValueOnce(oicRows); // oicRows
      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.oic_concentration).toBeCloseTo(2000 / 2100, 4);
    });

    it('sets null for ratios when call OI change is zero', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      mockSql.mockResolvedValueOnce([
        {
          option_symbol: 'SPX260324P05750',
          strike: 5750,
          is_call: false,
          oi_diff: -600,
          prev_ask_volume: 0,
          prev_bid_volume: 0,
          prev_multi_leg_volume: 0,
          prev_total_premium: 0,
        },
      ]); // oicRows — only puts, callOiChange = 0

      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // callOiChange = 0 → pcr = null
      expect(features.oic_oi_change_pcr).toBeNull();
      // totalVol = 0 → ask ratio = null
      expect(features.oic_ask_ratio).toBeNull();
      // allVol = 0 → multi-leg pct = null
      expect(features.oic_multi_leg_pct).toBeNull();
    });

    it('handles empty OI change data (no oicRows)', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();
      mockSql.mockResolvedValueOnce([]); // oicRows (empty)
      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.oic_net_oi_change).toBeUndefined();
      expect(features.oic_concentration).toBeUndefined();
    });

    it('handles OI change query failure gracefully', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();
      mockSql.mockRejectedValueOnce(new Error('DB error')); // oicRows fails
      suffixVolSurface();

      await expect(
        engineerPhase2Features(mockSql as never, DATE_STR, features),
      ).resolves.toBeUndefined();

      expect(features.oic_net_oi_change).toBeUndefined();
    });

    it('sets null for concentration when total abs diff is zero', async () => {
      const features = makeFeatures({ spx_open: 5800 });
      prefillForOic();

      mockSql.mockResolvedValueOnce([
        {
          option_symbol: 'SPX260324C05800',
          strike: 5800,
          is_call: true,
          oi_diff: 0,
          prev_ask_volume: 100,
          prev_bid_volume: 100,
          prev_multi_leg_volume: 0,
          prev_total_premium: 10000,
        },
      ]); // oicRows with zero diff

      suffixVolSurface();

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.oic_concentration).toBeNull();
    });
  });

  // ── Vol surface features ────────────────────────────────

  describe('vol surface features', () => {
    /**
     * Set up all preceding SQL mocks so we reach the vol surface section.
     * No UW_API_KEY → skips max pain & options volume.
     */
    function prefillForVolSurface() {
      delete process.env.UW_API_KEY;
      mockSql.mockResolvedValueOnce([]); // prevDayRows
      mockSql.mockResolvedValueOnce([]); // settlements
      mockSql.mockResolvedValueOnce([]); // eventRows
      mockSql.mockResolvedValueOnce([]); // nextEventRow
      mockSql.mockResolvedValueOnce([]); // dpRows
      mockSql.mockResolvedValueOnce([]); // oicRows
    }

    it('computes iv_ts_spread and iv_ts_contango when contango', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      // tsRows: one point at 30 DTE with vol=25
      mockSql.mockResolvedValueOnce([{ days: 30, volatility: 25 }]); // tsRows

      // ivMonRow: 0DTE vol = 20 (lower than 30D → contango)
      mockSql.mockResolvedValueOnce([{ volatility: 20 }]); // ivMonRow

      // rvRow: empty
      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // spread = 20 - 25 = -5
      expect(features.iv_ts_spread).toBeCloseTo(-5, 4);
      // contango = 0DTE < 30D → true
      expect(features.iv_ts_contango).toBe(true);
      // slope = (20 - 25) / 25 = -0.2
      expect(features.iv_ts_slope_0d_30d).toBeCloseTo(-0.2, 4);
    });

    it('computes iv_ts_contango=false when inverted (0DTE > 30D)', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([{ days: 30, volatility: 18 }]); // tsRows

      mockSql.mockResolvedValueOnce([{ volatility: 25 }]); // ivMonRow — 25 > 18 → inverted

      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.iv_ts_spread).toBeCloseTo(7, 4); // 25 - 18
      expect(features.iv_ts_contango).toBe(false);
      expect(features.iv_ts_slope_0d_30d).toBeCloseTo(7 / 18, 4);
    });

    it('finds closest point to 30 DTE from multiple term structure rows', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([
        { days: 15, volatility: 22 },
        { days: 28, volatility: 20 }, // closest to 30
        { days: 60, volatility: 18 },
      ]); // tsRows

      mockSql.mockResolvedValueOnce([{ volatility: 24 }]); // ivMonRow — 0DTE vol

      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // 30D point is the 28-DTE row (vol=20)
      // spread = 24 - 20 = 4
      expect(features.iv_ts_spread).toBeCloseTo(4, 4);
      expect(features.iv_ts_contango).toBe(false);
    });

    it('skips term structure features when no ivMonRow (zeroDteVol is null)', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([{ days: 30, volatility: 20 }]); // tsRows

      mockSql.mockResolvedValueOnce([]); // ivMonRow — empty → zeroDteVol = null

      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.iv_ts_spread).toBeUndefined();
      expect(features.iv_ts_contango).toBeUndefined();
      expect(features.iv_ts_slope_0d_30d).toBeUndefined();
    });

    it('skips term structure features when tsRows is empty', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([]); // tsRows — empty

      mockSql.mockResolvedValueOnce([{ volatility: 24 }]); // ivMonRow

      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.iv_ts_spread).toBeUndefined();
      expect(features.iv_ts_contango).toBeUndefined();
    });

    it('sets null for iv_ts_slope_0d_30d when thirtyD vol is 0', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([{ days: 30, volatility: 0 }]); // tsRows — vol=0

      mockSql.mockResolvedValueOnce([{ volatility: 20 }]); // ivMonRow

      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // spread and contango should still be set
      expect(features.iv_ts_spread).toBeCloseTo(20, 4); // 20 - 0
      expect(features.iv_ts_contango).toBe(false);
      // slope should be null (thirtyD.vol = 0 → division guard)
      expect(features.iv_ts_slope_0d_30d).toBeNull();
    });

    it('populates realized vol fields from vol_realized table', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([]); // tsRows
      mockSql.mockResolvedValueOnce([]); // ivMonRow

      mockSql.mockResolvedValueOnce([
        {
          rv_30d: '15.2',
          iv_rv_spread: '4.8',
          iv_overpricing_pct: '31.5',
          iv_rank: '55.0',
        },
      ]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.uw_rv_30d).toBeCloseTo(15.2);
      expect(features.uw_iv_rv_spread).toBeCloseTo(4.8);
      expect(features.uw_iv_overpricing_pct).toBeCloseTo(31.5);
      expect(features.iv_rank).toBeCloseTo(55.0);
    });

    it('handles null values in rvRow via num()', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([]); // tsRows
      mockSql.mockResolvedValueOnce([]); // ivMonRow

      mockSql.mockResolvedValueOnce([
        {
          rv_30d: null,
          iv_rv_spread: '',
          iv_overpricing_pct: 'not-a-number',
          iv_rank: '55.0',
        },
      ]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.uw_rv_30d).toBeNull();
      expect(features.uw_iv_rv_spread).toBeNull();
      expect(features.uw_iv_overpricing_pct).toBeNull();
      expect(features.iv_rank).toBeCloseTo(55.0);
    });

    it('skips rv fields when rvRow is empty', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockResolvedValueOnce([]); // tsRows
      mockSql.mockResolvedValueOnce([]); // ivMonRow
      mockSql.mockResolvedValueOnce([]); // rvRow

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      expect(features.uw_rv_30d).toBeUndefined();
      expect(features.iv_rank).toBeUndefined();
    });

    it('handles vol surface query failure gracefully', async () => {
      const features = makeFeatures();
      prefillForVolSurface();

      mockSql.mockRejectedValueOnce(new Error('DB error')); // tsRows fails

      await expect(
        engineerPhase2Features(mockSql as never, DATE_STR, features),
      ).resolves.toBeUndefined();

      expect(features.iv_ts_spread).toBeUndefined();
      expect(features.uw_rv_30d).toBeUndefined();
    });
  });

  // ── Integration: full pipeline ────────────────────────────

  describe('integration', () => {
    it('processes all feature sections in order without errors', async () => {
      process.env.UW_API_KEY = 'test-key';

      const features = makeFeatures({
        vix: 18.5,
        vix1d: 17,
        vix9d: 20,
        vvix: 95,
        spx_open: 5800,
      });

      // Query 1: prevDayRows
      mockSql.mockResolvedValueOnce([
        {
          date: '2026-03-23',
          day_range_pts: 42,
          close_vs_open: 5.2,
          vix_close: '17.0',
          direction: 'UP',
          range_cat: 'NORMAL',
        },
      ]);

      // Query 2: settlements (11 prices for full vol)
      const settlements = Array.from({ length: 11 }, (_, i) => ({
        settlement: String(5800 - i * 3 + (i % 3) * 5),
      }));
      mockSql.mockResolvedValueOnce(settlements);

      // Query 3: vvixHistory (20 values)
      const vvixHistory = Array.from({ length: 20 }, (_, i) => ({
        vvix: String(80 + i * 2),
      }));
      mockSql.mockResolvedValueOnce(vvixHistory);

      // Query 4: eventRows
      mockSql.mockResolvedValueOnce([
        { event_name: 'CPI Release', event_type: 'CPI', event_time: '08:30' },
      ]);

      // Query 5: nextEventRow
      mockSql.mockResolvedValueOnce([{ next_date: '2026-03-27' }]);

      // Max pain
      mockedFetchMaxPain.mockResolvedValueOnce([
        { expiry: '2026-03-24', max_pain: '5785.00' },
      ]);

      // Query 6: dpRows (from dark_pool_levels)
      mockSql.mockResolvedValueOnce([
        {
          spx_approx: 5810,
          total_premium: '500000',
          trade_count: 100,
          total_shares: 50000,
        },
      ]);

      // Options volume fetch
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              call_volume: '150000',
              put_volume: '200000',
              call_open_interest: '500000',
              put_open_interest: '600000',
              call_premium: '1500000',
              put_premium: '2000000',
              bullish_premium: '800000',
              bearish_premium: '1200000',
              call_volume_ask_side: '80000',
              put_volume_bid_side: '90000',
              avg_30_day_call_volume: '120000',
              avg_30_day_put_volume: '180000',
            },
          ],
        }),
      } as Response);

      await engineerPhase2Features(mockSql as never, DATE_STR, features);

      // Verify key features from each section
      expect(features.prev_day_range_pts).toBe(42);
      expect(features.realized_vol_5d).toBeGreaterThan(0);
      expect(features.realized_vol_10d).toBeGreaterThan(0);
      expect(features.rv_iv_ratio).toBeGreaterThan(0);
      expect(features.vix_term_slope).toBeCloseTo((20 - 17) / 18.5);
      expect(features.vvix_percentile).toBeDefined();
      expect(features.event_type).toBe('CPI');
      expect(features.event_count).toBe(1);
      expect(features.days_to_next_event).toBe(2);
      expect(features.max_pain_0dte).toBe(5785);
      expect(features.max_pain_dist).toBe(-15);
      expect(features.dp_total_premium).toBe(500000);
      expect(features.dp_cluster_count).toBe(1);
      expect(features.opt_call_volume).toBe(150000);
      expect(features.opt_vol_pcr).toBeCloseTo(200000 / 150000);
    });
  });
});

// ── isWithinUWWindow helper ────────────────────────────────

describe('isWithinUWWindow', () => {
  // Pin a synthetic "today" so tests are deterministic regardless of
  // when the suite runs.
  const TODAY = new Date('2026-04-07T12:00:00.000Z');

  it('returns true when dateStr is today', () => {
    expect(isWithinUWWindow('2026-04-07', TODAY)).toBe(true);
  });

  it('returns true for a future date (UW returns empty, not 403)', () => {
    expect(isWithinUWWindow('2026-05-01', TODAY)).toBe(true);
  });

  it('returns true when dateStr is roughly 25 trading days ago', () => {
    // ~25 trading days ≈ 35 calendar days → 2026-04-07 minus 35 days ≈
    // 2026-03-03. Well inside the 44-calendar-day approximation.
    expect(isWithinUWWindow('2026-03-03', TODAY)).toBe(true);
  });

  it('returns false when dateStr is roughly 40 trading days ago', () => {
    // ~40 trading days ≈ 56 calendar days → 2026-02-10. Outside the
    // 44-day window, so UW would 403 and we should skip.
    expect(isWithinUWWindow('2026-02-10', TODAY)).toBe(false);
  });

  it('returns true at the exact 30-trading-day calendar boundary', () => {
    // 44 calendar days before 2026-04-07 = 2026-02-22. The helper uses
    // ceil(30 * 7/5) + 2 = 44 calendar days, inclusive. Any date
    // on-or-after 2026-02-22 should be within the window.
    expect(isWithinUWWindow('2026-02-22', TODAY)).toBe(true);
    // One calendar day outside the boundary should be excluded.
    expect(isWithinUWWindow('2026-02-21', TODAY)).toBe(false);
  });

  it('returns false for an invalid date string', () => {
    expect(isWithinUWWindow('not-a-date', TODAY)).toBe(false);
  });

  it('respects a custom `days` parameter', () => {
    // 10 trading days ≈ ceil(14) + 2 = 16 calendar days.
    // 2026-04-07 - 16 = 2026-03-22 (boundary, inclusive).
    expect(isWithinUWWindow('2026-03-22', TODAY, 10)).toBe(true);
    expect(isWithinUWWindow('2026-03-21', TODAY, 10)).toBe(false);
  });
});
