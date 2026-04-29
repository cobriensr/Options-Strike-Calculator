import { describe, expect, it } from 'vitest';
import {
  STALE_FRESHNESS_MIN,
  STALE_PROGRESS_PCT,
  computePathShape,
} from '../_lib/path-shape.js';

const T0 = new Date('2026-04-29T14:00:00Z').getTime(); // detection
const NOW_FRESH = new Date('2026-04-29T14:10:00Z').getTime(); // 10 min later
const NOW_STALE = new Date('2026-04-29T14:35:00Z').getTime(); // 35 min later

describe('computePathShape', () => {
  it('reports zero progress when underlying has not moved', () => {
    const out = computePathShape(T0, 6500, 6510, 6500, NOW_FRESH);
    expect(out.progressPct).toBe(0);
    expect(out.freshnessMin).toBe(10);
    expect(out.isStale).toBe(false);
  });

  it('reports 100% progress when call underlying reaches strike', () => {
    const out = computePathShape(T0, 6500, 6510, 6510, NOW_FRESH);
    expect(out.progressPct).toBe(1);
    expect(out.isStale).toBe(false);
  });

  it('reports >100% when call underlying goes past strike', () => {
    const out = computePathShape(T0, 6500, 6510, 6520, NOW_FRESH);
    expect(out.progressPct).toBe(2);
    expect(out.isStale).toBe(false);
  });

  it('reports negative progress when call underlying moves away', () => {
    const out = computePathShape(T0, 6500, 6510, 6490, NOW_FRESH);
    expect(out.progressPct).toBe(-1);
    expect(out.isStale).toBe(false); // young alert; not stale yet
  });

  it('handles puts (strike below spot, want price down)', () => {
    // Detection: spot 6500, strike 6490 (put strike below spot)
    // Underlying drops to 6493 → progress = (6493-6500) / (6490-6500) = 0.7
    const out = computePathShape(T0, 6500, 6490, 6493, NOW_FRESH);
    expect(out.progressPct).toBeCloseTo(0.7, 5);
  });

  it('flags stale when freshness > threshold AND progress < threshold', () => {
    // 35 min old, only 10% progress → stale
    const out = computePathShape(T0, 6500, 6510, 6501, NOW_STALE);
    expect(out.freshnessMin).toBe(35);
    expect(out.progressPct).toBeCloseTo(0.1, 5);
    expect(out.isStale).toBe(true);
  });

  it('does NOT flag stale when alert is old but progress is meaningful', () => {
    // 35 min old but 50% progress → still tradeable, not stale
    const out = computePathShape(T0, 6500, 6510, 6505, NOW_STALE);
    expect(out.progressPct).toBeCloseTo(0.5, 5);
    expect(out.isStale).toBe(false);
  });

  it('does NOT flag stale when alert is young, regardless of progress', () => {
    const out = computePathShape(T0, 6500, 6510, 6500, NOW_FRESH);
    expect(out.freshnessMin).toBeLessThan(STALE_FRESHNESS_MIN);
    expect(out.isStale).toBe(false);
  });

  it('returns null progress + non-stale when current spot is null', () => {
    const out = computePathShape(T0, 6500, 6510, null, NOW_STALE);
    expect(out.progressPct).toBeNull();
    expect(out.isStale).toBe(false);
  });

  it('returns null progress + non-stale when strike == spot_at_detect', () => {
    const out = computePathShape(T0, 6500, 6500, 6505, NOW_FRESH);
    expect(out.progressPct).toBeNull();
    expect(out.isStale).toBe(false);
  });

  it('clamps freshness to 0 if alertTs is in the future (clock skew)', () => {
    const futureTs = NOW_FRESH + 60_000;
    const out = computePathShape(futureTs, 6500, 6510, 6500, NOW_FRESH);
    expect(out.freshnessMin).toBe(0);
  });

  it('uses the documented 0.25 progress threshold for stale check', () => {
    // 35 min old, exactly at threshold → NOT stale (strict <)
    const atThreshold = computePathShape(
      T0,
      6500,
      6510,
      6500 + 10 * STALE_PROGRESS_PCT,
      NOW_STALE,
    );
    expect(atThreshold.progressPct).toBeCloseTo(STALE_PROGRESS_PCT, 5);
    expect(atThreshold.isStale).toBe(false);

    // Just under threshold → stale
    const justUnder = computePathShape(
      T0,
      6500,
      6510,
      6500 + 10 * (STALE_PROGRESS_PCT - 0.01),
      NOW_STALE,
    );
    expect(justUnder.isStale).toBe(true);
  });
});
