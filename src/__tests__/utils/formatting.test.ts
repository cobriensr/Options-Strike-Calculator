import { describe, it, expect } from 'vitest';
import {
  roundTo,
  round0,
  round1,
  round2,
  round4,
  snapToSpyHalf,
} from '../../utils/formatting';

describe('roundTo', () => {
  it('rounds to specified decimals (0, 1, 2, 3)', () => {
    expect(roundTo(3.14159, 0)).toBe(3);
    expect(roundTo(3.14159, 1)).toBe(3.1);
    expect(roundTo(3.14159, 2)).toBe(3.14);
    expect(roundTo(3.14159, 3)).toBe(3.142);
  });

  it('handles negative numbers', () => {
    expect(roundTo(-2.556, 2)).toBe(-2.56);
    expect(roundTo(-7.896, 1)).toBe(-7.9);
    expect(roundTo(-3.1, 0)).toBe(-3);
  });
});

describe('round0', () => {
  it('rounds to nearest integer', () => {
    expect(round0(3.2)).toBe(3);
    expect(round0(3.7)).toBe(4);
    expect(round0(10.0)).toBe(10);
  });

  it('rounds .5 up', () => {
    expect(round0(2.5)).toBe(3);
    expect(round0(0.5)).toBe(1);
  });

  it('handles negative numbers', () => {
    expect(round0(-1.4)).toBe(-1);
    expect(round0(-1.6)).toBe(-2);
  });
});

describe('round1', () => {
  it('rounds to 1 decimal place', () => {
    expect(round1(3.14)).toBe(3.1);
    expect(round1(2.75)).toBe(2.8);
    expect(round1(9.99)).toBe(10);
  });

  it('truncates beyond 1 decimal', () => {
    expect(round1(1.1234)).toBe(1.1);
    expect(round1(5.6789)).toBe(5.7);
  });
});

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(3.14159)).toBe(3.14);
    expect(round2(1.005)).toBe(1);
  });

  it('standard financial rounding case', () => {
    expect(round2(19.995)).toBe(20);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(99.999)).toBe(100);
  });
});

describe('round4', () => {
  it('rounds to 4 decimal places', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1.00005)).toBe(1.0001);
    expect(round4(3.14159265)).toBe(3.1416);
  });
});

describe('snapToSpyHalf', () => {
  it('snaps SPX strike to nearest SPY half-point', () => {
    // SPX 5650 / 10 → SPY 565.0
    expect(snapToSpyHalf(5650, 10)).toBe(565);
    // SPX 5675 / 10 → SPY 567.5
    expect(snapToSpyHalf(5675, 10)).toBe(567.5);
  });

  it('example: SPX 5700 / 10.1 → 564.5', () => {
    expect(snapToSpyHalf(5700, 10.1)).toBe(564.5);
  });

  it('handles exact divisions', () => {
    expect(snapToSpyHalf(5000, 10)).toBe(500);
    expect(snapToSpyHalf(5500, 10)).toBe(550);
    expect(snapToSpyHalf(6000, 10)).toBe(600);
  });
});
