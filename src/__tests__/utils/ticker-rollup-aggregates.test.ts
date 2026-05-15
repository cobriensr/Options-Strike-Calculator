import { describe, it, expect } from 'vitest';
import {
  computeRollupAggregates,
  formatBiasLabel,
  formatSpreadDuration,
  formatTideLabel,
  type RollupAlertSummary,
} from '../../utils/ticker-rollup-aggregates';

function makeRow(
  overrides: Partial<RollupAlertSummary> = {},
): RollupAlertSummary {
  return {
    optionType: 'C',
    mktTideDiff: 100,
    directionGated: false,
    triggeredAt: '2026-05-15T13:30:00Z',
    strike: 100,
    ...overrides,
  };
}

describe('computeRollupAggregates', () => {
  it('returns null bias and unknown tide on empty input', () => {
    const agg = computeRollupAggregates([]);
    expect(agg.bias).toBeNull();
    expect(agg.tide).toEqual({ dir: 'unknown', align: 'unknown' });
    expect(agg.spreadMinutes).toBeNull();
    expect(agg.gatedCount).toBe(0);
    expect(agg.strikeRange).toBeNull();
  });

  describe('bias', () => {
    it('all calls → bull', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C' }),
        makeRow({ optionType: 'C', strike: 105 }),
      ]);
      expect(agg.bias).toBe('bull');
    });

    it('all puts → bear', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'P' }),
        makeRow({ optionType: 'P', strike: 95 }),
      ]);
      expect(agg.bias).toBe('bear');
    });

    it('mixed call+put → mixed', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C' }),
        makeRow({ optionType: 'P' }),
      ]);
      expect(agg.bias).toBe('mixed');
    });
  });

  describe('tide', () => {
    it('all positive tide + bull → aligned up', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', mktTideDiff: 200 }),
        makeRow({ optionType: 'C', mktTideDiff: 50, strike: 105 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'up', align: 'aligned' });
    });

    it('all negative tide + bear → aligned down', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'P', mktTideDiff: -200 }),
        makeRow({ optionType: 'P', mktTideDiff: -50, strike: 95 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'down', align: 'aligned' });
    });

    it('positive tide + bear → counter', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'P', mktTideDiff: 100 }),
        makeRow({ optionType: 'P', mktTideDiff: 200, strike: 95 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'up', align: 'counter' });
    });

    it('mixed tide signs → mixed regardless of bias', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', mktTideDiff: 100 }),
        makeRow({ optionType: 'C', mktTideDiff: -200, strike: 105 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'mixed', align: 'mixed' });
    });

    it('mixed bias → tide mixed regardless of sign agreement', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', mktTideDiff: 100 }),
        makeRow({ optionType: 'P', mktTideDiff: 200 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'mixed', align: 'mixed' });
    });

    it('all null mktTideDiff → unknown', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', mktTideDiff: null }),
        makeRow({ optionType: 'C', mktTideDiff: null, strike: 105 }),
      ]);
      expect(agg.tide).toEqual({ dir: 'unknown', align: 'unknown' });
    });

    it('exact-zero tide values are ignored (neither pos nor neg)', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', mktTideDiff: 0 }),
        makeRow({ optionType: 'C', mktTideDiff: 0, strike: 105 }),
      ]);
      // No positive and no negative samples → mixed/unknown territory.
      // Implementation treats this as 'mixed' (pos=0, neg=0, but nonNull>0).
      expect(agg.tide).toEqual({ dir: 'mixed', align: 'mixed' });
    });
  });

  describe('spreadMinutes', () => {
    it('null for single fire', () => {
      const agg = computeRollupAggregates([makeRow()]);
      expect(agg.spreadMinutes).toBeNull();
    });

    it('null when all timestamps are identical', () => {
      const agg = computeRollupAggregates([
        makeRow({ triggeredAt: '2026-05-15T13:30:00Z' }),
        makeRow({ triggeredAt: '2026-05-15T13:30:00Z', strike: 105 }),
      ]);
      expect(agg.spreadMinutes).toBeNull();
    });

    it('rounds difference to nearest minute', () => {
      const agg = computeRollupAggregates([
        makeRow({ triggeredAt: '2026-05-15T13:30:00Z' }),
        makeRow({ triggeredAt: '2026-05-15T13:38:00Z', strike: 105 }),
      ]);
      expect(agg.spreadMinutes).toBe(8);
    });

    it('ignores invalid timestamps', () => {
      const agg = computeRollupAggregates([
        makeRow({ triggeredAt: 'not-a-date' }),
        makeRow({ triggeredAt: '2026-05-15T13:30:00Z', strike: 105 }),
      ]);
      // Only one valid timestamp remains → no spread.
      expect(agg.spreadMinutes).toBeNull();
    });
  });

  describe('gatedCount', () => {
    it('counts directionGated rows', () => {
      const agg = computeRollupAggregates([
        makeRow({ directionGated: true }),
        makeRow({ directionGated: false, strike: 105 }),
        makeRow({ directionGated: true, strike: 110 }),
      ]);
      expect(agg.gatedCount).toBe(2);
    });

    it('returns 0 when none are gated', () => {
      const agg = computeRollupAggregates([
        makeRow({ directionGated: false }),
        makeRow({ directionGated: false, strike: 105 }),
      ]);
      expect(agg.gatedCount).toBe(0);
    });
  });

  describe('strikeRange', () => {
    it('null for a single distinct strike', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100 }),
        makeRow({ strike: 100 }),
      ]);
      expect(agg.strikeRange).toBeNull();
    });

    it('treats call+put at same strike as one distinct value', () => {
      const agg = computeRollupAggregates([
        makeRow({ optionType: 'C', strike: 100 }),
        makeRow({ optionType: 'P', strike: 100 }),
      ]);
      expect(agg.strikeRange).toBeNull();
    });

    it('returns min/max/spread across distinct strikes', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 68 }),
        makeRow({ strike: 71 }),
      ]);
      expect(agg.strikeRange).toEqual({ min: 68, max: 71, spreadPts: 3 });
    });

    it('handles three or more distinct strikes', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100 }),
        makeRow({ strike: 105 }),
        makeRow({ strike: 110 }),
        makeRow({ strike: 105 }),
      ]);
      expect(agg.strikeRange).toEqual({ min: 100, max: 110, spreadPts: 10 });
    });
  });
});

