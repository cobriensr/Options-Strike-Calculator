/**
 * Unit tests for the gex.ts decomposed helpers. The 4 helpers
 * (findClosestSnapshotTs / fetchPriorGammaMap / enrichStrikes /
 * computeAggregates) are tested in isolation; the orchestrator
 * fetchGexLandscape is exercised end-to-end on Railway.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  findClosestSnapshotTs,
  fetchPriorGammaMap,
  enrichStrikes,
  computeAggregates,
  type DaemonStrikeRow,
} from '../src/gex.js';

// Helper: build a tagged-template mock that returns canned rows on the
// Nth call. neon's sql tag is callable as `sql\`...\`` and returns the
// rows directly (no .rows wrapper, no execute step).
function makeSqlMock(returns: unknown[][]): {
  // Cast to any in tests because the real neon function type is
  // generic over ArrayMode/FullResults; at the call sites we only
  // need a tagged-template-callable function returning rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any;
  calls: number;
} {
  let i = 0;
  const calls = { n: 0 };
  const fn = vi.fn((..._args: unknown[]) => {
    const ret = returns[i] ?? [];
    i++;
    calls.n++;
    return Promise.resolve(ret);
  });
  return {
    sql: fn,
    get calls() {
      return calls.n;
    },
  };
}

describe('findClosestSnapshotTs', () => {
  it('returns the timestamp from the first row', async () => {
    const { sql } = makeSqlMock([[{ ts: '2026-04-22T13:35:32Z' }]]);
    const result = await findClosestSnapshotTs(
      sql,
      '2026-04-22',
      '2026-04-22T13:35:00Z',
    );
    expect(result).toBe('2026-04-22T13:35:32Z');
  });

  it('returns null when no row is found', async () => {
    const { sql } = makeSqlMock([[]]);
    const result = await findClosestSnapshotTs(
      sql,
      '2026-04-22',
      '2026-04-22T13:35:00Z',
    );
    expect(result).toBeNull();
  });
});

describe('fetchPriorGammaMap', () => {
  it('returns empty map when no prior snapshot exists', async () => {
    const { sql } = makeSqlMock([[]]);
    const map = await fetchPriorGammaMap(
      sql,
      '2026-04-22',
      '2026-04-22T13:34:00Z',
    );
    expect(map.size).toBe(0);
  });

  it('aggregates call+put gamma OI per strike', async () => {
    const { sql } = makeSqlMock([
      [{ ts: '2026-04-22T13:34:00Z' }],
      [
        { strike: 5800, call_gamma_oi: '100', put_gamma_oi: '50' },
        { strike: 5810, call_gamma_oi: '-30', put_gamma_oi: '20' },
      ],
    ]);
    const map = await fetchPriorGammaMap(
      sql,
      '2026-04-22',
      '2026-04-22T13:34:00Z',
    );
    expect(map.get(5800)).toBe(150);
    expect(map.get(5810)).toBe(-10);
  });
});

describe('enrichStrikes', () => {
  const baseRow = {
    strike: 5800,
    price: 5805,
    call_gamma_oi: '100',
    put_gamma_oi: '50',
    call_charm_oi: null,
    put_charm_oi: null,
  };

  it('populates dollarGamma and skips classification when charm is null', () => {
    const out = enrichStrikes([baseRow], 5805, new Map(), new Map());
    expect(out).toHaveLength(1);
    expect(out[0]!.strike).toBe(5800);
    expect(out[0]!.dollarGamma).toBe(150);
    expect(out[0]!.classification).toBeUndefined();
    expect(out[0]!.signal).toBeUndefined();
  });

  it('classifies + signals when charm OI is present', () => {
    const row = { ...baseRow, call_charm_oi: '20', put_charm_oi: '-5' };
    const out = enrichStrikes([row], 5805, new Map(), new Map());
    expect(out[0]!.charm).toBe(15);
    // gamma=150 (>=0), charm=15 (>=0) => sticky-pin
    expect(out[0]!.classification).toBe('sticky-pin');
    expect(out[0]!.signal).toBeTruthy();
  });

  it('computes delta1m and delta5m vs prior maps', () => {
    const prev1m = new Map([[5800, 100]]);
    const prev5m = new Map([[5800, 50]]);
    const out = enrichStrikes([baseRow], 5805, prev1m, prev5m);
    // current=150, prev1m=100 → +50%
    expect(out[0]!.delta1m).toBeCloseTo(50, 5);
    // current=150, prev5m=50 → +200%
    expect(out[0]!.delta5m).toBeCloseTo(200, 5);
  });

  it('skips delta when prior is missing or zero', () => {
    const prev1m = new Map([[5800, 0]]);
    const out = enrichStrikes([baseRow], 5805, prev1m, new Map());
    expect(out[0]!.delta1m).toBeUndefined();
    expect(out[0]!.delta5m).toBeUndefined();
  });
});

describe('computeAggregates', () => {
  const strikes: DaemonStrikeRow[] = [
    { strike: 5820, dollarGamma: 200 },
    { strike: 5810, dollarGamma: 500 },
    { strike: 5800, dollarGamma: -300 },
    { strike: 5790, dollarGamma: -100 },
  ];

  it('computes net + signed totals', () => {
    const agg = computeAggregates(strikes, 5805);
    expect(agg.totalPosGex).toBe(700);
    expect(agg.totalNegGex).toBe(-400);
    expect(agg.netGex).toBe(300);
    expect(agg.regime).toBe('positive_gamma');
  });

  it('classifies regime as negative when net is negative', () => {
    const negStrikes: DaemonStrikeRow[] = [
      { strike: 5800, dollarGamma: -500 },
      { strike: 5810, dollarGamma: 100 },
    ];
    expect(computeAggregates(negStrikes, 5805).regime).toBe('negative_gamma');
  });

  it('classifies regime as neutral when net is zero', () => {
    const zeroStrikes: DaemonStrikeRow[] = [
      { strike: 5800, dollarGamma: -100 },
      { strike: 5810, dollarGamma: 100 },
    ];
    expect(computeAggregates(zeroStrikes, 5805).regime).toBe('neutral');
  });

  it('picks top-2 drift targets by absolute gamma above and below spot', () => {
    const agg = computeAggregates(strikes, 5805);
    // Above spot (5810, 5820): 500 > 200 → [5810, 5820]
    expect(agg.driftTargetsUp).toEqual([5810, 5820]);
    // Below spot (5800, 5790): |-300| > |-100| → [5800, 5790]
    expect(agg.driftTargetsDown).toEqual([5800, 5790]);
  });

  it('finds ATM strike as the nearest to spot', () => {
    // spot=5805 → strike 5810 (dist 5) is closer than 5800 (dist 5);
    // tie resolution keeps the FIRST candidate (the SQL ORDER BY DESC
    // puts 5820 first; iteration from there picks 5810 first when
    // dist drops). With strict `<`, ties stay on the first candidate
    // seen at that distance.
    const agg = computeAggregates(strikes, 5805);
    // Both 5800 and 5810 are 5 away. Iteration order preserves the
    // first one whose distance equals the running min — which is the
    // initial atmStrike (strikes[0] = 5820, dist 15), then 5810
    // (dist 5) wins, and 5800 ties (strict `<` → no update).
    expect(agg.atmStrike).toBe(5810);
  });
});
