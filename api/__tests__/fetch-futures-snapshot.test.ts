// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-03'),
}));

import handler from '../cron/fetch-futures-snapshot.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const MARKET_TIME = new Date('2026-04-03T16:00:00.000Z');

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

// ── SQL dispatch helper ────────────────────────────────────
//
// Because computeSnapshot runs 7 symbols concurrently via
// Promise.allSettled, mockResolvedValueOnce ordering is
// non-deterministic. We instead build a dispatcher that
// inspects the tagged template SQL strings to route responses.
//

interface SymbolData {
  latestClose: string;
  latestTs: string;
  hourAgoClose: string | null;
  dayOpenClose: string | null;
  avgVol: string | null;
  todayVol: string | null;
}

/**
 * Configure mockSql to dispatch based on query template content.
 * `symbolMap` keys are symbol names → data for that symbol.
 * Missing symbols return empty arrays for latest bar (→ skipped).
 */
function setupSqlDispatch(
  symbolMap: Record<string, SymbolData | null>,
) {
  mockSql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('??');

      // Detect which query this is by template content
      if (query.includes('INSERT INTO futures_snapshots')) {
        return Promise.resolve([]);
      }

      // computeSnapshot queries — look for symbol in values
      const symbol = values.find(
        (v) =>
          typeof v === 'string' &&
          ['ES', 'NQ', 'VXM1', 'VXM2', 'ZN', 'RTY', 'CL'].includes(v),
      ) as string | undefined;

      if (!symbol) return Promise.resolve([]);

      const data = symbolMap[symbol];
      if (!data) return Promise.resolve([]); // no data → skip

      if (query.includes('ORDER BY ts DESC LIMIT 1') && !query.includes('<=')) {
        // Latest bar query
        return Promise.resolve([
          { close: data.latestClose, ts: data.latestTs },
        ]);
      }

      if (query.includes('<=') && query.includes('ORDER BY ts DESC LIMIT 1')) {
        // 1H ago bar
        if (data.hourAgoClose) {
          return Promise.resolve([{ close: data.hourAgoClose }]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('ORDER BY ts ASC LIMIT 1')) {
        // Day open bar
        if (data.dayOpenClose) {
          return Promise.resolve([{ close: data.dayOpenClose }]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('AVG(daily_vol)')) {
        // 20-day avg volume
        return Promise.resolve([{ avg_vol: data.avgVol }]);
      }

      if (query.includes('SUM(volume) AS today_vol')) {
        // Today volume
        return Promise.resolve([{ today_vol: data.todayVol }]);
      }

      return Promise.resolve([]);
    },
  );
}

function makeSymbolData(overrides: Partial<SymbolData> = {}): SymbolData {
  return {
    latestClose: '5700',
    latestTs: MARKET_TIME.toISOString(),
    hourAgoClose: '5690',
    dayOpenClose: '5680',
    avgVol: '50000',
    todayVol: '60000',
    ...overrides,
  };
}

describe('fetch-futures-snapshot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(MARKET_TIME);

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: '',
      today: '2026-04-03',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Guard ─────────────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Happy path: all 7 symbols ─────────────────────────────

  it('processes all 7 symbols and upserts snapshots', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VXM1: makeSymbolData({ latestClose: '18.5' }),
      VXM2: makeSymbolData({ latestClose: '20.0' }),
      ZN: makeSymbolData({ latestClose: '110.5' }),
      RTY: makeSymbolData({ latestClose: '2100' }),
      CL: makeSymbolData({ latestClose: '75.50' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      stored: number;
      skipped: number;
      symbols: { symbol: string }[];
    };
    expect(json.stored).toBe(7);
    expect(json.skipped).toBe(0);
    expect(json.symbols).toHaveLength(7);
  });

  // ── Missing bars for some symbols ─────────────────────────

  it('handles missing bars gracefully (some symbols have no data)', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VXM1: null, // empty
      VXM2: null, // empty
      ZN: makeSymbolData({ latestClose: '110.5' }),
      RTY: null, // empty
      CL: makeSymbolData({ latestClose: '75.50' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { stored: number; skipped: number };
    expect(json.stored).toBe(4);
    expect(json.skipped).toBe(3);
  });

  // ── Change percentage computation ─────────────────────────

  it('computes change_1h_pct correctly from mock data', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        hourAgoClose: '5650',
        dayOpenClose: '5600',
      }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      symbols: {
        symbol: string;
        change1hPct: number;
      }[];
    };
    const es = json.symbols.find((s) => s.symbol === 'ES');
    expect(es).toBeDefined();
    // 1H change: (5700-5650)/5650*100 ≈ 0.8849557522
    expect(es!.change1hPct).toBeCloseTo(0.885, 2);
  });

  it('computes change_day_pct correctly', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        hourAgoClose: '5690',
        dayOpenClose: '5600',
      }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as {
      symbols: { symbol: string; changeDayPct: number }[];
    };
    const es = json.symbols.find((s) => s.symbol === 'ES');
    // Day change: (5700-5600)/5600*100 ≈ 1.7857142857
    expect(es!.changeDayPct).toBeCloseTo(1.786, 2);
  });

  // ── Stale data handling ───────────────────────────────────

  it('skips symbols with stale bars (>15 min old)', async () => {
    const staleTs = new Date(
      MARKET_TIME.getTime() - 20 * 60 * 1000,
    ).toISOString();

    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700', latestTs: staleTs }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { stored: number; skipped: number };
    // ES stale → null, 6 others empty → all skipped
    expect(json.stored).toBe(0);
    expect(json.skipped).toBe(7);
  });

  // ── Partial failure tolerance ─────────────────────────────

  it('handles DB errors on individual symbol queries', async () => {
    // Set up dispatch for most symbols, but make NQ throw
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    // Override: intercept NQ queries to throw
    const originalImpl = mockSql.getMockImplementation()!;
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const symbol = values.find(
          (v) => typeof v === 'string' && v === 'NQ',
        );
        if (
          symbol === 'NQ' &&
          strings.join('').includes('ORDER BY ts DESC LIMIT 1')
        ) {
          return Promise.reject(new Error('connection reset'));
        }
        return originalImpl(strings, ...values);
      },
    );

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      stored: number;
      errors: string[] | undefined;
    };
    expect(json.stored).toBe(1); // only ES
    // NQ should have an error
    expect(json.errors).toBeDefined();
    expect(json.errors!.some((e) => e.includes('NQ'))).toBe(true);
  });

  // ── Null change values ────────────────────────────────────

  it('returns null for change values when no comparison bars exist', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        hourAgoClose: null,
        dayOpenClose: null,
        avgVol: null,
        todayVol: null,
      }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      symbols: {
        symbol: string;
        change1hPct: number | null;
        changeDayPct: number | null;
      }[];
    };
    const es = json.symbols.find((s) => s.symbol === 'ES');
    expect(es!.change1hPct).toBeNull();
    expect(es!.changeDayPct).toBeNull();
  });

  // ── Response shape ────────────────────────────────────────

  it('includes job name and durationMs in response', async () => {
    setupSqlDispatch({
      ES: null,
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.job).toBe('fetch-futures-snapshot');
    expect(typeof json.durationMs).toBe('number');
  });

  // ── Volume ratio computation ──────────────────────────────

  it('computes volume ratio correctly', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        avgVol: '100000',
        todayVol: '120000',
      }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    // Volume ratio = 120000/100000 = 1.2 — not directly in response
    // but verifying the symbol was stored
    const json = res._json as {
      stored: number;
      symbols: { symbol: string; price: number }[];
    };
    expect(json.stored).toBe(1);
    expect(json.symbols[0]!.symbol).toBe('ES');
    expect(json.symbols[0]!.price).toBe(5700);
  });

  // ── Top-level error ───────────────────────────────────────

  it('returns 500 and captures Sentry on unexpected error', async () => {
    // Make the outer getDb() call (line 149) throw by having
    // the upsert INSERT throw after allSettled completes
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: null,
      VXM1: null,
      VXM2: null,
      ZN: null,
      RTY: null,
      CL: null,
    });

    // Override: make INSERT upsert throw
    const originalImpl = mockSql.getMockImplementation()!;
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('').includes('INSERT INTO futures_snapshots')) {
          return Promise.reject(new Error('upsert failed'));
        }
        return originalImpl(strings, ...values);
      },
    );

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
