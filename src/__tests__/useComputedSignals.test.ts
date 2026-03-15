import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useComputedSignals } from '../hooks/useComputedSignals';
import type { HistorySnapshot } from '../hooks/useHistoryData';

// ============================================================
// MOCK DEPENDENCIES
// ============================================================

vi.mock('../data/vixRangeStats', () => ({
  findBucket: vi.fn((vix: number) => {
    if (vix < 15) return { zone: 'GREEN' };
    if (vix < 20) return { zone: 'YELLOW' };
    if (vix < 25) return { zone: 'ORANGE' };
    return { zone: 'RED' };
  }),
  estimateRange: vi.fn(() => ({
    medOC: 0.5,
    medHL: 0.8,
    p90OC: 1.0,
    p90HL: 1.5,
  })),
  getDowMultiplier: vi.fn(() => ({
    multHL: 1.1,
    multOC: 0.9,
  })),
}));

vi.mock('../data/eventCalendar', () => ({
  getEventsForDate: vi.fn((date: string) => {
    if (date === '2026-03-20') return [{ event: 'Triple Witching' }];
    return [];
  }),
  getEarlyCloseHourET: vi.fn((date: string) => {
    if (date === '2026-12-24') return 13;
    return undefined;
  }),
}));

// ============================================================
// HELPERS
// ============================================================

function makeInputs(
  overrides: Partial<Parameters<typeof useComputedSignals>[0]> = {},
) {
  return {
    vix: 18,
    spot: 5700,
    T: 0.025,
    skewPct: 5,
    clusterMult: 1.0,
    selectedDate: '2026-03-10', // Tuesday
    timeHour: '10',
    timeMinute: '30',
    timeAmPm: 'AM',
    timezone: 'ET',
    ivMode: 'vix',
    ivModeVix: 'vix',
    liveVix1d: 15,
    liveVix9d: 17,
    liveVvix: 90,
    liveOpeningRange: undefined,
    historySnapshot: null,
    ...overrides,
  };
}

function compute(
  overrides: Partial<Parameters<typeof useComputedSignals>[0]> = {},
) {
  const { result } = renderHook(() =>
    useComputedSignals(makeInputs(overrides)),
  );
  return result.current;
}

// ============================================================
// TESTS
// ============================================================

