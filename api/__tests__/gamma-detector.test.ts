// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

// `withDbRetry` is mocked to a thin passthrough so each `sql` template call
// resolves through our injected fn without paying the retry-cycle delay or
// trying to reach a real db. Tests pass a fresh mockSql per case via the
// public function signature.
vi.mock('../_lib/db.js', () => ({
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import type { NeonQueryFunction } from '@neondatabase/serverless';

import {
  E1_HOLD_BARS,
  E5_BREAKDOWN_PTS,
  PCS_MAX_ABS_GEX,
  PERISCOPE_MAX_AGE_MIN,
  computeEsBasisChange5m,
  detectE1,
  detectE5,
  detectPcsMonday,
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  getDomFromEtDateStr,
  getDowLabel,
  insertFire,
  loadDayContext,
  loadPositiveGammaNodes,
  loadPreDayFilter,
  loadRecentBars,
  type Bar,
  type DayContext,
  type DetectorFire,
  type DowLabel,
  type GammaNode,
} from '../_lib/gamma-detector.js';

type Sql = NeonQueryFunction<false, false>;

/**
 * Build a mock `sql` tagged-template fn whose Nth invocation resolves with
 * the Nth fixture in `responses`. Calls past the end fall back to `[]` so a
 * test that mocks fewer rows than the production function queries still
 * fails predictably (returning empty data) rather than throwing.
 */
function makeMockSql(responses: unknown[]): {
  sql: Sql;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  mock.mockResolvedValue([]);
  return { sql: mock as unknown as Sql, mock };
}

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

// E5 is disabled (returns null) — see api/_lib/gamma-detector.ts for the
// rationale. The 2026-05-23 backfill exposed forward-looking selection bias
// in the brainstorm's +8.95 result. These tests pin the disabled contract
// so a future reactivation must consciously update them. E5_BREAKDOWN_PTS
// is still exported (referenced here) so the surface stays stable for the
// eventual real-time rewrite.
describe('detectE5 — disabled (forward-looking selection bias)', () => {
  const node: GammaNode = { strike: 7400, value: 200_000 };

  it('exports E5_BREAKDOWN_PTS for future reactivation', () => {
    expect(E5_BREAKDOWN_PTS).toBe(1.0);
  });

  it('always returns null even on a textbook wick + breakdown pattern', () => {
    const bars: Bar[] = [
      makeBar({ open: 7405, high: 7406, low: 7404, close: 7405 }),
      makeBar({ open: 7405, high: 7405, low: 7398, close: 7402 }),
      makeBar({ open: 7402, high: 7403, low: 7400, close: 7401 }),
      makeBar({ open: 7401, high: 7402, low: 7398.5, close: 7399 }),
      makeBar({ open: 7399, high: 7400, low: 7396, close: 7397 }),
    ];
    expect(detectE5(bars, [node])).toBeNull();
  });

  it('returns null on empty bars and empty nodes', () => {
    expect(detectE5([], [])).toBeNull();
    expect(detectE5([makeBar()], [])).toBeNull();
    expect(detectE5([], [node])).toBeNull();
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

// ============================================================
// DB LOADERS
// ============================================================

describe('loadRecentBars', () => {
  it('reverses DESC SQL output into chronological ASC bars', async () => {
    // SQL returns newest-first; loader should walk back so the output is
    // oldest-first. Three rows in mixed numeric/string column types
    // (Neon serializes numerics as strings).
    const { sql, mock } = makeMockSql([
      [
        {
          timestamp: '2026-05-21T14:02:00Z',
          open: '7402',
          high: 7404,
          low: '7400',
          close: 7403,
        },
        {
          timestamp: '2026-05-21T14:01:00Z',
          open: '7401',
          high: 7403,
          low: '7399',
          close: 7402,
        },
        {
          timestamp: '2026-05-21T14:00:00Z',
          open: '7400',
          high: 7402,
          low: '7398',
          close: 7401,
        },
      ],
    ]);

    const bars = await loadRecentBars(sql, '2026-05-21');

    expect(mock).toHaveBeenCalledOnce();
    expect(bars).toHaveLength(3);
    expect(bars[0]?.timestamp.toISOString()).toBe('2026-05-21T14:00:00.000Z');
    expect(bars[2]?.timestamp.toISOString()).toBe('2026-05-21T14:02:00.000Z');
    // Strings coerced to numbers.
    expect(bars[0]?.open).toBe(7400);
    expect(typeof bars[0]?.high).toBe('number');
  });

  it('returns empty array when SQL returns no rows', async () => {
    const { sql } = makeMockSql([[]]);
    const bars = await loadRecentBars(sql, '2026-05-21');
    expect(bars).toEqual([]);
  });

  it('skips null rows defensively (driver-edge sparse arrays)', async () => {
    const { sql } = makeMockSql([
      [
        null,
        {
          timestamp: '2026-05-21T14:00:00Z',
          open: 7400,
          high: 7402,
          low: 7398,
          close: 7401,
        },
      ],
    ]);
    const bars = await loadRecentBars(sql, '2026-05-21');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(7401);
  });
});

describe('loadPositiveGammaNodes', () => {
  it('coerces numeric strings and returns the rows verbatim', async () => {
    const { sql, mock } = makeMockSql([
      [
        { strike: 7380, value: '150000' },
        { strike: 7400, value: 500_000 },
        { strike: '7420', value: '300000.5' },
      ],
    ]);

    const nodes = await loadPositiveGammaNodes(sql, '2026-05-21');

    expect(mock).toHaveBeenCalledOnce();
    expect(nodes).toEqual([
      { strike: 7380, value: 150_000 },
      { strike: 7400, value: 500_000 },
      { strike: 7420, value: 300_000.5 },
    ]);
  });

  it('returns empty list when no fresh snapshot exists', async () => {
    const { sql } = makeMockSql([[]]);
    const nodes = await loadPositiveGammaNodes(sql, '2026-05-21');
    expect(nodes).toEqual([]);
  });

  it('exports PERISCOPE_MAX_AGE_MIN so a future loosening of the freshness window is a one-line change', () => {
    // Captures the constant in test scope so a regression in the SQL
    // freshness window (e.g. someone dropping the NOW() - INTERVAL clause)
    // would also need to flip this constant — making intent traceable.
    expect(PERISCOPE_MAX_AGE_MIN).toBe(15);
  });
});

describe('loadPreDayFilter', () => {
  it('computes 5-day return from oldest-of-6 vs newest, plus prior iv_rank', async () => {
    // closes (newest-first per SQL): 7400, 7390, 7380, 7370, 7360, 7350
    // 5d return = (7400 - 7350) / 7350 = +0.006802...
    const { sql } = makeMockSql([
      [
        { day_close: '7400' },
        { day_close: '7390' },
        { day_close: '7380' },
        { day_close: '7370' },
        { day_close: '7360' },
        { day_close: '7350' },
      ],
      [{ date: '2026-05-20', iv_rank: '42.5' }],
    ]);

    const out = await loadPreDayFilter(sql, '2026-05-21');

    expect(out.prior_5d_ret).toBeCloseTo((7400 - 7350) / 7350, 6);
    expect(out.prior_iv_rank).toBe(42.5);
  });

  it('returns null prior_5d_ret when fewer than 6 closing rows available', async () => {
    const { sql } = makeMockSql([
      [{ day_close: 7400 }, { day_close: 7390 }, { day_close: 7380 }],
      [{ date: '2026-05-20', iv_rank: 20 }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_5d_ret).toBeNull();
    expect(out.prior_iv_rank).toBe(20);
  });

  it('returns null prior_5d_ret when oldest close is zero (defensive divide-by-zero guard)', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 0 },
      ],
      [{ date: '2026-05-20', iv_rank: 20 }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_5d_ret).toBeNull();
  });

  it('returns null prior_iv_rank when vol_realized has no recent row', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7350 },
      ],
      [],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_iv_rank).toBeNull();
  });

  it('returns null prior_iv_rank when iv_rank column is null', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7350 },
      ],
      [{ date: '2026-05-20', iv_rank: null }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_iv_rank).toBeNull();
  });
});

