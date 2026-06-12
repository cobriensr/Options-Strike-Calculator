/**
 * netflow-time-grid unit tests.
 *
 * Regression suite for the production blank-chart bug: one tick whose
 * `ts` fails Date.parse poisoned the minute grid (NaN map key → NaN
 * grid bounds → `for (t = NaN; t <= NaN; …)` emits nothing) and the
 * component then setData([])'d every flow series — silently wiping a
 * previously-full chart on every poll.
 *
 * Tick fixtures mirror the realistic shapes in TickerNetFlowChart.test.tsx
 * (ISO `ts` + cumulative values), mapped to grid Points exactly the way
 * the component does: `isoToUtcSec(ts) ?? NaN`.
 */

import { describe, it, expect } from 'vitest';
import type { UTCTimestamp } from 'lightweight-charts';
import {
  isoToUtcSec,
  sessionMinuteGrid,
  isDroppedTickTs,
} from '../components/charts/netflow-time-grid';
import type { Point } from '../components/charts/netflow-time-grid';

// ── Fixtures ──────────────────────────────────────────────────────────

/** Map a {ts, value} tick to a grid Point the way the component does. */
const toPoint = (ts: string, value: number): Point => ({
  time: (isoToUtcSec(ts) ?? Number.NaN) as UTCTimestamp,
  value,
});

// Realistic cumulative net-flow ticks (shape copied from the component
// test fixtures): ascending ISO timestamps on a 2026-05-08 session.
const healthyTicks: { ts: string; value: number }[] = [
  { ts: '2026-05-08T14:30:00Z', value: 100 },
  { ts: '2026-05-08T14:31:00Z', value: 200 },
  { ts: '2026-05-08T14:33:10Z', value: 250 },
];

const DATE = '2026-05-08';
// 2026-05-08 is CDT (UTC-5): 08:30 CT = 13:30Z, 15:00 CT = 20:00Z.
const openSec = Math.floor(Date.parse('2026-05-08T13:30:00Z') / 1000);
const closeSec = Math.floor(Date.parse('2026-05-08T20:00:00Z') / 1000);

const healthyPoints = (): Point[] =>
  healthyTicks.map((t) => toPoint(t.ts, t.value));

// ============================================================
// isoToUtcSec
// ============================================================

describe('isoToUtcSec', () => {
  it('returns whole UTC seconds for a valid ISO timestamp', () => {
    expect(isoToUtcSec('2026-05-08T14:30:00Z')).toBe(
      Math.floor(Date.parse('2026-05-08T14:30:00Z') / 1000),
    );
  });

  it('returns null when Date.parse is not finite', () => {
    expect(isoToUtcSec('garbage')).toBeNull();
    expect(isoToUtcSec('not-a-date')).toBeNull();
    expect(isoToUtcSec('')).toBeNull();
  });
});

// ============================================================
// isDroppedTickTs — the component's Sentry-sample predicate
// ============================================================

describe('isDroppedTickTs', () => {
  it('matches both drop classes when date bounds are available', () => {
    // Healthy in-session tick → kept.
    expect(isDroppedTickTs('2026-05-08T14:30:00Z', DATE)).toBe(false);
    // Unparsable → dropped.
    expect(isDroppedTickTs('not-a-date', DATE)).toBe(true);
    // Finite but outside the ±24h clamp (both directions) → dropped.
    expect(isDroppedTickTs('2001-01-01T12:00:00Z', DATE)).toBe(true);
    expect(isDroppedTickTs('2030-01-01T12:00:00Z', DATE)).toBe(true);
    // Within the 24h slack (pre-open print) → kept, like the grid.
    expect(isDroppedTickTs('2026-05-08T10:00:00Z', DATE)).toBe(false);
  });

  it('applies only the parse check without a date (no bounds → no clamp)', () => {
    expect(isDroppedTickTs('not-a-date')).toBe(true);
    expect(isDroppedTickTs('2001-01-01T12:00:00Z')).toBe(false);
  });
});

// ============================================================
// sessionMinuteGrid — NaN guarding
// ============================================================

describe('sessionMinuteGrid: healthy series (behavior unchanged)', () => {
  it('lays the full-session minute grid with the real ticks inside', () => {
    const { points, dropped } = sessionMinuteGrid(healthyPoints(), DATE);
    expect(dropped).toBe(0);
    expect(points.length).toBeGreaterThanOrEqual(healthyTicks.length);
    expect(points[0]!.time).toBe(openSec);
    expect(points.at(-1)!.time).toBe(closeSec);
    // Real tick values survive at their minute slots.
    const valueAt = (iso: string) =>
      (
        points.find(
          (p) => p.time === Math.floor(Date.parse(iso) / 1000),
        ) as Point
      )?.value;
    expect(valueAt('2026-05-08T14:30:00Z')).toBe(100);
    expect(valueAt('2026-05-08T14:31:00Z')).toBe(200);
    expect(valueAt('2026-05-08T14:33:00Z')).toBe(250);
  });
});

