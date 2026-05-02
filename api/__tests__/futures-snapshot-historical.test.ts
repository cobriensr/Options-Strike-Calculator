// @vitest-environment node

/**
 * Tests for GET /api/futures/snapshot with the `?at=<ISO>` query
 * param (historical derivation path). The default path (no `at`) is
 * covered in futures-snapshot.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: vi.fn(
      (fn: (scope: { setTransactionName: () => void }) => unknown) =>
        fn({ setTransactionName: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

// Pass-through (real impl) is fine for the historical tests — the
// picked timestamp is what drives tradeDate, not the current time.
vi.mock('../../src/utils/timezone.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/utils/timezone.js')
  >('../../src/utils/timezone.js');
  return actual;
});

import handler from '../futures/snapshot.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';

// Historical bar timestamp fixture (1 min before picked `at`)
const PICKED_AT = '2026-04-17T19:30:00.000Z';
const BAR_TS = '2026-04-17T19:29:00.000Z';

// ── SQL dispatcher ──────────────────────────────────────────

interface SymbolData {
  latestClose: string;
  latestTs: string;
  hourAgoClose: string | null;
  dayOpenClose: string | null;
  avgVol: string | null;
  todayVol: string | null;
}

function makeSymbolData(overrides: Partial<SymbolData> = {}): SymbolData {
  return {
    latestClose: '5700',
    latestTs: BAR_TS,
    hourAgoClose: '5690',
    dayOpenClose: '5680',
    avgVol: '50000',
    todayVol: '60000',
    ...overrides,
  };
}

/**
 * Install a dispatcher on mockSql that routes queries by template
 * content. Mirrors the shape used in fetch-futures-snapshot.test.ts,
 * but tuned to the historical endpoint's extra queries (MIN(ts),
 * market_snapshots SPX lookup).
 */
