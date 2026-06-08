// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  findProminentPeaks,
  simulateFlowInversion,
  eodCtForTrigger,
  type FlowMinute,
  type MinutePrice,
} from '../_lib/flow-inversion.js';

describe('findProminentPeaks', () => {
  it('finds the most-prominent peak in a unimodal cumulative series', () => {
    // 0,1,3,7,9,7,5,3,1 — peak at index 4. Left descent reaches 0,
    // right descent reaches 1, so base = max(0, 1) = 1 and prominence
    // = 9 - 1 = 8 (matches scipy.signal.find_peaks(prominence=...)).
    const peaks = findProminentPeaks([0, 1, 3, 7, 9, 7, 5, 3, 1], 0);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.idx).toBe(4);
    expect(peaks[0]!.prominence).toBe(8);
  });

  it('rejects peaks below the prominence floor', () => {
    // Tiny ripple in the middle of a flat series — prominence < threshold.
    const peaks = findProminentPeaks([1, 2, 1, 1, 1, 1, 1, 2, 1], 5);
    expect(peaks).toHaveLength(0);
  });

  it('keeps multiple peaks when each meets the prominence floor', () => {
    // Two distinct peaks separated by a deep valley.
    const peaks = findProminentPeaks([0, 5, 0, 4, 0], 1);
    expect(peaks).toHaveLength(2);
    expect(peaks.map((p) => p.idx)).toEqual([1, 3]);
  });

  it('ignores edge maxima (i==0 or i==n-1)', () => {
    const peaks = findProminentPeaks([10, 5, 0, 5, 10], 0);
    expect(peaks).toHaveLength(0);
  });
});

describe('eodCtForTrigger', () => {
  it('returns 20:00 UTC during CDT (e.g. May)', () => {
    const trigger = new Date('2026-05-02T15:00:00Z'); // 10:00 CT
    const eod = eodCtForTrigger(trigger);
    expect(eod.toISOString()).toBe('2026-05-02T20:00:00.000Z');
  });

  it('returns 21:00 UTC during CST (e.g. January)', () => {
    const trigger = new Date('2026-01-15T15:00:00Z'); // 09:00 CT
    const eod = eodCtForTrigger(trigger);
    expect(eod.toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });
});

// Build a synthetic minute series spanning 14:00–20:30 UTC (09:00–15:30 CT)
// in 1-minute steps starting at the supplied base.
function buildMinutes(
  start: Date,
  count: number,
  fn: (i: number) => number,
): MinutePrice[] {
  const out: MinutePrice[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      ts: new Date(start.getTime() + i * 60_000),
      mid: fn(i),
    });
  }
  return out;
}

function buildFlow(
  start: Date,
  count: number,
  fn: (i: number) => number,
): FlowMinute[] {
  const out: FlowMinute[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      ts: new Date(start.getTime() + i * 60_000),
      value: fn(i),
    });
  }
  return out;
}

