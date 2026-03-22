import { describe, it, expect } from 'vitest';
import { classifyOpeningRange } from '../../utils/classifiers';

describe('classifyOpeningRange', () => {
  // ---- Green zone: pctOfMedian < 0.4 ----

  it('returns green / RANGE INTACT for pctOfMedian = 0', () => {
    const result = classifyOpeningRange(0);
    expect(result.signal).toBe('green');
    expect(result.label).toBe('RANGE INTACT');
  });

  it('returns green / RANGE INTACT for pctOfMedian = 0.2', () => {
    const result = classifyOpeningRange(0.2);
    expect(result.signal).toBe('green');
    expect(result.label).toBe('RANGE INTACT');
  });

  it('returns green / RANGE INTACT for pctOfMedian = 0.39', () => {
    const result = classifyOpeningRange(0.39);
    expect(result.signal).toBe('green');
    expect(result.label).toBe('RANGE INTACT');
  });

  it('returns green advice about good conditions', () => {
    const result = classifyOpeningRange(0.1);
    expect(result.advice).toContain('Good conditions');
  });

  // ---- Yellow zone: 0.4 <= pctOfMedian < 0.65 ----

  it('returns yellow / MODERATE at exactly 0.4 (boundary)', () => {
    const result = classifyOpeningRange(0.4);
    expect(result.signal).toBe('yellow');
    expect(result.label).toBe('MODERATE');
  });

  it('returns yellow / MODERATE for pctOfMedian = 0.5', () => {
    const result = classifyOpeningRange(0.5);
    expect(result.signal).toBe('yellow');
    expect(result.label).toBe('MODERATE');
  });

  it('returns yellow / MODERATE for pctOfMedian = 0.64', () => {
    const result = classifyOpeningRange(0.64);
    expect(result.signal).toBe('yellow');
    expect(result.label).toBe('MODERATE');
  });

  it('returns yellow advice about tighter deltas', () => {
    const result = classifyOpeningRange(0.5);
    expect(result.advice).toContain('tighter deltas');
  });

  // ---- Red zone: pctOfMedian >= 0.65 ----

  it('returns red / RANGE EXHAUSTED at exactly 0.65 (boundary)', () => {
    const result = classifyOpeningRange(0.65);
    expect(result.signal).toBe('red');
    expect(result.label).toBe('RANGE EXHAUSTED');
  });

  it('returns red / RANGE EXHAUSTED for pctOfMedian = 0.8', () => {
    const result = classifyOpeningRange(0.8);
    expect(result.signal).toBe('red');
    expect(result.label).toBe('RANGE EXHAUSTED');
  });

  it('returns red / RANGE EXHAUSTED for pctOfMedian = 1.0', () => {
    const result = classifyOpeningRange(1.0);
    expect(result.signal).toBe('red');
    expect(result.label).toBe('RANGE EXHAUSTED');
  });

  it('returns red advice about elevated risk', () => {
    const result = classifyOpeningRange(0.9);
    expect(result.advice).toContain('elevated risk');
  });

  // ---- Extreme values ----

  it('handles negative pctOfMedian as green', () => {
    const result = classifyOpeningRange(-0.1);
    expect(result.signal).toBe('green');
  });

  it('handles pctOfMedian > 1.0 as red', () => {
    const result = classifyOpeningRange(2.5);
    expect(result.signal).toBe('red');
    expect(result.label).toBe('RANGE EXHAUSTED');
  });
});
