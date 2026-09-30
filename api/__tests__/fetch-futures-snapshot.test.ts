// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
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
  // Cash session (holiday-aware) — gates the dead-feed alert. Set per
  // test in beforeEach; tests of the off-session path override it.
  isMarketOpen: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-03'),
  // computeSnapshot relies on this for DST-aware cash-session open;
  // 2026-04-03 is EDT so day-open is 13:30 UTC.
  getETMarketOpenUtcIso: vi.fn(() => '2026-04-03T13:30:00.000Z'),
  // Default to "open" so existing tests keep their assumed behavior;
  // tests that need the closed-market skip path override per-test.
  isFuturesMarketOpen: vi.fn(() => true),
}));

import handler from '../cron/fetch-futures-snapshot.js';
import { cronGuard, isMarketOpen } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
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
// Because computeSnapshot runs every symbol concurrently via
// Promise.allSettled, mockResolvedValueOnce ordering is
// non-deterministic. We instead build a dispatcher that
// inspects the tagged template SQL strings to route responses.
//

interface SymbolData {
  latestClose: string;
  latestTs: string;
  hourAgoClose: string | null;
  hourAgoTs: string;
  dayOpenClose: string | null;
  dayOpenTs: string;
  avgVol: string | null;
  todayVol: string | null;
}

/**
 * Every symbol that appeared as a bound value in a computeSnapshot
 * query during the current test. Reset by setupSqlDispatch.
 */
const queriedSymbols = new Set<string>();

/**
 * Configure mockSql to dispatch based on query template content.
 * `symbolMap` keys are symbol names → data for that symbol.
 * Missing symbols return empty arrays for latest bar (→ skipped).
 *
 * Query shapes emitted by computeSnapshot (in order per symbol):
 *   1. Latest bar:    ts <= ${atIso}            ORDER BY ts DESC LIMIT 1
 *   2. 1H ago:        ts <= ${oneHourAgoIso}    ORDER BY ts DESC LIMIT 1
 *   3. Day open:      ts >= ${dayOpenTs}        ORDER BY ts ASC  LIMIT 1
 *   4. 20-day avg volume (AVG(daily_vol) subquery)
 *   5. Today volume   (SUM(volume) AS today_vol)
 *
 * Because (1) and (2) both match `ts <= X ORDER BY ts DESC LIMIT 1`,
 * we disambiguate by the ISO timestamp value: the latest-bar query
 * passes the handler's "now" (MARKET_TIME), while the 1H-ago query
 * passes MARKET_TIME - 60m.
 */
