import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRangeAnalysis } from '../../hooks/useRangeAnalysis';
import type { HistorySnapshot } from '../../hooks/useHistoryData';

// ============================================================
// HELPERS
// ============================================================

/** Default inputs that place us in a normal mid-session scenario */
function makeInputs(
  overrides: Partial<Parameters<typeof useRangeAnalysis>[0]> = {},
): Parameters<typeof useRangeAnalysis>[0] {
  return {
    vix: 18,
    spot: 5700,
    timeHour: '11',
    timeMinute: '00',
    timeAmPm: 'AM',
    timezone: 'ET',
    selectedDate: '2026-03-20',
    vix1d: 15,
    medianHlPct: 1.0,
    liveOpeningRange: undefined,
    liveYesterdayHigh: undefined,
    liveYesterdayLow: undefined,
    livePriorDays: undefined,
    liveEvents: undefined,
    historySnapshot: null,
    ...overrides,
  };
}

function render(
  overrides: Partial<Parameters<typeof useRangeAnalysis>[0]> = {},
) {
  const { result } = renderHook(() => useRangeAnalysis(makeInputs(overrides)));
  return result.current;
}

// ============================================================
// Parkinson RV (single-day) — tested via liveYesterdayHigh/Low
// ============================================================

describe('useRangeAnalysis — Parkinson RV (single-day)', () => {
  it('computes rvAnnualized from yesterday high/low', () => {
    const result = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
    });

    expect(result.rvAnnualized).not.toBeNull();
    expect(result.rvAnnualized).toBeGreaterThan(0);
    expect(result.rvIvRatio).not.toBeNull();
    expect(result.rvIvLabel).not.toBeNull();
  });

  it('returns known value for a specific high/low pair', () => {
    // Parkinson formula: sqrt(1/(4*ln2)) * |ln(H/L)| * sqrt(252)
    // H=5750, L=5650: ln(5750/5650) = ln(1.0177) ≈ 0.01754
    // sqrt(1/(4*0.6931)) ≈ 0.6006
    // 0.6006 * 0.01754 * 15.875 ≈ 0.1672
    const result = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
    });

    expect(result.rvAnnualized).toBeCloseTo(0.1672, 2);
  });

  it('returns zero RV fields when high <= low', () => {
    const result = render({
      liveYesterdayHigh: 5650,
      liveYesterdayLow: 5750,
    });

    expect(result.rvAnnualized).toBeNull();
    expect(result.rvIvRatio).toBeNull();
    expect(result.rvIvLabel).toBeNull();
  });

  it('returns null RV fields when high equals low', () => {
    const result = render({
      liveYesterdayHigh: 5700,
      liveYesterdayLow: 5700,
    });

    expect(result.rvAnnualized).toBeNull();
    expect(result.rvIvRatio).toBeNull();
  });

  it('returns null RV fields when yesterday data is missing', () => {
    const result = render({
      liveYesterdayHigh: undefined,
      liveYesterdayLow: undefined,
    });

    expect(result.rvAnnualized).toBeNull();
    expect(result.rvIvRatio).toBeNull();
    expect(result.rvIvLabel).toBeNull();
  });
});

// ============================================================
// Rolling Parkinson RV — tested via livePriorDays
// ============================================================

