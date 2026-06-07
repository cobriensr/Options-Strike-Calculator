// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  FLOW_REGIME_BASELINE,
  MIN_BUCKET_TRADES,
  classifyRegime,
  computeFlowMetrics,
  evaluateFlowRegime,
  percentileOf,
  sideSign,
  slotForEtMinute,
  type FlowRegimeBaseline,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';

// ── A small deterministic baseline fixture ───────────────────────────────────
// Slot 0 is well-populated (n_days ≥ min). Slot 1 is intentionally thin
// (n_days < min) to exercise the insufficient-baseline path. Breakpoints are
// chosen so a known input lands on a known percentile.

const PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99];

const FIXTURE: FlowRegimeBaseline = {
  schema_version: 1,
  generated_from: 'test fixture',
  universe: ['SPY', 'QQQ', 'SPXW', 'NDXP', 'IWM', 'TSLA', 'NVDA'],
  index_set: ['SPXW', 'NDXP', 'QQQ', 'SPY', 'IWM'],
  bucket_minutes: 30,
  rth_start_minute: 570,
  rth_end_minute: 960,
  slot_count: 13,
  min_days_per_slot: 15,
  side_sign_map: { ask: 1, bid: -1, mid: 0, no_side: 0 },
  percentiles: PCTS,
  slots: [
    {
      slot: 0,
      n_days: 100,
      // nd_tilt breakpoints: symmetric around 0.
      nd_tilt_breakpoints: [-0.5, -0.4, -0.3, -0.1, 0.0, 0.1, 0.3, 0.4, 0.5],
      // idx0dte_put_share breakpoints: ascending in [0, 0.2].
      idx0dte_put_share_breakpoints: [
        0.0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.14, 0.16, 0.2,
      ],
    },
    {
      slot: 1,
      n_days: 3, // below min_days_per_slot → insufficient
      nd_tilt_breakpoints: [-0.5, -0.4, -0.3, -0.1, 0, 0.1, 0.3, 0.4, 0.5],
      idx0dte_put_share_breakpoints: [
        0.0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.14, 0.16, 0.2,
      ],
    },
  ],
};

// ── sideSign ─────────────────────────────────────────────────────────────────

describe('sideSign', () => {
  it.each([
    ['ask', 1],
    ['bid', -1],
    ['mid', 0],
    ['no_side', 0],
    ['garbage', 0],
  ])('maps %s → %d', (side, expected) => {
    expect(sideSign(side, FIXTURE.side_sign_map)).toBe(expected);
  });
});

// ── slotForEtMinute ──────────────────────────────────────────────────────────

describe('slotForEtMinute', () => {
  it.each([
    [570, 0], // 09:30
    [599, 0], // 09:59 (still slot 0)
    [600, 1], // 10:00
    [930, 12], // 15:30
    [959, 12], // 15:59 (last RTH minute)
  ])('et minute %d → slot %d', (min, slot) => {
    expect(slotForEtMinute(min, FIXTURE)).toBe(slot);
  });

  it('returns null before RTH open', () => {
    expect(slotForEtMinute(569, FIXTURE)).toBeNull();
  });

  it('returns null at/after RTH close', () => {
    expect(slotForEtMinute(960, FIXTURE)).toBeNull();
    expect(slotForEtMinute(1000, FIXTURE)).toBeNull();
  });
});

// ── percentileOf ─────────────────────────────────────────────────────────────