describe('loadDayContext', () => {
  // 2026-05-25 is a Monday in NY. Day-of-month is 25, so neither
  // is_dom_1_5 nor is_dom_16_20 should fire.
  const REFERENCE_TIME = new Date('2026-05-25T14:00:00Z');

  it('assembles full context: open, gap, dow, pre-day filter, DOM flags', async () => {
    const { sql } = makeMockSql([
      // todayOpenRows
      [{ day_open: 7405 }],
      // priorCloseRows
      [{ day_close: 7400 }],
      // loadPreDayFilter → close rows (6)
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7300 }, // oldest
      ],
      // loadPreDayFilter → iv rows
      [{ date: '2026-05-22', iv_rank: 30 }],
    ]);

    const ctx = await loadDayContext(sql, REFERENCE_TIME);

    expect(ctx.today).toBe('2026-05-25');
    expect(ctx.dow_label).toBe('Monday');
    expect(ctx.day_open).toBe(7405);
    expect(ctx.prior_close).toBe(7400);
    expect(ctx.open_gap_pct).toBeCloseTo(((7405 - 7400) / 7400) * 100, 6);
    // 5d return = (7400 - 7300) / 7300 = +0.013...  > -0.01, so pre-day
    // filter does NOT fire (it requires <-0.01 AND iv_rank>25).
    expect(ctx.pre_day_filter_fires).toBe(false);
    expect(ctx.is_fomc_day).toBe(false);
    expect(ctx.is_dom_1_5).toBe(false);
    expect(ctx.is_dom_16_20).toBe(false);
  });

  it('marks pre_day_filter_fires when prior_5d < -1% AND iv_rank > 25', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7300 }],
      [{ day_close: 7400 }],
      [
        { day_close: 7300 },
        { day_close: 7350 },
        { day_close: 7380 },
        { day_close: 7420 },
        { day_close: 7440 },
        { day_close: 7450 }, // oldest = 7450, newest = 7300 → -2% 5d ret
      ],
      [{ date: '2026-05-22', iv_rank: 40 }],
    ]);

    const ctx = await loadDayContext(sql, REFERENCE_TIME);
    expect(ctx.prior_5d_ret).toBeLessThan(-0.01);
    expect(ctx.prior_iv_rank).toBe(40);
    expect(ctx.pre_day_filter_fires).toBe(true);
  });

  it('open_gap_pct is 0 when prior_close is 0 (defensive)', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7405 }],
      [{ day_close: 0 }],
      [],
      [],
    ]);
    const ctx = await loadDayContext(sql, REFERENCE_TIME);
    expect(ctx.open_gap_pct).toBe(0);
  });

  it('passes isFomcDay through from caller opts', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    const ctx = await loadDayContext(sql, REFERENCE_TIME, { isFomcDay: true });
    expect(ctx.is_fomc_day).toBe(true);
  });

  it('flags is_dom_1_5 for early-month dates', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    // 2026-05-04 is a Monday + DOM 4 → should hit is_dom_1_5
    const ctx = await loadDayContext(sql, new Date('2026-05-04T14:00:00Z'));
    expect(ctx.is_dom_1_5).toBe(true);
    expect(ctx.is_dom_16_20).toBe(false);
  });

  it('flags is_dom_16_20 for mid-month dates', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    // 2026-05-18 is DOM 18 → should hit is_dom_16_20
    const ctx = await loadDayContext(sql, new Date('2026-05-18T14:00:00Z'));
    expect(ctx.is_dom_1_5).toBe(false);
    expect(ctx.is_dom_16_20).toBe(true);
  });
});

