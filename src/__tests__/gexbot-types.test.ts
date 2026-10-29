import { describe, it, expect } from 'vitest';

import { deriveGammaSign, formatDte } from '../components/Gexbot/types';

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

  it('treats a zero zero_gamma as unknown, never "long" (no-volume sentinel)', () => {
    // GEXBot sends zero_gamma = 0 before any volume prints.
    expect(deriveGammaSign(5985, 0)).toBe('unknown');
    expect(deriveGammaSign(1, 0)).toBe('unknown');
    expect(deriveGammaSign(-1, 0)).toBe('unknown');
  });

  it('handles zero values without divide-by-zero or sign-flip surprises', () => {
    expect(deriveGammaSign(0, 0)).toBe('unknown');
    expect(deriveGammaSign(-1, 0)).toBe('unknown');
  });

  it('handles negative spot/zero_gamma consistently (sign comparison only)', () => {
    // VIX zero-gamma can never be negative in practice, but the
    // helper should still behave deterministically.
    expect(deriveGammaSign(-10, -20)).toBe('long');
    expect(deriveGammaSign(-20, -10)).toBe('short');
  });
});

describe('formatDte', () => {
  it('formats the per-ticker nearest expiry', () => {
    expect(formatDte(0)).toBe('0DTE');
    expect(formatDte(2)).toBe('2DTE');
  });

  it('does not assume 0DTE when min_dte is missing', () => {
    expect(formatDte(null)).toBe('DTE n/a');
    expect(formatDte(undefined)).toBe('DTE n/a');
  });
});
