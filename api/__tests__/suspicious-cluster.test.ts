import { describe, it, expect } from 'vitest';
import {
  computeSuspiciousClusters,
  clusterKey,
  MIN_CLUSTER_STRIKES,
  type ClusterCandidateRow,
} from '../_lib/suspicious-cluster.js';

const row = (o: Partial<ClusterCandidateRow>): ClusterCandidateRow => ({
  underlyingSymbol: 'META',
  optionType: 'C',
  strike: 617.5,
  dte: 0,
  entryPrice: 0.34,
  spot: 613,
  askPct: 0.74,
  ...o,
});

describe('computeSuspiciousClusters', () => {
  it('flags a side with >=3 distinct cheap-OTM-ask 0DTE strikes', () => {
    const rows = [
      row({ strike: 617.5 }),
      row({ strike: 615, entryPrice: 0.91 }),
      row({ strike: 622.5, entryPrice: 1.25, askPct: 0.71 }),
    ];
    const map = computeSuspiciousClusters(rows);
    expect(map.get(clusterKey('META', 'C'))).toBe(3);
  });

  it('counts DISTINCT strikes, not rows (dedupes repeated strikes)', () => {
    const rows = [row({ strike: 617.5 }), row({ strike: 617.5 }), row({ strike: 615 })];
    expect(computeSuspiciousClusters(rows).has(clusterKey('META', 'C'))).toBe(false); // only 2 distinct
  });

  it('excludes non-members: not 0DTE, too expensive, ITM, or below ask floor', () => {
    const rows = [
      row({ strike: 617.5 }),
      row({ strike: 615 }),
      row({ strike: 600, dte: 1 }), // not 0DTE
      row({ strike: 625, entryPrice: 2.0 }), // too expensive
      row({ strike: 610, spot: 620 }), // call ITM (strike < spot)
      row({ strike: 630, askPct: 0.5 }), // below ask floor
    ];
    // only 617.5 + 615 are members -> 2 distinct -> no cluster
    expect(computeSuspiciousClusters(rows).has(clusterKey('META', 'C'))).toBe(false);
  });

  it('treats puts OTM as strike <= spot', () => {
    const rows = [
      row({ optionType: 'P', strike: 610, spot: 613 }),
      row({ optionType: 'P', strike: 612.5, spot: 613 }),
      row({ optionType: 'P', strike: 600, spot: 613 }),
    ];
    expect(computeSuspiciousClusters(rows).get(clusterKey('META', 'P'))).toBe(3);
  });

  it('keeps calls and puts on the same ticker as separate sides', () => {
    const rows = [
      row({ optionType: 'C', strike: 617.5 }),
      row({ optionType: 'C', strike: 615 }),
      row({ optionType: 'P', strike: 610, spot: 613 }),
    ];
    const map = computeSuspiciousClusters(rows);
    expect(map.has(clusterKey('META', 'C'))).toBe(false); // 2 calls
    expect(map.has(clusterKey('META', 'P'))).toBe(false); // 1 put
  });

  it('skips rows with null spot (cannot determine OTM)', () => {
    const rows = [
      row({ strike: 617.5, spot: null }),
      row({ strike: 615, spot: null }),
      row({ strike: 622.5, spot: null }),
    ];
    expect(computeSuspiciousClusters(rows).size).toBe(0);
  });
});

describe('MIN_CLUSTER_STRIKES', () => {
  it('is 3', () => expect(MIN_CLUSTER_STRIKES).toBe(3));
});
