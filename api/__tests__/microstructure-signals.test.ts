// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  classifyCrossAssetOfi,
  computeAllSymbolSignals,
  computeMicrostructureSignals,
  formatMicrostructureDualSymbolForClaude,
  formatMicrostructureForClaude,
} from '../_lib/microstructure-signals.js';

/**
 * Fixed "now" used by every test. `computeMicrostructureSignals`
 * dispatches 6 SQL queries in parallel per symbol (three OFI windows,
 * two spread queries, one TOB). We don't rely on call order — instead
 * we classify each call by its template text + params and return the
 * appropriate stubbed rows.
 *
 * As of the Phase 5a rework the helper also takes a `symbol`
 * parameter, so all classifier helpers check the symbol param
 * (string literal in the tagged template — neon passes it as
 * `params[0]` on the OFI queries) to route responses per-symbol in
 * the dual-symbol tests.
 */
const FIXED_NOW = new Date('2026-04-18T15:30:00.000Z');
const FIXED_NOW_MS = FIXED_NOW.getTime();

/** Tag that identifies what the helper is asking for. */
type QueryKind =
  | 'ofi_1m'
  | 'ofi_5m'
  | 'ofi_1h'
  | 'spread_baseline'
  | 'spread_current'
  | 'tob_latest';

interface OfiStub {
  buyVolume: number;
  sellVolume: number;
  totalTrades: number;
}

interface StubResponses {
  ofi1m?: OfiStub | null;
  ofi5m?: OfiStub | null;
  ofi1h?: OfiStub | null;
  spreadBaseline?: Array<{ minuteMs: number; medianSpread: number }>;
  spreadCurrent?: { medianSpread: number; n: number } | null;
  tobLatest?: { tsMs: number; bidSize: number; askSize: number } | null;
}

/** Distinct thresholds between OFI windows — 1m=60k, 5m=300k, 1h=3.6m. */
function classifyOfiWindow(diffMs: number): QueryKind {
  if (diffMs < 150_000) return 'ofi_1m';
  if (diffMs < 900_000) return 'ofi_5m';
  return 'ofi_1h';
}

function classify(strings: TemplateStringsArray, params: unknown[]): QueryKind {
  const joined = strings.join('');
  if (joined.includes('FROM futures_trade_ticks')) {
    // Params: [symbol, earliestIso, nowIso]
    const earliestIso = params[1] as string;
    const earliestMs = new Date(earliestIso).getTime();
    return classifyOfiWindow(FIXED_NOW_MS - earliestMs);
  }
  if (joined.includes('FROM futures_top_of_book')) {
    if (joined.includes('ORDER BY ts DESC')) return 'tob_latest';
    if (joined.includes('GROUP BY')) return 'spread_baseline';
    if (joined.includes('COUNT(*)')) return 'spread_current';
    const earliestIso = params[1] as string;
    const earliestMs = new Date(earliestIso).getTime();
    const diff = FIXED_NOW_MS - earliestMs;
    return diff > 900_000 ? 'spread_baseline' : 'spread_current';
  }
  throw new Error(`Unrecognized SQL call: ${joined}`);
}

/** Symbol passed as first param in every query. */
function extractSymbol(params: unknown[]): string {
  return String(params[0] ?? '');
}

