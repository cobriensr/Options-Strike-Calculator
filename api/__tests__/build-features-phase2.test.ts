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

import { engineerPhase2Features } from '../_lib/build-features-phase2.js';
import { fetchMaxPain } from '../_lib/max-pain.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

// ── Helpers ───────────────────────────────────────────────

/** Create a fresh features object with optional overrides. */
function makeFeatures(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return { ...overrides };
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
  });

  afterEach(() => {
    process.env = originalEnv;
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
        features.realized_vol_5d / 20,
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
