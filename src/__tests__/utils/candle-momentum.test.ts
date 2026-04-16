import { describe, it, expect } from 'vitest';
import {
  computeMomentum,
  EMPTY_MOMENTUM,
  signalLabel,
  signalColor,
} from '../../utils/candle-momentum';
import type { SPXCandle } from '../../hooks/useGexTarget';

/** Helper: build a candle with the given open/close. Range = |high - low|. */
function candle(
  open: number,
  close: number,
  opts?: { high?: number; low?: number; datetime?: number },
): SPXCandle {
  const hi = opts?.high ?? Math.max(open, close) + 1;
  const lo = opts?.low ?? Math.min(open, close) - 1;
  return {
    open,
    close,
    high: hi,
    low: lo,
    volume: 1000,
    datetime: opts?.datetime ?? Date.now(),
  };
}

describe('computeMomentum', () => {
  it('returns EMPTY_MOMENTUM for < 2 candles', () => {
    expect(computeMomentum([])).toEqual(EMPTY_MOMENTUM);
    expect(computeMomentum([candle(100, 101)])).toEqual(EMPTY_MOMENTUM);
  });

  it('computes positive ROC when price rises', () => {
    const candles = [candle(100, 101), candle(101, 105)];
    const m = computeMomentum(candles);
    expect(m.roc1).toBe(4); // 105 - 101
    // roc3/roc5: not enough history → safeClose falls back to latest close
    expect(m.roc3).toBe(0);
    expect(m.roc5).toBe(0);
  });

  it('computes negative ROC when price falls', () => {
    const candles = [candle(105, 104), candle(104, 100)];
    const m = computeMomentum(candles);
    expect(m.roc1).toBe(-4); // 100 - 104
  });

  describe('streak detection', () => {
    it('counts consecutive green candles as positive streak', () => {
      const candles = [
        candle(100, 102),
        candle(102, 104),
        candle(104, 106),
      ];
      const m = computeMomentum(candles);
      expect(m.streak).toBe(3);
    });

    it('counts consecutive red candles as negative streak', () => {
      const candles = [
        candle(106, 104),
        candle(104, 102),
        candle(102, 100),
      ];
      const m = computeMomentum(candles);
      expect(m.streak).toBe(-3);
    });

    it('breaks streak on direction change', () => {
      const candles = [
        candle(100, 102), // green
        candle(102, 100), // red
        candle(100, 98), // red
      ];
      const m = computeMomentum(candles);
      expect(m.streak).toBe(-2);
    });

    it('breaks streak on doji (close === open)', () => {
      const candles = [
        candle(100, 102),
        candle(102, 102), // doji
        candle(102, 104),
      ];
      const m = computeMomentum(candles);
      expect(m.streak).toBe(1); // only the last green counts
    });
  });

  describe('range expansion', () => {
    it('detects expanding ranges', () => {
      // Previous window: 5 candles with range 2 (high-low)
      const narrow = Array.from({ length: 5 }, (_, i) =>
        candle(100 + i, 101 + i, { high: 102 + i, low: 100 + i }),
      );
      // Current window: 5 candles with range 5 (> 2 * 1.2 = 2.4)
      const wide = Array.from({ length: 5 }, (_, i) =>
        candle(100 + i, 103 + i, { high: 105 + i, low: 100 + i }),
      );
      const m = computeMomentum([...narrow, ...wide]);
      expect(m.rangeExpanding).toBe(true);
    });

    it('does not flag contracting ranges', () => {
      // Previous window: wide ranges
      const wide = Array.from({ length: 5 }, (_, i) =>
        candle(100 + i, 103 + i, { high: 105 + i, low: 100 + i }),
      );
      // Current window: narrow ranges
      const narrow = Array.from({ length: 5 }, (_, i) =>
        candle(100 + i, 101 + i, { high: 102 + i, low: 100 + i }),
      );
      const m = computeMomentum([...wide, ...narrow]);
      expect(m.rangeExpanding).toBe(false);
    });
  });

  describe('acceleration', () => {
    it('is positive when ROC is increasing', () => {
      // c0: close=100, c1: close=101 (roc1=+1), c2: close=104 (roc1=+3)
      const candles = [candle(99, 100), candle(100, 101), candle(101, 104)];
      const m = computeMomentum(candles);
      // roc1 = 104-101 = 3, prevRoc1 = 101-100 = 1, acceleration = 2
      expect(m.acceleration).toBe(2);
    });

    it('is negative when ROC is decreasing', () => {
      // c0: close=100, c1: close=104 (roc1=+4), c2: close=105 (roc1=+1)
      const candles = [candle(99, 100), candle(100, 104), candle(104, 105)];
      const m = computeMomentum(candles);
      // roc1 = 105-104 = 1, prevRoc1 = 104-100 = 4, acceleration = -3
      expect(m.acceleration).toBe(-3);
    });
  });

  describe('signal classification', () => {
    it('classifies surge-down with 3+ red candles and expanding ranges', () => {
      // 5 narrow candles (previous range window — range = 3 each)
      const prev = Array.from({ length: 5 }, (_, i) =>
        candle(100 - i, 99 - i, { high: 101 - i, low: 98 - i }),
      );
      // 5 red candles with wider ranges (fills current RANGE_WINDOW — range = 8+ each)
      const surge = [
        candle(95, 92, { high: 96, low: 88 }),
        candle(92, 88, { high: 93, low: 85 }),
        candle(88, 84, { high: 89, low: 81 }),
        candle(84, 80, { high: 85, low: 77 }),
        candle(80, 75, { high: 81, low: 72 }),
      ];
      const m = computeMomentum([...prev, ...surge]);
      expect(m.signal).toBe('surge-down');
      expect(m.streak).toBeLessThanOrEqual(-3);
      expect(m.rangeExpanding).toBe(true);
    });

    it('classifies drift-up with 2 green candles', () => {
      const candles = [
        candle(100, 99), // red (breaks any prior streak)
        candle(99, 100),
        candle(100, 102),
      ];
      const m = computeMomentum(candles);
      expect(m.signal).toBe('drift-up');
    });

    it('classifies flat with no streak and small ROC', () => {
      const candles = [
        candle(100, 101), // green
        candle(101, 100), // red — breaks streak
      ];
      const m = computeMomentum(candles);
      expect(m.signal).toBe('flat');
    });
  });
});

describe('signalLabel', () => {
  it('returns correct labels', () => {
    expect(signalLabel('surge-up')).toContain('SURGE');
    expect(signalLabel('surge-down')).toContain('SURGE');
    expect(signalLabel('drift-up')).toContain('DRIFT');
    expect(signalLabel('flat')).toBe('FLAT');
  });
});

describe('signalColor', () => {
  it('returns green-ish for up signals', () => {
    expect(signalColor('surge-up')).toBe('#00e676');
    expect(signalColor('drift-up')).toBe('#69f0ae');
  });

  it('returns red-ish for down signals', () => {
    expect(signalColor('surge-down')).toBe('#ff5252');
    expect(signalColor('drift-down')).toBe('#ff8a80');
  });
});