describe('percentileOf', () => {
  const bps = FIXTURE.slots[0]!.nd_tilt_breakpoints;

  it('returns the p50 percentile at the median breakpoint', () => {
    expect(percentileOf(0.0, bps, PCTS)).toBe(50);
  });

  it('clamps below the smallest breakpoint to p1', () => {
    expect(percentileOf(-10, bps, PCTS)).toBe(1);
  });

  it('clamps above the largest breakpoint to p99', () => {
    expect(percentileOf(10, bps, PCTS)).toBe(99);
  });

  it('interpolates linearly between breakpoints', () => {
    // Between p50 (bp 0.0) and p75 (bp 0.1): value 0.05 is halfway → 62.5.
    expect(percentileOf(0.05, bps, PCTS)).toBeCloseTo(62.5, 6);
  });

  it('handles a value exactly on an interior breakpoint', () => {
    // bp 0.3 is p90.
    expect(percentileOf(0.3, bps, PCTS)).toBe(90);
  });

  it('returns 50 on a degenerate (empty) breakpoint list', () => {
    expect(percentileOf(0.1, [], [])).toBe(50);
  });
});

// ── classifyRegime ───────────────────────────────────────────────────────────

describe('classifyRegime', () => {
  it.each([
    // nd, idxput, regime, color
    [5, 50, 'bearish', 'red'], // nd ≤10
    [50, 95, 'bearish', 'red'], // idxput ≥90
    [5, 95, 'bearish', 'red'], // both extreme bearish
    [95, 5, 'bullish', 'green'], // nd ≥90 AND idxput ≤10
    [20, 50, 'caution', 'amber'], // nd ≤25
    [50, 80, 'caution', 'amber'], // idxput ≥75
    [50, 50, 'normal', 'gray'], // mid
    [95, 50, 'normal', 'gray'], // high nd but idxput not low → not bullish
    [95, 11, 'normal', 'gray'], // nd high, idxput just above 10 → not bullish
  ] as const)('nd=%d idxput=%d → %s/%s', (nd, idxput, regime, color) => {
    const r = classifyRegime(nd, idxput);
    expect(r.regime).toBe(regime);
    expect(r.color).toBe(color);
  });

  it('prioritizes bearish over bullish when both could trigger', () => {
    // nd ≥90 (bullish-eligible) but idxput ≥90 (bearish) → bearish wins.
    expect(classifyRegime(95, 95).regime).toBe('bearish');
  });
});

// ── computeFlowMetrics ───────────────────────────────────────────────────────