describe('formatSpreadDuration', () => {
  it('renders minutes when ≤ 60', () => {
    expect(formatSpreadDuration(8)).toBe('Δ 8min');
    expect(formatSpreadDuration(60)).toBe('Δ 60min');
  });

  it('renders hours with one decimal when > 60', () => {
    expect(formatSpreadDuration(150)).toBe('Δ 2.5h');
    expect(formatSpreadDuration(61)).toBe('Δ 1.0h');
  });
});

describe('formatBiasLabel', () => {
  it('formats each bias variant', () => {
    expect(formatBiasLabel('bull')).toBe('↑ bull');
    expect(formatBiasLabel('bear')).toBe('↓ bear');
    expect(formatBiasLabel('mixed')).toBe('~ mixed');
  });
});

describe('formatTideLabel', () => {
  it('renders unknown as muted dash', () => {
    expect(formatTideLabel({ dir: 'unknown', align: 'unknown' })).toBe(
      'tide —',
    );
  });

  it('renders mixed without arrow', () => {
    expect(formatTideLabel({ dir: 'mixed', align: 'mixed' })).toBe(
      'tide mixed',
    );
  });

  it('renders aligned/counter with arrow', () => {
    expect(formatTideLabel({ dir: 'up', align: 'aligned' })).toBe(
      'tide ↑ aligned',
    );
    expect(formatTideLabel({ dir: 'down', align: 'counter' })).toBe(
      'tide ↓ counter',
    );
  });
});