describe('computeEsBasisChange5m', () => {
  const REFERENCE_TIME = new Date('2026-05-25T14:30:00Z');

  it('returns the ES-vs-SPX delta when both series have 6 bars', async () => {
    // esNow.close - esThen.close = 7402 - 7400 = +2
    // spxNow.close - spxThen.close = 7401 - 7400 = +1
    // basis change = esDelta - spxDelta = +1
    const { sql } = makeMockSql([
      [
        { close: 7402 }, // newest (idx 0)
        { close: 7401.8 },
        { close: 7401.5 },
        { close: 7401 },
        { close: 7400.5 },
        { close: 7400 }, // oldest (idx 5)
      ],
      [
        { close: 7401 },
        { close: 7400.8 },
        { close: 7400.5 },
        { close: 7400 },
        { close: 7400.2 },
        { close: 7400 },
      ],
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeCloseTo(1, 6);
  });

  it('returns null when ES has fewer than 6 bars (sidecar gap)', async () => {
    const { sql } = makeMockSql([
      [{ close: 7402 }, { close: 7401 }, { close: 7400 }], // only 3
      [
        { close: 7401 },
        { close: 7400.8 },
        { close: 7400.5 },
        { close: 7400 },
        { close: 7400.2 },
        { close: 7400 },
      ],
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeNull();
  });

  it('returns null when SPX has fewer than 6 bars (RTH-gate transitions)', async () => {
    const { sql } = makeMockSql([
      [
        { close: 7402 },
        { close: 7401.8 },
        { close: 7401.5 },
        { close: 7401 },
        { close: 7400.5 },
        { close: 7400 },
      ],
      [], // SPX dry
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeNull();
  });

  it('defaults referenceTime to NOW() when no arg passed', async () => {
    const { sql } = makeMockSql([
      [
        { close: 7402 },
        { close: 7401 },
        { close: 7401 },
        { close: 7401 },
        { close: 7400 },
        { close: 7400 },
      ],
      [
        { close: 7401 },
        { close: 7401 },
        { close: 7401 },
        { close: 7400 },
        { close: 7400 },
        { close: 7400 },
      ],
    ]);
    // Just confirm it doesn't throw — the value asserts the contract that
    // the default referenceTime doesn't break the SQL template.
    const basis = await computeEsBasisChange5m(sql);
    expect(basis).toBeCloseTo(1, 6);
  });
});

describe('insertFire', () => {
  const makeFire = (overrides: Partial<DetectorFire> = {}): DetectorFire => ({
    fired_at: new Date('2026-05-25T15:00:00Z'),
    signal_type: 'e1_long_call',
    dow_label: 'Monday',
    confidence_tier: 'HIGH',
    spot_at_fire: 7401,
    node_strike: 7400,
    node_gex: 300_000,
    bar_open: 7395,
    bar_high: 7402,
    bar_low: 7394,
    bar_close: 7401,
    bar_range: 8,
    es_basis_change_5m: 1.0,
    prior_5d_ret: -0.012,
    prior_iv_rank: 32,
    pre_day_filter_fires: true,
    open_gap_pct: 0.4,
    is_fomc_day: false,
    is_dom_1_5: false,
    is_dom_16_20: false,
    ...overrides,
  });

  it('returns true when INSERT returns a row (new fire persisted)', async () => {
    const { sql, mock } = makeMockSql([[{ id: 42 }]]);
    const inserted = await insertFire(sql, makeFire());
    expect(inserted).toBe(true);
    expect(mock).toHaveBeenCalledOnce();
  });

  it('returns false when ON CONFLICT DO NOTHING skipped the insert', async () => {
    // Idempotency contract: the unique key (fired_at, signal_type, node_strike)
    // collides → INSERT … RETURNING id returns zero rows.
    const { sql } = makeMockSql([[]]);
    const inserted = await insertFire(sql, makeFire());
    expect(inserted).toBe(false);
  });
});
