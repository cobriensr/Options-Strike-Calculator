// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  computeMicrostructureSignals,
  formatMicrostructureForClaude,
} from '../_lib/microstructure-signals.js';

/**
 * Fixed "now" used by every test. `computeMicrostructureSignals`
 * dispatches 5 SQL queries in parallel (two OFI windows, two spread
 * windows, one TOB). We don't rely on call order — instead we
 * classify each call by its template text + params and return the
 * appropriate stubbed rows.
 */
const FIXED_NOW = new Date('2026-04-18T15:30:00.000Z');
const FIXED_NOW_MS = FIXED_NOW.getTime();

/** Tag that identifies what the helper is asking for. */
type QueryKind =
  | 'ofi_1m'
  | 'ofi_5m'
  | 'spread_baseline'
  | 'spread_current'
  | 'tob_latest';

interface StubResponses {
  ofi1m?: {
    buyVolume: number;
    sellVolume: number;
    totalTrades: number;
  } | null;
  ofi5m?: {
    buyVolume: number;
    sellVolume: number;
    totalTrades: number;
  } | null;
  /** Array of per-minute baseline spread readings (each entry is one quote). */
  spreadBaselineRows?: Array<{ tsMs: number; spread: number }>;
  spreadCurrentRows?: Array<{ tsMs: number; spread: number }>;
  /** Most recent TOB quote (or null to simulate empty table). */
  tobLatest?: { tsMs: number; bidSize: number; askSize: number } | null;
}

/**
 * Classify an incoming SQL call by the shape of its template strings.
 * The neon tag-template driver calls the mock as
 *   mockSql(strings: TemplateStringsArray, ...params: unknown[])
 * so we inspect the joined template text.
 */
function classify(strings: TemplateStringsArray, params: unknown[]): QueryKind {
  const joined = strings.join('');
  if (joined.includes('FROM futures_trade_ticks')) {
    // Distinguish 1m vs 5m windows by the earliest-ts param (first
    // param after symbol, which is the window start ISO).
    const earliestIso = params[1] as string;
    const earliestMs = new Date(earliestIso).getTime();
    const diff = FIXED_NOW_MS - earliestMs;
    // 1m window = 60_000ms, 5m = 300_000ms — classify at 150_000ms threshold.
    return diff < 150_000 ? 'ofi_1m' : 'ofi_5m';
  }
  if (joined.includes('FROM futures_top_of_book')) {
    if (joined.includes('ORDER BY ts DESC')) return 'tob_latest';
    // Spread queries: baseline uses 30-min start; current uses 1-min start.
    const earliestIso = params[1] as string;
    const earliestMs = new Date(earliestIso).getTime();
    const diff = FIXED_NOW_MS - earliestMs;
    return diff > 900_000 ? 'spread_baseline' : 'spread_current';
  }
  throw new Error(`Unrecognized SQL call: ${joined}`);
}

function installMock(responses: StubResponses) {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const kind = classify(strings, params);
      switch (kind) {
        case 'ofi_1m': {
          const r = responses.ofi1m;
          if (r === null || r === undefined) {
            return [{ buy_volume: 0, sell_volume: 0, total_trades: 0 }];
          }
          return [
            {
              buy_volume: r.buyVolume,
              sell_volume: r.sellVolume,
              total_trades: r.totalTrades,
            },
          ];
        }
        case 'ofi_5m': {
          const r = responses.ofi5m;
          if (r === null || r === undefined) {
            return [{ buy_volume: 0, sell_volume: 0, total_trades: 0 }];
          }
          return [
            {
              buy_volume: r.buyVolume,
              sell_volume: r.sellVolume,
              total_trades: r.totalTrades,
            },
          ];
        }
        case 'spread_baseline': {
          const rows = responses.spreadBaselineRows ?? [];
          return rows.map((r) => ({
            ts: new Date(r.tsMs).toISOString(),
            spread: r.spread,
          }));
        }
        case 'spread_current': {
          const rows = responses.spreadCurrentRows ?? [];
          return rows.map((r) => ({
            ts: new Date(r.tsMs).toISOString(),
            spread: r.spread,
          }));
        }
        case 'tob_latest': {
          const r = responses.tobLatest;
          if (r === null || r === undefined) return [];
          return [
            {
              ts: new Date(r.tsMs).toISOString(),
              bid_size: r.bidSize,
              ask_size: r.askSize,
            },
          ];
        }
      }
    },
  );
}

