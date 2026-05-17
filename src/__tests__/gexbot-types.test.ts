import { describe, it, expect } from 'vitest';

import { deriveGammaSign } from '../components/Gexbot/types';

describe('deriveGammaSign', () => {
  it('returns "long" when spot > zero_gamma', () => {
    expect(deriveGammaSign(22, 20)).toBe('long');
    expect(deriveGammaSign(5995.5, 5980)).toBe('long');
  });

  it('returns "short" when spot < zero_gamma', () => {
    expect(deriveGammaSign(18, 20)).toBe('short');
    expect(deriveGammaSign(5950, 5980)).toBe('short');
  });

  it('returns "unknown" when spot === zero_gamma (exact crossing)', () => {
    expect(deriveGammaSign(20, 20)).toBe('unknown');
  });

  it('returns "unknown" when either input is null', () => {
    expect(deriveGammaSign(null, 20)).toBe('unknown');
    expect(deriveGammaSign(20, null)).toBe('unknown');
    expect(deriveGammaSign(null, null)).toBe('unknown');
  });

  it('handles zero values without divide-by-zero or sign-flip surprises', () => {
    expect(deriveGammaSign(0, 0)).toBe('unknown');
    expect(deriveGammaSign(1, 0)).toBe('long');
    expect(deriveGammaSign(-1, 0)).toBe('short');
  });

  it('handles negative spot/zero_gamma consistently (sign comparison only)', () => {
    // VIX zero-gamma can never be negative in practice, but the
    // helper should still behave deterministically.
    expect(deriveGammaSign(-10, -20)).toBe('long');
    expect(deriveGammaSign(-20, -10)).toBe('short');
  });
});
