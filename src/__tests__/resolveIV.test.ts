import { describe, it, expect } from 'vitest';
import { resolveIV } from '../utils/calculator';
import { DEFAULTS } from '../constants';

describe('resolveIV: VIX mode', () => {
  it('converts VIX 20 with default multiplier 1.15 to σ = 0.23', () => {
    const result = resolveIV('vix', { vix: 20, multiplier: 1.15 });
    expect(result.sigma).toBeCloseTo(0.23, 6);
    expect(result.error).toBeUndefined();
  });

  it('converts VIX 20 with multiplier 1.0 to σ = 0.20 (no adjustment)', () => {
    const result = resolveIV('vix', { vix: 20, multiplier: 1 });
    expect(result.sigma).toBeCloseTo(0.2, 6);
  });

  it('converts VIX 19 with multiplier 1.15 to σ = 0.2185', () => {
    const result = resolveIV('vix', { vix: 19, multiplier: 1.15 });
    expect(result.sigma).toBeCloseTo(0.2185, 4);
  });

  it('converts VIX 30 with multiplier 1.20 to σ = 0.36', () => {
    const result = resolveIV('vix', { vix: 30, multiplier: 1.2 });
    expect(result.sigma).toBeCloseTo(0.36, 6);
  });

  it('converts VIX 10 with multiplier 1.10 to σ = 0.11', () => {
    const result = resolveIV('vix', { vix: 10, multiplier: 1.1 });
    expect(result.sigma).toBeCloseTo(0.11, 6);
  });

  // Edge cases
  it('rejects VIX = 0', () => {
    const result = resolveIV('vix', { vix: 0, multiplier: 1.15 });
    expect(result.sigma).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects negative VIX', () => {
    const result = resolveIV('vix', { vix: -5, multiplier: 1.15 });
    expect(result.sigma).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects NaN VIX', () => {
    const result = resolveIV('vix', { vix: Number.NaN, multiplier: 1.15 });
    expect(result.sigma).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects undefined VIX', () => {
    const result = resolveIV('vix', { multiplier: 1.15 });
    expect(result.sigma).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('rejects multiplier below minimum', () => {
    const result = resolveIV('vix', { vix: 20, multiplier: 0.9 });
    expect(result.sigma).toBeNull();
    expect(result.error).toContain(String(DEFAULTS.IV_PREMIUM_MIN));
  });

  it('rejects multiplier above maximum', () => {
    const result = resolveIV('vix', { vix: 20, multiplier: 2.5 });
    expect(result.sigma).toBeNull();
    expect(result.error).toContain(String(DEFAULTS.IV_PREMIUM_MAX));
  });

  it('accepts multiplier at exact minimum boundary', () => {
    const result = resolveIV('vix', {
      vix: 20,
      multiplier: DEFAULTS.IV_PREMIUM_MIN,
    });
    expect(result.sigma).toBeCloseTo(0.2, 6);
    expect(result.error).toBeUndefined();
  });

  it('accepts multiplier at exact maximum boundary', () => {
    const result = resolveIV('vix', {
      vix: 20,
      multiplier: DEFAULTS.IV_PREMIUM_MAX,
    });
    // 20 * 2.0 / 100 = 0.40
    expect(result.sigma).toBeCloseTo(0.4, 6);
    expect(result.error).toBeUndefined();
  });

  it('rejects NaN multiplier', () => {
    const result = resolveIV('vix', { vix: 20, multiplier: Number.NaN });
    expect(result.sigma).toBeNull();
  });

  it('rejects undefined multiplier', () => {
    const result = resolveIV('vix', { vix: 20 });
    expect(result.sigma).toBeNull();
  });
});

describe('resolveIV: Direct mode', () => {
  it('passes through σ = 0.22 directly', () => {
    const result = resolveIV('direct', { directIV: 0.22 });
    expect(result.sigma).toBe(0.22);
    expect(result.error).toBeUndefined();
  });

  it('passes through σ = 0.05 (low IV)', () => {
    const result = resolveIV('direct', { directIV: 0.05 });
    expect(result.sigma).toBe(0.05);
  });

  it('passes through σ = 1.5 (extreme but valid)', () => {
    const result = resolveIV('direct', { directIV: 1.5 });
    expect(result.sigma).toBe(1.5);
  });

  it('rejects σ > 2 with helpful error', () => {
    const result = resolveIV('direct', { directIV: 20 });
    expect(result.sigma).toBeNull();
    expect(result.error).toContain('decimal');
  });

  it('rejects σ = 0', () => {
    const result = resolveIV('direct', { directIV: 0 });
    expect(result.sigma).toBeNull();
  });

  it('rejects negative σ', () => {
    const result = resolveIV('direct', { directIV: -0.2 });
    expect(result.sigma).toBeNull();
  });

  it('rejects NaN', () => {
    const result = resolveIV('direct', { directIV: Number.NaN });
    expect(result.sigma).toBeNull();
  });

  it('rejects undefined', () => {
    const result = resolveIV('direct', {});
    expect(result.sigma).toBeNull();
  });
});

describe('resolveIV: Invalid mode', () => {
  it('returns error for unknown mode', () => {
    const result = resolveIV('unknown' as any, { vix: 20, multiplier: 1.15 });
    expect(result.sigma).toBeNull();
    expect(result.error).toBeDefined();
  });
});

describe('resolveIV: VIX and Direct produce same σ', () => {
  it('VIX 20 × 1.15 = direct 0.23', () => {
    const vixResult = resolveIV('vix', { vix: 20, multiplier: 1.15 });
    const directResult = resolveIV('direct', { directIV: 0.23 });
    expect(vixResult.sigma).toBeCloseTo(directResult.sigma!, 6);
  });
});
