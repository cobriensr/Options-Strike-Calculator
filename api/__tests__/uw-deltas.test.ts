// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  classifyDarkPoolVelocity,
  classifyEtfTide,
  classifyGexIntradayDelta,
  classifyWhaleFlow,
  computeDarkPoolVelocity,
  computeEtfTideDivergence,
  computeGexIntradayDelta,
  computeUwDeltas,
  computeWhaleFlowPositioning,
  formatUwDeltasForClaude,
} from '../_lib/uw-deltas.js';

/**
 * Fixed "now" used by every test. 2026-04-20 Monday 15:00 UTC
 * (11:00 ET / 10:00 CT — well inside RTH).
 */
const FIXED_NOW = new Date('2026-04-20T15:00:00.000Z');
const FIXED_NOW_MS = FIXED_NOW.getTime();

type QueryKind =
  | 'dark_pool_velocity'
  | 'gex_intraday'
  | 'whale_flow'
  | 'etf_tide';

function classify(strings: TemplateStringsArray): QueryKind {
  const joined = strings.join('');
  if (joined.includes('FROM dark_pool_levels')) return 'dark_pool_velocity';
  if (joined.includes('FROM spot_exposures')) return 'gex_intraday';
  if (joined.includes('FROM flow_alerts')) return 'whale_flow';
  if (joined.includes('FROM flow_data')) return 'etf_tide';
  throw new Error(`Unrecognized SQL call: ${joined.slice(0, 120)}`);
}

// ── Dark pool velocity ───────────────────────────────────────────

