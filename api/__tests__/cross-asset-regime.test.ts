// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  computeCrossAssetRegime,
  formatCrossAssetRegimeForClaude,
} from '../_lib/cross-asset-regime.js';

/**
 * Fixed "now" used by every test in this file. The mock keys off
 * `Date.now() - atIso` to bucket calls into latest/5m/30m windows;
 * a real system clock can drift during slow CI runs and flip
 * branches. `vi.setSystemTime` freezes the clock so bucketing is
 * deterministic.
 */
const FIXED_NOW = new Date('2026-04-18T15:30:00.000Z');

/**
 * The helper executes 14 independent DB queries in parallel via
 * Promise.all:
 *   - For each of the 6 symbols, a pair of (latest, prior-5min) close
 *     lookups = 12 queries.
 *   - One extra pair for CL over a 30-min lookback = 2 queries.
 *
 * Total = 14. Because Promise.all does not guarantee SQL call order,
 * we use a keyed mock: the row returned depends on which (symbol, ts
 * window) the SQL was given — detected by inspecting the SQL template
 * arguments that neon's tag template passes as parameters.
 *
 * The neon serverless driver invokes the template function with
 * `(strings, ...params)`. We match on the params.
 */

interface StubBar {
  symbol: string;
  /** Identifies whether this is the "latest" (0ms) or "prior" (lookbackMs) bar. */
  lookbackMs: 0 | 300_000 | 1_800_000;
  close: number | null;
}

function stubBars(bars: StubBar[]) {
  mockSql.mockImplementation(
    async (_strings: TemplateStringsArray, ...params: unknown[]) => {
      // Query shape used by closeAt:
      //   params = [symbol, atIso, earliestIso]
      const [symbol, atIso, earliestIso] = params as [string, string, string];
      const atMs = new Date(atIso).getTime();
      const nowMs = Date.now();
      // Difference between the query's `at` and "now" tells us which
      // lookback window this call represents (0 for latest, 300_000 for
      // 5-min prior, 1_800_000 for 30-min prior).
      const diff = nowMs - atMs;
      let lookbackMs: 0 | 300_000 | 1_800_000;
      if (diff < 150_000) lookbackMs = 0;
      else if (diff < 900_000) lookbackMs = 300_000;
      else lookbackMs = 1_800_000;

      const match = bars.find(
        (b) => b.symbol === symbol && b.lookbackMs === lookbackMs,
      );
      if (!match || match.close == null) return [];
      // The helper also validates `ts >= earliestIso`. We don't need to
      // simulate that — finding the row is enough. Reference the param to
      // silence unused-variable lint warnings.
      if (!earliestIso) return [];
      return [{ close: String(match.close) }];
    },
  );
}

