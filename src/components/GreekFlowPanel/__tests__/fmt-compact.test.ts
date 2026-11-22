import { describe, it, expect } from 'vitest';
import { fmtCompact } from '../fmt-compact';

describe('fmtCompact', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1234, '1.2K'],
    [-1500, '-1.5K'],
    [4321, '4.3K'],
    [1_234_567, '1.2M'],
    [123_456_789, '123.5M'],
    [1_500_000_000, '1.5B'],
  ])('formats %d as %s', (n, expected) => {
    expect(fmtCompact(n)).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('renders %s as an em dash', (_name, n) => {
    expect(fmtCompact(n)).toBe('—');
  });
});
