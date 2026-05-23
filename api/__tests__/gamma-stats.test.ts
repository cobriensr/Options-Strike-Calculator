// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  DRIFT_EDGE_RATIO_THRESHOLD,
  DRIFT_MIN_N,
  DRIFT_WIN_RATE_THRESHOLD,
  EXPECTED_EDGE_PTS,
  aggregateFireStats,
  detectDrift,
} from '../_lib/gamma-stats.js';
import type { SignalType } from '../_lib/gamma-detector.js';

interface RowSpec {
  signal_type: SignalType;
  ret_30m: number | null;
}

function makeRows(specs: RowSpec[]) {
  return specs.map((s) => ({ signal_type: s.signal_type, ret_30m: s.ret_30m }));
}

const FROM = '2026-04-23';
const TO = '2026-05-21';

describe('aggregateFireStats', () => {
  it('returns zero-state on empty input', () => {
    const stats = aggregateFireStats([], FROM, TO);
    expect(stats.n_total).toBe(0);
    expect(stats.n_with_outcome).toBe(0);
    expect(stats.win_rate).toBeNull();
    expect(stats.mean_edge_pts).toBeNull();
    expect(stats.by_signal).toHaveLength(3);
    for (const s of stats.by_signal) {
      expect(s.n_total).toBe(0);
      expect(s.win_rate).toBeNull();
    }
  });

  it('excludes NULL ret_30m rows from win-rate + mean calculations', () => {
    const rows = makeRows([
      { signal_type: 'e1_long_call', ret_30m: 5 },
      { signal_type: 'e1_long_call', ret_30m: null }, // pending outcome
      { signal_type: 'e1_long_call', ret_30m: -2 },
    ]);
    const stats = aggregateFireStats(rows, FROM, TO);
    expect(stats.n_total).toBe(3);
    expect(stats.n_with_outcome).toBe(2);
    expect(stats.win_rate).toBeCloseTo(0.5, 5);
    expect(stats.mean_edge_pts).toBeCloseTo(1.5, 5); // (5 + -2) / 2
  });

  it('computes per-signal stats independently', () => {
    const rows = makeRows([
      { signal_type: 'e1_long_call', ret_30m: 6 },
      { signal_type: 'e1_long_call', ret_30m: 4 },
      { signal_type: 'e5_long_put', ret_30m: 10 },
      { signal_type: 'e5_long_put', ret_30m: -5 },
      { signal_type: 'pcs_monday', ret_30m: 20 },
    ]);
    const stats = aggregateFireStats(rows, FROM, TO);

    const e1 = stats.by_signal.find((s) => s.signal_type === 'e1_long_call')!;
    expect(e1.n_total).toBe(2);
    expect(e1.win_rate).toBeCloseTo(1.0, 5);
    expect(e1.mean_edge_pts).toBeCloseTo(5, 5);
    expect(e1.edge_ratio).toBeCloseTo(5 / EXPECTED_EDGE_PTS.e1_long_call, 5);

    const e5 = stats.by_signal.find((s) => s.signal_type === 'e5_long_put')!;
    expect(e5.win_rate).toBeCloseTo(0.5, 5);
    expect(e5.mean_edge_pts).toBeCloseTo(2.5, 5);

    const pcs = stats.by_signal.find((s) => s.signal_type === 'pcs_monday')!;
    expect(pcs.n_total).toBe(1);
    expect(pcs.win_rate).toBeCloseTo(1.0, 5);
    expect(pcs.mean_edge_pts).toBeCloseTo(20, 5);
  });

  it('handles all-NULL ret_30m by reporting nulls but counting n_total', () => {
    const rows = makeRows([
      { signal_type: 'e1_long_call', ret_30m: null },
      { signal_type: 'e1_long_call', ret_30m: null },
    ]);
    const stats = aggregateFireStats(rows, FROM, TO);
    expect(stats.n_total).toBe(2);
    expect(stats.n_with_outcome).toBe(0);
    expect(stats.win_rate).toBeNull();
    expect(stats.mean_edge_pts).toBeNull();
  });
});

describe('detectDrift', () => {
  it('returns null when sample is below the floor (no false alarms early)', () => {
    // 5 fires, all losers — would trip win-rate rule at higher n, but
    // n < DRIFT_MIN_N so we must not fire.
    expect(DRIFT_MIN_N).toBe(10);
    const rows = makeRows([
      { signal_type: 'e1_long_call', ret_30m: -1 },
      { signal_type: 'e1_long_call', ret_30m: -1 },
      { signal_type: 'e1_long_call', ret_30m: -1 },
      { signal_type: 'e1_long_call', ret_30m: -1 },
      { signal_type: 'e1_long_call', ret_30m: -1 },
    ]);
    const stats = aggregateFireStats(rows, FROM, TO);
    expect(detectDrift(stats)).toBeNull();
  });

  it('fires when composite win rate falls below threshold (n >= 10)', () => {
    // 12 outcomes, 50% win rate (under DRIFT_WIN_RATE_THRESHOLD = 0.55).
    expect(DRIFT_WIN_RATE_THRESHOLD).toBe(0.55);
    const rows: RowSpec[] = [];
    for (let i = 0; i < 6; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: 5 });
    for (let i = 0; i < 6; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: -1 });
    const stats = aggregateFireStats(makeRows(rows), FROM, TO);
    const drift = detectDrift(stats);
    expect(drift).not.toBeNull();
    expect(drift!.reasons.some((r) => r.includes('win rate'))).toBe(true);
  });

  it('fires when a per-signal edge ratio collapses (n >= 10)', () => {
    // 10 e1 outcomes averaging +1 pt — below 50% of EXPECTED_EDGE_PTS.e1_long_call (5.36).
    expect(DRIFT_EDGE_RATIO_THRESHOLD).toBe(0.5);
    const rows: RowSpec[] = [];
    // 8 wins, 2 losses to keep win rate above the win-rate rule so we
    // isolate the edge-ratio rule specifically.
    for (let i = 0; i < 8; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: 1.5 });
    for (let i = 0; i < 2; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: -1 });
    const stats = aggregateFireStats(makeRows(rows), FROM, TO);
    const drift = detectDrift(stats);
    expect(drift).not.toBeNull();
    expect(drift!.reasons.some((r) => r.includes('edge ratio'))).toBe(true);
    expect(drift!.reasons.some((r) => r.includes('e1_long_call'))).toBe(true);
  });

  it('does not fire on a healthy sample matching backtest expectation', () => {
    // 12 e1 outcomes averaging the expected edge (+5.36 ish).
    const rows: RowSpec[] = [];
    for (let i = 0; i < 9; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: 6 });
    for (let i = 0; i < 3; i += 1)
      rows.push({ signal_type: 'e1_long_call', ret_30m: -1 });
    const stats = aggregateFireStats(makeRows(rows), FROM, TO);
    expect(detectDrift(stats)).toBeNull();
  });
});