describe('computeFlowMetrics', () => {
  const row = (over: Partial<FlowTradeRow>): FlowTradeRow => ({
    ticker: 'TSLA',
    optionType: 'C',
    expiry: '2026-06-04',
    tradeDateEt: '2026-06-04',
    side: 'ask',
    delta: 0.5,
    size: 10,
    price: 2,
    ...over,
  });

  it('returns all-zero sums for empty input', () => {
    expect(
      computeFlowMetrics([], FIXTURE.index_set, FIXTURE.side_sign_map),
    ).toEqual({ ndNum: 0, ndDen: 0, idxPutPremium: 0, totalPremium: 0 });
  });

  it('all-mid trades produce nd_tilt 0 (ndNum 0, ndDen > 0)', () => {
    const rows = [
      row({ side: 'mid', delta: 0.5, size: 10 }),
      row({ side: 'no_side', delta: -0.3, size: 5 }),
    ];
    const sums = computeFlowMetrics(
      rows,
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(sums.ndNum).toBe(0);
    expect(sums.ndDen).toBeGreaterThan(0);
    // The evaluator computes ndNum/ndDen = 0.
    const res = evaluateFlowRegime({ sums, slot: 0, baseline: FIXTURE });
    expect(res.ndTilt).toBe(0);
  });

  it('uses premium column when provided, else price·size·100', () => {
    const withPrem = computeFlowMetrics(
      [row({ premium: 1234, price: 999 })],
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(withPrem.totalPremium).toBe(1234);
    const withPrice = computeFlowMetrics(
      [row({ price: 2, size: 10 })], // 2·10·100 = 2000
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(withPrice.totalPremium).toBe(2000);
  });

  it('counts only 0DTE index puts toward idxPutPremium', () => {
    const rows = [
      // index put, 0DTE → counts
      row({
        ticker: 'SPXW',
        optionType: 'P',
        expiry: '2026-06-04',
        premium: 5000,
      }),
      // index put but NOT 0DTE → excluded
      row({
        ticker: 'SPY',
        optionType: 'P',
        expiry: '2026-06-18',
        premium: 9000,
      }),
      // index CALL 0DTE → excluded
      row({
        ticker: 'QQQ',
        optionType: 'C',
        expiry: '2026-06-04',
        premium: 7000,
      }),
      // non-index put 0DTE → excluded
      row({
        ticker: 'TSLA',
        optionType: 'P',
        expiry: '2026-06-04',
        premium: 3000,
      }),
    ];
    const sums = computeFlowMetrics(
      rows,
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(sums.idxPutPremium).toBe(5000);
    expect(sums.totalPremium).toBe(5000 + 9000 + 7000 + 3000);
  });

  it("accepts tape-style 'put'/'call' option types", () => {
    const sums = computeFlowMetrics(
      [
        row({
          ticker: 'SPY',
          optionType: 'put',
          expiry: '2026-06-04',
          premium: 100,
        }),
      ],
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(sums.idxPutPremium).toBe(100);
  });

  it('aggregates net_delta_tilt across mixed sides', () => {
    // ask 0.5·10 (+) and bid 0.4·10 (−): ndNum = 5 − 4 = 1; ndDen = 5+4 = 9.
    const sums = computeFlowMetrics(
      [
        row({ side: 'ask', delta: 0.5, size: 10 }),
        row({ side: 'bid', delta: 0.4, size: 10 }),
      ],
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
    );
    expect(sums.ndNum).toBeCloseTo(1, 6);
    expect(sums.ndDen).toBeCloseTo(9, 6);
    const res = evaluateFlowRegime({ sums, slot: 0, baseline: FIXTURE });
    expect(res.ndTilt).toBeCloseTo(1 / 9, 6);
  });

  it('restricts ALL sums to the baseline universe (#2)', () => {
    // ZZZZ is outside FIXTURE.universe — it must contribute to NEITHER the
    // net-delta sums NOR the put-share denominator, so the metrics stay scored
    // on the same population the baseline was built on if the WS subscription
    // ever widens beyond the universe.
    const rows = [
      // In-universe index 0DTE put: counts toward both num + den.
      row({
        ticker: 'SPY',
        optionType: 'P',
        expiry: '2026-06-04',
        side: 'ask',
        delta: -0.5,
        size: 10,
        premium: 1000,
      }),
      // Out-of-universe row: large delta + large premium — must be ignored.
      row({
        ticker: 'ZZZZ',
        optionType: 'P',
        expiry: '2026-06-04',
        side: 'bid',
        delta: -0.9,
        size: 100,
        premium: 999_999,
      }),
    ];
    const sums = computeFlowMetrics(
      rows,
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
      FIXTURE.universe,
    );
    // Only the SPY row contributed.
    expect(sums.ndNum).toBeCloseTo(-0.5 * 10, 6);
    expect(sums.ndDen).toBeCloseTo(0.5 * 10, 6);
    expect(sums.totalPremium).toBe(1000);
    expect(sums.idxPutPremium).toBe(1000);
  });

  it('excludes null / non-finite-price rows from the put-share ratio (#4)', () => {
    // A row whose premium can't be resolved (no premium, null price) must NOT
    // count as a 0-premium row in the denominator — that would phantom-dilute
    // idx0dte_put_share. It may still contribute to net_delta_tilt.
    const rows = [
      // Valid index 0DTE put → counts toward num + den.
      row({
        ticker: 'QQQ',
        optionType: 'P',
        expiry: '2026-06-04',
        side: 'ask',
        delta: -0.4,
        size: 5,
        premium: 800,
      }),
      // Null price, no premium → excluded from premium math entirely, but its
      // valid delta/size still feed net_delta_tilt.
      {
        ...row({
          ticker: 'TSLA',
          optionType: 'C',
          side: 'ask',
          delta: 0.6,
          size: 20,
        }),
        price: undefined,
        premium: undefined,
      },
    ];
    const sums = computeFlowMetrics(
      rows,
      FIXTURE.index_set,
      FIXTURE.side_sign_map,
      FIXTURE.universe,
    );
    // Denominator is ONLY the valid row's premium (no phantom 0 added).
    expect(sums.totalPremium).toBe(800);
    expect(sums.idxPutPremium).toBe(800);
    // Both rows' deltas feed net_delta_tilt: ndNum = -0.4*5 + 0.6*20 = 10.
    expect(sums.ndNum).toBeCloseTo(-0.4 * 5 + 0.6 * 20, 6);
    expect(sums.ndDen).toBeCloseTo(0.4 * 5 + 0.6 * 20, 6);
  });
});

// ── evaluateFlowRegime ───────────────────────────────────────────────────────

describe('evaluateFlowRegime', () => {
  it('scores a normal mid-distribution bucket', () => {
    const res = evaluateFlowRegime({
      ndTilt: 0.0, // p50
      idx0dtePutShare: 0.08, // p50
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.ndPercentile).toBe(50);
    expect(res.idxputPercentile).toBe(50);
    expect(res.regime).toBe('normal');
    expect(res.color).toBe('gray');
    expect(res.hasBaseline).toBe(true);
  });

  it('flags bearish when nd_tilt is in the low tail', () => {
    const res = evaluateFlowRegime({
      ndTilt: -0.45, // between p1(-0.5) and p5(-0.4) → ~p3
      idx0dtePutShare: 0.08,
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.ndPercentile).toBeLessThanOrEqual(10);
    expect(res.regime).toBe('bearish');
    expect(res.color).toBe('red');
  });

  it('flags bearish when idx put share is in the high tail', () => {
    const res = evaluateFlowRegime({
      ndTilt: 0.0, // p50 (not bearish on its own)
      idx0dtePutShare: 0.18, // between p95(0.16) and p99(0.2) → ≥90
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.idxputPercentile).toBeGreaterThanOrEqual(90);
    expect(res.regime).toBe('bearish');
  });

  it('flags bullish only when nd high AND idx put low', () => {
    const res = evaluateFlowRegime({
      ndTilt: 0.45, // between p95(0.4) and p99(0.5) → ≥90
      idx0dtePutShare: 0.01, // between p1(0) and p5(0.02) → ≤10
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.regime).toBe('bullish');
    expect(res.color).toBe('green');
  });

  it('returns insufficient-baseline result for a thin slot', () => {
    const res = evaluateFlowRegime({
      ndTilt: -0.45,
      idx0dtePutShare: 0.18,
      slot: 1, // n_days = 3 < 15
      baseline: FIXTURE,
    });
    expect(res.hasBaseline).toBe(false);
    expect(res.ndPercentile).toBeNull();
    expect(res.idxputPercentile).toBeNull();
    expect(res.regime).toBe('normal');
    expect(res.color).toBe('gray');
    expect(res.confidence).toBe('low');
    expect(res.confidenceReason).toBe('thin-baseline');
    // Raw metrics still surfaced.
    expect(res.ndTilt).toBe(-0.45);
    expect(res.idx0dtePutShare).toBe(0.18);
  });

  it('suppresses an extreme but thin LIVE bucket to low-confidence (#1)', () => {
    // Healthy baseline (slot 0) + an extreme tilt that WOULD classify bearish,
    // but nTrades below MIN_BUCKET_TRADES → the evaluator owns the floor and
    // suppresses: null percentiles + normal/gray + reason 'thin-bucket'.
    const res = evaluateFlowRegime({
      ndTilt: -0.45, // would be bearish on its own
      idx0dtePutShare: 0.18, // would be bearish on its own
      slot: 0, // n_days = 100 → baseline IS healthy
      nTrades: MIN_BUCKET_TRADES - 1,
      baseline: FIXTURE,
    });
    expect(res.confidence).toBe('low');
    expect(res.confidenceReason).toBe('thin-bucket');
    // hasBaseline reflects the slot's depth, which is fine here...
    expect(res.hasBaseline).toBe(true);
    // ...but the read is still suppressed.
    expect(res.ndPercentile).toBeNull();
    expect(res.idxputPercentile).toBeNull();
    expect(res.regime).toBe('normal');
    expect(res.color).toBe('gray');
    // Raw metrics preserved for persistence/transparency.
    expect(res.ndTilt).toBe(-0.45);
    expect(res.idx0dtePutShare).toBe(0.18);
  });

  it('scores a healthy bucket at/above MIN_BUCKET_TRADES (#1)', () => {
    const res = evaluateFlowRegime({
      ndTilt: -0.45,
      idx0dtePutShare: 0.08,
      slot: 0,
      nTrades: MIN_BUCKET_TRADES,
      baseline: FIXTURE,
    });
    expect(res.confidence).toBe('ok');
    expect(res.confidenceReason).toBeNull();
    expect(res.ndPercentile).not.toBeNull();
    expect(res.regime).toBe('bearish');
  });

  it('returns insufficient-baseline for an unknown slot', () => {
    const res = evaluateFlowRegime({
      ndTilt: 0,
      idx0dtePutShare: 0,
      slot: 99,
      baseline: FIXTURE,
    });
    expect(res.hasBaseline).toBe(false);
    expect(res.regime).toBe('normal');
  });

  it('accepts component sums and computes the ratios itself', () => {
    const res = evaluateFlowRegime({
      sums: { ndNum: 0, ndDen: 100, idxPutPremium: 8, totalPremium: 100 },
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.ndTilt).toBe(0); // 0/100
    expect(res.idx0dtePutShare).toBe(0.08); // 8/100
    expect(res.ndPercentile).toBe(50);
  });

  it('guards divide-by-zero in component sums (empty bucket)', () => {
    const res = evaluateFlowRegime({
      sums: { ndNum: 0, ndDen: 0, idxPutPremium: 0, totalPremium: 0 },
      slot: 0,
      baseline: FIXTURE,
    });
    expect(res.ndTilt).toBe(0);
    expect(res.idx0dtePutShare).toBe(0);
    expect(Number.isFinite(res.ndPercentile!)).toBe(true);
  });
});

// ── Sanity checks against the committed baseline artifact ─────────────────────

describe('committed FLOW_REGIME_BASELINE artifact', () => {
  it('has the expected shape and constants', () => {
    expect(FLOW_REGIME_BASELINE.bucket_minutes).toBe(30);
    expect(FLOW_REGIME_BASELINE.slot_count).toBe(13);
    expect(FLOW_REGIME_BASELINE.rth_start_minute).toBe(570);
    expect(FLOW_REGIME_BASELINE.rth_end_minute).toBe(960);
    expect(FLOW_REGIME_BASELINE.index_set).toEqual([
      'SPXW',
      'NDXP',
      'QQQ',
      'SPY',
      'IWM',
    ]);
    // Every index symbol must be inside the universe (consistency rule).
    for (const sym of FLOW_REGIME_BASELINE.index_set) {
      expect(FLOW_REGIME_BASELINE.universe).toContain(sym);
    }
  });

  it('has 13 slots with ascending breakpoints', () => {
    expect(FLOW_REGIME_BASELINE.slots).toHaveLength(13);
    for (const s of FLOW_REGIME_BASELINE.slots) {
      const bp = s.nd_tilt_breakpoints;
      for (let i = 1; i < bp.length; i++) {
        expect(bp[i]!).toBeGreaterThanOrEqual(bp[i - 1]!);
      }
    }
  });

  it('evaluates the live artifact without throwing', () => {
    const res = evaluateFlowRegime({
      ndTilt: 0,
      idx0dtePutShare: 0.03,
      slot: 0,
    });
    expect(['normal', 'caution', 'bearish', 'bullish']).toContain(res.regime);
  });
});