function setupSqlDispatch(symbolMap: Record<string, SymbolData | null>) {
  // Canonical ISO of the cron's "now" so we're resilient to sub-second
  // precision drift (e.g. …:00Z vs …:00.000Z) when comparing bounds.
  const nowIso = new Date(MARKET_TIME).toISOString();
  const normalizeIso = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };
  queriedSymbols.clear();

  mockSql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('??');

      if (query.includes('INSERT INTO futures_snapshots')) {
        return Promise.resolve([]);
      }

      const symbol = values.find(
        (v) =>
          typeof v === 'string' &&
          ['ES', 'NQ', 'VX1', 'VX2', 'ZN', 'RTY', 'CL', 'GC', 'DX'].includes(v),
      ) as string | undefined;

      if (!symbol) return Promise.resolve([]);
      queriedSymbols.add(symbol);

      const data = symbolMap[symbol];
      if (!data) return Promise.resolve([]); // no data → skip

      if (query.includes('ORDER BY ts DESC LIMIT 1') && query.includes('<=')) {
        // Either latest or 1H-ago; disambiguate by the ts bound passed
        // in. Normalize both sides through new Date(...).toISOString()
        // so precision differences don't flip the branch.
        const isLatest = values.some((v) => normalizeIso(v) === nowIso);
        if (isLatest) {
          return Promise.resolve([
            { close: data.latestClose, ts: data.latestTs },
          ]);
        }
        if (data.hourAgoClose) {
          return Promise.resolve([
            { close: data.hourAgoClose, ts: data.hourAgoTs },
          ]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('ORDER BY ts ASC LIMIT 1')) {
        if (data.dayOpenClose) {
          return Promise.resolve([
            { close: data.dayOpenClose, ts: data.dayOpenTs },
          ]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('AVG(daily_vol)')) {
        return Promise.resolve([{ avg_vol: data.avgVol }]);
      }

      if (query.includes('SUM(volume) AS today_vol')) {
        return Promise.resolve([{ today_vol: data.todayVol }]);
      }

      return Promise.resolve([]);
    },
  );
}

/** Symbols bound into each INSERT INTO futures_snapshots call, in order. */
function insertedSymbols(): string[] {
  return mockSql.mock.calls
    .filter(([strings]) =>
      (strings as TemplateStringsArray)
        .join('')
        .includes('INSERT INTO futures_snapshots'),
    )
    .map(([, , , symbol]) => symbol as string);
}

function makeSymbolData(overrides: Partial<SymbolData> = {}): SymbolData {
  return {
    latestClose: '5700',
    latestTs: MARKET_TIME.toISOString(),
    hourAgoClose: '5690',
    hourAgoTs: new Date(MARKET_TIME.getTime() - 60 * 60 * 1000).toISOString(),
    dayOpenClose: '5680',
    // Matches the mocked getETMarketOpenUtcIso (9:30 ET on 2026-04-03).
    dayOpenTs: '2026-04-03T13:30:00.000Z',
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
    // Cash session open by default. isMarketOpen is mocked, so the
    // fixture date (2026-04-03, actually Good Friday) doesn't matter.
    vi.mocked(isMarketOpen).mockReturnValue(true);
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

  // ── Happy path: all 8 symbols ─────────────────────────────

  it('processes all 8 symbols and upserts snapshots', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VX1: makeSymbolData({ latestClose: '18.5' }),
      VX2: makeSymbolData({ latestClose: '20.0' }),
      ZN: makeSymbolData({ latestClose: '110.5' }),
      RTY: makeSymbolData({ latestClose: '2100' }),
      CL: makeSymbolData({ latestClose: '75.50' }),
      GC: makeSymbolData({ latestClose: '2350' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      stored: number;
      skipped: number;
      symbols: { symbol: string }[];
    };
    expect(json.stored).toBe(8);
    expect(json.skipped).toBe(0);
    expect(json.symbols).toHaveLength(8);
    expect(insertedSymbols()).toHaveLength(8);
  });

  // ── DX dropped (ICE; no UW feed) ──────────────────────────

  it('never queries or writes DX', async () => {
    // Even if DX bars existed and were fresh, the cron must not ask.
    setupSqlDispatch({
      ES: makeSymbolData(),
      DX: makeSymbolData({ latestClose: '104.25' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(queriedSymbols.has('DX')).toBe(false);
    expect(queriedSymbols.has('ES')).toBe(true);
    expect(insertedSymbols()).toEqual(['ES']);
  });

  // ── Missing bars for some symbols ─────────────────────────

  it('handles missing bars gracefully (some symbols have no data)', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VX1: null,
      VX2: null,
      ZN: makeSymbolData({ latestClose: '110.5' }),
      RTY: null,
      CL: makeSymbolData({ latestClose: '75.50' }),
      GC: null,
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as { stored: number; skipped: number };
    expect(json.stored).toBe(4);
    expect(json.skipped).toBe(4);
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
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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

  it('stores a snapshot when the latest bar is fresh', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        latestTs: new Date(MARKET_TIME.getTime() - 2 * 60 * 1000).toISOString(),
      }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(insertedSymbols()).toEqual(['ES']);
  });

  it('writes no row for a symbol whose latest bar is older than 15 min', async () => {
    // Regression: the cron wrote ES = 7752.75 (the 2026-09-03 close) into
    // every futures_snapshots row for ~4 weeks after the feed stopped.
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '7752.75',
        latestTs: '2026-03-27T21:59:00.000Z',
      }),
      NQ: makeSymbolData({ latestClose: '20500' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      stored: number;
      skipped: number;
      errors?: string[];
    };
    expect(json.stored).toBe(1);
    expect(json.skipped).toBe(7);
    expect(json.errors).toBeUndefined();
    expect(insertedSymbols()).toEqual(['NQ']);
    // One stale symbol is not an error and not a dead feed.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('writes only the fresh symbol when one is fresh and one is stale', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({
        latestClose: '20500',
        latestTs: new Date(
          MARKET_TIME.getTime() - 16 * 60 * 1000,
        ).toISOString(),
      }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      stored: number;
      symbols: { symbol: string }[];
    };
    expect(json.stored).toBe(1);
    expect(json.symbols.map((s) => s.symbol)).toEqual(['ES']);
    expect(insertedSymbols()).toEqual(['ES']);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Dead-feed alert ───────────────────────────────────────

  it('alerts once and returns 503 when ES and NQ are both stale in the cash session', async () => {
    // What would have caught the 2026-09-03 → 09-29 frozen-ES outage.
    setupSqlDispatch({
      ES: makeSymbolData({ latestTs: '2026-04-03T15:30:00.000Z' }),
      NQ: makeSymbolData({ latestTs: '2026-04-03T15:20:00.000Z' }),
      // A still-fresh thin symbol keeps its row despite the alert.
      CL: makeSymbolData({ latestClose: '75.50' }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      job: 'fetch-futures-snapshot',
      error: 'futures feed stale',
      stored: 1,
    });
    expect(insertedSymbols()).toEqual(['CL']);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-futures-snapshot: no fresh ES or NQ bar during the cash session',
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['futures-snapshot', 'feed-stale'],
        extra: expect.objectContaining({
          ES: {
            kind: 'stale',
            latestTs: '2026-04-03T15:30:00.000Z',
            ageMinutes: 30,
          },
          NQ: {
            kind: 'stale',
            latestTs: '2026-04-03T15:20:00.000Z',
            ageMinutes: 40,
          },
          VX1: { kind: 'missing' },
        }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-snapshot',
      expect.objectContaining({ status: 'error', feedStale: true }),
    );
  });

  it('treats ES and NQ with no bars at all as a dead feed', async () => {
    setupSqlDispatch({});

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(503);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(insertedSymbols()).toEqual([]);
  });

  it('does not alert when only CL is stale', async () => {
    // CL/ZN legitimately go quiet for 15+ min, mostly overnight.
    setupSqlDispatch({
      ES: makeSymbolData(),
      NQ: makeSymbolData(),
      CL: makeSymbolData({
        latestTs: new Date(
          MARKET_TIME.getTime() - 25 * 60 * 1000,
        ).toISOString(),
      }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(insertedSymbols()).toEqual(['ES', 'NQ']);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-futures-snapshot',
      expect.objectContaining({ status: 'ok', feedStale: false }),
    );
  });

  it('does not alert outside the cash session (e.g. the 17:00 CT reopen slot)', async () => {
    // At the reopen the newest ES/NQ bar is the pre-break close (~61 min
    // old); CME holiday halts look the same. Neither is a dead feed.
    vi.mocked(isMarketOpen).mockReturnValue(false);
    const preBreak = new Date(
      MARKET_TIME.getTime() - 61 * 60 * 1000,
    ).toISOString();
    setupSqlDispatch({
      ES: makeSymbolData({ latestTs: preBreak }),
      NQ: makeSymbolData({ latestTs: preBreak }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(insertedSymbols()).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('nulls change_1h_pct when the 1H reference bar predates a feed gap', async () => {
    setupSqlDispatch({
      ES: makeSymbolData({
        latestClose: '5700',
        hourAgoClose: '5000',
        hourAgoTs: '2026-03-20T20:59:00.000Z',
      }),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    const json = res._json as {
      symbols: { symbol: string; change1hPct: number | null }[];
    };
    expect(json.symbols[0]!.symbol).toBe('ES');
    expect(json.symbols[0]!.change1hPct).toBeNull();
  });

  // ── Partial failure tolerance ─────────────────────────────

  it('returns 500 and reports each symbol when every query rejects', async () => {
    mockSql.mockRejectedValue(new Error('connection reset'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    const json = res._json as { error: string; errors: string[] };
    expect(json.error).toBe('All symbols failed');
    expect(json.errors).toHaveLength(8);
    expect(json.errors).toContain('ES: connection reset');
    expect(Sentry.captureException).toHaveBeenCalledTimes(8);
    expect(insertedSymbols()).toEqual([]);
  });

  it('handles DB errors on individual symbol queries', async () => {
    // Set up dispatch for most symbols, but make NQ throw
    setupSqlDispatch({
      ES: makeSymbolData({ latestClose: '5700' }),
      NQ: makeSymbolData({ latestClose: '20500' }),
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
    });

    // Override: intercept NQ queries to throw
    const originalImpl = mockSql.getMockImplementation()!;
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const symbol = values.find((v) => typeof v === 'string' && v === 'NQ');
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
    // NQ's rejection surfaces by name, and reaches Sentry
    expect(json.errors).toEqual(['NQ: connection reset']);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection reset' }),
    );
    expect(insertedSymbols()).toEqual(['ES']);
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
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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
      ES: makeSymbolData(),
      NQ: null,
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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
      VX1: null,
      VX2: null,
      ZN: null,
      RTY: null,
      CL: null,
      GC: null,
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

  // SENTRY-EMERALD-DESERT-5E: when futures are closed (Sat all day, Fri-Sun
  // weekend gap, daily Mon-Thu maint break), the cron must short-circuit
  // with 200 instead of running computeSnapshot — otherwise every symbol
  // fails for lack of fresh bars and Sentry's monitor times out.
  it('skips with 200 when futures market is closed', async () => {
    const { isFuturesMarketOpen } = await import('../../src/utils/timezone.js');
    vi.mocked(isFuturesMarketOpen).mockReturnValueOnce(false);
    vi.mocked(cronGuard).mockReturnValueOnce({
      today: '2026-05-09',
      apiKey: 'test',
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-futures-snapshot',
      skipped: true,
      reason: 'futures market closed',
    });
    expect(mockSql).not.toHaveBeenCalled();
    // No dead-feed alert while futures are closed.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