describe('computeCrossAssetRegime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies RISK-ON when composite is large positive with ES up and ZN down', async () => {
    const now = FIXED_NOW;
    // ES +0.5%, NQ +0.6% → numerator = 0.011
    // ZN -0.3%, GC -0.1% → denom = -0.002
    // composite = 0.011 / -0.002 = -5.5 (NOT risk-on since denom sign flips)
    //
    // For a proper RISK-ON: numerator positive, denom NEGATIVE → composite NEGATIVE
    // but spec says "composite > 1.5 AND ES_ret > 0 AND ZN_ret < 0"
    // So we need the ratio to actually be > 1.5. With ES+0.5% NQ+0.6%
    // numerator = 0.011. For composite > 1.5 we need denom > 0 and small
    // so composite = 0.011 / 0.007 = 1.57 — denom positive (ZN up - GC up small)
    //
    // But spec ALSO requires ZN_ret < 0 for RISK-ON — so composite must be
    // arranged carefully. Let's use: ES +0.5%, NQ +0.4% → num = 0.009;
    // ZN -0.01%, GC -0.01% → denom = 0. That fails denom min.
    //
    // The only way to get composite > 1.5 AND ZN < 0 is numerator and denom
    // both negative (magnitudes): num = -(|pos|), denom = -(|pos|) → positive ratio.
    // Spec says ES_ret > 0, so num positive. Then composite > 1.5 requires
    // denom > 0 AND small. But spec requires ZN_ret < 0 → denom = ZN - GC < 0 if GC > ZN.
    //
    // So RISK-ON requires composite > 1.5 AND ES > 0 AND ZN < 0: these are
    // satisfiable when GC << ZN (both negative but GC more so). E.g.:
    //   ZN = -0.001 (-0.1%), GC = -0.007 (-0.7%) → denom = 0.006
    //   ES = +0.005, NQ = +0.006 → num = 0.011 → composite = 1.83.
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 5030 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5005 }, // +0.499%
      { symbol: 'NQ', lookbackMs: 0, close: 18060 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 17952 }, // +0.602%
      { symbol: 'ZN', lookbackMs: 0, close: 110.9 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 }, // -0.09%
      { symbol: 'RTY', lookbackMs: 0, close: 2050 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2045 },
      { symbol: 'CL', lookbackMs: 0, close: 72.5 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.3 },
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.4 },
      { symbol: 'GC', lookbackMs: 0, close: 2050 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2065 }, // -0.727%
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.composite).not.toBeNull();
    expect(result!.composite!).toBeGreaterThan(1.5);
    expect(result!.components.es).toBeGreaterThan(0);
    expect(result!.components.zn).toBeLessThan(0);
    expect(result!.regime).toBe('RISK-ON');
  });

  it('classifies RISK-OFF when composite is large negative with ES down and ZN up', async () => {
    const now = FIXED_NOW;
    // ES -0.5%, NQ -0.6% → num = -0.011
    // ZN +0.2%, GC +0.5% → denom = -0.003 → composite = 3.67 (POSITIVE)
    //
    // Spec: composite < -1.5, ES < 0, ZN > 0 (or GC > 0). Need negative composite.
    // Numerator negative, denom positive → composite negative.
    // ZN +0.5%, GC +0.1% → denom = 0.004 → composite = -2.75.
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 4975 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5000 }, // -0.5%
      { symbol: 'NQ', lookbackMs: 0, close: 17892 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 18000 }, // -0.6%
      { symbol: 'ZN', lookbackMs: 0, close: 111.55 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 }, // +0.495%
      { symbol: 'RTY', lookbackMs: 0, close: 2030 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2050 },
      { symbol: 'CL', lookbackMs: 0, close: 72.0 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.3 },
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.1 },
      { symbol: 'GC', lookbackMs: 0, close: 2052 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2050 }, // +0.0976%
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.composite).not.toBeNull();
    expect(result!.composite!).toBeLessThan(-1.5);
    expect(result!.components.es).toBeLessThan(0);
    expect(result!.components.zn).toBeGreaterThan(0);
    expect(result!.regime).toBe('RISK-OFF');
  });

  it('classifies MACRO-STRESS when CL 30-min move exceeds 2% regardless of composite', async () => {
    const now = FIXED_NOW;
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 5000 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5000 },
      { symbol: 'NQ', lookbackMs: 0, close: 18000 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 18000 },
      { symbol: 'ZN', lookbackMs: 0, close: 111.0 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 },
      { symbol: 'RTY', lookbackMs: 0, close: 2050 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2050 },
      { symbol: 'CL', lookbackMs: 0, close: 74.5 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.3 },
      // +3.43% move over 30 min triggers macro-stress
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.0 },
      { symbol: 'GC', lookbackMs: 0, close: 2050 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2050 },
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.clSpike).toBe(true);
    expect(result!.regime).toBe('MACRO-STRESS');
  });

  it('flags ES/NQ divergence when |ES_ret - NQ_ret| > 0.3%', async () => {
    const now = FIXED_NOW;
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 5050 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5000 }, // +1%
      { symbol: 'NQ', lookbackMs: 0, close: 17990 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 18000 }, // -0.056%
      { symbol: 'ZN', lookbackMs: 0, close: 111.0 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 },
      { symbol: 'RTY', lookbackMs: 0, close: 2050 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2050 },
      { symbol: 'CL', lookbackMs: 0, close: 72.0 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.0 },
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.0 },
      { symbol: 'GC', lookbackMs: 0, close: 2050 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2050 },
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.esNqDiverging).toBe(true);
  });

  it('returns MIXED and null composite when denominator ZN_ret - GC_ret is near zero', async () => {
    const now = FIXED_NOW;
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 5005 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5000 },
      { symbol: 'NQ', lookbackMs: 0, close: 18005 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 18000 },
      // ZN_ret == GC_ret → denominator is exactly 0
      { symbol: 'ZN', lookbackMs: 0, close: 111.1 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 },
      { symbol: 'RTY', lookbackMs: 0, close: 2050 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2050 },
      { symbol: 'CL', lookbackMs: 0, close: 72.0 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.0 },
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.0 },
      { symbol: 'GC', lookbackMs: 0, close: 2051.845 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2050 },
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.composite).toBeNull();
    expect(result!.regime).toBe('MIXED');
  });

  it('returns null when ES has no latest bar', async () => {
    const now = FIXED_NOW;
    stubBars([
      // ES absent entirely
      { symbol: 'NQ', lookbackMs: 0, close: 18005 },
      { symbol: 'NQ', lookbackMs: 300_000, close: 18000 },
      { symbol: 'ZN', lookbackMs: 0, close: 111.1 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 },
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).toBeNull();
  });

  it('tolerates a single missing component (NQ) without crashing', async () => {
    const now = FIXED_NOW;
    stubBars([
      { symbol: 'ES', lookbackMs: 0, close: 5005 },
      { symbol: 'ES', lookbackMs: 300_000, close: 5000 },
      // NQ missing — composite should degrade to null
      { symbol: 'ZN', lookbackMs: 0, close: 111.0 },
      { symbol: 'ZN', lookbackMs: 300_000, close: 111.0 },
      { symbol: 'RTY', lookbackMs: 0, close: 2050 },
      { symbol: 'RTY', lookbackMs: 300_000, close: 2050 },
      { symbol: 'CL', lookbackMs: 0, close: 72.0 },
      { symbol: 'CL', lookbackMs: 300_000, close: 72.0 },
      { symbol: 'CL', lookbackMs: 1_800_000, close: 72.0 },
      { symbol: 'GC', lookbackMs: 0, close: 2050 },
      { symbol: 'GC', lookbackMs: 300_000, close: 2050 },
    ]);

    const result = await computeCrossAssetRegime(now);
    expect(result).not.toBeNull();
    expect(result!.components.es).not.toBeNull();
    expect(result!.components.nq).toBeNull();
    expect(result!.composite).toBeNull();
    expect(result!.regime).toBe('MIXED');
  });
});

describe('formatCrossAssetRegimeForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatCrossAssetRegimeForClaude(null)).toBeNull();
  });

  it('renders the regime line, composite, and component percentages', () => {
    const output = formatCrossAssetRegimeForClaude({
      regime: 'RISK-ON',
      composite: 1.83,
      esNqDiverging: false,
      clSpike: false,
      components: {
        es: 0.005,
        nq: 0.006,
        zn: -0.001,
        rty: 0.002,
        cl: -0.001,
        gc: -0.007,
      },
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).not.toBeNull();
    expect(output).toContain('Regime: RISK-ON');
    expect(output).toContain('1.83');
    expect(output).toContain('ES: +0.50%');
    expect(output).toContain('NQ: +0.60%');
    expect(output).toContain('ZN: -0.10%');
    expect(output).toContain('GC: -0.70%');
  });

  it('renders N/A for null components and notes denominator issue', () => {
    const output = formatCrossAssetRegimeForClaude({
      regime: 'MIXED',
      composite: null,
      esNqDiverging: false,
      clSpike: false,
      components: {
        es: 0.001,
        nq: null,
        zn: null,
        rty: null,
        cl: null,
        gc: null,
      },
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).toContain('denominator too small');
    expect(output).toContain('NQ: N/A');
  });

  it('lists divergence and CL-spike flags when triggered', () => {
    const output = formatCrossAssetRegimeForClaude({
      regime: 'MACRO-STRESS',
      composite: null,
      esNqDiverging: true,
      clSpike: true,
      components: {
        es: 0.01,
        nq: 0.0,
        zn: 0.0,
        rty: 0.0,
        cl: 0.03,
        gc: 0.0,
      },
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).toContain('ES/NQ diverging');
    expect(output).toContain('oil spike');
  });
});
