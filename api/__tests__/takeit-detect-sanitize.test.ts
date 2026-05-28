import { describe, it, expect } from 'vitest';
import { sanitizeScoringInputs } from '../_lib/takeit-detect.js';

describe('sanitizeScoringInputs', () => {
  it('preserves finite numbers and nulls unchanged', () => {
    const input = { dte: 0, vol_oi: 0.5, ask_pct: null };
    expect(sanitizeScoringInputs(input)).toEqual(input);
  });

  it('replaces NaN with null (cannot route safely through trees)', () => {
    const result = sanitizeScoringInputs({ dte: Number.NaN, vol_oi: 0.5 });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBe(0.5);
  });

  it('replaces +Infinity and -Infinity with null', () => {
    const result = sanitizeScoringInputs({
      dte: Number.POSITIVE_INFINITY,
      vol_oi: Number.NEGATIVE_INFINITY,
    });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBeNull();
  });

  it('returns the count of fields that were sanitized', () => {
    const { sanitized, rejectedCount } = sanitizeScoringInputs(
      { a: Number.NaN, b: 0.5, c: Number.POSITIVE_INFINITY, d: null },
      { withRejectedCount: true },
    );
    expect(rejectedCount).toBe(2);
    expect(sanitized.a).toBeNull();
    expect(sanitized.b).toBe(0.5);
    expect(sanitized.c).toBeNull();
    expect(sanitized.d).toBeNull();
  });
});
