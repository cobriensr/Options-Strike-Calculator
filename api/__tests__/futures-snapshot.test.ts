// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (actual.isRetryableDbError(err)) {
          throw new actual.TransientDbError(err);
        }
        throw err;
      }
    },
    TransientDbError: actual.TransientDbError,
    isRetryableDbError: actual.isRetryableDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: vi.fn(
      (
        fn: (scope: {
          setTransactionName: () => void;
          setTag: () => void;
        }) => unknown,
      ) => fn({ setTransactionName: vi.fn(), setTag: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
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

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-03'),
}));

vi.mock('../_lib/vix-term-structure.js', () => ({
  fetchVixTermStructure: vi.fn(),
}));

import handler from '../futures/snapshot.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import {
  fetchVixTermStructure,
  type VixTermStructure,
} from '../_lib/vix-term-structure.js';

const VIX_TERM: VixTermStructure = {
  live: {
    vix: 16.5,
    vix3m: 18.6,
    ratio: 0.887,
    band: 'CONTANGO',
    asOf: '2026-04-03T15:59:30.000Z',
  },
  lastClose: { vix: 16.39, vix3m: 18.58, ratio: 0.882, band: 'CONTANGO' },
  futuresRegime: 'CONTANGO',
};

/**
 * Helper to build mock snapshot rows returned from futures_snapshots.
 */
function makeSnapshotRow(
  symbol: string,
  price: number,
  change1h: number | null = null,
  changeDay: number | null = null,
  volumeRatio: number | null = null,
  ts: string = '2026-04-03T16:00:00.000Z',
) {
  return {
    symbol,
    price: String(price),
    change_1h_pct: change1h != null ? String(change1h) : null,
    change_day_pct: changeDay != null ? String(changeDay) : null,
    volume_ratio: volumeRatio != null ? String(volumeRatio) : null,
    ts,
  };
}

describe('GET /api/futures/snapshot', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };

    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    vi.mocked(fetchVixTermStructure).mockResolvedValue(VIX_TERM);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 405 for PUT', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guards ───────────────────────────────────────────

  it('returns 403 when bot detected (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementationOnce(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 401 when not owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementationOnce(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  // ── No data ───────────────────────────────────────────────

  it('returns null futures fields but still the VIX term structure when no snapshot rows exist', async () => {
    // Combined query returns no rows
    mockSql.mockResolvedValueOnce([]);
    // MIN(ts) query for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: '2026-03-15T13:30:00.000Z' }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      snapshots: [],
      vixTermStructure: VIX_TERM,
      esSpxBasis: null,
      updatedAt: null,
      oldestTs: '2026-03-15T13:30:00.000Z',
      requestedAt: null,
    });
  });

  // ── Happy path with full data ─────────────────────────────

  it('returns correct response shape with mock data', async () => {
    const ts = '2026-04-03T16:00:00.000Z';

    // 1. Combined query (snapshot rows with inline MAX subquery)
    mockSql.mockResolvedValueOnce([
      makeSnapshotRow('CL', 75.5, 0.5, 1.2, 1.1, ts),
      makeSnapshotRow('ES', 5700, 0.15, 0.8, 1.3, ts),
      makeSnapshotRow('NQ', 20500, -0.1, 0.5, 0.9, ts),
      makeSnapshotRow('RTY', 2100, 0.3, -0.2, 1.0, ts),
      makeSnapshotRow('ZN', 110.5, 0.05, 0.1, 0.8, ts),
    ]);

    // 2. MIN(ts) for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: '2026-03-15T13:30:00.000Z' }]);

    // 3. SPX query (ES exists → look up SPX)
    mockSql.mockResolvedValueOnce([{ spx: '5690' }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      snapshots: { symbol: string; price: number }[];
      vixTermStructure: VixTermStructure | null;
      esSpxBasis: number;
      updatedAt: string;
      oldestTs: string;
      requestedAt: string | null;
    };

    expect(json.snapshots).toHaveLength(5);
    expect(json.updatedAt).toBe(ts);
    expect(json.oldestTs).toBe('2026-03-15T13:30:00.000Z');
    expect(json.requestedAt).toBeNull();
    expect(json.vixTermStructure).toEqual(VIX_TERM);
    expect(fetchVixTermStructure).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveProperty('vxTermSpread');
    expect(json).not.toHaveProperty('vxTermStructure');

    // ES should have price 5700
    const es = json.snapshots.find((s) => s.symbol === 'ES');
    expect(es!.price).toBe(5700);
  });

  // ── VIX term structure ────────────────────────────────────

  it('passes a fully degraded VIX term structure through unchanged', async () => {
    const degraded: VixTermStructure = {
      live: null,
      lastClose: null,
      futuresRegime: null,
    };
    vi.mocked(fetchVixTermStructure).mockResolvedValueOnce(degraded);
    mockSql.mockResolvedValueOnce([makeSnapshotRow('NQ', 20500)]);
    mockSql.mockResolvedValueOnce([{ oldest: null }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(
      (res._json as { vixTermStructure: unknown }).vixTermStructure,
    ).toEqual(degraded);
  });

  // ── ES-SPX basis ──────────────────────────────────────────

  it('computes ES-SPX basis correctly', async () => {
    mockSql.mockResolvedValueOnce([makeSnapshotRow('ES', 5710)]);
    // MIN(ts) for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: null }]);
    // SPX query
    mockSql.mockResolvedValueOnce([{ spx: '5700' }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as { esSpxBasis: number };
    // Basis = 5710 - 5700 = 10
    expect(json.esSpxBasis).toBe(10);
  });

  it('returns null ES-SPX basis when no SPX data', async () => {
    mockSql.mockResolvedValueOnce([makeSnapshotRow('ES', 5710)]);
    // MIN(ts) for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: null }]);
    // SPX query returns empty
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as { esSpxBasis: number | null };
    expect(json.esSpxBasis).toBeNull();
  });

  // ── Cache headers ─────────────────────────────────────────

  it('sets correct cache headers when data exists', async () => {
    mockSql.mockResolvedValueOnce([makeSnapshotRow('ES', 5700)]);
    // MIN(ts) for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: null }]);
    // SPX query
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe(
      'private, s-maxage=60, stale-while-revalidate=30',
    );
  });

  it('sets correct cache headers when no data exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    // MIN(ts) for oldestTs
    mockSql.mockResolvedValueOnce([{ oldest: null }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe(
      'private, s-maxage=60, stale-while-revalidate=30',
    );
  });

  // ── DB error ──────────────────────────────────────────────

  it('returns 500 on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('degrades to 503 + Retry-After on a transient db timeout (no Sentry)', async () => {
    mockSql.mockRejectedValueOnce(new Error('db attempt timeout'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
