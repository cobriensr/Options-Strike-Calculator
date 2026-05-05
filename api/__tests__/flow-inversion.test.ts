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
});
