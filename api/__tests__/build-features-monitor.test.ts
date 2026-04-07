// @vitest-environment node

vi.mock('../../src/utils/timezone.js', () => ({
  getETTime: vi.fn((date: Date) => {
    const hours = date.getUTCHours() - 4;
    return {
      hour: hours < 0 ? hours + 24 : hours,
      minute: date.getUTCMinutes(),
    };
  }),
  getETDateStr: vi.fn((date: Date) => {
    return date.toISOString().split('T')[0];
  }),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { engineerMonitorFeatures } from '../_lib/build-features-monitor.js';
import type { FeatureRow } from '../_lib/build-features-types.js';

// ── Types ───────────────────────────────────────────────────

interface IvRow {
  timestamp: string;
  volatility: string;
  spx_price: string;
}

interface RatioRow {
  timestamp: string;
  ratio: string;
}

// ── Helpers ─────────────────────────────────────────────────

const DATE_STR = '2026-04-02';

/**
 * Create an IV monitor row at a given ET minute.
 * Converts ET minutes-after-midnight to a UTC timestamp
 * (ET + 4h = UTC for the crude mock above).
 */
function makeIvRow(
  minutesET: number,
  volatility: number,
  spxPrice = 6600,
): IvRow {
  const hours = Math.floor(minutesET / 60);
  const mins = minutesET % 60;
  const utcH = String(hours + 4).padStart(2, '0');
  const utcM = String(mins).padStart(2, '0');
  const ts = `2026-04-02T${utcH}:${utcM}:00Z`;
  return {
    timestamp: ts,
    volatility: String(volatility),
    spx_price: String(spxPrice),
  };
}

/** Create a flow_ratio_monitor row at a given ET minute. */
function makeRatioRow(minutesET: number, ratio: number): RatioRow {
  const hours = Math.floor(minutesET / 60);
  const mins = minutesET % 60;
  const utcH = String(hours + 4).padStart(2, '0');
  const utcM = String(mins).padStart(2, '0');
  const ts = `2026-04-02T${utcH}:${utcM}:00Z`;
  return { timestamp: ts, ratio: String(ratio) };
}

describe('engineerMonitorFeatures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── IV Features ─────────────────────────────────────────────

  describe('IV features', () => {
    it('leaves all iv_* undefined when iv_monitor returns no rows', async () => {
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]); // iv_monitor
      mockSql.mockResolvedValueOnce([]); // flow_ratio_monitor

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_open).toBeUndefined();
      expect(features.iv_max).toBeUndefined();
      expect(features.iv_range).toBeUndefined();
      expect(features.iv_at_t2).toBeUndefined();
      expect(features.iv_crush_rate).toBeUndefined();
      expect(features.iv_spike_count).toBeUndefined();
    });

    it('sets iv_open to the first volatility reading', async () => {
      const ivRows = [
        makeIvRow(570, 0.229), // 9:30 AM
        makeIvRow(575, 0.235),
        makeIvRow(580, 0.24),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]); // ratios

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_open).toBeCloseTo(0.229, 4);
    });

    it('sets iv_max to the highest volatility', async () => {
      const ivRows = [
        makeIvRow(570, 0.18),
        makeIvRow(575, 0.25),
        makeIvRow(580, 0.22),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_max).toBeCloseTo(0.25, 4);
    });

    it('sets iv_range to max - min volatility', async () => {
      const ivRows = [
        makeIvRow(570, 0.18),
        makeIvRow(575, 0.25),
        makeIvRow(580, 0.2),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // max=0.25, min=0.18 → range=0.07
      expect(features.iv_range).toBeCloseTo(0.07, 4);
    });

    it('sets iv_at_t2 to nearest reading within 5 min of 10:30 AM', async () => {
      // T2 = 630 min ET = 10:30 AM
      const ivRows = [
        makeIvRow(570, 0.2),
        makeIvRow(628, 0.195), // 2 min before T2 — closest
        makeIvRow(660, 0.22),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_at_t2).toBeCloseTo(0.195, 4);
    });

    it('sets iv_at_t2 to null when no reading near T2', async () => {
      // All readings far from 630 min (more than 5 min away)
      const ivRows = [
        makeIvRow(570, 0.2), // 60 min away
        makeIvRow(700, 0.22), // 70 min away
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_at_t2).toBeNull();
    });

    it('computes iv_crush_rate as last_iv - iv_at_2:30PM', async () => {
      // Crush start = 870 min ET = 2:30 PM
      // Last row represents final reading
      const ivRows = [
        makeIvRow(570, 0.25),
        makeIvRow(869, 0.22), // near 870 — crush start
        makeIvRow(960, 0.15), // last reading (4:00 PM)
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // endVol - startVol = 0.15 - 0.22 = -0.07 (negative = crush)
      expect(features.iv_crush_rate).toBeCloseTo(-0.07, 4);
    });

    it('sets iv_crush_rate to null when no reading near 2:30 PM', async () => {
      const ivRows = [
        makeIvRow(570, 0.25),
        makeIvRow(600, 0.22),
        // Nothing near 870
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // crushStart is null → feature not set (remains undefined)
      expect(features.iv_crush_rate).toBeUndefined();
    });

    it('counts iv spikes where vol jumped >= IV_JUMP_MIN with SPX < 5 pts', async () => {
      // Need >= 6 rows. Spike at index 5: vol[5] - vol[0] >= IV_JUMP_MIN (0.01)
      const ivRows = [
        makeIvRow(570, 0.2, 6600),
        makeIvRow(571, 0.2, 6600),
        makeIvRow(572, 0.2, 6600),
        makeIvRow(573, 0.2, 6601),
        makeIvRow(574, 0.2, 6601),
        makeIvRow(575, 0.24, 6602), // +0.04 vol, +2 pts SPX → spike
        makeIvRow(576, 0.25, 6602), // +0.05 from [1], +2 → spike
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_spike_count).toBe(2);
    });

    it('excludes vol jump when SPX moved >= 5 pts', async () => {
      // Vol jumps but SPX also moves >= 5 pts → not a spike
      const ivRows = [
        makeIvRow(570, 0.2, 6600),
        makeIvRow(571, 0.2, 6600),
        makeIvRow(572, 0.2, 6600),
        makeIvRow(573, 0.2, 6600),
        makeIvRow(574, 0.2, 6600),
        makeIvRow(575, 0.24, 6606), // +0.04 vol, +6 pts SPX → excluded
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_spike_count).toBe(0);
    });

    it('returns iv_spike_count 0 when fewer than 6 rows', async () => {
      const ivRows = [
        makeIvRow(570, 0.2),
        makeIvRow(571, 0.25),
        makeIvRow(572, 0.3),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.iv_spike_count).toBe(0);
    });
  });

  // ── Flow Ratio Features ───────────────────────────────────

  describe('flow ratio features', () => {
    it('leaves all pcr_* undefined when flow_ratio_monitor returns no rows', async () => {
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]); // iv_monitor
      mockSql.mockResolvedValueOnce([]); // flow_ratio_monitor

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.pcr_open).toBeUndefined();
      expect(features.pcr_max).toBeUndefined();
      expect(features.pcr_min).toBeUndefined();
      expect(features.pcr_range).toBeUndefined();
      expect(features.pcr_trend_t1_t2).toBeUndefined();
      expect(features.pcr_spike_count).toBeUndefined();
    });

    it('sets pcr_open to the first ratio reading', async () => {
      const ratioRows = [
        makeRatioRow(570, 0.85),
        makeRatioRow(575, 0.9),
        makeRatioRow(580, 0.88),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]); // iv
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.pcr_open).toBeCloseTo(0.85, 4);
    });

    it('sets pcr_max and pcr_min correctly', async () => {
      const ratioRows = [
        makeRatioRow(570, 0.85),
        makeRatioRow(575, 1.2),
        makeRatioRow(580, 0.6),
        makeRatioRow(585, 0.95),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.pcr_max).toBeCloseTo(1.2, 4);
      expect(features.pcr_min).toBeCloseTo(0.6, 4);
    });

    it('sets pcr_range to max - min ratio', async () => {
      const ratioRows = [
        makeRatioRow(570, 0.85),
        makeRatioRow(575, 1.2),
        makeRatioRow(580, 0.6),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // 1.20 - 0.60 = 0.60
      expect(features.pcr_range).toBeCloseTo(0.6, 4);
    });

    it('computes pcr_trend_t1_t2 as ratio_at_T2 - ratio_at_T1', async () => {
      // T1 = 600 min (10:00 AM), T2 = 630 min (10:30 AM)
      const ratioRows = [
        makeRatioRow(570, 0.8),
        makeRatioRow(599, 0.9), // near T1
        makeRatioRow(631, 1.1), // near T2
        makeRatioRow(660, 1.0),
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // ratio_T2 - ratio_T1 = 1.10 - 0.90 = 0.20
      expect(features.pcr_trend_t1_t2).toBeCloseTo(0.2, 4);
    });

    it('does not set pcr_trend_t1_t2 when no readings near T1 or T2', async () => {
      // All readings far from T1=600 and T2=630
      const ratioRows = [
        makeRatioRow(570, 0.8), // 30 min from T1
        makeRatioRow(700, 0.9), // 70 min from T2
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // findNearest returns null for both → if block not entered
      expect(features.pcr_trend_t1_t2).toBeUndefined();
    });

    it('counts pcr spikes where |ratio delta| >= 0.7 from 5-rows-ago', async () => {
      // Need >= 6 rows. Spike when |current - prev[i-5]| >= 0.7
      const ratioRows = [
        makeRatioRow(570, 0.8),
        makeRatioRow(571, 0.82),
        makeRatioRow(572, 0.81),
        makeRatioRow(573, 0.83),
        makeRatioRow(574, 0.8),
        makeRatioRow(575, 1.55), // |1.55 - 0.80| = 0.75 >= 0.7 → spike
        makeRatioRow(576, 1.6), // |1.60 - 0.82| = 0.78 >= 0.7 → spike
      ];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.pcr_spike_count).toBe(2);
    });

    it('returns pcr_spike_count 0 when fewer than 6 rows', async () => {
      const ratioRows = [makeRatioRow(570, 0.8), makeRatioRow(575, 1.5)];
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features.pcr_spike_count).toBe(0);
    });
  });

  // ── Combined scenarios ────────────────────────────────────

  describe('combined scenarios', () => {
    it('leaves features unchanged when both tables are empty', async () => {
      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      const features: FeatureRow = { existing_field: 42 };
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      expect(features).toEqual({ existing_field: 42 });
    });

    it('computes all 12 features when both tables are populated', async () => {
      // Build realistic IV rows covering the full session:
      // open at 9:30 (570), T2 at 10:30 (630), crush start at 2:30 (870),
      // close at 4:00 (960). Need >= 6 for spike counting.
      const ivRows = [
        makeIvRow(570, 0.22, 6600), // open
        makeIvRow(575, 0.22, 6601),
        makeIvRow(580, 0.22, 6601),
        makeIvRow(585, 0.22, 6602),
        makeIvRow(590, 0.22, 6602),
        makeIvRow(595, 0.26, 6603), // +0.04 vol, +3 SPX → spike
        makeIvRow(630, 0.24, 6605), // T2 reading
        makeIvRow(870, 0.2, 6610), // crush start
        makeIvRow(960, 0.14, 6615), // last (close)
      ];

      // Build ratio rows: T1=600, T2=630, with spike data
      const ratioRows = [
        makeRatioRow(570, 0.8), // open
        makeRatioRow(575, 0.82),
        makeRatioRow(580, 0.81),
        makeRatioRow(585, 0.83),
        makeRatioRow(590, 0.8),
        makeRatioRow(595, 1.55), // |1.55-0.80|=0.75 → spike
        makeRatioRow(600, 0.9), // near T1
        makeRatioRow(630, 1.05), // near T2
        makeRatioRow(660, 0.95),
      ];

      const mockSql = vi.fn();
      mockSql.mockResolvedValueOnce(ivRows);
      mockSql.mockResolvedValueOnce(ratioRows);

      const features: FeatureRow = {};
      await engineerMonitorFeatures(mockSql as never, DATE_STR, features);

      // IV features
      expect(features.iv_open).toBeCloseTo(0.22, 4);
      expect(features.iv_max).toBeCloseTo(0.26, 4);
      // min=0.14, max=0.26 → range=0.12
      expect(features.iv_range).toBeCloseTo(0.12, 4);
      expect(features.iv_at_t2).toBeCloseTo(0.24, 4);
      // crush: endVol(0.14) - startVol(0.20) = -0.06
      expect(features.iv_crush_rate).toBeCloseTo(-0.06, 4);
      // Spikes detected with IV_JUMP_MIN=0.01 (lowered 2026-04-07):
      //   index 5: vol 0.26-0.22=0.04 ≥ 0.01, price 6603-6600=3 < 5 ✓
      //   index 6: vol 0.24-0.22=0.02 ≥ 0.01, price 6605-6601=4 < 5 ✓
      expect(features.iv_spike_count).toBe(2);

      // PCR features
      expect(features.pcr_open).toBeCloseTo(0.8, 4);
      expect(features.pcr_max).toBeCloseTo(1.55, 4);
      expect(features.pcr_min).toBeCloseTo(0.8, 4);
      expect(features.pcr_range).toBeCloseTo(0.75, 4);
      // trend: ratio_T2(1.05) - ratio_T1(0.90) = 0.15
      expect(features.pcr_trend_t1_t2).toBeCloseTo(0.15, 4);
      // spike at index 5: |1.55-0.80|=0.75≥0.7
      expect(features.pcr_spike_count).toBe(1);
    });
  });
});
