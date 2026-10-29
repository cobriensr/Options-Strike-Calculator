import { describe, expect, it } from 'vitest';

import {
  buildLadderRows,
  sortAndCapRows,
} from '../components/Gexbot/strike-mover-ladder/aggregation';
import type { AggregatedRow } from '../components/Gexbot/strike-mover-ladder/types';
import { makeWinner } from './helpers/makeWinner';

const CAT = 'gex_zero/maxchange';

describe('buildLadderRows', () => {
  it('returns [] when no winners match the 0DTE gex category', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_one/maxchange', 6750, 100)],
      'classic',
    );
    expect(rows).toEqual([]);
  });

  it('keeps only the selected model endpoint', () => {
    const input = [
      makeWinner('SPX', CAT, 6750, 2_100, 'classic'),
      makeWinner('SPX', CAT, 6700, -900, 'state'),
    ];
    expect(buildLadderRows(input, 'classic').map((r) => r.strike)).toEqual([
      6750,
    ]);
    expect(buildLadderRows(input, 'state').map((r) => r.strike)).toEqual([
      6700,
    ]);
  });

  it('produces a single row when SPX is the only winner', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', CAT, 6750, 2_100)],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6750);
    expect(rows[0]!.change).toBe(2_100);
    expect(rows[0]!.symbols).toEqual(['SPX']);
    expect(rows[0]!.confirmCount).toBe(0);
    expect(rows[0]!.isLargestMover).toBe(true);
  });

  it('drops ES_SPX and NQ_NDX rows entirely', () => {
    const rows = buildLadderRows(
      [
        makeWinner('ES_SPX', CAT, 6785, 2_050),
        makeWinner('NQ_NDX', CAT, 29000, 100),
      ],
      'classic',
    );
    expect(rows).toEqual([]);
  });

  it('does not count ES_SPX as confirmation for SPX', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', CAT, 6750, 2_100),
        makeWinner('ES_SPX', CAT, 6752, 2_050),
      ],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX']);
    expect(rows[0]!.confirmCount).toBe(0);
  });

  it('bins SPY x 10 with SPX and confirms with 2 distinct underlyings', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', CAT, 6750, 2_100), makeWinner('SPY', CAT, 675, 950)],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('merges SPX and SPY bins at most 5 points apart', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', CAT, 6745, 2_100), makeWinner('SPY', CAT, 675, 1_500)],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('suppresses the confirm badge when signs disagree', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', CAT, 6750, 2_100), makeWinner('SPY', CAT, 675, -500)],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmCount).toBe(0);
  });

  it('filters non-spine tickers (QQQ, NDX, IWM) out entirely', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', CAT, 6750, 2_100),
        makeWinner('QQQ', CAT, 702, -800),
        makeWinner('NDX', CAT, 29000, 365),
        makeWinner('IWM', CAT, 272, -100),
      ],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX']);
  });

  it('rounds SPY-derived strikes to the nearest 5 for binning', () => {
    const rows = buildLadderRows(
      [makeWinner('SPY', CAT, 673.4, 800), makeWinner('SPX', CAT, 6735, 1_400)],
      'classic',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6735);
  });

  it('skips winners whose change is exactly zero', () => {
    expect(
      buildLadderRows([makeWinner('SPX', CAT, 6750, 0)], 'classic'),
    ).toEqual([]);
  });

  it('marks only the largest |change| row as isLargestMover', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', CAT, 6700, 1_500),
        makeWinner('SPX', CAT, 6800, -3_200),
      ],
      'classic',
    );
    expect(rows.find((r) => r.strike === 6800)!.isLargestMover).toBe(true);
    expect(rows.find((r) => r.strike === 6700)!.isLargestMover).toBe(false);
  });

  it('uses the SPX sample to set canonical change when SPX present', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', CAT, 6750, 2_100), makeWinner('SPY', CAT, 675, 9_999)],
      'classic',
    );
    expect(rows[0]!.change).toBe(2_100);
  });
});

describe('sortAndCapRows', () => {
  const make = (strike: number, change: number): AggregatedRow => ({
    strike,
    change,
    symbols: ['SPX'],
    confirmCount: 0,
    isLargestMover: false,
  });

  it('orders rows by strike descending', () => {
    const out = sortAndCapRows(
      [make(6700, 1), make(6800, 1), make(6750, 1)],
      6750,
    );
    expect(out.map((r) => r.strike)).toEqual([6800, 6750, 6700]);
  });

  it('caps each side at 5 rows, preferring proximity to spot', () => {
    const above = [6770, 6780, 6790, 6800, 6810, 6820, 6830].map((s) =>
      make(s, 1),
    );
    const below = [6730, 6720, 6710, 6700, 6690, 6680, 6670].map((s) =>
      make(s, 1),
    );
    const out = sortAndCapRows([...above, ...below], 6750);
    expect(out.map((r) => r.strike)).toEqual([
      6810, 6800, 6790, 6780, 6770, 6730, 6720, 6710, 6700, 6690,
    ]);
  });

  it('keeps near-spot rows in the visible set when the sides are capped', () => {
    const rows = [
      ...[6770, 6780, 6790, 6800, 6810, 6820].map((s) => make(s, 1)),
      make(6750, 1),
    ];
    const out = sortAndCapRows(rows, 6750);
    expect(out.find((r) => r.strike === 6750)).toBeDefined();
  });
});
