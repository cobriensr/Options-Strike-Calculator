import { describe, it, expect } from 'vitest';
import {
  computeVolumeDelta,
  distFromSpot,
  findMagnets,
  rankByVolume,
} from '../../utils/volume-per-strike';
import type {
  VolumePerStrikeRow,
  VolumePerStrikeSnapshot,
} from '../../types/api';

// ── Fixture builders ─────────────────────────────────────────

function makeRow(
  strike: number,
  overrides: Partial<VolumePerStrikeRow> = {},
): VolumePerStrikeRow {
  return {
    strike,
    callVolume: 0,
    putVolume: 0,
    callOi: 0,
    putOi: 0,
    ...overrides,
  };
}

function makeSnapshot(
  timestamp: string,
  strikes: VolumePerStrikeRow[],
): VolumePerStrikeSnapshot {
  return { timestamp, strikes };
}

/**
 * Build a sequence of snapshots where a single strike's fields follow the
 * provided per-snapshot values. Useful for delta testing.
 */
function explicitSeries(
  strike: number,
  callVolumes: number[],
  putVolumes: number[],
): VolumePerStrikeSnapshot[] {
  const len = Math.max(callVolumes.length, putVolumes.length);
  const snapshots: VolumePerStrikeSnapshot[] = [];
  for (let i = 0; i < len; i++) {
    const row = makeRow(strike, {
      callVolume: callVolumes[i] ?? 0,
      putVolume: putVolumes[i] ?? 0,
    });
    snapshots.push(
      makeSnapshot(new Date(Date.UTC(2026, 3, 7, 20, i, 0)).toISOString(), [
        row,
      ]),
    );
  }
  return snapshots;
}

// ── findMagnets ─────────────────────────────────────────────

describe('findMagnets', () => {
  it('returns nulls for an empty snapshot', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', []);
    expect(findMagnets(snap)).toEqual({
      maxCallStrike: null,
      maxPutStrike: null,
    });
  });

  it('returns nulls for a null snapshot', () => {
    expect(findMagnets(null)).toEqual({
      maxCallStrike: null,
      maxPutStrike: null,
    });
  });

  it('returns nulls for an undefined snapshot', () => {
    expect(findMagnets(undefined)).toEqual({
      maxCallStrike: null,
      maxPutStrike: null,
    });
  });

  it('returns the same strike for call and put when only one strike exists', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6620, { callVolume: 500, putVolume: 300 }),
    ]);
    expect(findMagnets(snap)).toEqual({
      maxCallStrike: 6620,
      maxPutStrike: 6620,
    });
  });

  it('picks different strikes for call-max and put-max', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 100, putVolume: 2000 }),
      makeRow(6615, { callVolume: 800, putVolume: 900 }),
      makeRow(6620, { callVolume: 1500, putVolume: 200 }),
    ]);
    expect(findMagnets(snap)).toEqual({
      maxCallStrike: 6620,
      maxPutStrike: 6610,
    });
  });

  it('breaks call-side ties by picking the LOWER strike', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 1000, putVolume: 0 }),
      makeRow(6615, { callVolume: 1000, putVolume: 0 }),
      makeRow(6620, { callVolume: 1000, putVolume: 0 }),
    ]);
    expect(findMagnets(snap).maxCallStrike).toBe(6610);
  });

  it('breaks put-side ties by picking the LOWER strike', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 0, putVolume: 750 }),
      makeRow(6615, { callVolume: 0, putVolume: 750 }),
      makeRow(6620, { callVolume: 0, putVolume: 750 }),
    ]);
    expect(findMagnets(snap).maxPutStrike).toBe(6610);
  });

  it('returns the lowest strike when all volumes are zero (not nulls)', () => {
    // Pre-open / pre-trade state: snapshot exists with strikes but nothing
    // has traded yet. Documents the subtle `0 > -Infinity` seeding behavior
    // so a future reader doesn't mistake this for a bug.
    const snap = makeSnapshot('2026-04-07T13:29:59Z', [
      makeRow(6610),
      makeRow(6615),
      makeRow(6620),
    ]);
    expect(findMagnets(snap)).toEqual({
      maxCallStrike: 6610,
      maxPutStrike: 6610,
    });
  });
});

// ── rankByVolume ────────────────────────────────────────────

