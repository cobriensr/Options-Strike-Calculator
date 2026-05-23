// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  E1_HOLD_BARS,
  E5_BREAKDOWN_PTS,
  PCS_MAX_ABS_GEX,
  detectE1,
  detectE5,
  detectPcsMonday,
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  getDomFromEtDateStr,
  getDowLabel,
  type Bar,
  type DayContext,
  type DowLabel,
  type GammaNode,
} from '../_lib/gamma-detector.js';

const makeBar = (overrides: Partial<Bar> = {}): Bar => ({
  timestamp: new Date('2026-05-21T14:00:00Z'),
  open: 7400,
  high: 7402,
  low: 7398,
  close: 7401,
  ...overrides,
});

const makeDayContext = (overrides: Partial<DayContext> = {}): DayContext => ({
  today: '2026-05-21',
  dow_label: 'Monday',
  day_open: 7400,
  prior_close: 7390,
  open_gap_pct: 0.27, // > FLAT_GAP threshold
  prior_5d_ret: -0.015,
  prior_iv_rank: 30,
  pre_day_filter_fires: true,
  is_fomc_day: false,
  is_dom_1_5: false,
  is_dom_16_20: false,
  ...overrides,
});

describe('gamma-detector helpers', () => {
  describe('getDowLabel', () => {
    it('returns Monday for a Monday ET date', () => {
      // 2026-05-25 is a Monday in NY
      const d = new Date('2026-05-25T14:00:00Z');
      expect(getDowLabel(d)).toBe('Monday');
    });

    it('returns Friday for a Friday ET date', () => {
      // 2026-05-22 is a Friday in NY
      const d = new Date('2026-05-22T14:00:00Z');
      expect(getDowLabel(d)).toBe('Friday');
    });

    it('returns null on Saturday and Sunday', () => {
      const sat = new Date('2026-05-23T14:00:00Z');
      const sun = new Date('2026-05-24T14:00:00Z');
      expect(getDowLabel(sat)).toBeNull();
      expect(getDowLabel(sun)).toBeNull();
    });
  });

  describe('getConfidenceTier', () => {
    it('returns MAXIMUM for Monday + pre-day filter', () => {
      expect(getConfidenceTier('Monday', true)).toBe('MAXIMUM');
    });

    it('returns HIGH for Monday without pre-day filter', () => {
      expect(getConfidenceTier('Monday', false)).toBe('HIGH');
    });

    it('returns HIGH for Friday regardless of pre-day filter', () => {
      expect(getConfidenceTier('Friday', false)).toBe('HIGH');
      expect(getConfidenceTier('Friday', true)).toBe('HIGH');
    });

    it('returns MEDIUM for Tuesday/Wednesday/Thursday', () => {
      const mids: DowLabel[] = ['Tuesday', 'Wednesday', 'Thursday'];
      for (const dow of mids) {
        expect(getConfidenceTier(dow, false)).toBe('MEDIUM');
        expect(getConfidenceTier(dow, true)).toBe('MEDIUM');
      }
    });
  });

  describe('getDomFromEtDateStr', () => {
    it('extracts day-of-month from ISO date string', () => {
      expect(getDomFromEtDateStr('2026-05-01')).toBe(1);
      expect(getDomFromEtDateStr('2026-05-15')).toBe(15);
      expect(getDomFromEtDateStr('2026-12-31')).toBe(31);
    });
  });

  describe('findNearestFloorBelow / findNearestCeilingAbove', () => {
    const nodes: GammaNode[] = [
      { strike: 7380, value: 100_000 },
      { strike: 7400, value: 500_000 },
      { strike: 7420, value: 300_000 },
      { strike: 7440, value: 150_000 },
    ];

    it('finds highest strike below price', () => {
      const found = findNearestFloorBelow(nodes, 7410);
      expect(found?.strike).toBe(7400);
    });

    it('finds lowest strike above price', () => {
      const found = findNearestCeilingAbove(nodes, 7410);
      expect(found?.strike).toBe(7420);
    });

    it('returns null when no node exists below', () => {
      expect(findNearestFloorBelow(nodes, 7370)).toBeNull();
    });

    it('returns null when no node exists above', () => {
      expect(findNearestCeilingAbove(nodes, 7450)).toBeNull();
    });

    it('excludes nodes at exactly the price (strict comparison)', () => {
      expect(findNearestFloorBelow(nodes, 7400)?.strike).toBe(7380);
      expect(findNearestCeilingAbove(nodes, 7420)?.strike).toBe(7440);
    });
  });
});