describe('sessionMinuteGrid: one poisoned tick is dropped, grid intact', () => {
  it('produces the same grid as the healthy series and reports dropped=1', () => {
    const healthy = sessionMinuteGrid(healthyPoints(), DATE);

    // Same series with ONE poisoned tick inserted mid-stream.
    const poisoned: Point[] = [
      toPoint(healthyTicks[0]!.ts, healthyTicks[0]!.value),
      toPoint('not-a-date', 999),
      toPoint(healthyTicks[1]!.ts, healthyTicks[1]!.value),
      toPoint(healthyTicks[2]!.ts, healthyTicks[2]!.value),
    ];
    const result = sessionMinuteGrid(poisoned, DATE);

    expect(result.dropped).toBe(1);
    expect(result.points).toEqual(healthy.points);
    // Explicitly: NOT the production failure mode (empty wipe).
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points[0]!.time).toBe(openSec);
    expect(result.points.at(-1)!.time).toBe(closeSec);
  });

  it('never returns empty for a non-empty input with valid points (no date → dedup fallback)', () => {
    const poisoned: Point[] = [
      toPoint(healthyTicks[0]!.ts, healthyTicks[0]!.value),
      toPoint('not-a-date', 999),
      toPoint(healthyTicks[1]!.ts, healthyTicks[1]!.value),
    ];
    const { points, dropped } = sessionMinuteGrid(poisoned, undefined);
    expect(dropped).toBe(1);
    expect(points.length).toBe(2);
    expect(points.every((p) => Number.isFinite(p.time as number))).toBe(true);
  });
});

describe('sessionMinuteGrid: finitely-mis-parsed timestamps are range-clamped', () => {
  // V8's lenient Date.parse can read digit-bearing garbage (e.g.
  // 'garbage-1') as a FINITE far-away date — Jan 2001 — which passes a
  // pure finite-ness guard and would inflate the minute grid to ~13M
  // points (2001→today). Ticks outside [open−24h, close+24h] must be
  // dropped exactly like non-finite ones.
  const sessionSize = (closeSec - openSec) / 60 + 1;

  it('drops a valid-but-ancient tick; grid stays session-sized', () => {
    const healthy = sessionMinuteGrid(healthyPoints(), DATE);
    const poisoned: Point[] = [
      toPoint('2001-01-01T12:00:00Z', 999),
      ...healthyPoints(),
    ];
    const result = sessionMinuteGrid(poisoned, DATE);
    // Cheap assertion first: against unclamped code the grid here is
    // ~13M points and a deep compare on it would dominate the run.
    expect(result.dropped).toBe(1);
    expect(result.points.length).toBe(sessionSize);
    expect(result.points).toEqual(healthy.points);
  });

  it('drops a valid-but-far-future tick; grid stays session-sized', () => {
    const healthy = sessionMinuteGrid(healthyPoints(), DATE);
    const poisoned: Point[] = [
      ...healthyPoints(),
      toPoint('2030-01-01T12:00:00Z', 888),
    ];
    const result = sessionMinuteGrid(poisoned, DATE);
    expect(result.dropped).toBe(1);
    expect(result.points.length).toBe(sessionSize);
    expect(result.points).toEqual(healthy.points);
  });

  it('keeps legitimate near-session out-of-bounds prints (within 24h slack)', () => {
    // Pre-open prints a few hours before the 08:30 CT open are real data
    // — the grid has always extended to include them. The clamp must not
    // eat them.
    const preOpen = toPoint('2026-05-08T10:00:00Z', 5); // 05:00 CT
    const result = sessionMinuteGrid([preOpen, ...healthyPoints()], DATE);
    expect(result.dropped).toBe(0);
    expect(
      result.points.some((p) => p.time === preOpen.time && 'value' in p),
    ).toBe(true);
  });
});

describe('sessionMinuteGrid: all ticks poisoned', () => {
  it('returns empty points + dropped=N without throwing', () => {
    // NOTE: invalid fixtures must be digit-free — V8's lenient Date.parse
    // reads 'garbage-1' as Jan 2001 (finite!), which is a different
    // failure class than the NaN poisoning under test here.
    const allBad: Point[] = [
      toPoint('garbage', 10),
      toPoint('not-a-date', 20),
      toPoint('totally-bogus', 30),
    ];
    let result: ReturnType<typeof sessionMinuteGrid> | null = null;
    expect(() => {
      result = sessionMinuteGrid(allBad, DATE);
    }).not.toThrow();
    expect(result!.points).toEqual([]);
    expect(result!.dropped).toBe(3);
  });

  it('zero-valid is the ONLY case that may return empty (empty input too)', () => {
    const { points, dropped } = sessionMinuteGrid([], DATE);
    expect(points).toEqual([]);
    expect(dropped).toBe(0);
  });
});