/**
 * Build a baseline window of quotes sufficient to produce a valid
 * z-score. 30 distinct minutes, one quote per minute, spread `base`
 * ± a small jitter so stddev is nonzero.
 */
function makeBaselineRows(
  base: number,
  jitter: number,
): Array<{ tsMs: number; spread: number }> {
  const out: Array<{ tsMs: number; spread: number }> = [];
  // 30 minute buckets: each at FIXED_NOW - k*60_000, k ∈ [1, 30].
  for (let k = 1; k <= 30; k++) {
    const tsMs = FIXED_NOW_MS - k * 60_000 + 10_000; // +10s inside the bucket
    // Alternate + / - jitter to produce nonzero stddev.
    const spread = base + (k % 2 === 0 ? jitter : -jitter);
    out.push({ tsMs, spread });
  }
  return out;
}

/** Current-minute spread quotes for the last ~60 sec. */
function makeCurrentRows(
  spread: number,
  count: number,
): Array<{ tsMs: number; spread: number }> {
  const out: Array<{ tsMs: number; spread: number }> = [];
  for (let i = 0; i < count; i++) {
    // Within the last 50 seconds.
    const tsMs = FIXED_NOW_MS - (i + 1) * 10_000;
    out.push({ tsMs, spread });
  }
  return out;
}