describe('useComputedSignals', () => {
  // ── ET time conversion ──────────────────────────────────

  describe('ET time', () => {
    it('converts AM time correctly', () => {
      const s = compute({ timeHour: '9', timeMinute: '35', timeAmPm: 'AM' });
      expect(s.etHour).toBe(9);
      expect(s.etMinute).toBe(35);
    });

    it('converts PM time correctly', () => {
      const s = compute({ timeHour: '2', timeMinute: '00', timeAmPm: 'PM' });
      expect(s.etHour).toBe(14);
      expect(s.etMinute).toBe(0);
    });

    it('handles 12 PM as noon', () => {
      const s = compute({ timeHour: '12', timeMinute: '00', timeAmPm: 'PM' });
      expect(s.etHour).toBe(12);
    });

    it('handles 12 AM as midnight', () => {
      const s = compute({ timeHour: '12', timeMinute: '00', timeAmPm: 'AM' });
      expect(s.etHour).toBe(0);
    });

    it('adds 1 hour when timezone is CT', () => {
      const s = compute({
        timeHour: '9',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'CT',
      });
      expect(s.etHour).toBe(10);
    });
  });

  // ── Volatility resolution ──────────────────────────────

  describe('volatility resolution', () => {
    it('uses live values when no history snapshot', () => {
      const s = compute({
        liveVix1d: 14,
        liveVix9d: 16,
        liveVvix: 88,
        historySnapshot: null,
      });
      expect(s.vix1d).toBe(14);
      expect(s.vix9d).toBe(16);
      expect(s.vvix).toBe(88);
    });

    it('uses snapshot values when history snapshot present', () => {
      const s = compute({
        liveVix1d: 14,
        liveVix9d: 16,
        liveVvix: 88,
        historySnapshot: {
          vix1d: 20,
          vix9d: 22,
          vvix: 110,
        } as HistorySnapshot,
      });
      expect(s.vix1d).toBe(20);
      expect(s.vix9d).toBe(22);
      expect(s.vvix).toBe(110);
    });

    it('returns undefined for snapshot null fields', () => {
      const s = compute({
        historySnapshot: {
          vix1d: null,
          vix9d: null,
          vvix: null,
        } as unknown as HistorySnapshot,
      });
      expect(s.vix1d).toBeUndefined();
      expect(s.vix9d).toBeUndefined();
      expect(s.vvix).toBeUndefined();
    });
  });

  // ── Sigma source ────────────────────────────────────────

  describe('sigmaSource', () => {
    it('returns VIX1D when vix1d is available', () => {
      const s = compute({ liveVix1d: 15 });
      expect(s.sigmaSource).toBe('VIX1D');
    });

    it('returns VIX × 1.15 when no vix1d and ivMode matches ivModeVix', () => {
      const s = compute({
        liveVix1d: undefined,
        ivMode: 'vix',
        ivModeVix: 'vix',
      });
      expect(s.sigmaSource).toBe('VIX × 1.15');
    });

    it('returns manual when no vix1d and ivMode differs', () => {
      const s = compute({
        liveVix1d: undefined,
        ivMode: 'manual',
        ivModeVix: 'vix',
      });
      expect(s.sigmaSource).toBe('manual');
    });
  });

  // ── Early return without vix/spot/T ─────────────────────

  describe('missing core inputs', () => {
    it('returns defaults when vix is undefined', () => {
      const s = compute({ vix: undefined });
      expect(s.regimeZone).toBeNull();
      expect(s.icCeiling).toBeNull();
      expect(s.medianOcPct).toBeNull();
    });

    it('returns defaults when spot is undefined', () => {
      const s = compute({ spot: undefined });
      expect(s.regimeZone).toBeNull();
    });

    it('returns defaults when T is undefined', () => {
      const s = compute({ T: undefined });
      expect(s.regimeZone).toBeNull();
    });

    it('still populates dataNote on early return', () => {
      const s = compute({ vix: undefined });
      expect(s.dataNote).toBeDefined();
    });
  });

  // ── Regime zone ─────────────────────────────────────────

  describe('regime zone', () => {
    it('sets regime zone from VIX bucket', () => {
      expect(compute({ vix: 12 }).regimeZone).toBe('GREEN');
      expect(compute({ vix: 18 }).regimeZone).toBe('YELLOW');
      expect(compute({ vix: 22 }).regimeZone).toBe('ORANGE');
      expect(compute({ vix: 30 }).regimeZone).toBe('RED');
    });
  });

  // ── Day of week ─────────────────────────────────────────

  describe('day of week', () => {
    it('parses Tuesday from 2026-03-10', () => {
      const s = compute({ selectedDate: '2026-03-10' });
      expect(s.dowLabel).toBe('Tuesday');
    });

    it('parses Friday from 2026-03-13', () => {
      const s = compute({ selectedDate: '2026-03-13' });
      expect(s.dowLabel).toBe('Friday');
    });

    it('parses Monday from 2026-03-09', () => {
      const s = compute({ selectedDate: '2026-03-09' });
      expect(s.dowLabel).toBe('Monday');
    });

    it('returns null dowLabel for weekend dates', () => {
      const s = compute({ selectedDate: '2026-03-14' }); // Saturday
      expect(s.dowLabel).toBeNull();
    });

    it('falls back to current day when selectedDate is undefined', () => {
      const s = compute({ selectedDate: undefined });
      // Should resolve to a valid day name or null (weekend)
      if (s.dowLabel) {
        expect([
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
        ]).toContain(s.dowLabel);
      } else {
        expect(s.dowLabel).toBeNull();
      }
    });

    it('populates dow multipliers', () => {
      const s = compute({ selectedDate: '2026-03-10' });
      expect(s.dowMultHL).toBe(1.1);
      expect(s.dowMultOC).toBe(0.9);
    });
  });

  // ── Range thresholds ────────────────────────────────────

  describe('range thresholds', () => {
    it('computes adjusted range values', () => {
      const s = compute();
      // medOC = 0.5, ocAdj = 0.9 * 1.0 => 0.45
      expect(s.medianOcPct).toBeCloseTo(0.45);
      // medHL = 0.8, hlAdj = 1.1 * 1.0 => 0.88
      expect(s.medianHlPct).toBeCloseTo(0.88);
      // p90OC = 1.0, ocAdj = 0.9 => 0.9
      expect(s.p90OcPct).toBeCloseTo(0.9);
      // p90HL = 1.5, hlAdj = 1.1 => 1.65
      expect(s.p90HlPct).toBeCloseTo(1.65);
    });

    it('computes p90 points from spot', () => {
      const s = compute({ spot: 5700 });
      // p90OcPts = round((0.9 / 100) * 5700) = round(51.3) = 51
      expect(s.p90OcPts).toBe(51);
      // p90HlPts = round((1.65 / 100) * 5700) = round(94.05) = 94
      expect(s.p90HlPts).toBe(94);
    });

    it('applies cluster multiplier', () => {
      const s = compute({ clusterMult: 1.5 });
      // medOC = 0.5 * (0.9 * 1.5) = 0.675
      expect(s.medianOcPct).toBeCloseTo(0.675);
    });

    it('defaults clusterMult <= 0 to 1', () => {
      const a = compute({ clusterMult: 0 });
      const b = compute({ clusterMult: 1 });
      expect(a.medianOcPct).toBe(b.medianOcPct);
    });
  });

  // ── Delta guide ceilings ────────────────────────────────

  describe('delta guide ceilings', () => {
    it('computes IC ceiling and spread ceilings', () => {
      const s = compute();
      expect(s.icCeiling).toBeTypeOf('number');
      expect(s.icCeiling).toBeGreaterThan(0);
      expect(s.putSpreadCeiling).toBeGreaterThanOrEqual(s.icCeiling!);
      expect(s.callSpreadCeiling).toBeGreaterThanOrEqual(s.icCeiling!);
    });

    it('computes conservative delta as ~60% of IC ceiling', () => {
      const s = compute();
      expect(s.conservativeDelta).toBe(
        Math.max(1, Math.floor(s.icCeiling! * 0.6)),
      );
    });

    it('computes moderate delta from H-L range', () => {
      const s = compute();
      expect(s.moderateDelta).toBeTypeOf('number');
      expect(s.moderateDelta).toBeGreaterThan(0);
    });
  });

  // ── Opening range ───────────────────────────────────────

  describe('opening range', () => {
    it('marks available after 10:00 AM ET', () => {
      const s = compute({ timeHour: '10', timeMinute: '00', timeAmPm: 'AM' });
      expect(s.openingRangeAvailable).toBe(true);
    });

    it('marks unavailable before 10:00 AM ET', () => {
      const s = compute({ timeHour: '9', timeMinute: '59', timeAmPm: 'AM' });
      expect(s.openingRangeAvailable).toBe(false);
    });

    it('uses live opening range when no snapshot', () => {
      const s = compute({
        timeHour: '10',
        timeMinute: '30',
        timeAmPm: 'AM',
        liveOpeningRange: { high: 5720, low: 5690 },
      });
      expect(s.openingRangeHigh).toBe(5720);
      expect(s.openingRangeLow).toBe(5690);
      expect(s.openingRangePctConsumed).toBeTypeOf('number');
      expect(s.openingRangeSignal).toMatch(/^(GREEN|MODERATE|RED)$/);
    });

    it('uses snapshot opening range over live when present', () => {
      const s = compute({
        timeHour: '11',
        timeMinute: '00',
        timeAmPm: 'AM',
        liveOpeningRange: { high: 9999, low: 9990 },
        historySnapshot: {
          openingRange: { high: 5710, low: 5695 },
          vix1d: 15,
          vix9d: 17,
          vvix: 90,
        } as unknown as HistorySnapshot,
      });
      expect(s.openingRangeHigh).toBe(5710);
      expect(s.openingRangeLow).toBe(5695);
    });

    it('classifies GREEN when consumed < 40%', () => {
      const s = compute({
        liveOpeningRange: { high: 5701, low: 5700 },
      });
      expect(s.openingRangeSignal).toBe('GREEN');
    });

    it('classifies MODERATE when consumed is 40-65%', () => {
      // medianHlPct ≈ 0.88, so rangePct/0.88 in [0.4,0.65] → rangePct ≈ 0.40
      // rangePct = (high - low) / spot * 100 ≈ (23/5700)*100 ≈ 0.40
      const s = compute({
        liveOpeningRange: { high: 5723, low: 5700 },
      });
      expect(s.openingRangeSignal).toBe('MODERATE');
    });

    it('classifies RED when consumed >= 65%', () => {
      // rangePct/0.88 >= 0.65 → rangePct >= 0.572 → pts >= 33
      const s = compute({
        liveOpeningRange: { high: 5740, low: 5700 },
      });
      expect(s.openingRangeSignal).toBe('RED');
    });

    it('skips opening range when data is zero', () => {
      const s = compute({ liveOpeningRange: { high: 0, low: 0 } });
      expect(s.openingRangeHigh).toBeNull();
    });
  });

  // ── VIX term structure ──────────────────────────────────

  describe('VIX term structure', () => {
    it('classifies normal term structure', () => {
      const s = compute({
        liveVix1d: 16,
        liveVix9d: 17,
        liveVvix: 92,
        vix: 18,
      });
      expect(s.vixTermSignal).toMatch(/^(calm|normal|elevated|extreme)$/);
    });

    it('returns null when all vol inputs undefined', () => {
      const s = compute({
        liveVix1d: undefined,
        liveVix9d: undefined,
        liveVvix: undefined,
      });
      expect(s.vixTermSignal).toBeNull();
    });

    it('classifies extreme when vix1d >> vix', () => {
      const s = compute({
        liveVix1d: 30,
        liveVix9d: undefined,
        liveVvix: undefined,
        vix: 18,
      });
      expect(s.vixTermSignal).toBe('extreme');
    });

    it('classifies calm when vix1d << vix', () => {
      const s = compute({
        liveVix1d: 10,
        liveVix9d: undefined,
        liveVvix: undefined,
        vix: 18,
      });
      expect(s.vixTermSignal).toBe('calm');
    });

    it('uses worst signal across indicators', () => {
      // vix1d/vix = 18/18 = 1.0 → elevated; vvix = 130 → extreme
      const s = compute({
        liveVix1d: 18,
        liveVix9d: undefined,
        liveVvix: 130,
        vix: 18,
      });
      expect(s.vixTermSignal).toBe('extreme');
    });
  });

  // ── Price context from history snapshot ─────────────────

  describe('price context', () => {
    it('populates OHLC and overnight gap from snapshot', () => {
      const s = compute({
        historySnapshot: {
          runningOHLC: { open: 5680, high: 5720, low: 5660 },
          previousClose: 5670,
          vix1d: 15,
          vix9d: 17,
          vvix: 90,
        } as unknown as HistorySnapshot,
      });
      expect(s.spxOpen).toBe(5680);
      expect(s.spxHigh).toBe(5720);
      expect(s.spxLow).toBe(5660);
      expect(s.prevClose).toBe(5670);
      expect(s.overnightGap).toBeCloseTo(((5680 - 5670) / 5670) * 100, 4);
    });

    it('returns null OHLC without snapshot', () => {
      const s = compute({ historySnapshot: null });
      expect(s.spxOpen).toBeNull();
      expect(s.prevClose).toBeNull();
      expect(s.overnightGap).toBeNull();
    });

    it('does not compute gap when prevClose is 0', () => {
      const s = compute({
        historySnapshot: {
          runningOHLC: { open: 5680, high: 5720, low: 5660 },
          previousClose: 0,
          vix1d: 15,
          vix9d: 17,
          vvix: 90,
        } as unknown as HistorySnapshot,
      });
      expect(s.overnightGap).toBeNull();
    });
  });

  // ── Events ──────────────────────────────────────────────

  describe('events', () => {
    it('detects event day', () => {
      const s = compute({ selectedDate: '2026-03-20' });
      expect(s.isEventDay).toBe(true);
      expect(s.eventNames).toContain('Triple Witching');
    });

    it('no events on normal day', () => {
      const s = compute({ selectedDate: '2026-03-10' });
      expect(s.isEventDay).toBe(false);
      expect(s.eventNames).toHaveLength(0);
    });

    it('detects early close', () => {
      const s = compute({ selectedDate: '2026-12-24' });
      expect(s.isEarlyClose).toBe(true);
    });

    it('no early close on normal day', () => {
      const s = compute({ selectedDate: '2026-03-10' });
      expect(s.isEarlyClose).toBe(false);
    });
  });

  // ── Data note ───────────────────────────────────────────

  describe('dataNote', () => {
    it('includes VIX1D warning when vix1d unavailable', () => {
      const s = compute({ liveVix1d: undefined });
      expect(s.dataNote).toContain('VIX1D unavailable');
    });

    it('includes pre-10AM note when before opening range', () => {
      const s = compute({ timeHour: '9', timeMinute: '30', timeAmPm: 'AM' });
      expect(s.dataNote).toContain('opening range not yet complete');
    });

    it('includes backtest note when history snapshot present', () => {
      const s = compute({
        historySnapshot: {
          vix1d: 15,
          vix9d: 17,
          vvix: 90,
        } as HistorySnapshot,
      });
      expect(s.dataNote).toContain('Backtesting');
    });

    it('returns undefined when all data available and after 10AM', () => {
      const s = compute({
        liveVix1d: 15,
        timeHour: '10',
        timeMinute: '30',
        timeAmPm: 'AM',
        historySnapshot: null,
      });
      expect(s.dataNote).toBeUndefined();
    });
  });
});
