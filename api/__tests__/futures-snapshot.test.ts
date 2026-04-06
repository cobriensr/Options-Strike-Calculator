// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn().mockReturnValue(false),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-03'),
}));

import handler from '../futures/snapshot.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

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

    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
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

  it('returns 403 when bot detected', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  // ── No data ───────────────────────────────────────────────

  it('returns null fields when no data exists', async () => {
    // Combined query returns no rows
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      snapshots: [],
      vxTermSpread: null,
      vxTermStructure: null,
      esSpxBasis: null,
      updatedAt: null,
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
      makeSnapshotRow('VXM1', 18.5, null, null, null, ts),
      makeSnapshotRow('VXM2', 20.0, null, null, null, ts),
      makeSnapshotRow('ZN', 110.5, 0.05, 0.1, 0.8, ts),
    ]);

    // 2. SPX query (ES exists → look up SPX)
    mockSql.mockResolvedValueOnce([{ spx: '5690' }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      snapshots: { symbol: string; price: number }[];
      vxTermSpread: number;
      vxTermStructure: string;
      esSpxBasis: number;
      updatedAt: string;
    };

    expect(json.snapshots).toHaveLength(7);
    expect(json.updatedAt).toBe(ts);

    // ES should have price 5700
    const es = json.snapshots.find((s) => s.symbol === 'ES');
    expect(es!.price).toBe(5700);
  });

  // ── VX term structure: CONTANGO ───────────────────────────

  it('computes CONTANGO when VXM1 < VXM2 (spread < -0.25)', async () => {
    mockSql.mockResolvedValueOnce([
      makeSnapshotRow('VXM1', 18.0),
      makeSnapshotRow('VXM2', 20.0),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      vxTermSpread: number;
      vxTermStructure: string;
    };
    // Spread = 18.0 - 20.0 = -2.0 (< -0.25 → CONTANGO)
    expect(json.vxTermSpread).toBe(-2);
    expect(json.vxTermStructure).toBe('CONTANGO');
  });

  // ── VX term structure: BACKWARDATION ──────────────────────

  it('computes BACKWARDATION when VXM1 > VXM2 (spread > 0.25)', async () => {
    mockSql.mockResolvedValueOnce([
      makeSnapshotRow('VXM1', 22.0),
      makeSnapshotRow('VXM2', 20.0),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as {
      vxTermSpread: number;
      vxTermStructure: string;
    };
    // Spread = 22.0 - 20.0 = 2.0 (> 0.25 → BACKWARDATION)
    expect(json.vxTermSpread).toBe(2);
    expect(json.vxTermStructure).toBe('BACKWARDATION');
  });

  // ── VX term structure: FLAT ───────────────────────────────

  it('computes FLAT when VXM1 ≈ VXM2 (spread within threshold)', async () => {
    mockSql.mockResolvedValueOnce([
      makeSnapshotRow('VXM1', 20.1),
      makeSnapshotRow('VXM2', 20.0),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as {
      vxTermSpread: number;
      vxTermStructure: string;
    };
    // Spread = 20.1 - 20.0 = 0.1 (within ±0.25 → FLAT)
    expect(json.vxTermSpread).toBe(0.1);
    expect(json.vxTermStructure).toBe('FLAT');
  });

  // ── Null VX term structure when missing VX symbols ────────

  it('returns null term structure when VX symbols are missing', async () => {
    mockSql.mockResolvedValueOnce([
      makeSnapshotRow('ES', 5700, 0.1, 0.5, 1.0),
      makeSnapshotRow('NQ', 20500),
    ]);
    // SPX query (ES exists)
    mockSql.mockResolvedValueOnce([{ spx: '5690' }]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const json = res._json as {
      vxTermSpread: number | null;
      vxTermStructure: string | null;
    };
    expect(json.vxTermSpread).toBeNull();
    expect(json.vxTermStructure).toBeNull();
  });

  // ── ES-SPX basis ──────────────────────────────────────────

  it('computes ES-SPX basis correctly', async () => {
    mockSql.mockResolvedValueOnce([makeSnapshotRow('ES', 5710)]);
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
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe(
      'private, s-maxage=60, stale-while-revalidate=30',
    );
  });

  it('sets correct cache headers when no data exists', async () => {
    mockSql.mockResolvedValueOnce([]);

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
});
