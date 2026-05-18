import { describe, expect, it } from 'vitest';
import {
  deltaFromAtFire,
  flowBadge,
  tideBadge,
} from '../../utils/macro-badges.js';

describe('deltaFromAtFire', () => {
  it('returns NCP - NPP when both are finite', () => {
    expect(deltaFromAtFire(5_000_000, 2_000_000)).toBe(3_000_000);
    expect(deltaFromAtFire(1_000_000, 4_000_000)).toBe(-3_000_000);
  });

  it('returns 0 for equal values', () => {
    expect(deltaFromAtFire(1_000_000, 1_000_000)).toBe(0);
  });

  it('returns null when either input is null/undefined', () => {
    expect(deltaFromAtFire(null, 1_000_000)).toBeNull();
    expect(deltaFromAtFire(1_000_000, null)).toBeNull();
    expect(deltaFromAtFire(null, null)).toBeNull();
    expect(deltaFromAtFire(undefined, 1_000_000)).toBeNull();
  });

  it('returns null when either input is NaN or Infinity', () => {
    expect(deltaFromAtFire(Number.NaN, 1_000_000)).toBeNull();
    expect(deltaFromAtFire(1_000_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('tideBadge', () => {
  it('returns null when diff is null', () => {
    expect(tideBadge(null)).toBeNull();
  });

  it('returns up arrow + green for positive diff', () => {
    const v = tideBadge(1_000_000);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide ⬆');
    expect(v!.cls).toContain('green');
  });

  it('returns down arrow + red for negative diff', () => {
    const v = tideBadge(-1_000_000);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide ⬇');
    expect(v!.cls).toContain('red');
  });

  it('returns neutral arrow for zero', () => {
    const v = tideBadge(0);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide →');
    expect(v!.cls).toContain('neutral');
  });

  it('tooltip mentions fire-time market tide source', () => {
    const v = tideBadge(1_000_000);
    expect(v!.tooltip).toMatch(/market tide/i);
    expect(v!.tooltip).toMatch(/spike-bucket|fire/i);
  });
});

describe('flowBadge', () => {
  it('returns null when diff is null', () => {
    expect(flowBadge(null)).toBeNull();
  });

  it('returns Flow ⬆ + green for positive diff', () => {
    const v = flowBadge(2_000_000);
    expect(v!.label).toBe('Flow ⬆');
    expect(v!.cls).toContain('green');
  });

  it('returns Flow ⬇ + red for negative diff', () => {
    const v = flowBadge(-2_000_000);
    expect(v!.label).toBe('Flow ⬇');
    expect(v!.cls).toContain('red');
  });

  it('returns Flow → for zero', () => {
    const v = flowBadge(0);
    expect(v!.label).toBe('Flow →');
    expect(v!.cls).toContain('neutral');
  });

  it('tooltip mentions fire-time + sign-only + per-ticker', () => {
    const v = flowBadge(2_000_000);
    expect(v!.tooltip).toMatch(/fire time/i);
    expect(v!.tooltip).toMatch(/sign-only/i);
    expect(v!.tooltip).toMatch(/per-ticker|net flow/i);
  });
});
