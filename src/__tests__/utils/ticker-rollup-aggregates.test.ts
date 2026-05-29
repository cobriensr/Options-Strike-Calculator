import { describe, it, expect } from 'vitest';
import {
  BURST_STORM_BADGE_LABEL,
  BURST_STORM_INTENSITY_THRESHOLDS,
  computeRollupAggregates,
  findEarliestConvictionWindow,
  formatBiasLabel,
  formatFlowLabel,
  formatPremiumAmount,
  formatSpreadDuration,
  formatTideLabel,
  HIGH_CONVICTION_BADGE_LABEL,
  isBurstStorm,
  isHighConviction,
  isStrongConviction,
  STRONG_CONVICTION_BADGE_LABEL,
  STRONG_CONVICTION_MAX_ENTRY,
  STRONG_CONVICTION_PM_START_CT_HOUR,
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
    tickerNetFlowAtFire: null,
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

describe('isStrongConviction', () => {
  // A clean ✦ conviction cluster: 3 calls, 3 strikes, within 15 min,
  // all in the AM (13:30Z = 8:30 CT). `over` lets each case set
  // entryPrice / triggeredAt per row.
  function cluster(over: Partial<RollupAlertSummary>[]): RollupAlertSummary[] {
    const base = [
      { strike: 100, triggeredAt: '2026-05-15T13:30:00Z' },
      { strike: 105, triggeredAt: '2026-05-15T13:34:00Z' },
      { strike: 110, triggeredAt: '2026-05-15T13:38:00Z' },
    ];
    return base.map((b, i) =>
      makeRow({ optionType: 'C', entryPrice: 0.5, ...b, ...over[i] }),
    );
  }

  it('accepts a cheap, pre-PM conviction cluster', () => {
    const rows = cluster([
      { entryPrice: 0.3 },
      { entryPrice: 0.45 },
      { entryPrice: 0.2 },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(true);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(true);
  });

  it('rejects when the base conviction predicate fails (only 2 fires)', () => {
    const rows = [
      makeRow({
        strike: 100,
        entryPrice: 0.3,
        triggeredAt: '2026-05-15T13:30:00Z',
      }),
      makeRow({
        strike: 105,
        entryPrice: 0.3,
        triggeredAt: '2026-05-15T13:32:00Z',
      }),
    ];
    const agg = computeRollupAggregates(rows);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(false);
  });

  it('rejects when any fire is above the cheap ceiling', () => {
    const rows = cluster([
      { entryPrice: 0.3 },
      { entryPrice: 1.5 }, // one pricey ticket disqualifies the cluster
      { entryPrice: 0.2 },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(true);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(false);
  });

  it('rejects when a fire is missing its entry price', () => {
    const rows = cluster([{ entryPrice: 0.3 }, { entryPrice: null }, {}]);
    const agg = computeRollupAggregates(rows);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(false);
  });

  it('accepts at the cheap-ceiling boundary (entry == $1.00)', () => {
    const rows = cluster([
      { entryPrice: STRONG_CONVICTION_MAX_ENTRY },
      { entryPrice: STRONG_CONVICTION_MAX_ENTRY },
      { entryPrice: STRONG_CONVICTION_MAX_ENTRY },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(true);
  });

  it('rejects a PM cluster (>= 12:30 CT)', () => {
    // 18:00/18:04/18:08Z = 13:00–13:08 CT — cheap and clean, but PM.
    const rows = cluster([
      { entryPrice: 0.3, triggeredAt: '2026-05-15T18:00:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T18:04:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T18:08:00Z' },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isHighConviction(agg, rows.length)).toBe(true);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(false);
  });

  it('treats exactly 12:30 CT as PM (excluded)', () => {
    // 17:30Z = 12:30 CT (CDT) — the PM boundary is inclusive.
    const rows = cluster([
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:30:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:31:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:32:00Z' },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(false);
  });

  it('accepts a cluster ending just before PM (12:29 CT)', () => {
    // 17:21/17:25/17:29Z = 12:21–12:29 CT — all < 12:30, still qualifies.
    const rows = cluster([
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:21:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:25:00Z' },
      { entryPrice: 0.3, triggeredAt: '2026-05-15T17:29:00Z' },
    ]);
    const agg = computeRollupAggregates(rows);
    expect(isStrongConviction(agg, rows.length, rows)).toBe(true);
  });

  it('exposes the canonical constants and label', () => {
    expect(STRONG_CONVICTION_MAX_ENTRY).toBe(1.0);
    expect(STRONG_CONVICTION_PM_START_CT_HOUR).toBe(12.5);
    expect(STRONG_CONVICTION_BADGE_LABEL).toBe('✦✦ conviction');
  });
});

describe('findEarliestConvictionWindow', () => {
  // Helper to build a clean-bias multi-strike row sequence at the
  // given epoch-ms offsets from a base time.
  const baseMs = Date.parse('2026-05-15T13:30:00Z');
  function rowAt(offsetMin: number, strike: number): RollupAlertSummary {
    return makeRow({
      optionType: 'C',
      strike,
      triggeredAt: new Date(baseMs + offsetMin * 60_000).toISOString(),
    });
  }

  it('returns null when fewer than MIN_FIRES (=3) rows', () => {
    expect(findEarliestConvictionWindow([])).toBeNull();
    expect(findEarliestConvictionWindow([rowAt(0, 100)])).toBeNull();
    expect(
      findEarliestConvictionWindow([rowAt(0, 100), rowAt(1, 101)]),
    ).toBeNull();
  });

  it('returns null when no 15-min window has 3+ qualifying fires', () => {
    // 3 fires but spread over 30 min — no window contains all 3
    const rows = [rowAt(0, 100), rowAt(16, 101), rowAt(30, 102)];
    expect(findEarliestConvictionWindow(rows)).toBeNull();
  });

  it('returns the earliest qualifying window when one exists', () => {
    // First 3 are inside 15 min (qualifies). The 4th is far away and
    // would push the spread past 15 min if the whole set were used,
    // but the earliest 3-fire window still qualifies on its own.
    const rows = [rowAt(0, 100), rowAt(2, 101), rowAt(6, 102), rowAt(40, 103)];
    const result = findEarliestConvictionWindow(rows);
    expect(result?.firstFireMs).toBe(baseMs);
    expect(result?.fireCount).toBe(3);
  });

  it('returns null when the only window has mixed bias', () => {
    const rows = [
      rowAt(0, 100),
      { ...rowAt(2, 101), optionType: 'P' as const },
      rowAt(6, 102),
    ];
    expect(findEarliestConvictionWindow(rows)).toBeNull();
  });

  it('returns null when the only window has a single strike', () => {
    const rows = [rowAt(0, 100), rowAt(2, 100), rowAt(6, 100)];
    expect(findEarliestConvictionWindow(rows)).toBeNull();
  });

  it('sorts unsorted input by timestamp before scanning', () => {
    const rows = [rowAt(6, 102), rowAt(0, 100), rowAt(2, 101)];
    const result = findEarliestConvictionWindow(rows);
    expect(result?.firstFireMs).toBe(baseMs);
    expect(result?.fireCount).toBe(3);
  });

  it('drops rows with non-finite triggeredAt', () => {
    const rows = [
      makeRow({ triggeredAt: 'not-a-date' }),
      rowAt(0, 100),
      rowAt(2, 101),
      rowAt(6, 102),
    ];
    const result = findEarliestConvictionWindow(rows);
    expect(result?.firstFireMs).toBe(baseMs);
    expect(result?.fireCount).toBe(3);
  });

  it('reports the FULL count when the qualifying window spans more than MIN_FIRES', () => {
    // 5 fires inside 12 minutes — fireCount on the window is 5
    const rows = [
      rowAt(0, 100),
      rowAt(2, 101),
      rowAt(5, 102),
      rowAt(8, 103),
      rowAt(12, 104),
    ];
    const result = findEarliestConvictionWindow(rows);
    expect(result?.firstFireMs).toBe(baseMs);
    expect(result?.fireCount).toBe(5);
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

describe('computeRollupAggregates — flow aggregation', () => {
  it('returns flow: aligned when bull bias and all flows positive', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'C', tickerNetFlowAtFire: 5_000_000 }),
      makeRow({ optionType: 'C', tickerNetFlowAtFire: 3_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'up', align: 'aligned' });
  });

  it('returns flow: aligned when bear bias and all flows negative', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'P', tickerNetFlowAtFire: -5_000_000 }),
      makeRow({ optionType: 'P', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'down', align: 'aligned' });
  });

  it('returns flow: counter when bull bias but flows negative', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'C', tickerNetFlowAtFire: -1_000_000 }),
      makeRow({ optionType: 'C', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'down', align: 'counter' });
  });

  it('returns flow: mixed when group has both call and put alerts', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'C', tickerNetFlowAtFire: 1_000_000 }),
      makeRow({ optionType: 'P', tickerNetFlowAtFire: 1_000_000 }),
    ]);
    expect(agg.flow.dir).toBe('mixed');
    expect(agg.flow.align).toBe('mixed');
  });

  it('returns flow: mixed when single-bias group has split flow signs', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'C', tickerNetFlowAtFire: 3_000_000 }),
      makeRow({ optionType: 'C', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow.dir).toBe('mixed');
  });

  it('returns flow: unknown when every row has null tickerNetFlowAtFire', () => {
    const agg = computeRollupAggregates([
      makeRow({ optionType: 'C', tickerNetFlowAtFire: null }),
      makeRow({ optionType: 'C', tickerNetFlowAtFire: null }),
    ]);
    expect(agg.flow).toEqual({ dir: 'unknown', align: 'unknown' });
  });
});

describe('formatFlowLabel', () => {
  it('renders "flow ↑ aligned"', () => {
    expect(formatFlowLabel({ dir: 'up', align: 'aligned' })).toBe(
      'flow ↑ aligned',
    );
  });

  it('renders "flow ↓ counter"', () => {
    expect(formatFlowLabel({ dir: 'down', align: 'counter' })).toBe(
      'flow ↓ counter',
    );
  });

  it('renders "flow mixed"', () => {
    expect(formatFlowLabel({ dir: 'mixed', align: 'mixed' })).toBe(
      'flow mixed',
    );
  });

  it('renders "flow —" for unknown', () => {
    expect(formatFlowLabel({ dir: 'unknown', align: 'unknown' })).toBe(
      'flow —',
    );
  });
});
