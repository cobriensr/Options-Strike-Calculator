import { describe, it, expect } from 'vitest';
import { theme } from '../../themes';
import {
  classifyVix1dRatio,
  classifyVix9dRatio,
  classifyVvix,
} from '../../components/VIXTermStructure/classifiers';

// ============================================================
// classifyVix1dRatio
// ============================================================

describe('classifyVix1dRatio', () => {
  it('returns calm when ratio < 0.85', () => {
    const r = classifyVix1dRatio(0.7);
    expect(r).toEqual({
      ratio: 0.7,
      signal: 'calm',
      label: 'CALM',
      color: theme.green,
      advice: expect.stringContaining('quieter'),
    });
  });

  it('returns normal when ratio >= 0.85 and < 1.15', () => {
    const r = classifyVix1dRatio(1.0);
    expect(r.signal).toBe('normal');
    expect(r.label).toBe('NORMAL');
    expect(r.color).toBe(theme.accent);
  });

  it('returns elevated when ratio >= 1.15 and < 1.5', () => {
    const r = classifyVix1dRatio(1.3);
    expect(r.signal).toBe('elevated');
    expect(r.label).toBe('ELEVATED');
    expect(r.color).toBe(theme.caution);
    expect(r.advice).toContain('Widen');
  });

  it('returns extreme when ratio >= 1.5', () => {
    const r = classifyVix1dRatio(1.8);
    expect(r.signal).toBe('extreme');
    expect(r.label).toBe('EVENT RISK');
    expect(r.color).toBe(theme.red);
    expect(r.advice).toContain('sitting out');
  });

  it('preserves the input ratio in all results', () => {
    for (const v of [0.5, 0.85, 1.15, 2.0]) {
      expect(classifyVix1dRatio(v).ratio).toBe(v);
    }
  });

  // Boundary values
  it('classifies exactly 0.85 as normal (not calm)', () => {
    expect(classifyVix1dRatio(0.85).signal).toBe('normal');
  });

  it('classifies exactly 1.15 as elevated (not normal)', () => {
    expect(classifyVix1dRatio(1.15).signal).toBe('elevated');
  });

  it('classifies exactly 1.5 as extreme (not elevated)', () => {
    expect(classifyVix1dRatio(1.5).signal).toBe('extreme');
  });
});

// ============================================================
// classifyVix9dRatio
// ============================================================

describe('classifyVix9dRatio', () => {
  it('returns calm (contango) when ratio < 0.9', () => {
    const r = classifyVix9dRatio(0.8);
    expect(r).toEqual({
      ratio: 0.8,
      signal: 'calm',
      label: 'CONTANGO',
      color: theme.green,
      advice: expect.stringContaining('Favorable'),
    });
  });

  it('returns normal (flat) when ratio >= 0.9 and < 1.1', () => {
    const r = classifyVix9dRatio(1.0);
    expect(r.signal).toBe('normal');
    expect(r.label).toBe('FLAT');
    expect(r.color).toBe(theme.accent);
  });

  it('returns elevated (inverted) when ratio >= 1.1 and < 1.25', () => {
    const r = classifyVix9dRatio(1.15);
    expect(r.signal).toBe('elevated');
    expect(r.label).toBe('INVERTED');
    expect(r.color).toBe(theme.caution);
    expect(r.advice).toContain('Caution');
  });

  it('returns extreme (steep inversion) when ratio >= 1.25', () => {
    const r = classifyVix9dRatio(1.4);
    expect(r.signal).toBe('extreme');
    expect(r.label).toBe('STEEP INVERSION');
    expect(r.color).toBe(theme.red);
    expect(r.advice).toContain('Defensive');
  });

  it('preserves the input ratio in all results', () => {
    for (const v of [0.5, 0.9, 1.1, 1.5]) {
      expect(classifyVix9dRatio(v).ratio).toBe(v);
    }
  });

  // Boundary values
  it('classifies exactly 0.9 as normal (not calm)', () => {
    expect(classifyVix9dRatio(0.9).signal).toBe('normal');
  });

  it('classifies exactly 1.1 as elevated (not normal)', () => {
    expect(classifyVix9dRatio(1.1).signal).toBe('elevated');
  });

  it('classifies exactly 1.25 as extreme (not elevated)', () => {
    expect(classifyVix9dRatio(1.25).signal).toBe('extreme');
  });
});

// ============================================================
// classifyVvix
// ============================================================

describe('classifyVvix', () => {
  it('returns stable/calm when VVIX < 80', () => {
    const r = classifyVvix(70);
    expect(r).toEqual({
      value: 70,
      signal: 'calm',
      label: 'STABLE',
      color: theme.green,
      advice: expect.stringContaining('Favorable for selling premium'),
    });
  });

  it('returns normal when VVIX >= 80 and < 100', () => {
    const r = classifyVvix(90);
    expect(r.signal).toBe('normal');
    expect(r.label).toBe('NORMAL');
    expect(r.color).toBe(theme.accent);
  });

  it('returns elevated/unstable when VVIX >= 100 and < 120', () => {
    const r = classifyVvix(110);
    expect(r.signal).toBe('elevated');
    expect(r.label).toBe('UNSTABLE');
    expect(r.color).toBe(theme.caution);
    expect(r.advice).toContain('Tighten deltas');
  });

  it('returns extreme/danger when VVIX >= 120', () => {
    const r = classifyVvix(130);
    expect(r.signal).toBe('extreme');
    expect(r.label).toBe('DANGER');
    expect(r.color).toBe(theme.red);
    expect(r.advice).toContain('whipsaw');
  });

  it('preserves the input value in all results', () => {
    for (const v of [65, 85, 105, 135]) {
      expect(classifyVvix(v).value).toBe(v);
    }
  });

  // Boundary values
  it('classifies exactly 80 as normal (not stable)', () => {
    expect(classifyVvix(80).signal).toBe('normal');
  });

  it('classifies exactly 100 as elevated (not normal)', () => {
    expect(classifyVvix(100).signal).toBe('elevated');
  });

  it('classifies exactly 120 as extreme (not elevated)', () => {
    expect(classifyVvix(120).signal).toBe('extreme');
  });
});