describe('useRangeAnalysis — Rolling Parkinson RV (multi-day)', () => {
  it('uses rolling RV when livePriorDays has >= 2 entries', () => {
    const priorDays = [
      { high: 5750, low: 5650 },
      { high: 5720, low: 5680 },
      { high: 5780, low: 5640 },
      { high: 5730, low: 5670 },
      { high: 5760, low: 5660 },
    ];

    const result = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: priorDays,
    });

    expect(result.rvAnnualized).not.toBeNull();
    expect(result.rvAnnualized).toBeGreaterThan(0);
    expect(result.rvIvRatio).not.toBeNull();
  });

  it('falls back to single-day when livePriorDays has < 2 entries', () => {
    const singleDayResult = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: [{ high: 5750, low: 5650 }],
    });

    const noRollingResult = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: undefined,
    });

    // Both should produce the same single-day Parkinson estimate
    expect(singleDayResult.rvAnnualized).toBe(noRollingResult.rvAnnualized);
  });

  it('rolling RV differs from single-day RV with varied data', () => {
    // Days with different ranges should produce a different rolling RV
    // than a single day alone
    const priorDays = [
      { high: 5800, low: 5600 }, // wide range
      { high: 5720, low: 5680 }, // narrow range
      { high: 5780, low: 5640 }, // medium range
    ];

    const rollingResult = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: priorDays,
    });

    const singleResult = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: undefined,
    });

    // Rolling should average across all days, producing different result
    expect(rollingResult.rvAnnualized).not.toBe(singleResult.rvAnnualized);
  });

  it('skips invalid days in rolling (high <= low)', () => {
    const priorDays = [
      { high: 5750, low: 5650 }, // valid
      { high: 5680, low: 5720 }, // invalid: high < low
      { high: 5730, low: 5670 }, // valid
    ];

    const result = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: priorDays,
    });

    // Should still compute (2 valid days)
    expect(result.rvAnnualized).not.toBeNull();
    expect(result.rvAnnualized).toBeGreaterThan(0);
  });

  it('returns null RV when all rolling days are invalid', () => {
    const priorDays = [
      { high: 0, low: 5650 }, // invalid
      { high: 5680, low: 5720 }, // invalid
    ];

    const result = render({
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
      livePriorDays: priorDays,
    });

    // Rolling returns 0, but since we have ydayHigh/Low > 0 with >= 2 priorDays,
    // the code uses rollingParkinsonRV which returns 0 for all-invalid data.
    // rv=0 means iv division yields 0/iv = 0 ratio
    expect(result.rvIvRatio).toBe(0);
  });
});

// ============================================================
// RV/IV ratio labels
// ============================================================

describe('useRangeAnalysis — RV/IV labels', () => {
  it('labels as "IV Rich" when rvIvRatio < 0.8', () => {
    // Need a very small RV (narrow range) relative to VIX
    // VIX=30, vix1d=30 → IV = 30/100 = 0.30
    // Yesterday range: 5710-5700 → tiny range → very low RV
    const result = render({
      vix: 30,
      vix1d: 30,
      liveYesterdayHigh: 5710,
      liveYesterdayLow: 5700,
    });

    expect(result.rvIvLabel).toBe('IV Rich');
    expect(result.rvIvRatio).toBeLessThan(0.8);
  });

  it('labels as "IV Cheap" when rvIvRatio > 1.2', () => {
    // Need a large RV relative to low VIX
    // VIX=10, vix1d=10 → IV = 10/100 = 0.10
    // Yesterday range: 5800-5600 → wide range → high RV
    const result = render({
      vix: 10,
      vix1d: 10,
      liveYesterdayHigh: 5800,
      liveYesterdayLow: 5600,
    });

    expect(result.rvIvLabel).toBe('IV Cheap');
    expect(result.rvIvRatio).toBeGreaterThan(1.2);
  });

  it('labels as "Fair Value" when rvIvRatio between 0.8 and 1.2', () => {
    // We need to calibrate so that RV/IV is roughly 1.0
    // VIX=18, vix1d=undefined → IV = 18*1.15/100 = 0.207
    // Parkinson RV: sqrt(1/(4*ln2)) * ln(H/L) * sqrt(252)
    // For RV ≈ 0.207: ln(H/L) ≈ 0.207 / (0.6006 * 15.875) ≈ 0.0217
    // H/L ≈ e^0.0217 ≈ 1.0219 → if L=5700, H ≈ 5825
    const result = render({
      vix: 18,
      vix1d: undefined,
      liveYesterdayHigh: 5825,
      liveYesterdayLow: 5700,
    });

    expect(result.rvIvLabel).toBe('Fair Value');
    expect(result.rvIvRatio).toBeGreaterThanOrEqual(0.8);
    expect(result.rvIvRatio).toBeLessThanOrEqual(1.2);
  });

  it('uses VIX1D for IV when available', () => {
    const withVix1d = render({
      vix: 18,
      vix1d: 12,
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
    });

    const withoutVix1d = render({
      vix: 18,
      vix1d: undefined,
      liveYesterdayHigh: 5750,
      liveYesterdayLow: 5650,
    });

    // Different IV denominators should yield different ratios
    expect(withVix1d.rvIvRatio).not.toBe(withoutVix1d.rvIvRatio);
    // VIX1D=12 → IV=0.12, VIX*1.15=0.207 → same RV but different ratio
    // Lower IV → higher ratio
    expect(withVix1d.rvIvRatio).toBeGreaterThan(withoutVix1d.rvIvRatio!);
  });
});

