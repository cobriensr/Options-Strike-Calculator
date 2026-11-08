import { describe, it, expect } from 'vitest';
import { computeClusterSignal } from '../../utils/volatility-cluster';
import { getClusterMultiplier } from '../../data/vixRangeStats';

/**
 * The cluster multiplier's one formula: VolatilityCluster's panel and the
 * app-level value both read it, so they cannot drift (F24).
 *
 * Range buckets below use open 10000 so the range % is (high - low) / 100.
 * Thresholds (H-L %): lowVix p50 0.73 / p75 1.01 / p90 1.32; midVix 1.24 /
 * 1.64 / 2.15; highVix 1.99 / 2.74 / 3.78.
 */
function signalFor(vix: number, rangePct: number) {
  return computeClusterSignal({
    vix,
    spot: 10000,
    open: 10000,
    high: 10000 + rangePct * 50,
    low: 10000 - rangePct * 50,
  });
}

describe('computeClusterSignal: VIX regime x range bucket', () => {
  it.each([
    // VIX < 18
    [15, 0.5, 'Calm (<p50)', 0.914, 'VIX <18'],
    [15, 0.9, 'Normal (p50–p75)', 1.005, 'VIX <18'],
    [15, 1.2, 'Active (p75–p90)', 1.103, 'VIX <18'],
    [15, 1.5, 'Hot (>p90)', 1.235, 'VIX <18'],
    // VIX 18-25
    [20, 1.0, 'Calm (<p50)', 0.956, 'VIX 18–25'],
    [20, 1.5, 'Normal (p50–p75)', 0.969, 'VIX 18–25'],
    [20, 2.0, 'Active (p75–p90)', 1.039, 'VIX 18–25'],
    [20, 2.5, 'Hot (>p90)', 1.203, 'VIX 18–25'],
    // VIX 25+
    [30, 1.5, 'Calm (<p50)', 0.895, 'VIX 25+'],
    [30, 2.5, 'Normal (p50–p75)', 0.976, 'VIX 25+'],
    [30, 3.0, 'Active (p75–p90)', 1.192, 'VIX 25+'],
    [30, 4.0, 'Hot (>p90)', 1.872, 'VIX 25+'],
  ])(
    'VIX %d, range %d%% -> %s (%d), %s',
    (vix, rangePct, bucketLabel, mult, regime) => {
      const s = signalFor(vix, rangePct);
      expect(s.rangePct).toBeCloseTo(rangePct, 9);
      expect(s.cluster?.yesterdayPctile).toBe(bucketLabel);
      expect(s.cluster?.regime).toBe(regime);
      expect(s.mult).toBe(mult);
    },
  );

  it.each([
    [17.99, 'VIX <18'],
    [18, 'VIX 18–25'],
    [24.99, 'VIX 18–25'],
    [25, 'VIX 25+'],
  ])('VIX %d falls in %s', (vix, regime) => {
    expect(signalFor(vix, 1.5).cluster?.regime).toBe(regime);
  });

  it('returns exactly what getClusterMultiplier returns for the range', () => {
    const s = computeClusterSignal({
      vix: 22,
      spot: 6800,
      open: 6681.78,
      high: 6810.44,
      low: 6636.04,
    });
    const rangePct = ((6810.44 - 6636.04) / 6681.78) * 100;
    expect(s.rangePct).toBeCloseTo(rangePct, 12);
    expect(s.cluster).toEqual(getClusterMultiplier(22, rangePct));
    expect(s.mult).toBe(1.203);
  });
});

describe('computeClusterSignal: range as a percent of the reference price', () => {
  it('normal day: range over yesterday open', () => {
    const s = computeClusterSignal({
      vix: 20,
      spot: 6800,
      open: 6800,
      high: 6850,
      low: 6750,
    });
    expect(s.rangePct).toBeCloseTo((100 / 6800) * 100, 12);
    expect(s.cluster?.yesterdayPctile).toBe('Normal (p50–p75)');
    expect(s.mult).toBe(0.969);
  });

  it('open 0 falls back to spot as the reference', () => {
    const s = computeClusterSignal({
      vix: 20,
      spot: 5000,
      open: 0,
      high: 5100,
      low: 5000,
    });
    expect(s.rangePct).toBeCloseTo(2, 12); // 100 / 5000, not 100 / 5050
  });

  it.each([
    ['negative', -6800],
    ['NaN', Number.NaN],
    ['null', null],
    ['undefined', undefined],
  ])('an open that is %s falls back to spot', (_name, open) => {
    const s = computeClusterSignal({
      vix: 20,
      spot: 5000,
      open,
      high: 5100,
      low: 5000,
    });
    expect(s.rangePct).toBeCloseTo(2, 12);
  });

  it('no open and no spot: the high-low midpoint is the reference', () => {
    const s = computeClusterSignal({
      vix: 20,
      spot: null,
      open: null,
      high: 5100,
      low: 5000,
    });
    expect(s.rangePct).toBeCloseTo((100 / 5050) * 100, 12);
  });

  it('a spot of 0 is not a usable reference (midpoint instead)', () => {
    const s = computeClusterSignal({
      vix: 20,
      spot: 0,
      open: undefined,
      high: 5100,
      low: 5000,
    });
    expect(s.rangePct).toBeCloseTo((100 / 5050) * 100, 12);
  });

  it('a midpoint of 0 or less gives no signal rather than Infinity', () => {
    const s = computeClusterSignal({
      vix: 20,
      spot: null,
      open: null,
      high: 5,
      low: -5,
    });
    expect(s).toEqual({ rangePct: null, cluster: null, mult: 1 });
  });
});

describe('computeClusterSignal: missing or unusable input gives 1', () => {
  const base = { vix: 20, spot: 6800, open: 6800, high: 6850, low: 6750 };

  it.each([
    ['high equals low', { high: 6800, low: 6800 }],
    ['high below low', { high: 6750, low: 6850 }],
    ['high missing', { high: undefined }],
    ['low missing', { low: null }],
    ['high NaN', { high: Number.NaN }],
    ['low NaN', { low: Number.NaN }],
    ['high Infinity', { high: Number.POSITIVE_INFINITY }],
  ])('%s: no range, no cluster, mult 1', (_name, patch) => {
    expect(computeClusterSignal({ ...base, ...patch })).toEqual({
      rangePct: null,
      cluster: null,
      mult: 1,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ])('VIX %s: the range is kept, the cluster is not, mult 1', (_n, vix) => {
    const s = computeClusterSignal({ ...base, vix });
    expect(s.rangePct).toBeCloseTo((100 / 6800) * 100, 12);
    expect(s.cluster).toBeNull();
    expect(s.mult).toBe(1);
  });
});
