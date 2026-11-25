import { describe, it, expect } from 'vitest';
import { openingRangeSignal } from '../../utils/opening-range-signal';

/**
 * The opening range's "percent consumed" and its signal: the range as a
 * percent of spot, over the day's median high-low percent, graded by
 * classifyOpeningRange (green under 0.4, yellow under 0.65, red from there).
 * useRangeAnalysis and the stored-row repair both call this one function.
 *
 * Inputs here use spot 10000 and a median of 2%, so a range of N points is
 * N / 10000 * 100 / 2 consumed: 80 points is exactly 0.4 and 130 exactly 0.65.
 */
const SPOT = 10000;
const LOW = 10000;

describe('openingRangeSignal: the grades at each boundary', () => {
  it.each([
    ['a tiny range', 10001, 0.005, 'GREEN'],
    ['just under 0.4', 10079.9, 0.3995, 'GREEN'],
    ['exactly 0.4 is the first MODERATE', 10080, 0.4, 'MODERATE'],
    ['just under 0.65', 10129.9, 0.6495, 'MODERATE'],
    ['exactly 0.65 is the first RED', 10130, 0.65, 'RED'],
    ['a big range', 10400, 2, 'RED'],
  ])('%s', (_label, high, consumed, signal) => {
    const reading = openingRangeSignal(high, LOW, SPOT, 2);

    expect(reading).not.toBeNull();
    expect(reading!.signal).toBe(signal);
    expect(reading!.consumed).toBeCloseTo(consumed, 10);
  });

  it('returns the exact float the live card computes at the boundaries', () => {
    // No rounding: 0.4 and 0.65 are the classifier's own thresholds.
    expect(openingRangeSignal(10080, LOW, SPOT, 2)!.consumed).toBe(0.4);
    expect(openingRangeSignal(10130, LOW, SPOT, 2)!.consumed).toBe(0.65);
  });
});

describe('openingRangeSignal: real rows', () => {
  it.each([
    // [label, high, low, spot, median, consumed, signal]
    ['a 1 pt range on SPX 5700', 5701, 5700, 5700, 0.88, 0.0199362, 'GREEN'],
    ['a 23 pt range', 5723, 5700, 5700, 0.88, 0.4585327, 'MODERATE'],
    ['a 40 pt range', 5740, 5700, 5700, 0.88, 0.7974482, 'RED'],
    ['a 100 pt range on SPX 6950', 7000, 6900, 6950, 1.2, 1.1990408, 'RED'],
  ])('%s', (_label, high, low, spot, median, consumed, signal) => {
    const reading = openingRangeSignal(high, low, spot, median);

    expect(reading!.signal).toBe(signal);
    expect(reading!.consumed).toBeCloseTo(consumed, 6);
  });
});

describe('openingRangeSignal: the median', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])(
    'a %s median is treated as 1, as the live card always has',
    (_l, median) => {
      // 40 points on 10000 is 0.4% of spot: 0.4 consumed at a median of 1.
      const reading = openingRangeSignal(10040, LOW, SPOT, median);

      expect(reading).toEqual({ consumed: 0.4, signal: 'MODERATE' });
    },
  );

  it.each([
    ['0', 0],
    ['negative', -1],
  ])('a median of %s consumes nothing, whatever the range', (_l, median) => {
    // No median to measure against: not an infinite or negative reading.
    expect(openingRangeSignal(10500, LOW, SPOT, median)).toEqual({
      consumed: 0,
      signal: 'GREEN',
    });
  });
});

describe('openingRangeSignal: ranges with no width', () => {
  it('a zero-width range consumes nothing and grades GREEN', () => {
    expect(openingRangeSignal(10000, 10000, SPOT, 2)).toEqual({
      consumed: 0,
      signal: 'GREEN',
    });
  });

  it('a reversed range (high under low) reads as negative consumed and GREEN, as the live code does', () => {
    const reading = openingRangeSignal(9900, 10000, SPOT, 2);

    expect(reading!.signal).toBe('GREEN');
    expect(reading!.consumed).toBeLessThan(0);
  });
});

// The caller (the live hook, or a repair of a stored row) may hold a range or a
// spot that is not a price: nothing is graded, and nothing throws.
describe('openingRangeSignal: inputs that are not a price', () => {
  it.each<[string, number, number, number]>([
    ['a high of 0', 0, LOW, SPOT],
    ['a negative high', -5, LOW, SPOT],
    ['a NaN high', Number.NaN, LOW, SPOT],
    ['a low of 0', 10080, 0, SPOT],
    ['a negative low', 10080, -1, SPOT],
    ['a NaN low', 10080, Number.NaN, SPOT],
    ['a spot of 0', 10080, LOW, 0],
    ['a NaN spot', 10080, LOW, Number.NaN],
  ])('%s gives null', (_label, high, low, spot) => {
    expect(openingRangeSignal(high, low, spot, 2)).toBeNull();
  });
});

// What the function does with inputs it does not reject. The live hook never
// reaches these, and a caller that reads a stored row checks `Number.isFinite`
// before it calls: the function reads a negative spot, an infinite high and a
// NaN median as they come, and these rows pin that so a change to `!!spot` or
// to the median guard does not slip through.
describe('openingRangeSignal: inputs it reads as they come', () => {
  it('a negative spot reads a negative consumed value and grades GREEN', () => {
    expect(openingRangeSignal(5723, 5700, -5700, 0.88)).toEqual({
      consumed: -0.4585326953748007,
      signal: 'GREEN',
    });
  });

  it.each<[string, number, number, number, number, number]>([
    ['two infinite prices', Infinity, Infinity, 10000, 2, Number.NaN],
    ['an infinite high', Infinity, 5700, 5700, 0.88, Infinity],
  ])(
    '%s read a non-finite consumed value and grade RED',
    (_label, high, low, spot, median, consumed) => {
      expect(openingRangeSignal(high, low, spot, median)).toEqual({
        consumed,
        signal: 'RED',
      });
    },
  );

  it('a NaN median consumes nothing, as a median of 0 does', () => {
    expect(openingRangeSignal(5723, 5700, 5700, Number.NaN)).toEqual({
      consumed: 0,
      signal: 'GREEN',
    });
  });
});