function setupHistoricalDispatch(opts: {
  symbols: Record<string, SymbolData | null>;
  oldestTs: string | null;
  spx?: string | null;
}) {
  const { symbols, oldestTs, spx = null } = opts;
  // Canonical ISO of the picked `at` so we can compare regardless of
  // the exact sub-second formatting the endpoint happens to emit.
  const pickedAtIso = new Date(PICKED_AT).toISOString();
  const normalizeIso = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };

  mockSql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('??');

      if (query.includes('MIN(ts)') && query.includes('futures_bars')) {
        return Promise.resolve([{ oldest: oldestTs }]);
      }

      if (query.includes('FROM market_snapshots')) {
        if (spx == null) return Promise.resolve([]);
        return Promise.resolve([{ spx }]);
      }

      // computeSnapshot queries
      const symbol = values.find(
        (v) =>
          typeof v === 'string' &&
          ['ES', 'NQ', 'VX1', 'VX2', 'ZN', 'RTY', 'CL', 'GC', 'DX'].includes(v),
      ) as string | undefined;

      if (!symbol) return Promise.resolve([]);
      const data = symbols[symbol];
      if (!data) return Promise.resolve([]);

      if (query.includes('ORDER BY ts DESC LIMIT 1') && query.includes('<=')) {
        // Latest-bar query uses `atIso` as the bound; 1H-ago query uses
        // `at - 60m`. Normalize both sides through `new Date(x).toISOString()`
        // so we're resilient to sub-second formatting drift.
        const isLatest = values.some((v) => normalizeIso(v) === pickedAtIso);
        if (isLatest) {
          return Promise.resolve([
            { close: data.latestClose, ts: data.latestTs },
          ]);
        }
        if (data.hourAgoClose) {
          return Promise.resolve([{ close: data.hourAgoClose }]);
        }
        return Promise.resolve([]);
      }

      if (query.includes('ORDER BY ts ASC LIMIT 1')) {
        if (data.dayOpenClose) {
          return Promise.resolve([{ close: data.dayOpenClose }]);
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

const ALL_NULL_SYMBOLS: Record<string, SymbolData | null> = {
  ES: null,
  NQ: null,
  VX1: null,
  VX2: null,
  ZN: null,
  RTY: null,
  CL: null,
  GC: null,
  DX: null,
};

// ── Suite ───────────────────────────────────────────────────

describe('GET /api/futures/snapshot?at=<ISO>', () => {
  const originalEnv = process.env;
  // Pin "now" to a moment AFTER PICKED_AT so the `at must not be in
  // the future` refine doesn't reject the fixture. Future-date
  // rejection is verified explicitly in the malformed `at` table.
  const FAKE_NOW = new Date('2026-04-17T20:00:00.000Z');

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Validation ────────────────────────────────────────────

  it.each([
    ['not-a-date', 'arbitrary garbage'],
    ['', 'empty string'],
    ['2026-04-17', 'date-only'],
    ['2026-04-17T19:30:00', 'no timezone suffix'],
    ['2099-01-01T00:00:00Z', 'future date'],
  ])('returns 400 when `at` is %j (%s)', async (value) => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { at: value } }), res);

    expect(res._status).toBe(400);
    const json = res._json as { error: string; details: unknown };
    expect(json.error).toBe('Invalid query');
    expect(json.details).toBeDefined();
  });

  it('returns 400 when `at` is an array (duplicate query param)', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { at: ['2026-04-17T19:30:00Z', '2026-04-17T20:30:00Z'] },
      }),
      res,
    );

    expect(res._status).toBe(400);
  });

  // ── Historical happy path ─────────────────────────────────

  it('returns historical snapshots when `at` is valid', async () => {
    setupHistoricalDispatch({
      symbols: {
        ...ALL_NULL_SYMBOLS,
        ES: makeSymbolData({ latestClose: '5710' }),
        VX1: makeSymbolData({
          latestClose: '18.5',
          hourAgoClose: null,
          dayOpenClose: null,
          avgVol: null,
          todayVol: null,
        }),
        VX2: makeSymbolData({
          latestClose: '20.0',
          hourAgoClose: null,
          dayOpenClose: null,
          avgVol: null,
          todayVol: null,
        }),
      },
      oldestTs: '2026-03-15T13:30:00.000Z',
      spx: '5700',
    });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as {
      snapshots: { symbol: string; price: number }[];
      vxTermSpread: number;
      vxTermStructure: string;
      esSpxBasis: number;
      updatedAt: string | null;
      oldestTs: string | null;
      requestedAt: string | null;
    };

    // 3 symbols had data
    expect(json.snapshots).toHaveLength(3);
    const es = json.snapshots.find((s) => s.symbol === 'ES');
    expect(es!.price).toBe(5710);

    // VX term spread = 18.5 - 20.0 = -1.5 → CONTANGO
    expect(json.vxTermSpread).toBe(-1.5);
    expect(json.vxTermStructure).toBe('CONTANGO');

    // ES-SPX basis = 5710 - 5700
    expect(json.esSpxBasis).toBe(10);

    // updatedAt = latestTs from bars (not the picked `at`)
    expect(json.updatedAt).toBe(BAR_TS);

    expect(json.oldestTs).toBe('2026-03-15T13:30:00.000Z');
    expect(json.requestedAt).toBe(PICKED_AT);
  });

  // ── No bars before picked time ────────────────────────────

  it('returns empty snapshots when `at` precedes oldest bar', async () => {
    setupHistoricalDispatch({
      symbols: ALL_NULL_SYMBOLS,
      oldestTs: '2026-04-18T13:30:00.000Z',
      spx: null,
    });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as {
      snapshots: unknown[];
      vxTermSpread: number | null;
      esSpxBasis: number | null;
      updatedAt: string | null;
      oldestTs: string | null;
      requestedAt: string | null;
    };

    expect(json.snapshots).toEqual([]);
    expect(json.vxTermSpread).toBeNull();
    expect(json.esSpxBasis).toBeNull();
    expect(json.updatedAt).toBeNull();
    expect(json.oldestTs).toBe('2026-04-18T13:30:00.000Z');
    expect(json.requestedAt).toBe(PICKED_AT);
  });

  // ── Basis null when no SPX row ────────────────────────────

  it('returns null esSpxBasis when no market_snapshots row exists', async () => {
    setupHistoricalDispatch({
      symbols: {
        ...ALL_NULL_SYMBOLS,
        ES: makeSymbolData({ latestClose: '5710' }),
      },
      oldestTs: '2026-03-15T13:30:00.000Z',
      spx: null, // no SPX row on the picked trade_date
    });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as {
      snapshots: { symbol: string }[];
      esSpxBasis: number | null;
    };
    expect(json.snapshots).toHaveLength(1);
    expect(json.esSpxBasis).toBeNull();
  });

  // ── oldestTs from MIN(ts) ─────────────────────────────────

  it('populates oldestTs from MIN(ts) on futures_bars', async () => {
    setupHistoricalDispatch({
      symbols: ALL_NULL_SYMBOLS,
      oldestTs: '2026-02-01T14:00:00.000Z',
      spx: null,
    });

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );

    expect(res._status).toBe(200);
    const json = res._json as { oldestTs: string | null };
    expect(json.oldestTs).toBe('2026-02-01T14:00:00.000Z');
  });

  // ── Auth guards still fire on historical path ─────────────

  it('returns 403 for bots even with valid `at` (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementationOnce(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );
    expect(res._status).toBe(403);
  });

  it('returns 401 for non-owners even with valid `at` (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementationOnce(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { at: PICKED_AT } }),
      res,
    );
    expect(res._status).toBe(401);
  });
});