describe('detectE1 — long-call breakthrough', () => {
  const node: GammaNode = { strike: 7400, value: 300_000 };

  // Build HOLD_BARS+1 bars: breakthrough at index 0, then HOLD bars
  // all closing above the node strike.
  const validSequence = (): Bar[] => [
    makeBar({ open: 7395, high: 7402, low: 7394, close: 7401 }),
    makeBar({ open: 7401, high: 7404, low: 7400.5, close: 7403 }),
    makeBar({ open: 7403, high: 7405, low: 7402, close: 7404 }),
    makeBar({ open: 7404, high: 7406, low: 7402, close: 7405 }),
  ];

  it('fires when breakthrough + 3-bar hold matches', () => {
    expect(validSequence().length).toBe(E1_HOLD_BARS + 1);
    const hit = detectE1(validSequence(), [node]);
    expect(hit).not.toBeNull();
    expect(hit?.node.strike).toBe(7400);
  });

  it('does not fire when any hold bar closes back below node', () => {
    const bars = validSequence();
    bars[2] = makeBar({ ...bars[2], close: 7399 }); // dropped below node
    const hit = detectE1(bars, [node]);
    expect(hit).toBeNull();
  });

  it('does not fire when breakthrough bar opened ABOVE the node', () => {
    const bars = validSequence();
    bars[0] = makeBar({ open: 7401, high: 7405, low: 7400, close: 7404 });
    const hit = detectE1(bars, [node]);
    expect(hit).toBeNull();
  });

  it('returns null when insufficient bars', () => {
    expect(detectE1([], [node])).toBeNull();
    expect(detectE1([makeBar()], [node])).toBeNull();
  });

  it('returns null when no positive-gamma node exists', () => {
    const hit = detectE1(validSequence(), []);
    expect(hit).toBeNull();
  });
});

describe('detectE5 — long-put failed-reversal', () => {
  const node: GammaNode = { strike: 7400, value: 200_000 };

  it('fires when a recent wick exists and current bar breaks below', () => {
    // Wick bar 5 minutes ago at 7400 floor: low pierced (7398), close back above (7402).
    // Current bar: low at 7396 = wick.low (7398) - 2 pts, beyond E5_BREAKDOWN_PTS.
    const bars: Bar[] = [
      makeBar({ open: 7405, high: 7406, low: 7404, close: 7405 }),
      makeBar({ open: 7405, high: 7405, low: 7398, close: 7402 }), // wick
      makeBar({ open: 7402, high: 7403, low: 7400, close: 7401 }),
      makeBar({ open: 7401, high: 7402, low: 7398.5, close: 7399 }),
      makeBar({ open: 7399, high: 7400, low: 7396, close: 7397 }), // breakdown
    ];
    const hit = detectE5(bars, [node]);
    expect(hit).not.toBeNull();
    expect(hit?.wickBar.low).toBe(7398);
    expect(hit?.breakBar.low).toBe(7396);
  });

  it('does not fire when current bar low is only marginally below wick low', () => {
    const bars: Bar[] = [
      makeBar({ open: 7405, high: 7405, low: 7398, close: 7402 }), // wick
      makeBar({
        open: 7402,
        high: 7403,
        low: 7397.5, // only 0.5 below — under E5_BREAKDOWN_PTS (1.0)
        close: 7400,
      }),
    ];
    expect(E5_BREAKDOWN_PTS).toBe(1.0);
    const hit = detectE5(bars, [node]);
    expect(hit).toBeNull();
  });

  it('does not fire without a qualifying wick in lookback', () => {
    // No wick (all bars stay clear of the node).
    const bars: Bar[] = [
      makeBar({ open: 7405, high: 7406, low: 7404, close: 7405 }),
      makeBar({ open: 7405, high: 7405, low: 7395, close: 7396 }), // close below = no wick
    ];
    const hit = detectE5(bars, [node]);
    expect(hit).toBeNull();
  });
});

describe('detectPcsMonday', () => {
  const node: GammaNode = { strike: 7400, value: 100_000 }; // small wall
  const bigNode: GammaNode = { strike: 7400, value: 2_000_000 }; // big wall

  const wickBar = makeBar({
    open: 7405,
    high: 7406,
    low: 7398,
    close: 7402, // wick pierces 7400 floor and closes back above
  });

  it('fires on Monday with small wall + ES basis + non-flat gap', () => {
    const ctx = makeDayContext({ dow_label: 'Monday', open_gap_pct: 0.5 });
    const hit = detectPcsMonday([wickBar], [node], ctx, 1.0); // ES basis ok
    expect(hit).not.toBeNull();
    expect(hit?.node.strike).toBe(7400);
  });

  it('does not fire on Tuesday', () => {
    const ctx = makeDayContext({ dow_label: 'Tuesday' });
    expect(detectPcsMonday([wickBar], [node], ctx, 1.0)).toBeNull();
  });

  it('does not fire on flat-gap day', () => {
    const ctx = makeDayContext({ open_gap_pct: 0.05 });
    expect(detectPcsMonday([wickBar], [node], ctx, 1.0)).toBeNull();
  });

  it('does not fire when wall is too large', () => {
    const ctx = makeDayContext();
    expect(Math.abs(bigNode.value)).toBeGreaterThan(PCS_MAX_ABS_GEX);
    expect(detectPcsMonday([wickBar], [bigNode], ctx, 1.0)).toBeNull();
  });

  it('does not fire when ES basis is weak', () => {
    const ctx = makeDayContext();
    expect(detectPcsMonday([wickBar], [node], ctx, -0.1)).toBeNull();
  });

  it('fires when ES basis is null (passthrough — basis filter skipped)', () => {
    const ctx = makeDayContext();
    expect(detectPcsMonday([wickBar], [node], ctx, null)).not.toBeNull();
  });
});