describe('rankByVolume', () => {
  it('returns an empty array for an empty snapshot', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', []);
    expect(rankByVolume(snap, 5)).toEqual([]);
  });

  it('returns an empty array for null/undefined snapshots', () => {
    expect(rankByVolume(null, 5)).toEqual([]);
    expect(rankByVolume(undefined, 5)).toEqual([]);
  });

  it('returns an empty array when topN is zero or negative', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6615, { callVolume: 1000 }),
    ]);
    expect(rankByVolume(snap, 0)).toEqual([]);
    expect(rankByVolume(snap, -3)).toEqual([]);
  });

  it('returns all strikes sorted when topN exceeds strike count', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 100, putVolume: 50 }),
      makeRow(6615, { callVolume: 500, putVolume: 300 }),
      makeRow(6620, { callVolume: 200, putVolume: 1200 }),
    ]);
    const ranked = rankByVolume(snap, 10);
    expect(ranked).toHaveLength(3);
    // Max-per-side keys: 6610 → 100, 6615 → 500, 6620 → 1200
    expect(ranked.map((r) => r.strike)).toEqual([6620, 6615, 6610]);
  });

  it('returns exactly topN when topN is smaller than strike count', () => {
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6605, { callVolume: 50 }),
      makeRow(6610, { callVolume: 100 }),
      makeRow(6615, { callVolume: 500 }),
      makeRow(6620, { callVolume: 200 }),
      makeRow(6625, { callVolume: 900 }),
    ]);
    const ranked = rankByVolume(snap, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.strike)).toEqual([6625, 6615]);
  });

  it('ranks by max(call, put) — one side dominates for some strikes', () => {
    // 6610: put-heavy (1500), 6615: call-heavy (1200), 6620: balanced (400/400),
    // 6625: call-heavy (900). Max-per-side keys: 1500, 1200, 900, 400.
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 50, putVolume: 1500 }),
      makeRow(6615, { callVolume: 1200, putVolume: 100 }),
      makeRow(6620, { callVolume: 400, putVolume: 400 }),
      makeRow(6625, { callVolume: 900, putVolume: 10 }),
    ]);
    const ranked = rankByVolume(snap, 4);
    expect(ranked.map((r) => r.strike)).toEqual([6610, 6615, 6625, 6620]);
  });

  it('does NOT mutate the input snapshot', () => {
    const strikes: VolumePerStrikeRow[] = [
      makeRow(6610, { callVolume: 100 }),
      makeRow(6615, { callVolume: 900 }),
      makeRow(6620, { callVolume: 300 }),
    ];
    const snap = makeSnapshot('2026-04-07T20:00:00Z', strikes);
    const originalOrder = snap.strikes.map((r) => r.strike);
    rankByVolume(snap, 3);
    expect(snap.strikes.map((r) => r.strike)).toEqual(originalOrder);
  });

  it('preserves ascending-strike order for equal max values (stable tie-break)', () => {
    // Three strikes with identical max-per-side keys (500).
    // Stable sort should preserve the input order (ascending by strike).
    const snap = makeSnapshot('2026-04-07T20:00:00Z', [
      makeRow(6610, { callVolume: 500, putVolume: 100 }),
      makeRow(6615, { callVolume: 500, putVolume: 200 }),
      makeRow(6620, { callVolume: 500, putVolume: 300 }),
    ]);
    const ranked = rankByVolume(snap, 3);
    expect(ranked.map((r) => r.strike)).toEqual([6610, 6615, 6620]);
  });
});

// ── computeVolumeDelta ──────────────────────────────────────

describe('computeVolumeDelta', () => {
  it('returns null when snapshots has fewer than offsetSlots + 1 entries', () => {
    // 5 snapshots, need 6 for offsetSlots=5
    const snaps = explicitSeries(
      6615,
      [100, 120, 140, 160, 180],
      [0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 6615, 'call', 5)).toBeNull();
  });

  it('returns a value at the exact boundary (length === offsetSlots + 1)', () => {
    // 6 snapshots, offsetSlots=5 → past = snapshots[0] (100), now =
    // snapshots[5] (200). Boundary check for the `length < offset + 1`
    // guard — confirms the guard is exclusive and index 0 is reachable.
    const snaps = explicitSeries(
      6615,
      [100, 120, 140, 160, 180, 200],
      [0, 0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 6615, 'call', 5)).toBeCloseTo(100, 5);
  });

  it('returns null when the strike is not in the reference snapshot', () => {
    // Strike 6615 appears in every snapshot, but we query for a strike
    // that does not exist anywhere in the series.
    const snaps = explicitSeries(
      6615,
      [100, 200, 300, 400, 500, 600],
      [0, 0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 9999, 'call', 5)).toBeNull();
  });

  it('returns null when the past (reference) value is zero', () => {
    // past = index (6 - 1 - 5) = 0 → value 0, now = 500
    const snaps = explicitSeries(
      6615,
      [0, 100, 200, 300, 400, 500],
      [0, 0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 6615, 'call', 5)).toBeNull();
  });

  it('computes call-metric 5-min delta correctly', () => {
    // past = 100, now = 150 → +50%
    const snaps = explicitSeries(
      6615,
      [100, 110, 120, 130, 140, 150],
      [0, 0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 6615, 'call', 5)).toBeCloseTo(50, 5);
  });

  it('computes put-metric 5-min delta correctly', () => {
    // past = 200, now = 500 → +150%
    const snaps = explicitSeries(
      6615,
      [0, 0, 0, 0, 0, 0],
      [200, 250, 300, 350, 400, 500],
    );
    expect(computeVolumeDelta(snaps, 6615, 'put', 5)).toBeCloseTo(150, 5);
  });

  it('computes total-metric (call+put) 5-min delta correctly', () => {
    // past total = 100 + 200 = 300, now total = 300 + 600 = 900 → +200%
    const snaps = explicitSeries(
      6615,
      [100, 140, 180, 220, 260, 300],
      [200, 280, 360, 440, 520, 600],
    );
    expect(computeVolumeDelta(snaps, 6615, 'total', 5)).toBeCloseTo(200, 5);
  });

  it('produces negative deltas when volume decreases', () => {
    // past = 1000, now = 400 → -60%
    // (Unusual in volume data — cumulative counts — but possible after
    // contract expiry mid-day, so the math must handle it.)
    const snaps = explicitSeries(
      6615,
      [1000, 900, 800, 700, 600, 400],
      [0, 0, 0, 0, 0, 0],
    );
    expect(computeVolumeDelta(snaps, 6615, 'call', 5)).toBeCloseTo(-60, 5);
  });
});

// ── distFromSpot ────────────────────────────────────────────

describe('distFromSpot', () => {
  it('is positive when the strike is above spot', () => {
    expect(distFromSpot(6625, 6615)).toBe(10);
  });

  it('is negative when the strike is below spot', () => {
    expect(distFromSpot(6605, 6615)).toBe(-10);
  });

  it('is zero when the strike equals spot', () => {
    expect(distFromSpot(6615, 6615)).toBe(0);
  });
});