describe('computeMicrostructureSignals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path — all three signals present, composite BALANCED', async () => {
    installMock({
      // Neutral OFI (buy ≈ sell) with enough trades to pass the floor.
      ofi1m: { buyVolume: 500, sellVolume: 500, totalTrades: 40 },
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.ofi1m).toBeCloseTo(0, 5);
    expect(result!.ofi5m).toBeCloseTo(0, 5);
    expect(result!.spreadZscore).not.toBeNull();
    expect(result!.tobPressure).toBeCloseTo(1.0, 5);
    expect(result!.composite).toBe('BALANCED');
  });

  it('fires AGGRESSIVE_BUY when OFI 5m > 0.3 and TOB > 1.5', async () => {
    installMock({
      ofi1m: { buyVolume: 800, sellVolume: 200, totalTrades: 40 },
      ofi5m: { buyVolume: 4000, sellVolume: 1000, totalTrades: 200 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.26, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 200,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.ofi5m).toBeGreaterThan(0.3);
    expect(result!.tobPressure).toBeGreaterThan(1.5);
    expect(result!.composite).toBe('AGGRESSIVE_BUY');
  });

  it('fires AGGRESSIVE_SELL when OFI 5m < -0.3 and TOB < 0.67', async () => {
    installMock({
      ofi1m: { buyVolume: 200, sellVolume: 800, totalTrades: 40 },
      ofi5m: { buyVolume: 1000, sellVolume: 4000, totalTrades: 200 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 50,
        askSize: 200,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.ofi5m).toBeLessThan(-0.3);
    expect(result!.tobPressure).toBeLessThan(0.67);
    expect(result!.composite).toBe('AGGRESSIVE_SELL');
  });

  it('fires LIQUIDITY_STRESS when spread z > 2 even if OFI + TOB are aggressive-buy', async () => {
    installMock({
      // Directional OFI + TOB would normally be AGGRESSIVE_BUY…
      ofi1m: { buyVolume: 800, sellVolume: 200, totalTrades: 40 },
      ofi5m: { buyVolume: 4000, sellVolume: 1000, totalTrades: 200 },
      // …but spread blowout fires LIQUIDITY_STRESS first.
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(1.0, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 200,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.spreadZscore).not.toBeNull();
    expect(result!.spreadZscore!).toBeGreaterThan(2.0);
    expect(result!.composite).toBe('LIQUIDITY_STRESS');
  });

  it('drops OFI to null when fewer than 20 trades in window, other signals still compute', async () => {
    installMock({
      ofi1m: { buyVolume: 10, sellVolume: 5, totalTrades: 5 },
      ofi5m: { buyVolume: 12, sellVolume: 6, totalTrades: 8 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.ofi1m).toBeNull();
    expect(result!.ofi5m).toBeNull();
    expect(result!.spreadZscore).not.toBeNull();
    expect(result!.tobPressure).toBeCloseTo(1.0, 5);
    // Composite requires all three → null when OFI is missing.
    expect(result!.composite).toBeNull();
  });

  it('drops spread z-score when fewer than 30 baseline quotes', async () => {
    installMock({
      ofi1m: { buyVolume: 500, sellVolume: 500, totalTrades: 40 },
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      // Only 10 baseline quotes — below MIN_SPREAD_BASELINE_QUOTES.
      spreadBaselineRows: makeBaselineRows(0.25, 0.01).slice(0, 10),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.spreadZscore).toBeNull();
    expect(result!.ofi1m).not.toBeNull();
    expect(result!.tobPressure).not.toBeNull();
  });

  it('drops spread z-score when stddev is exactly zero (flat baseline)', async () => {
    // All baseline quotes identical → stddev = 0 → cannot compute z.
    const flatBaseline: Array<{ tsMs: number; spread: number }> = [];
    for (let k = 1; k <= 30; k++) {
      flatBaseline.push({
        tsMs: FIXED_NOW_MS - k * 60_000 + 10_000,
        spread: 0.25,
      });
    }
    installMock({
      ofi1m: { buyVolume: 500, sellVolume: 500, totalTrades: 40 },
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      spreadBaselineRows: flatBaseline,
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.spreadZscore).toBeNull();
  });

  it('drops TOB pressure when the latest quote is older than 30 sec', async () => {
    installMock({
      ofi1m: { buyVolume: 500, sellVolume: 500, totalTrades: 40 },
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        // 60 seconds old — fails staleness check.
        tsMs: FIXED_NOW_MS - 60_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.tobPressure).toBeNull();
  });

  it('drops TOB pressure when ask_size is zero', async () => {
    installMock({
      ofi1m: { buyVolume: 500, sellVolume: 500, totalTrades: 40 },
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      spreadBaselineRows: makeBaselineRows(0.25, 0.01),
      spreadCurrentRows: makeCurrentRows(0.25, 5),
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 0,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.tobPressure).toBeNull();
  });

  it('returns top-level null when all three signals are null', async () => {
    installMock({
      ofi1m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
      ofi5m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
      spreadBaselineRows: [],
      spreadCurrentRows: [],
      tobLatest: null,
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).toBeNull();
  });
});

describe('formatMicrostructureForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatMicrostructureForClaude(null)).toBeNull();
  });

  it('renders all signals with composite when present', () => {
    const out = formatMicrostructureForClaude({
      ofi1m: 0.42,
      ofi5m: 0.38,
      spreadZscore: 0.5,
      tobPressure: 1.8,
      composite: 'AGGRESSIVE_BUY',
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('OFI 1m: +0.42');
    expect(out).toContain('OFI 5m: +0.38');
    expect(out).toContain('Spread z-score');
    expect(out).toContain('+0.50');
    expect(out).toContain('TOB pressure');
    expect(out).toContain('1.80x');
    expect(out).toContain('Composite: AGGRESSIVE_BUY');
  });

  it('renders N/A for missing signals but keeps composite line', () => {
    const out = formatMicrostructureForClaude({
      ofi1m: null,
      ofi5m: null,
      spreadZscore: 2.5,
      tobPressure: null,
      composite: 'LIQUIDITY_STRESS',
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('OFI 1m: N/A');
    expect(out).toContain('OFI 5m: N/A');
    expect(out).toContain('+2.50');
    expect(out).toContain('TOB pressure (bid/ask size): N/A');
    expect(out).toContain('Composite: LIQUIDITY_STRESS');
  });

  it('renders composite N/A when unclassifiable', () => {
    const out = formatMicrostructureForClaude({
      ofi1m: 0.1,
      ofi5m: null,
      spreadZscore: null,
      tobPressure: null,
      composite: null,
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(out).toContain('Composite: N/A');
  });
});