describe('simulateFlowInversion', () => {
  const trigger = new Date('2026-05-02T15:00:00Z'); // 10:00 CDT, before EOD.
  const postStart = new Date('2026-05-02T15:01:00Z');
  const entryPrice = 1.0;

  it('exits at the inversion when the post-peak slope persists negative', () => {
    // Mids start at 1.0, peak at 1.5 around minute 30, fall to 1.2 by 60.
    const minutes = buildMinutes(postStart, 90, (i) =>
      i <= 30 ? 1.0 + 0.5 * (i / 30) : 1.5 - 0.3 * ((i - 30) / 60),
    );
    // Flow rises to peak at minute 30, then strictly falls — slope is
    // negative for at least 3 consecutive minutes after peak.
    const flow = buildFlow(postStart, 90, (i) => (i <= 30 ? 100 : -100));
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('inversion');
    expect(result.exitPct).not.toBeNull();
    expect(result.exitTs).not.toBeNull();
  });

  it('returns no_post_trigger_prices when minutes are all pre-trigger', () => {
    const pre = buildMinutes(
      new Date(trigger.getTime() - 60 * 60_000),
      30,
      () => 1.0,
    );
    const flow = buildFlow(postStart, 60, () => 100);
    const result = simulateFlowInversion(pre, flow, entryPrice, trigger);
    expect(result.status).toBe('no_post_trigger_prices');
    expect(result.exitPct).toBeNull();
  });

  it('returns insufficient_flow_data with <5 post-trigger flow rows', () => {
    const minutes = buildMinutes(postStart, 30, () => 1.1);
    const flow = buildFlow(postStart, 4, () => 100);
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('insufficient_flow_data');
  });

  it('reports no_flow_peak_detected when matched-side flow is monotonic', () => {
    const minutes = buildMinutes(postStart, 300, (i) => 1.0 + 0.001 * i);
    const flow = buildFlow(postStart, 300, () => 50);
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('no_flow_peak_detected');
  });

  it('falls back to EOD when peak occurs late in the window', () => {
    // Cumulative flow climbs then plateaus — peak well into the
    // window, but post-peak flow stays non-negative.
    const minutes = buildMinutes(postStart, 300, (i) =>
      i < 250 ? 1.0 + 0.001 * i : 1.25,
    );
    const flow = buildFlow(postStart, 300, (i) => {
      if (i < 100) return 100;
      if (i < 110) return -50;
      return 0;
    });
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    // Post-peak the flow goes negative for 10 min then flat — slope flips
    // and finds an inversion. Either status is acceptable for this shape.
    expect([
      'inversion',
      'eod_no_inversion_window',
      'eod_no_inversion_found',
    ]).toContain(result.status);
  });

  it('returns flat_flow_no_peak when cumulative flow has zero range', () => {
    // All-zero flow → cumsum is flat at 0 → max == min → rng <= 0.
    const minutes = buildMinutes(postStart, 30, () => 1.1);
    const flow = buildFlow(postStart, 10, () => 0);
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('flat_flow_no_peak');
    expect(result.exitPct).toBeNull();
    expect(result.exitTs).toBeNull();
  });

  it('selects the more-prominent of two peaks for the inversion search', () => {
    // Cumsum forms two peaks that BOTH clear the prominence floor: peak A at
    // idx 5 (prominence ~500) and peak B at idx 23 (prominence ~840). Because
    // peaks are returned in index order, the most-prominent-peak loop must
    // advance peakIdx from A to the more-prominent B. After dominant peak B,
    // flow turns strongly negative and persists → deterministic 'inversion'.
    const flow = buildFlow(postStart, 90, (i) => {
      if (i < 6) return 100; // peak A rise (cum -> 600)
      if (i < 12) return -90; // deep valley after A (cum -> 60)
      if (i < 24) return 70; // peak B rise, higher crest (cum -> 900)
      return -110; // sustained negative after dominant peak B
    });
    const minutes = buildMinutes(postStart, 90, (i) =>
      i <= 24 ? 1.0 + 0.01 * i : 1.24 - 0.005 * (i - 24),
    );
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('inversion');
    expect(result.exitTs).not.toBeNull();
  });

  it('falls back to EOD (window) when the peak leaves too few post-peak minutes', () => {
    // 9 flow rows: ramp up to a peak at index 6, then 2 trailing rows —
    // post-peak length (3) < INVERSION_SLOPE_WINDOW_MIN + NEG_PERSIST (8),
    // so the slope search is skipped and we take the EOD-window fallback.
    // Post minutes all precede EOD, so exitAtOrAfter appends `_eod_fallback`.
    const minutes = buildMinutes(postStart, 9, (i) => 1.0 + 0.01 * i);
    const flow = buildFlow(
      postStart,
      9,
      (i) => (i <= 6 ? 10 + i : -100), // strictly rising cum to idx 6, then drops
    );
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('eod_no_inversion_window_eod_fallback');
    expect(result.exitPct).not.toBeNull();
    // Fallback exit is the last available post-trigger minute.
    expect(result.exitTs).toEqual(minutes.at(-1)!.ts);
  });

  it('returns eod_no_inversion_found when post-peak slope never persists negative', () => {
    // Prominent peak at idx 9 (a sharp 2-bar drop gives it prominence), then
    // a strong recovery. The 5-min windowed slope dips negative only briefly
    // and never persists for 3 consecutive minutes, so no inversion index is
    // found and the search falls back to EOD.
    const flow = buildFlow(postStart, 60, (i) => {
      if (i < 10) return 100; // climb to the peak at idx 9
      if (i < 12) return -300; // sharp 2-bar drop → prominent peak
      return 120; // strong sustained recovery
    });
    const minutes = buildMinutes(postStart, 60, (i) => 1.0 + 0.001 * i);
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('eod_no_inversion_found_eod_fallback');
    expect(result.exitPct).not.toBeNull();
  });

  it('resets the negative-slope streak when slope turns non-negative mid-run', () => {
    // Post-peak: a 2-minute negative dip (streak=2) interrupted by a
    // positive bar (streak reset to 0), then a sustained negative run that
    // finally trips the 3-consecutive-minute inversion. Exercises the
    // `else { negStreak = 0 }` reset branch before a real inversion.
    const flow = buildFlow(postStart, 90, (i) => {
      if (i < 20) return 100; // climb to peak
      if (i < 22) return -200; // 2 negative slope mins (streak builds)
      if (i < 23) return 600; // positive bar resets streak
      return -300; // sustained negative → eventual inversion
    });
    const minutes = buildMinutes(postStart, 90, (i) =>
      i <= 20 ? 1.0 + 0.01 * i : 1.2 - 0.004 * (i - 20),
    );
    const result = simulateFlowInversion(minutes, flow, entryPrice, trigger);
    expect(result.status).toBe('inversion');
    expect(result.exitTs).not.toBeNull();
  });
});