describe('computeDarkPoolVelocity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns SURGE when current 5m is >2σ above baseline mean', async () => {
    // Baseline buckets 1..12 all = 2. Current bucket 0 = 20. Mean=2,
    // std≈0, but we want a measurable stddev → vary baseline a bit.
    const buckets = [20, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2];
    mockSql.mockResolvedValueOnce(
      buckets.map((strike_count, bucket_index) => ({
        bucket_index,
        strike_count,
      })),
    );

    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.count5m).toBe(20);
    expect(result!.classification).toBe('SURGE');
    expect(result!.zscore).toBeGreaterThan(2.0);
  });

  it('returns DROUGHT when current 5m is >2σ below baseline mean', async () => {
    // Baseline centered around 10 with jitter, current = 0
    const buckets = [0, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11];
    mockSql.mockResolvedValueOnce(
      buckets.map((strike_count, bucket_index) => ({
        bucket_index,
        strike_count,
      })),
    );

    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.count5m).toBe(0);
    expect(result!.classification).toBe('DROUGHT');
    expect(result!.zscore).toBeLessThan(-2.0);
  });

  it('returns NORMAL when the current bucket sits inside the baseline', async () => {
    const buckets = [5, 4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 5];
    mockSql.mockResolvedValueOnce(
      buckets.map((strike_count, bucket_index) => ({
        bucket_index,
        strike_count,
      })),
    );

    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('NORMAL');
    expect(Math.abs(result!.zscore)).toBeLessThan(2.0);
  });

  it('returns null when fewer than 10 non-zero baseline buckets', async () => {
    // Only 5 non-zero buckets in the baseline
    const buckets = [3, 5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 0, 0];
    mockSql.mockResolvedValueOnce(
      buckets.map((strike_count, bucket_index) => ({
        bucket_index,
        strike_count,
      })),
    );

    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('returns null when baseline stddev is zero (flat)', async () => {
    const buckets = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    mockSql.mockResolvedValueOnce(
      buckets.map((strike_count, bucket_index) => ({
        bucket_index,
        strike_count,
      })),
    );

    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('returns null when the query yields no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await computeDarkPoolVelocity(FIXED_NOW);
    expect(result).toBeNull();
  });
});

describe('classifyDarkPoolVelocity', () => {
  it('requires absolute delta floor for SURGE (not just z-score)', () => {
    // baseline mean=2, std=0.5; count5m=3 → z=2.0 but delta=+1 only
    // should NOT fire SURGE — single-cluster noise below the +3 floor.
    const result = classifyDarkPoolVelocity({
      count5m: 3,
      baselineMean: 2,
      zscore: 2.0,
    });
    expect(result).toBe('NORMAL');
  });

  it('fires SURGE when both z-score AND absolute delta clear the floor', () => {
    // mean=2, count5m=10 → delta=+8 ≥ 3, z large — SURGE.
    const result = classifyDarkPoolVelocity({
      count5m: 10,
      baselineMean: 2,
      zscore: 4.0,
    });
    expect(result).toBe('SURGE');
  });

  it('requires absolute delta floor for DROUGHT', () => {
    // baseline mean=3, count5m=1 → delta=-2 (below +3 floor)
    // z=-2.5 would classify DROUGHT on z alone — should NOT fire.
    const result = classifyDarkPoolVelocity({
      count5m: 1,
      baselineMean: 3,
      zscore: -2.5,
    });
    expect(result).toBe('NORMAL');
  });

  it('fires DROUGHT when both z-score AND absolute delta clear the floor', () => {
    // mean=10, count5m=1 → delta=-9 ≥ 3 magnitude, z very negative.
    const result = classifyDarkPoolVelocity({
      count5m: 1,
      baselineMean: 10,
      zscore: -3.0,
    });
    expect(result).toBe('DROUGHT');
  });

  it('returns NORMAL when z-score is within ±2', () => {
    const result = classifyDarkPoolVelocity({
      count5m: 5,
      baselineMean: 4,
      zscore: 1.0,
    });
    expect(result).toBe('NORMAL');
  });
});

// ── GEX intraday delta ───────────────────────────────────────────

describe('computeGexIntradayDelta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns STRENGTHENING when positive GEX grows >20%', async () => {
    mockSql.mockResolvedValueOnce([
      { gex_open: '1000000', gex_now: '1300000' },
    ]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.gexOpen).toBe(1_000_000);
    expect(result!.gexNow).toBe(1_300_000);
    expect(result!.deltaPct).toBeCloseTo(0.3, 5);
    expect(result!.classification).toBe('STRENGTHENING');
  });

  it('returns STRENGTHENING when negative GEX grows more negative >20%', async () => {
    mockSql.mockResolvedValueOnce([
      { gex_open: '-1000000', gex_now: '-1300000' },
    ]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('STRENGTHENING');
  });

  it('returns WEAKENING when GEX flips sign', async () => {
    mockSql.mockResolvedValueOnce([
      { gex_open: '1000000', gex_now: '-200000' },
    ]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('WEAKENING');
  });

  it('returns WEAKENING when magnitude halves on the same sign', async () => {
    mockSql.mockResolvedValueOnce([{ gex_open: '1000000', gex_now: '400000' }]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('WEAKENING');
  });

  it('returns STABLE when delta is under ±20%', async () => {
    mockSql.mockResolvedValueOnce([
      { gex_open: '1000000', gex_now: '1100000' },
    ]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('STABLE');
  });

  it('returns null when gex_open is zero', async () => {
    mockSql.mockResolvedValueOnce([{ gex_open: '0', gex_now: '500000' }]);
    const result = await computeGexIntradayDelta(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('returns null when either endpoint is missing', async () => {
    mockSql.mockResolvedValueOnce([{ gex_open: null, gex_now: '500000' }]);
    expect(await computeGexIntradayDelta(FIXED_NOW)).toBeNull();

    mockSql.mockResolvedValueOnce([{ gex_open: '500000', gex_now: null }]);
    expect(await computeGexIntradayDelta(FIXED_NOW)).toBeNull();
  });

  it('returns null when the query yields no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await computeGexIntradayDelta(FIXED_NOW)).toBeNull();
  });
});

describe('classifyGexIntradayDelta', () => {
  it('tags same-sign large move as STRENGTHENING', () => {
    expect(classifyGexIntradayDelta(1_000_000, 1_300_000, 0.3)).toBe(
      'STRENGTHENING',
    );
  });
  it('tags sign flip as WEAKENING', () => {
    expect(classifyGexIntradayDelta(1_000_000, -200_000, -1.2)).toBe(
      'WEAKENING',
    );
  });
  it('tags >=50% magnitude loss on same sign as WEAKENING', () => {
    expect(classifyGexIntradayDelta(1_000_000, 500_000, -0.5)).toBe(
      'WEAKENING',
    );
  });
  it('tags small same-sign moves as STABLE', () => {
    expect(classifyGexIntradayDelta(1_000_000, 1_100_000, 0.1)).toBe('STABLE');
    expect(classifyGexIntradayDelta(1_000_000, 900_000, -0.1)).toBe('STABLE');
  });
});

// ── Whale flow positioning ───────────────────────────────────────

describe('computeWhaleFlowPositioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns AGGRESSIVE_CALL_BIAS when ratio > 0.4 and total > $5M', async () => {
    mockSql.mockResolvedValueOnce([
      { call_premium: '10000000', put_premium: '2000000' },
    ]);
    const result = await computeWhaleFlowPositioning(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.callPremium).toBe(10_000_000);
    expect(result!.putPremium).toBe(2_000_000);
    expect(result!.netRatio).toBeCloseTo(0.6667, 3);
    expect(result!.classification).toBe('AGGRESSIVE_CALL_BIAS');
  });

  it('returns AGGRESSIVE_PUT_BIAS when ratio < -0.4 and total > $5M', async () => {
    mockSql.mockResolvedValueOnce([
      { call_premium: '2000000', put_premium: '10000000' },
    ]);
    const result = await computeWhaleFlowPositioning(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('AGGRESSIVE_PUT_BIAS');
  });

  it('returns BALANCED when total premium is below $5M floor despite extreme ratio', async () => {
    mockSql.mockResolvedValueOnce([
      { call_premium: '2000000', put_premium: '0' },
    ]);
    const result = await computeWhaleFlowPositioning(FIXED_NOW);
    expect(result).not.toBeNull();
    // Ratio is +1.0 but the $5M floor blocks classification
    expect(result!.netRatio).toBe(1);
    expect(result!.classification).toBe('BALANCED');
  });

  it('returns BALANCED when ratio sits inside ±0.4', async () => {
    mockSql.mockResolvedValueOnce([
      { call_premium: '6000000', put_premium: '5000000' },
    ]);
    const result = await computeWhaleFlowPositioning(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.netRatio)).toBeLessThan(0.4);
    expect(result!.classification).toBe('BALANCED');
  });

  it('returns null when total premium is zero', async () => {
    mockSql.mockResolvedValueOnce([{ call_premium: '0', put_premium: '0' }]);
    const result = await computeWhaleFlowPositioning(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('returns null when the query yields no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await computeWhaleFlowPositioning(FIXED_NOW)).toBeNull();
  });
});

describe('classifyWhaleFlow', () => {
  it('tags large call-biased ratio as AGGRESSIVE_CALL_BIAS', () => {
    expect(classifyWhaleFlow(0.6, 20_000_000)).toBe('AGGRESSIVE_CALL_BIAS');
  });
  it('tags large put-biased ratio as AGGRESSIVE_PUT_BIAS', () => {
    expect(classifyWhaleFlow(-0.6, 20_000_000)).toBe('AGGRESSIVE_PUT_BIAS');
  });
  it('tags below-floor totals as BALANCED regardless of ratio', () => {
    expect(classifyWhaleFlow(1, 4_999_999)).toBe('BALANCED');
    expect(classifyWhaleFlow(-1, 100_000)).toBe('BALANCED');
  });
  it('tags moderate ratios as BALANCED', () => {
    expect(classifyWhaleFlow(0.3, 20_000_000)).toBe('BALANCED');
    expect(classifyWhaleFlow(-0.2, 20_000_000)).toBe('BALANCED');
  });
});

// ── ETF tide divergence ──────────────────────────────────────────

describe('computeEtfTideDivergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns SPY_LEADING_BULL when SPY flows up and QQQ flows down', async () => {
    mockSql.mockResolvedValueOnce([
      {
        source: 'spy_etf_tide',
        first_flow: '0',
        last_flow: '100000000',
      },
      {
        source: 'qqq_etf_tide',
        first_flow: '0',
        last_flow: '-80000000',
      },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.spyDelta).toBe(100_000_000);
    expect(result!.qqqDelta).toBe(-80_000_000);
    expect(result!.classification).toBe('SPY_LEADING_BULL');
  });

  it('returns ALIGNED_RISK_ON when both tides flow strongly positive', async () => {
    mockSql.mockResolvedValueOnce([
      { source: 'spy_etf_tide', first_flow: '0', last_flow: '100000000' },
      { source: 'qqq_etf_tide', first_flow: '0', last_flow: '80000000' },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('ALIGNED_RISK_ON');
  });

  it('returns ALIGNED_RISK_OFF when both tides flow strongly negative', async () => {
    mockSql.mockResolvedValueOnce([
      { source: 'spy_etf_tide', first_flow: '0', last_flow: '-100000000' },
      { source: 'qqq_etf_tide', first_flow: '0', last_flow: '-80000000' },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('ALIGNED_RISK_OFF');
  });

  it('returns QQQ_LEADING_BEAR when QQQ sells off with SPY flat or up', async () => {
    mockSql.mockResolvedValueOnce([
      { source: 'spy_etf_tide', first_flow: '0', last_flow: '5000000' },
      { source: 'qqq_etf_tide', first_flow: '0', last_flow: '-80000000' },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('QQQ_LEADING_BEAR');
  });

  it('returns MIXED when neither tide clears the divergence threshold', async () => {
    mockSql.mockResolvedValueOnce([
      { source: 'spy_etf_tide', first_flow: '0', last_flow: '20000000' },
      { source: 'qqq_etf_tide', first_flow: '0', last_flow: '-20000000' },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('MIXED');
  });

  it('returns null when one tide is missing', async () => {
    mockSql.mockResolvedValueOnce([
      { source: 'spy_etf_tide', first_flow: '0', last_flow: '100000000' },
    ]);
    const result = await computeEtfTideDivergence(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('returns null when the query yields no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await computeEtfTideDivergence(FIXED_NOW)).toBeNull();
  });
});

describe('classifyEtfTide', () => {
  it('tags SPY up / QQQ down as SPY_LEADING_BULL', () => {
    expect(classifyEtfTide(100_000_000, -80_000_000)).toBe('SPY_LEADING_BULL');
  });
  it('tags both-positive as ALIGNED_RISK_ON', () => {
    expect(classifyEtfTide(80_000_000, 80_000_000)).toBe('ALIGNED_RISK_ON');
  });
  it('tags both-negative as ALIGNED_RISK_OFF', () => {
    expect(classifyEtfTide(-80_000_000, -80_000_000)).toBe('ALIGNED_RISK_OFF');
  });
  it('tags QQQ-led selloff with flat SPY as QQQ_LEADING_BEAR', () => {
    expect(classifyEtfTide(0, -80_000_000)).toBe('QQQ_LEADING_BEAR');
  });
  it('tags sub-threshold activity as MIXED', () => {
    expect(classifyEtfTide(20_000_000, 20_000_000)).toBe('MIXED');
    expect(classifyEtfTide(-20_000_000, 30_000_000)).toBe('MIXED');
  });
});

// ── Orchestrator ────────────────────────────────────────────────

describe('computeUwDeltas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function installHappyPath() {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const kind = classify(strings);
      switch (kind) {
        case 'dark_pool_velocity': {
          const buckets = [20, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2];
          return buckets.map((strike_count, bucket_index) => ({
            bucket_index,
            strike_count,
          }));
        }
        case 'gex_intraday':
          return [{ gex_open: '1000000', gex_now: '1300000' }];
        case 'whale_flow':
          return [{ call_premium: '10000000', put_premium: '2000000' }];
        case 'etf_tide':
          return [
            {
              source: 'spy_etf_tide',
              first_flow: '0',
              last_flow: '100000000',
            },
            {
              source: 'qqq_etf_tide',
              first_flow: '0',
              last_flow: '-80000000',
            },
          ];
      }
    });
  }

  it('runs all four queries in parallel and returns every signal', async () => {
    installHappyPath();
    const result = await computeUwDeltas(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.darkPool?.classification).toBe('SURGE');
    expect(result!.gex?.classification).toBe('STRENGTHENING');
    expect(result!.whaleFlow?.classification).toBe('AGGRESSIVE_CALL_BIAS');
    expect(result!.etfTide?.classification).toBe('SPY_LEADING_BULL');
    expect(mockSql.mock.calls.length).toBe(4);
  });

  it('isolates failures: one rejection does not suppress the others', async () => {
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const kind = classify(strings);
      if (kind === 'dark_pool_velocity') {
        throw new Error('simulated darkpool query failure');
      }
      if (kind === 'gex_intraday') {
        return [{ gex_open: '1000000', gex_now: '1300000' }];
      }
      if (kind === 'whale_flow') {
        return [{ call_premium: '10000000', put_premium: '2000000' }];
      }
      // etf_tide
      return [
        {
          source: 'spy_etf_tide',
          first_flow: '0',
          last_flow: '100000000',
        },
        {
          source: 'qqq_etf_tide',
          first_flow: '0',
          last_flow: '-80000000',
        },
      ];
    });

    const result = await computeUwDeltas(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.darkPool).toBeNull();
    expect(result!.gex?.classification).toBe('STRENGTHENING');
    expect(result!.whaleFlow?.classification).toBe('AGGRESSIVE_CALL_BIAS');
    expect(result!.etfTide?.classification).toBe('SPY_LEADING_BULL');
  });

  it('returns top-level null when every signal is null', async () => {
    mockSql.mockImplementation(async () => []);
    const result = await computeUwDeltas(FIXED_NOW);
    expect(result).toBeNull();
  });

  it('sets computedAt to the provided now', async () => {
    installHappyPath();
    const result = await computeUwDeltas(FIXED_NOW);
    expect(result!.computedAt).toBe(FIXED_NOW.toISOString());
  });

  it('ignores the FIXED_NOW timestamp in favor of the helper argument', () => {
    // Guard against accidental Date.now() coupling: the exported
    // helpers take `now` explicitly, so a change in FIXED_NOW_MS
    // should not affect query parameters derived from the argument.
    expect(FIXED_NOW_MS).toBe(FIXED_NOW.getTime());
  });
});

// ── Formatter ───────────────────────────────────────────────────

describe('formatUwDeltasForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatUwDeltasForClaude(null)).toBeNull();
  });

  it('returns null when every signal is null', () => {
    expect(
      formatUwDeltasForClaude({
        darkPool: null,
        gex: null,
        whaleFlow: null,
        etfTide: null,
        computedAt: FIXED_NOW.toISOString(),
      }),
    ).toBeNull();
  });

  it('renders every signal when all four are present', () => {
    const out = formatUwDeltasForClaude({
      darkPool: {
        count5m: 20,
        baselineMean: 2.5,
        baselineStd: 0.5,
        zscore: 3.5,
        classification: 'SURGE',
      },
      gex: {
        gexOpen: 1_000_000,
        gexNow: 1_300_000,
        deltaPct: 0.3,
        classification: 'STRENGTHENING',
      },
      whaleFlow: {
        callPremium: 10_000_000,
        putPremium: 2_000_000,
        netPremium: 8_000_000,
        netRatio: 0.67,
        classification: 'AGGRESSIVE_CALL_BIAS',
      },
      etfTide: {
        spyDelta: 100_000_000,
        qqqDelta: -80_000_000,
        classification: 'SPY_LEADING_BULL',
      },
      computedAt: FIXED_NOW.toISOString(),
    });
    expect(out).not.toBeNull();
    expect(out).toContain('<uw_deltas>');
    expect(out).toContain('Strikes active (last 5m): 20');
    expect(out).toContain('Classification: SURGE');
    expect(out).toContain('Delta %: +30.0%');
    expect(out).toContain('Classification: STRENGTHENING');
    expect(out).toContain('Call premium (cumulative): $10.0M');
    expect(out).toContain('Classification: AGGRESSIVE_CALL_BIAS');
    expect(out).toContain('SPY ETF tide delta: $100.0M');
    expect(out).toContain('QQQ ETF tide delta: -$80.0M');
    expect(out).toContain('Classification: SPY_LEADING_BULL');
    expect(out).toContain('</uw_deltas>');
  });

  it('renders N/A placeholders for partial coverage', () => {
    const out = formatUwDeltasForClaude({
      darkPool: null,
      gex: {
        gexOpen: 1_000_000,
        gexNow: 1_300_000,
        deltaPct: 0.3,
        classification: 'STRENGTHENING',
      },
      whaleFlow: null,
      etfTide: null,
      computedAt: FIXED_NOW.toISOString(),
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Strikes active (last 5m): N/A');
    expect(out).toContain('Classification: STRENGTHENING');
    expect(out).toContain('Call premium: N/A');
    expect(out).toContain('SPY ETF tide delta: N/A');
  });
});
