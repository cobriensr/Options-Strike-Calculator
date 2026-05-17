import { describe, it, expect } from 'vitest';
import {
  BURST_STORM_BADGE_LABEL,
  BURST_STORM_INTENSITY_THRESHOLDS,
  computeRollupAggregates,
  formatBiasLabel,
  formatPremiumAmount,
  formatSpreadDuration,
  formatTideLabel,
  HIGH_CONVICTION_BADGE_LABEL,
  isBurstStorm,
  isHighConviction,
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
    expect(agg.totalPremium).toBeNull();
    expect(agg.maxIntensity).toBeNull();
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

  describe('maxIntensity', () => {
    it('returns null when no row provides intensity', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100 }),
        makeRow({ strike: 105 }),
      ]);
      expect(agg.maxIntensity).toBeNull();
    });

    it('returns the max intensity, ignoring null/NaN', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100, intensity: 14 }),
        makeRow({ strike: 105, intensity: null }),
        makeRow({ strike: 110, intensity: 221 }),
        makeRow({ strike: 115, intensity: Number.NaN }),
        makeRow({ strike: 120, intensity: 37 }),
      ]);
      expect(agg.maxIntensity).toBe(221);
    });

    it('handles negative intensity values (uses max even if negative)', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100, intensity: -5 }),
        makeRow({ strike: 105, intensity: -10 }),
      ]);
      expect(agg.maxIntensity).toBe(-5);
    });
  });

  describe('totalPremium', () => {
    it('returns null when no row provides premium', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100 }),
        makeRow({ strike: 105 }),
      ]);
      expect(agg.totalPremium).toBeNull();
    });

    it('sums provided premiums and ignores nulls', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100, premium: 58_051 }),
        makeRow({ strike: 105, premium: null }),
        makeRow({ strike: 110, premium: 12_000 }),
      ]);
      expect(agg.totalPremium).toBe(70_051);
    });

    it('returns 0 when every contributing row was zero', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100, premium: 0 }),
        makeRow({ strike: 105, premium: 0 }),
      ]);
      expect(agg.totalPremium).toBe(0);
    });

    it('ignores non-finite premium values', () => {
      const agg = computeRollupAggregates([
        makeRow({ strike: 100, premium: Number.NaN }),
        makeRow({ strike: 105, premium: 5_000 }),
      ]);
      expect(agg.totalPremium).toBe(5_000);
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

describe('isBurstStorm', () => {
  // MSFT 2026-05-15 golden case: 9 SilentBoom alerts, max spikeRatio
  // 221, tide counter, mixed-bias passes — burst-storm catches what
  // conviction rejects.
  it('matches the MSFT 9-alert golden case (count gate)', () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      makeRow({
        optionType: 'C',
        strike: 430 + i,
        triggeredAt: `2026-05-15T${14 + i}:30:00Z`,
        intensity: i === 5 ? 221 : 14 + i,
        premium: 50_000,
      }),
    );
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  // NVDA 2026-05-15 golden case: 18 fires, max fireCount 22 — count
  // alone catches it.
  it('matches the NVDA 18-fire golden case (count gate)', () => {
    const rows = Array.from({ length: 18 }, (_, i) =>
      makeRow({
        optionType: 'C',
        strike: 220 + i,
        triggeredAt: `2026-05-15T${13 + (i % 4)}:30:00Z`,
        intensity: i === 0 ? 22 : 1,
      }),
    );
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(agg, rows.length, BURST_STORM_INTENSITY_THRESHOLDS.lottery),
    ).toBe(true);
  });

  it('fires on max intensity alone even when count and premium are quiet', () => {
    const rows = [
      makeRow({ strike: 100, intensity: 150, premium: 1_000 }),
      makeRow({ strike: 105, intensity: 5, premium: 1_000 }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  it('fires on aggregate premium alone when count + intensity are quiet', () => {
    const rows = [
      makeRow({ strike: 100, intensity: 1, premium: 300_000 }),
      makeRow({ strike: 105, intensity: 1, premium: 300_000 }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(agg.totalPremium).toBe(600_000);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  it('rejects quiet tickers below all three thresholds', () => {
    const rows = [
      makeRow({ strike: 100, intensity: 3, premium: 5_000 }),
      makeRow({ strike: 105, intensity: 5, premium: 5_000 }),
      makeRow({ strike: 110, intensity: 7, premium: 5_000 }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(false);
  });

  it('boundary: exactly 8 fires passes the count gate', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow({ strike: 100 + i, intensity: 1 }),
    );
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  it('boundary: 7 fires below count gate (and other gates quiet) rejects', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      makeRow({ strike: 100 + i, intensity: 1, premium: 1_000 }),
    );
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(false);
  });

  it('boundary: exactly ×100 spike passes the intensity gate', () => {
    const rows = [
      makeRow({ strike: 100, intensity: 100, premium: 1_000 }),
      makeRow({ strike: 105, intensity: 5, premium: 1_000 }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  it('boundary: exactly $500K aggregate premium passes', () => {
    const rows = [
      makeRow({ strike: 100, intensity: 1, premium: 250_000 }),
      makeRow({ strike: 105, intensity: 1, premium: 250_000 }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(
      isBurstStorm(
        agg,
        rows.length,
        BURST_STORM_INTENSITY_THRESHOLDS.silentBoom,
      ),
    ).toBe(true);
  });

  it('exports a label constant for chip rendering', () => {
    expect(BURST_STORM_BADGE_LABEL).toBe('⚡ storm');
  });
});

describe('formatPremiumAmount', () => {
  it('uses K abbreviation between 1K and 1M', () => {
    expect(formatPremiumAmount(58_051)).toBe('$58K');
    expect(formatPremiumAmount(1_000)).toBe('$1K');
    expect(formatPremiumAmount(999_999)).toBe('$1000K');
  });

  it('uses M abbreviation at or above 1M with one decimal', () => {
    expect(formatPremiumAmount(1_500_000)).toBe('$1.5M');
    expect(formatPremiumAmount(2_100_000)).toBe('$2.1M');
  });

  it('renders sub-1K values without abbreviation', () => {
    expect(formatPremiumAmount(0)).toBe('$0');
    expect(formatPremiumAmount(420)).toBe('$420');
  });

  it('renders non-finite as $—', () => {
    expect(formatPremiumAmount(Number.NaN)).toBe('$—');
    expect(formatPremiumAmount(Number.POSITIVE_INFINITY)).toBe('$—');
  });

  it('handles negative input with a leading minus', () => {
    expect(formatPremiumAmount(-5_000)).toBe('-$5K');
  });
});

describe('formatBiasLabel', () => {
  it('formats each bias variant', () => {
    expect(formatBiasLabel('bull')).toBe('↑ bull');
    expect(formatBiasLabel('bear')).toBe('↓ bear');
    expect(formatBiasLabel('mixed')).toBe('~ mixed');
  });
});

describe('isHighConviction', () => {
  // XOM golden case from 2026-05-15: 3 fires, all calls, 3 distinct
  // strikes, Δ 7min. Must pass.
  it('matches the XOM golden case', () => {
    const rows = [
      makeRow({
        optionType: 'C',
        strike: 152.5,
        triggeredAt: '2026-05-15T13:39:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 155,
        triggeredAt: '2026-05-15T13:33:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 150,
        triggeredAt: '2026-05-15T13:32:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(true);
  });

  // SNDK rejection from 2026-05-15: 5 fires but a 1295P among 4 calls.
  it('rejects the SNDK mixed-bias case', () => {
    const rows = [
      makeRow({
        optionType: 'P',
        strike: 1295,
        triggeredAt: '2026-05-15T13:38:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 1320,
        triggeredAt: '2026-05-15T13:35:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 1360,
        triggeredAt: '2026-05-15T13:32:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 1375,
        triggeredAt: '2026-05-15T13:32:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 1330,
        triggeredAt: '2026-05-15T13:32:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(false);
  });

  it('rejects fewer than 3 fires', () => {
    const rows = [
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:30:00Z' }),
      makeRow({ strike: 105, triggeredAt: '2026-05-15T13:32:00Z' }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(false);
  });

  it('rejects when only one distinct strike', () => {
    const rows = [
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:30:00Z' }),
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:32:00Z' }),
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:34:00Z' }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(false);
  });

  it('rejects when spread exceeds 15 minutes', () => {
    const rows = [
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:00:00Z' }),
      makeRow({ strike: 105, triggeredAt: '2026-05-15T13:10:00Z' }),
      makeRow({ strike: 110, triggeredAt: '2026-05-15T13:16:00Z' }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(agg.spreadMinutes).toBe(16);
    expect(isHighConviction(agg, rows.length)).toBe(false);
  });

  it('accepts exactly 15-minute spread (boundary)', () => {
    const rows = [
      makeRow({ strike: 100, triggeredAt: '2026-05-15T13:00:00Z' }),
      makeRow({ strike: 105, triggeredAt: '2026-05-15T13:07:00Z' }),
      makeRow({ strike: 110, triggeredAt: '2026-05-15T13:15:00Z' }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(agg.spreadMinutes).toBe(15);
    expect(isHighConviction(agg, rows.length)).toBe(true);
  });

  it('accepts a bearish 3-put cluster', () => {
    const rows = [
      makeRow({
        optionType: 'P',
        strike: 100,
        mktTideDiff: -200,
        triggeredAt: '2026-05-15T13:30:00Z',
      }),
      makeRow({
        optionType: 'P',
        strike: 95,
        mktTideDiff: -100,
        triggeredAt: '2026-05-15T13:34:00Z',
      }),
      makeRow({
        optionType: 'P',
        strike: 105,
        mktTideDiff: -50,
        triggeredAt: '2026-05-15T13:38:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(true);
  });

  it('accepts when tide is counter (alignment is not required)', () => {
    const rows = [
      makeRow({
        optionType: 'C',
        strike: 100,
        mktTideDiff: -200,
        triggeredAt: '2026-05-15T13:30:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 105,
        mktTideDiff: -100,
        triggeredAt: '2026-05-15T13:34:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 110,
        mktTideDiff: -50,
        triggeredAt: '2026-05-15T13:38:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(agg.tide).toEqual({ dir: 'down', align: 'counter' });
    expect(isHighConviction(agg, rows.length)).toBe(true);
  });

  it('accepts when tide is unknown (Phase-4 ramp)', () => {
    const rows = [
      makeRow({
        optionType: 'C',
        strike: 100,
        mktTideDiff: null,
        triggeredAt: '2026-05-15T13:30:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 105,
        mktTideDiff: null,
        triggeredAt: '2026-05-15T13:34:00Z',
      }),
      makeRow({
        optionType: 'C',
        strike: 110,
        mktTideDiff: null,
        triggeredAt: '2026-05-15T13:38:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(agg.tide).toEqual({ dir: 'unknown', align: 'unknown' });
    expect(isHighConviction(agg, rows.length)).toBe(true);
  });

  it('exports a label constant for chip rendering', () => {
    expect(HIGH_CONVICTION_BADGE_LABEL).toBe('✦ conviction');
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