// ============================================================
// History snapshot support for RV
// ============================================================

/** Build a minimal valid HistorySnapshot with overrides */
function makeSnapshot(
  overrides: Partial<HistorySnapshot> = {},
): HistorySnapshot {
  return {
    spot: 5700,
    spy: 570,
    runningOHLC: { open: 5710, high: 5730, low: 5690, last: 5700 },
    openingRange: null,
    yesterday: null,
    vix: 18,
    vixPrevClose: 17,
    vix1d: 15,
    vix9d: 17,
    vvix: 90,
    previousClose: 5700,
    candle: {
      datetime: 1710000000,
      time: '10:00',
      open: 5700,
      high: 5710,
      low: 5690,
      close: 5705,
    },
    candleIndex: 6,
    totalCandles: 78,
    ...overrides,
  };
}

describe('useRangeAnalysis — history snapshot RV', () => {
  it('uses history snapshot yesterday data for RV', () => {
    const snapshot = makeSnapshot({
      openingRange: {
        high: 5720,
        low: 5680,
        rangePts: 40,
        complete: true,
      },
      yesterday: {
        date: '2026-03-19',
        open: 5680,
        high: 5750,
        low: 5650,
        close: 5700,
        rangePct: 1.75,
        rangePts: 100,
      },
    });

    const result = render({
      historySnapshot: snapshot,
    });

    expect(result.rvAnnualized).not.toBeNull();
    expect(result.rvIvRatio).not.toBeNull();
  });

  it('computes overnight gap from history snapshot', () => {
    const snapshot = makeSnapshot({
      previousClose: 5700,
      runningOHLC: { open: 5720, high: 5730, low: 5690, last: 5700 },
    });

    const result = render({
      historySnapshot: snapshot,
    });

    // Gap = (5720 - 5700) / 5700 * 100 ≈ 0.3509%
    expect(result.overnightGap).toBeCloseTo(0.351, 2);
    expect(result.spxOpen).toBe(5720);
    expect(result.prevClose).toBe(5700);
  });
});

// ============================================================
// Edge cases — no vix or spot
// ============================================================

describe('useRangeAnalysis — missing core inputs', () => {
  it('returns defaults when vix is undefined', () => {
    const result = render({ vix: undefined });

    expect(result.rvAnnualized).toBeNull();
    expect(result.rvIvRatio).toBeNull();
    expect(result.openingRangeAvailable).toBe(false);
  });

  it('returns defaults when spot is undefined', () => {
    const result = render({ spot: undefined });

    expect(result.rvAnnualized).toBeNull();
    expect(result.rvIvRatio).toBeNull();
    expect(result.openingRangeAvailable).toBe(false);
  });
});

// ============================================================
// Annualization factor correctness
// ============================================================

describe('useRangeAnalysis — annualization factor', () => {
  it('uses sqrt(252) annualization for Parkinson RV', () => {
    // Parkinson single-day: sqrt(1/(4*ln2)) * ln(H/L) * sqrt(252)
    // We verify the annualization by comparing to hand-computed value
    const high = 5800;
    const low = 5700;
    const logHL = Math.log(high / low);
    const expectedRV = Math.sqrt(1 / (4 * Math.LN2)) * logHL * Math.sqrt(252);

    const result = render({
      liveYesterdayHigh: high,
      liveYesterdayLow: low,
    });

    expect(result.rvAnnualized).toBeCloseTo(expectedRV, 4);
  });
});
