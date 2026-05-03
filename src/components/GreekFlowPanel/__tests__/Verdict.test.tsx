import { describe, it, expect } from 'vitest';
import { computeVerdict, computeVerdictTimeline } from '../verdict-logic';
import type {
  DivergenceResult,
  GreekFlowRow,
  Sign,
} from '../../../hooks/useGreekFlow';

function div(spy: Sign, qqq: Sign): DivergenceResult {
  return {
    spySign: spy,
    qqqSign: qqq,
    diverging: spy !== 0 && qqq !== 0 && spy !== qqq,
  };
}

describe('computeVerdict', () => {
  it('returns directional-bull when both deltas are positive', () => {
    const v = computeVerdict(div(1, 1), div(0, 0));
    expect(v.kind).toBe('directional-bull');
    expect(v.delta).toBe('bullish');
  });

  it('returns directional-bear when both deltas are negative', () => {
    const v = computeVerdict(div(-1, -1), div(0, 0));
    expect(v.kind).toBe('directional-bear');
    expect(v.delta).toBe('bearish');
  });

  it('returns pin-harvest when deltas disagree but vegas are both short', () => {
    const v = computeVerdict(div(1, -1), div(-1, -1));
    expect(v.kind).toBe('pin-harvest');
    expect(v.delta).toBe('mixed');
    expect(v.vega).toBe('short');
  });

  it('returns vol-expansion when deltas disagree but vegas are both long', () => {
    const v = computeVerdict(div(1, -1), div(1, 1));
    expect(v.kind).toBe('vol-expansion');
  });

  it('returns no-trade when both deltas and vegas are mixed', () => {
    const v = computeVerdict(div(1, -1), div(1, -1));
    expect(v.kind).toBe('no-trade');
  });

  it('returns no-trade when one side has zero sign', () => {
    const v = computeVerdict(div(1, 0), div(-1, 0));
    expect(v.kind).toBe('no-trade');
  });

  it('vega regime modifies the directional action text', () => {
    const compressed = computeVerdict(div(1, 1), div(-1, -1));
    expect(compressed.action).toMatch(/vol compressing/i);
    const expanding = computeVerdict(div(1, 1), div(1, 1));
    expect(expanding.action).toMatch(/vol expanding/i);
  });
});

function row(
  ticker: 'SPY' | 'QQQ',
  i: number,
  cumDelta: number,
  cumVega: number,
): GreekFlowRow {
  return {
    ticker,
    timestamp: new Date(
      new Date('2026-04-28T13:30:00Z').getTime() + i * 60_000,
    ).toISOString(),
    transactions: 0,
    volume: 0,
    dir_vega_flow: 0,
    total_vega_flow: 0,
    otm_dir_vega_flow: 0,
    otm_total_vega_flow: 0,
    dir_delta_flow: 0,
    total_delta_flow: 0,
    otm_dir_delta_flow: 0,
    otm_total_delta_flow: 0,
    cum_dir_vega_flow: 0,
    cum_total_vega_flow: 0,
    cum_otm_dir_vega_flow: cumVega,
    cum_otm_total_vega_flow: 0,
    cum_dir_delta_flow: 0,
    cum_total_delta_flow: 0,
    cum_otm_dir_delta_flow: cumDelta,
    cum_otm_total_delta_flow: 0,
  };
}

describe('computeVerdictTimeline', () => {
  it('joins SPY and QQQ rows by timestamp and emits a kind per minute', () => {
    const spy = [row('SPY', 0, -1, -1), row('SPY', 1, -2, -2)];
    const qqq = [row('QQQ', 0, -1, -1), row('QQQ', 1, -2, -2)];
    const t = computeVerdictTimeline(spy, qqq);
    expect(t.points).toHaveLength(2);
    expect(t.points[0]?.kind).toBe('directional-bear');
    expect(t.points[1]?.kind).toBe('directional-bear');
  });

  it('counts verdict transitions and tracks current-since', () => {
    const spy = [
      row('SPY', 0, -1, -1), // bear
      row('SPY', 1, -1, -1), // bear
      row('SPY', 2, 1, -1), // mixed delta + short vega → pin
      row('SPY', 3, 1, 1), // mixed delta + long vega → vol-expansion
    ];
    const qqq = [
      row('QQQ', 0, -1, -1),
      row('QQQ', 1, -1, -1),
      row('QQQ', 2, -1, -1),
      row('QQQ', 3, -1, 1),
    ];
    const t = computeVerdictTimeline(spy, qqq);
    expect(t.points.map((p) => p.kind)).toEqual([
      'directional-bear',
      'directional-bear',
      'pin-harvest',
      'vol-expansion',
    ]);
    expect(t.transitions).toBe(2);
    expect(t.currentSince).toBe(spy[3]?.timestamp);
  });

  it('skips rows where one ticker has no matching timestamp', () => {
    const spy = [row('SPY', 0, -1, -1), row('SPY', 1, -2, -2)];
    const qqq = [row('QQQ', 0, -1, -1)]; // missing minute 1
    const t = computeVerdictTimeline(spy, qqq);
    expect(t.points).toHaveLength(1);
  });
});