function installMock(responses: StubResponses) {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const kind = classify(strings, params);
      switch (kind) {
        case 'ofi_1m':
        case 'ofi_5m':
        case 'ofi_1h': {
          const r =
            kind === 'ofi_1m'
              ? responses.ofi1m
              : kind === 'ofi_5m'
                ? responses.ofi5m
                : responses.ofi1h;
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
          const rows = responses.spreadBaseline ?? [];
          return rows.map((r) => ({
            minute: new Date(r.minuteMs).toISOString(),
            median_spread: String(r.medianSpread),
          }));
        }
        case 'spread_current': {
          const r = responses.spreadCurrent;
          if (r === null || r === undefined) return [];
          return [{ median_spread: String(r.medianSpread), n: r.n }];
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

/** Install a per-symbol mock that routes by first SQL param. */
function installPerSymbolMock(bySymbol: Record<string, StubResponses>) {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const symbol = extractSymbol(params);
      const responses = bySymbol[symbol] ?? {};
      const kind = classify(strings, params);
      switch (kind) {
        case 'ofi_1m':
        case 'ofi_5m':
        case 'ofi_1h': {
          const r =
            kind === 'ofi_1m'
              ? responses.ofi1m
              : kind === 'ofi_5m'
                ? responses.ofi5m
                : responses.ofi1h;
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
          const rows = responses.spreadBaseline ?? [];
          return rows.map((r) => ({
            minute: new Date(r.minuteMs).toISOString(),
            median_spread: String(r.medianSpread),
          }));
        }
        case 'spread_current': {
          const r = responses.spreadCurrent;
          if (r === null || r === undefined) return [];
          return [{ median_spread: String(r.medianSpread), n: r.n }];
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
 * Build a 30-minute-bucket baseline that produces a nonzero stddev.
 * Each minute's median alternates base ± jitter.
 */
function makeBaseline(
  base: number,
  jitter: number,
  bucketCount = 30,
): Array<{ minuteMs: number; medianSpread: number }> {
  const out: Array<{ minuteMs: number; medianSpread: number }> = [];
  for (let k = 1; k <= bucketCount; k++) {
    const minuteMs = Math.floor((FIXED_NOW_MS - k * 60_000) / 60_000) * 60_000;
    const medianSpread = base + (k % 2 === 0 ? jitter : -jitter);
    out.push({ minuteMs, medianSpread });
  }
  return out;
}

const HEALTHY_OFI_BALANCED: OfiStub = {
  buyVolume: 500,
  sellVolume: 500,
  totalTrades: 40,
};
const HEALTHY_OFI_BUY: OfiStub = {
  buyVolume: 4000,
  sellVolume: 1000,
  totalTrades: 200,
};
const HEALTHY_OFI_SELL: OfiStub = {
  buyVolume: 1000,
  sellVolume: 4000,
  totalTrades: 200,
};

describe('computeMicrostructureSignals (single symbol)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path — all four signals present, composite BALANCED', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('ES');
    expect(result!.ofi1m).toBeCloseTo(0, 5);
    expect(result!.ofi5m).toBeCloseTo(0, 5);
    expect(result!.ofi1h).toBeCloseTo(0, 5);
    expect(result!.spreadZscore).not.toBeNull();
    expect(result!.tobPressure).toBeCloseTo(1.0, 5);
    expect(result!.composite).toBe('BALANCED');
  });

  it('carries the NQ symbol through to the result', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BUY,
      ofi5m: HEALTHY_OFI_BUY,
      ofi1h: HEALTHY_OFI_BUY,
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 200,
        askSize: 100,
      },
    });

    const result = await computeMicrostructureSignals(FIXED_NOW, 'NQ');
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('NQ');
    expect(result!.ofi1h).toBeGreaterThan(0.3);
  });

  it('passes the symbol parameter through to the OFI SQL query', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: HEALTHY_OFI_BALANCED,
      ofi1h: HEALTHY_OFI_BALANCED,
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
      tobLatest: {
        tsMs: FIXED_NOW_MS - 5_000,
        bidSize: 100,
        askSize: 100,
      },
    });

    await computeMicrostructureSignals(FIXED_NOW, 'NQ');

    // Every SQL call must have received 'NQ' as the first positional
    // param (symbol). The mock signature is (strings, ...params), so
    // call[1] is the first param after the template strings.
    const symbolParams = mockSql.mock.calls.map(
      (call: unknown[]) => call[1] as string,
    );
    // Should have 6 calls (3 OFI + 2 spread + 1 TOB)
    expect(symbolParams.length).toBe(6);
    for (const s of symbolParams) {
      expect(s).toBe('NQ');
    }
  });

  it('fires AGGRESSIVE_BUY when OFI 5m > 0.3 and TOB > 1.5', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BUY,
      ofi5m: HEALTHY_OFI_BUY,
      ofi1h: HEALTHY_OFI_BUY,
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.26, n: 5 },
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
      ofi1m: HEALTHY_OFI_SELL,
      ofi5m: HEALTHY_OFI_SELL,
      ofi1h: HEALTHY_OFI_SELL,
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
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
      ofi1m: HEALTHY_OFI_BUY,
      ofi5m: HEALTHY_OFI_BUY,
      ofi1h: HEALTHY_OFI_BUY,
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 1.0, n: 5 },
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
      ofi1h: { buyVolume: 15, sellVolume: 7, totalTrades: 10 },
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
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
    expect(result!.ofi1h).toBeNull();
    expect(result!.spreadZscore).not.toBeNull();
    expect(result!.tobPressure).toBeCloseTo(1.0, 5);
    // Composite requires all three → null when OFI is missing.
    expect(result!.composite).toBeNull();
  });

  it('drops spread z-score when fewer than 30 baseline minute buckets', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: makeBaseline(0.25, 0.01, 20),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
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

  it('drops spread z-score when current-minute n < 3', async () => {
    installMock({
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 2 },
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
    const flatBaseline: Array<{ minuteMs: number; medianSpread: number }> = [];
    for (let k = 1; k <= 30; k++) {
      flatBaseline.push({
        minuteMs: Math.floor((FIXED_NOW_MS - k * 60_000) / 60_000) * 60_000,
        medianSpread: 0.25,
      });
    }
    installMock({
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: flatBaseline,
      spreadCurrent: { medianSpread: 0.25, n: 5 },
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
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
      tobLatest: {
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
      ofi1m: HEALTHY_OFI_BALANCED,
      ofi5m: { buyVolume: 2500, sellVolume: 2500, totalTrades: 200 },
      ofi1h: { buyVolume: 30000, sellVolume: 30000, totalTrades: 2400 },
      spreadBaseline: makeBaseline(0.25, 0.01),
      spreadCurrent: { medianSpread: 0.25, n: 5 },
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

  it('returns top-level null when all signals are null', async () => {
    installMock({
      ofi1m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
      ofi5m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
      ofi1h: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
      spreadBaseline: [],
      spreadCurrent: null,
      tobLatest: null,
    });

    const result = await computeMicrostructureSignals(FIXED_NOW);
    expect(result).toBeNull();
  });
});

describe('computeAllSymbolSignals (dual-symbol)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes ES and NQ in parallel (mock call count includes both)', async () => {
    installPerSymbolMock({
      ES: {
        ofi1m: HEALTHY_OFI_BALANCED,
        ofi5m: HEALTHY_OFI_BALANCED,
        ofi1h: HEALTHY_OFI_BALANCED,
        spreadBaseline: makeBaseline(0.25, 0.01),
        spreadCurrent: { medianSpread: 0.25, n: 5 },
        tobLatest: { tsMs: FIXED_NOW_MS - 5_000, bidSize: 100, askSize: 100 },
      },
      NQ: {
        ofi1m: HEALTHY_OFI_BUY,
        ofi5m: HEALTHY_OFI_BUY,
        ofi1h: HEALTHY_OFI_BUY,
        spreadBaseline: makeBaseline(0.5, 0.02),
        spreadCurrent: { medianSpread: 0.5, n: 5 },
        tobLatest: { tsMs: FIXED_NOW_MS - 5_000, bidSize: 200, askSize: 100 },
      },
    });

    const result = await computeAllSymbolSignals(FIXED_NOW);

    // 6 queries per symbol × 2 symbols = 12 total mock calls.
    expect(mockSql.mock.calls.length).toBe(12);

    expect(result.es).not.toBeNull();
    expect(result.nq).not.toBeNull();
    expect(result.es!.symbol).toBe('ES');
    expect(result.nq!.symbol).toBe('NQ');
    // NQ should register AGGRESSIVE_BUY, ES should be BALANCED.
    expect(result.es!.composite).toBe('BALANCED');
    expect(result.nq!.composite).toBe('AGGRESSIVE_BUY');
  });

  it('isolates failures: one symbol empty, the other still computes', async () => {
    installPerSymbolMock({
      ES: {
        ofi1m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
        ofi5m: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
        ofi1h: { buyVolume: 0, sellVolume: 0, totalTrades: 0 },
        spreadBaseline: [],
        spreadCurrent: null,
        tobLatest: null,
      },
      NQ: {
        ofi1m: HEALTHY_OFI_BUY,
        ofi5m: HEALTHY_OFI_BUY,
        ofi1h: HEALTHY_OFI_BUY,
        spreadBaseline: makeBaseline(0.5, 0.02),
        spreadCurrent: { medianSpread: 0.5, n: 5 },
        tobLatest: { tsMs: FIXED_NOW_MS - 5_000, bidSize: 200, askSize: 100 },
      },
    });

    const result = await computeAllSymbolSignals(FIXED_NOW);
    expect(result.es).toBeNull();
    expect(result.nq).not.toBeNull();
    expect(result.nq!.composite).toBe('AGGRESSIVE_BUY');
  });

  it('per-symbol DB rejection does not poison the other symbol', async () => {
    mockSql.mockImplementation(
      async (strings: TemplateStringsArray, ...params: unknown[]) => {
        const symbol = String(params[0] ?? '');
        if (symbol === 'ES') {
          throw new Error('simulated ES query failure');
        }
        // For NQ, serve a happy-path response based on query kind.
        const kind = classify(strings, params);
        switch (kind) {
          case 'ofi_1m':
          case 'ofi_5m':
          case 'ofi_1h':
            return [
              {
                buy_volume: HEALTHY_OFI_BUY.buyVolume,
                sell_volume: HEALTHY_OFI_BUY.sellVolume,
                total_trades: HEALTHY_OFI_BUY.totalTrades,
              },
            ];
          case 'spread_baseline':
            return makeBaseline(0.5, 0.02).map((r) => ({
              minute: new Date(r.minuteMs).toISOString(),
              median_spread: String(r.medianSpread),
            }));
          case 'spread_current':
            return [{ median_spread: '0.5', n: 5 }];
          case 'tob_latest':
            return [
              {
                ts: new Date(FIXED_NOW_MS - 5_000).toISOString(),
                bid_size: 200,
                ask_size: 100,
              },
            ];
        }
      },
    );

    const result = await computeAllSymbolSignals(FIXED_NOW);
    expect(result.es).toBeNull();
    expect(result.nq).not.toBeNull();
    expect(result.nq!.symbol).toBe('NQ');
  });
});

describe('formatMicrostructureForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatMicrostructureForClaude(null)).toBeNull();
  });

  it('renders all signals including 1h OFI', () => {
    const out = formatMicrostructureForClaude({
      symbol: 'ES',
      ofi1m: 0.42,
      ofi5m: 0.38,
      ofi1h: 0.31,
      spreadZscore: 0.5,
      tobPressure: 1.8,
      composite: 'AGGRESSIVE_BUY',
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('OFI 1m: +0.42');
    expect(out).toContain('OFI 5m: +0.38');
    expect(out).toContain('OFI 1h: +0.31');
    expect(out).toContain('Spread z-score');
    expect(out).toContain('+0.50');
    expect(out).toContain('TOB pressure');
    expect(out).toContain('1.80x');
    expect(out).toContain('Composite: AGGRESSIVE_BUY');
  });
});

describe('formatMicrostructureDualSymbolForClaude', () => {
  it('returns null when the input is null', () => {
    expect(formatMicrostructureDualSymbolForClaude(null)).toBeNull();
  });

  it('returns null when both symbols are null', () => {
    expect(
      formatMicrostructureDualSymbolForClaude({ es: null, nq: null }),
    ).toBeNull();
  });

  it('renders ES + NQ blocks with ALIGNED_BULLISH cross-asset read', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: {
        symbol: 'ES',
        ofi1m: 0.35,
        ofi5m: 0.38,
        ofi1h: 0.4,
        spreadZscore: 0.2,
        tobPressure: 1.6,
        composite: 'AGGRESSIVE_BUY',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: 0.45,
        ofi5m: 0.5,
        ofi1h: 0.55,
        spreadZscore: 0.3,
        tobPressure: 2.0,
        composite: 'AGGRESSIVE_BUY',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).not.toBeNull();
    expect(out).toContain('<microstructure_signals>');
    expect(out).toContain('ES (latest front-month)');
    expect(out).toContain('NQ (latest front-month)');
    expect(out).toContain('OFI 1h: +0.40 → AGGRESSIVE_BUY');
    expect(out).toContain('OFI 1h: +0.55 → AGGRESSIVE_BUY');
    expect(out).toContain('Cross-asset read (1h OFI)');
    expect(out).toContain('ALIGNED_BULLISH');
    expect(out).toContain('</microstructure_signals>');
  });

  it('fires ALIGNED_BEARISH when both symbols have OFI 1h < -0.3', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: {
        symbol: 'ES',
        ofi1m: -0.35,
        ofi5m: -0.38,
        ofi1h: -0.4,
        spreadZscore: 0.2,
        tobPressure: 0.5,
        composite: 'AGGRESSIVE_SELL',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: -0.45,
        ofi5m: -0.5,
        ofi1h: -0.55,
        spreadZscore: 0.3,
        tobPressure: 0.4,
        composite: 'AGGRESSIVE_SELL',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).toContain('ALIGNED_BEARISH');
    expect(out).toContain('OFI 1h: -0.40 → AGGRESSIVE_SELL');
    expect(out).toContain('OFI 1h: -0.55 → AGGRESSIVE_SELL');
  });

  it('fires DIVERGENCE when signs disagree and |delta| > 0.4', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: {
        symbol: 'ES',
        ofi1m: -0.25,
        ofi5m: -0.3,
        ofi1h: -0.3,
        spreadZscore: 0.1,
        tobPressure: 0.8,
        composite: null,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: 0.3,
        ofi5m: 0.35,
        ofi1h: 0.35,
        spreadZscore: 0.2,
        tobPressure: 1.4,
        composite: null,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).toContain('DIVERGENCE (NQ bid, ES offered)');
  });

  it('reports MIXED when one symbol is neutral and the other mild', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: {
        symbol: 'ES',
        ofi1m: 0.05,
        ofi5m: 0.05,
        ofi1h: 0.05,
        spreadZscore: 0.1,
        tobPressure: 1.1,
        composite: null,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: 0.25,
        ofi5m: 0.25,
        ofi1h: 0.25,
        spreadZscore: 0.2,
        tobPressure: 1.2,
        composite: null,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).toContain('MIXED');
  });

  it('reports INSUFFICIENT_DATA when NQ 1h OFI is null', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: {
        symbol: 'ES',
        ofi1m: 0.35,
        ofi5m: 0.38,
        ofi1h: 0.4,
        spreadZscore: 0.2,
        tobPressure: 1.6,
        composite: 'AGGRESSIVE_BUY',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: null,
        ofi5m: null,
        ofi1h: null,
        spreadZscore: null,
        tobPressure: null,
        composite: null,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).toContain('INSUFFICIENT_DATA');
    // ES block still renders with full data.
    expect(out).toContain('OFI 1h: +0.40 → AGGRESSIVE_BUY');
    // NQ block renders N/A placeholders.
    expect(out).toContain('OFI 1h: N/A');
  });

  it('renders one-sided result when ES is null but NQ has data', () => {
    const out = formatMicrostructureDualSymbolForClaude({
      es: null,
      nq: {
        symbol: 'NQ',
        ofi1m: 0.35,
        ofi5m: 0.38,
        ofi1h: 0.4,
        spreadZscore: 0.2,
        tobPressure: 1.6,
        composite: 'AGGRESSIVE_BUY',
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });
    expect(out).not.toBeNull();
    expect(out).toContain('ES (latest front-month)');
    expect(out).toContain('OFI 1h: N/A → N/A');
    expect(out).toContain('OFI 1h: +0.40 → AGGRESSIVE_BUY');
    expect(out).toContain('INSUFFICIENT_DATA');
  });

  it('renders the Historical rank line when ranks are provided (Phase 4b)', () => {
    const signals = {
      es: {
        symbol: 'ES',
        ofi1m: 0.1,
        ofi5m: 0.1,
        ofi1h: 0.12,
        spreadZscore: 0.0,
        tobPressure: 1.05,
        composite: 'BALANCED' as const,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: 0.35,
        ofi5m: 0.38,
        ofi1h: 0.38,
        spreadZscore: 0.2,
        tobPressure: 1.6,
        composite: 'AGGRESSIVE_BUY' as const,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    };
    const ranks = {
      es: { percentile: 55, mean: 0.05, std: 0.12, count: 252 },
      nq: { percentile: 92.1, mean: 0.02, std: 0.09, count: 252 },
    };
    const out = formatMicrostructureDualSymbolForClaude(signals, ranks);
    expect(out).not.toBeNull();
    // Percentile uses an ordinal suffix and cites the historical depth.
    expect(out).toContain(
      'Historical rank: 55th percentile of the last 252 days',
    );
    expect(out).toContain(
      'Historical rank: 92nd percentile of the last 252 days',
    );
    // Line sits directly under OFI 1h for each symbol (Claude reads it
    // in context of the live value).
    expect(out).toMatch(/OFI 1h: \+0\.12 → BALANCED\n\s+Historical rank: 55th/);
    expect(out).toMatch(
      /OFI 1h: \+0\.38 → AGGRESSIVE_BUY\n\s+Historical rank: 92nd/,
    );
  });

  it('omits the Historical rank line when ranks are null or missing (backward compat)', () => {
    const signals = {
      es: {
        symbol: 'ES',
        ofi1m: 0.1,
        ofi5m: 0.1,
        ofi1h: 0.12,
        spreadZscore: 0.0,
        tobPressure: 1.05,
        composite: 'BALANCED' as const,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
      nq: {
        symbol: 'NQ',
        ofi1m: 0.35,
        ofi5m: 0.38,
        ofi1h: 0.4,
        spreadZscore: 0.2,
        tobPressure: 1.6,
        composite: 'AGGRESSIVE_BUY' as const,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    };

    // Case 1: ranks omitted entirely — no Historical rank line anywhere.
    const outNoRanks = formatMicrostructureDualSymbolForClaude(signals);
    expect(outNoRanks).not.toContain('Historical rank');

    // Case 2: ranks object present but both sides null — same outcome.
    const outNullRanks = formatMicrostructureDualSymbolForClaude(signals, {
      es: null,
      nq: null,
    });
    expect(outNullRanks).not.toContain('Historical rank');

    // Case 3: one side ranked, other null — only the ranked side renders.
    const outOneSide = formatMicrostructureDualSymbolForClaude(signals, {
      es: null,
      nq: { percentile: 88, mean: 0.03, std: 0.1, count: 252 },
    });
    expect(outOneSide).not.toBeNull();
    // ES has no Historical rank line.
    expect(outOneSide).toMatch(
      /ES \(latest front-month\):\n\s+OFI 1h: \+0\.12 → BALANCED\n\s+OFI 5m:/,
    );
    // NQ does.
    expect(outOneSide).toContain('Historical rank: 88th percentile');
  });

  it('ordinal suffixes render correctly across 1-100 boundary cases', () => {
    const makeSignals = () => ({
      es: null,
      nq: {
        symbol: 'NQ',
        ofi1m: 0.1,
        ofi5m: 0.1,
        ofi1h: 0.1,
        spreadZscore: 0.0,
        tobPressure: 1.05,
        composite: 'BALANCED' as const,
        computedAt: '2026-04-18T15:30:00.000Z',
      },
    });

    // 1st, 2nd, 3rd, 4th — baseline suffixes.
    for (const [pct, suffix] of [
      [1, 'st'],
      [2, 'nd'],
      [3, 'rd'],
      [4, 'th'],
      // Teens: 11/12/13 must be "th" not "st/nd/rd".
      [11, 'th'],
      [12, 'th'],
      [13, 'th'],
      // Non-teens at the 1/2/3 mod10: 21st, 22nd, 23rd.
      [21, 'st'],
      [22, 'nd'],
      [23, 'rd'],
      // Top / bottom.
      [0, 'th'],
      [100, 'th'],
    ] as Array<[number, string]>) {
      const out = formatMicrostructureDualSymbolForClaude(makeSignals(), {
        nq: { percentile: pct, mean: 0, std: 0, count: 252 },
      });
      expect(out).toContain(`Historical rank: ${pct}${suffix} percentile`);
    }
  });
});

describe('classifyCrossAssetOfi (Math.sign(0) edge case)', () => {
  // Regression coverage for the Phase 5a review finding: without the
  // CROSS_ASSET_MIN_ABSOLUTE guard, Math.sign(0) === 0 makes an
  // exactly-zero OFI read as "opposite sign" to any directional OFI,
  // firing a spurious DIVERGENCE label ("ES offered") when the side
  // at 0 is actually neutral.

  it('treats ES exactly 0 with NQ directional as non-divergent', () => {
    const result = classifyCrossAssetOfi(0, 0.5);
    expect(result).not.toContain('DIVERGENCE');
    // NQ alone is > 0.3 but ES sits at 0 which is below the aligned
    // threshold — falls through to MIXED.
    expect(result).toBe('MIXED');
  });

  it('treats NQ exactly 0 with ES directional as non-divergent', () => {
    const result = classifyCrossAssetOfi(-0.5, 0);
    expect(result).not.toContain('DIVERGENCE');
    expect(result).toBe('MIXED');
  });

  it('fires DIVERGENCE when both OFIs are directional and signs disagree', () => {
    const result = classifyCrossAssetOfi(-0.3, 0.35);
    expect(result).toContain('DIVERGENCE');
    // |NQ - ES| = 0.65 > 0.4 threshold, signs differ, both above
    // the CROSS_ASSET_MIN_ABSOLUTE 0.1 guard.
    expect(result).toBe('DIVERGENCE (NQ bid, ES offered)');
  });

  it('respects the CROSS_ASSET_MIN_ABSOLUTE threshold for divergence', () => {
    // Below threshold on ES (|-0.05| < 0.1) → no divergence despite
    // the |NQ - ES| = 0.55 delta and opposing signs.
    const r1 = classifyCrossAssetOfi(-0.05, 0.5);
    expect(r1).not.toContain('DIVERGENCE');
    // At threshold + ε on ES (|-0.11| >= 0.1), divergence can fire.
    // |NQ - ES| = 0.61 > 0.4, signs disagree, both directional.
    const r2 = classifyCrossAssetOfi(-0.11, 0.5);
    expect(r2).toContain('DIVERGENCE');
  });
});
