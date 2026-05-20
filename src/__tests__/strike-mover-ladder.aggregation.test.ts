import { describe, expect, it } from 'vitest';

import {
  buildLadderRows,
  sortAndCapRows,
} from '../components/Gexbot/strike-mover-ladder/aggregation';
import { makeWinner } from './helpers/makeWinner';

describe('buildLadderRows', () => {
  it('returns [] when no winners match the active category', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_one/maxchange', 6750, 100)],
      'gex',
    );
    expect(rows).toEqual([]);
  });

  it('produces a single row when SPX is the only winner', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100)],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6750);
    expect(rows[0]!.change).toBe(2_100);
    expect(rows[0]!.symbols).toEqual(['SPX']);
    expect(rows[0]!.confirmCount).toBe(0);
    expect(rows[0]!.isLargestMover).toBe(true);
  });

  it('bins ES_SPX within ±5pt of SPX into the same row', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6752, 2_050),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'ES_SPX']);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('merges three adjacent bins (SPX/ES_SPX/SPY each ≤5pt apart) into one row', () => {
    // Each nearest-5 key is 5pt from its neighbour:
    //   SPX 6745    → bin 6745
    //   ES_SPX 6750 → bin 6750  (6750 − 6745 = 5  → merges into 6745)
    //   SPY 675.5×10 = 6755 → bin 6755 (6755 − 6750 = 5 → merges into 6745)
    // Anchoring against the trailing edge (maxKeyInBucket) lets the
    // chain collapse; anchoring against the original key (6745) would
    // leave 6755 as its own bucket because |6755 − 6745| = 10 > 5.
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6745, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 2_080),
        makeWinner('SPY', 'gex_zero/maxchange', 675.5, 1_500),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'ES_SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(3);
  });

  it('bins SPY × 10 with SPX into the same row', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 950),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('emits 3✓ when SPX + ES_SPX + SPY all agree on direction', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 2_080),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 1_500),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'ES_SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(3);
  });

  it('suppresses the confirm badge when signs disagree', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, -500),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmCount).toBe(0);
  });

  it('filters non-spine tickers (QQQ, NDX, IWM) out entirely', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('QQQ', 'gex_zero/maxchange', 702, -800),
        makeWinner('NDX', 'gex_zero/maxchange', 29000, 365),
        makeWinner('IWM', 'gex_zero/maxchange', 272, -100),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX']);
  });

  it('rounds SPY-derived strikes to the nearest 5 for binning', () => {
    // SPY 673.4 × 10 = 6734 → rounds to 6735.
    // SPX 6735 should bin with this SPY sample.
    const rows = buildLadderRows(
      [
        makeWinner('SPY', 'gex_zero/maxchange', 673.4, 800),
        makeWinner('SPX', 'gex_zero/maxchange', 6735, 1_400),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6735);
  });

  it('skips winners whose Δ is exactly zero', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_zero/maxchange', 6750, 0)],
      'gex',
    );
    expect(rows).toEqual([]);
  });

  it('marks only the largest |Δ| row as isLargestMover', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6700, 1_500),
        makeWinner('SPX', 'gex_zero/maxchange', 6800, -3_200),
      ],
      'gex',
    );
    expect(rows).toHaveLength(2);
    const big = rows.find((r) => r.strike === 6800);
    const small = rows.find((r) => r.strike === 6700);
    expect(big!.isLargestMover).toBe(true);
    expect(small!.isLargestMover).toBe(false);
  });

  it('uses the SPX sample to set canonical change when SPX present', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 9_999),
      ],
      'gex',
    );
    expect(rows[0]!.change).toBe(2_100);
  });
});

describe('sortAndCapRows', () => {
  const make = (
    strike: number,
    change: number,
  ): import('../components/Gexbot/strike-mover-ladder/types').AggregatedRow => ({
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
    // Spot 6750; ATM band ≈ ±16.875 pts. All test strikes must sit
    // outside the band so they classify cleanly as ceilings/floors.
    const ceilings = [6770, 6780, 6790, 6800, 6810, 6820, 6830].map((s) =>
      make(s, 1),
    );
    const floors = [6730, 6720, 6710, 6700, 6690, 6680, 6670].map((s) =>
      make(s, 1),
    );
    const out = sortAndCapRows([...ceilings, ...floors], 6750);

    // 5 ceilings closest to spot: 6770, 6780, 6790, 6800, 6810 (NOT 6820/6830).
    // 5 floors closest to spot: 6730, 6720, 6710, 6700, 6690 (NOT 6680/6670).
    expect(out.map((r) => r.strike)).toEqual([
      6810, 6800, 6790, 6780, 6770, 6730, 6720, 6710, 6700, 6690,
    ]);
  });

  it('keeps ATM rows in the visible set even when ceilings/floors are capped', () => {
    // 6770-6820 are ceilings (outside band); 6750 is exact ATM and
    // must survive even when the ceiling side is fully populated.
    const rows = [
      ...[6770, 6780, 6790, 6800, 6810, 6820].map((s) => make(s, 1)),
      make(6750, 1), // exact ATM
    ];
    const out = sortAndCapRows(rows, 6750);
    expect(out.find((r) => r.strike === 6750)).toBeDefined();
  });
});
