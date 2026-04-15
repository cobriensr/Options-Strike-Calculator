// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  engineerNopeFeatures,
  type NopeTickRow,
} from '../_lib/build-features-nope.js';

// ── Fixtures ─────────────────────────────────────────────────
//
// All timestamps are UTC. ET = UTC-5 (EST) or UTC-4 (EDT).
// We anchor to 2026-04-14 which is EDT → UTC-4.
//   09:30 ET → 13:30 UTC
//   10:00 ET (T1, 600 min) → 14:00 UTC
//   10:30 ET (T2, 630 min) → 14:30 UTC
//   11:00 ET (T3, 660 min) → 15:00 UTC
//   11:30 ET (T4, 690 min) → 15:30 UTC

const DATE = '2026-04-14';

function row(
  utcIso: string,
  nope: number,
  callDelta = 10000,
  putDelta = 8000,
): NopeTickRow {
  return {
    timestamp: utcIso,
    nope: nope.toString(),
    call_delta: callDelta.toString(),
    put_delta: putDelta.toString(),
  };
}

// ── Empty / no data ──────────────────────────────────────────

describe('engineerNopeFeatures', () => {
  it('returns all-null features when given empty input', () => {
    const f = engineerNopeFeatures([], DATE);
    expect(f.nope_t1).toBeNull();
    expect(f.nope_t2).toBeNull();
    expect(f.nope_t3).toBeNull();
    expect(f.nope_t4).toBeNull();
    expect(f.nope_am_mean).toBeNull();
    expect(f.nope_am_sign_flips).toBeNull();
    expect(f.nope_am_cum_delta).toBeNull();
  });

  it('ignores rows from a different ET date', () => {
    const rows = [row('2026-04-15T14:00:00.000Z', 0.0003)];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_t1).toBeNull();
    expect(f.nope_am_mean).toBeNull();
  });

  // ── Checkpoint matching ────────────────────────────────────

  it('matches checkpoint rows exactly at T1, T2, T3, T4', () => {
    const rows = [
      row('2026-04-14T14:00:00.000Z', 0.0001), // T1
      row('2026-04-14T14:30:00.000Z', 0.0002), // T2
      row('2026-04-14T15:00:00.000Z', -0.0001), // T3
      row('2026-04-14T15:30:00.000Z', -0.0003), // T4
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_t1).toBeCloseTo(0.0001, 10);
    expect(f.nope_t2).toBeCloseTo(0.0002, 10);
    expect(f.nope_t3).toBeCloseTo(-0.0001, 10);
    expect(f.nope_t4).toBeCloseTo(-0.0003, 10);
  });

  it('tolerates ±5 min drift on checkpoint matching', () => {
    const rows = [
      row('2026-04-14T14:03:00.000Z', 0.0005), // T1 + 3 min
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_t1).toBeCloseTo(0.0005, 10);
  });

  it('rejects checkpoint matches outside the tolerance window', () => {
    const rows = [
      row('2026-04-14T14:10:00.000Z', 0.0005), // T1 + 10 min → too far
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_t1).toBeNull();
  });

  // ── AM aggregates ──────────────────────────────────────────

  it('computes AM mean over the 09:30–11:30 window', () => {
    const rows = [
      row('2026-04-14T13:30:00.000Z', 0.0002), // 09:30 ET (in-window)
      row('2026-04-14T14:00:00.000Z', 0.0004), // 10:00 ET (in-window)
      row('2026-04-14T15:30:00.000Z', -0.0006), // 11:30 ET (in-window boundary)
      row('2026-04-14T16:00:00.000Z', 0.9), // 12:00 ET — out of window
    ];
    const f = engineerNopeFeatures(rows, DATE);
    // mean of 0.0002, 0.0004, -0.0006 → 0
    expect(f.nope_am_mean).toBeCloseTo(0, 10);
  });

  it('counts AM sign flips', () => {
    const rows = [
      row('2026-04-14T13:30:00.000Z', -0.0002), // 09:30
      row('2026-04-14T13:45:00.000Z', 0.0001), // flip 1
      row('2026-04-14T14:15:00.000Z', 0.0002),
      row('2026-04-14T14:45:00.000Z', -0.0001), // flip 2
      row('2026-04-14T15:15:00.000Z', 0.0001), // flip 3
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_am_sign_flips).toBe(3);
  });

  it('sums AM cumulative hedging delta', () => {
    const rows = [
      row('2026-04-14T13:30:00.000Z', 0.0001, 12000, 8000), // Δ = +4000
      row('2026-04-14T14:00:00.000Z', 0.0001, 10000, 15000), // Δ = -5000
      row('2026-04-14T14:30:00.000Z', 0.0001, 20000, 3000), // Δ = +17000
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_am_cum_delta).toBe(16000); // 4000 - 5000 + 17000
  });

  it('excludes rows outside AM window from cum_delta', () => {
    const rows = [
      row('2026-04-14T13:30:00.000Z', 0.0001, 10000, 5000), // 09:30 — in
      row('2026-04-14T16:30:00.000Z', 0.0001, 99999, 0), // 12:30 — out
    ];
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_am_cum_delta).toBe(5000);
  });

  it('keeps aggregates null when no AM rows exist, even if other rows present', () => {
    const rows = [row('2026-04-14T18:00:00.000Z', 0.0003)]; // 14:00 ET — post-AM
    const f = engineerNopeFeatures(rows, DATE);
    expect(f.nope_am_mean).toBeNull();
    expect(f.nope_am_sign_flips).toBeNull();
    expect(f.nope_am_cum_delta).toBeNull();
  });

  it('handles non-finite numeric strings defensively', () => {
    const rows: NopeTickRow[] = [
      {
        timestamp: '2026-04-14T13:30:00.000Z',
        nope: 'NaN',
        call_delta: '10000',
        put_delta: '5000',
      },
      row('2026-04-14T14:00:00.000Z', 0.0002, 8000, 3000),
    ];
    const f = engineerNopeFeatures(rows, DATE);
    // Invalid 'NaN' gets filtered from mean calc — mean is just 0.0002
    expect(f.nope_am_mean).toBeCloseTo(0.0002, 10);
    // cum_delta uses call_delta − put_delta from BOTH rows (numeric parse ok)
    expect(f.nope_am_cum_delta).toBe(5000 + 5000);
  });
});
