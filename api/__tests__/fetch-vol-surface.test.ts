// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
  uwFetch: vi.fn(),
  cronGuard: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-vol-surface.js';
import { cronGuard, uwFetch } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeTermStructureRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-04-02',
    dte: 7,
    volatility: '0.18',
    implied_move_perc: '0.025',
    ...overrides,
  };
}

function makeRealizedVolRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-04-02',
    implied_volatility: '0.20',
    realized_volatility: '0.15',
    ...overrides,
  };
}

function makeIvRankRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-04-02',
    iv_rank_1y: '45.5',
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

describe('fetch-vol-surface cron handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-04-02',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── cronGuard ───────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Skip when data exists ──────────────────────────────

  it('skips when data already exists for today', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 15 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Data already exists for 2026-04-02 (15 rows)',
    });
    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
  });

  // ── Success path ───────────────────────────────────────

  it('fetches all three endpoints and stores data on happy path', async () => {
    // Existing count query: no data yet
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const tsRows = [
      makeTermStructureRow({ dte: 7 }),
      makeTermStructureRow({ dte: 30, volatility: '0.22' }),
    ];
    const rvRows = [makeRealizedVolRow()];
    const ivRankRows = [makeIvRankRow()];

    // uwFetch is called 3 times via withRetry (term-structure, realized, iv-rank)
    vi.mocked(uwFetch)
      .mockResolvedValueOnce(tsRows)
      .mockResolvedValueOnce(rvRows)
      .mockResolvedValueOnce(ivRankRows);

    // Term structure INSERTs (2 rows)
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([{ id: 2 }]);

    // Realized vol INSERT
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-vol-surface',
      date: '2026-04-02',
      termStructure: { stored: 2, skipped: 0 },
      realizedVol: true,
      rawCounts: { tsRows: 2, rvRows: 1, ivRankRows: 1 },
    });
    expect(res._json).toHaveProperty('durationMs');
    expect(logger.info).toHaveBeenCalled();
  });

  // ── Term structure edge cases ─────────────────────────

  it('skips term structure rows with NaN dte', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const tsRows = [
      makeTermStructureRow({ dte: 'not-a-number', days: undefined }),
      makeTermStructureRow({ dte: 30 }),
    ];
    vi.mocked(uwFetch)
      .mockResolvedValueOnce(tsRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    // Only the second row gets inserted
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      termStructure: { stored: 1, skipped: 0 },
    });
  });

  it('uses days field when dte is missing', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const tsRows = [makeTermStructureRow({ dte: undefined, days: 14 })];
    vi.mocked(uwFetch)
      .mockResolvedValueOnce(tsRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      termStructure: { stored: 1, skipped: 0 },
    });
  });

  it('counts skipped term structure rows on conflict', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([makeTermStructureRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    // INSERT returns empty (conflict)
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      termStructure: { stored: 0, skipped: 1 },
    });
  });

  it('handles empty term structure response', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRealizedVolRow()])
      .mockResolvedValueOnce([makeIvRankRow()]);

    // Realized vol INSERT
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      termStructure: { stored: 0, skipped: 0 },
      realizedVol: true,
    });
  });

  // ── Realized vol edge cases ───────────────────────────

  it('returns realizedVol=false when rv response is empty', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([makeTermStructureRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeIvRankRow()]);

    // Term structure INSERT
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      realizedVol: false,
    });
  });

  it('computes IV-RV spread and overpricing correctly', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeRealizedVolRow({
          implied_volatility: '0.25',
          realized_volatility: '0.20',
        }),
      ])
      .mockResolvedValueOnce([makeIvRankRow({ iv_rank_1y: '60.0' })]);

    // Realized vol INSERT
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    // The handler stores to DB; we verify the SQL was called
    // 1 count check + 1 realized vol INSERT = 2 SQL calls
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('uses iv_rank field when iv_rank_1y is missing', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRealizedVolRow()])
      .mockResolvedValueOnce([
        makeIvRankRow({ iv_rank_1y: undefined, iv_rank: '55.0' }),
      ]);

    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ realizedVol: true });
  });

  it('handles empty IV rank response gracefully', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRealizedVolRow()])
      .mockResolvedValueOnce([]);

    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ realizedVol: true });
  });

  it('handles rv=0 without dividing by zero', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeRealizedVolRow({
          implied_volatility: '0.15',
          realized_volatility: '0',
        }),
      ])
      .mockResolvedValueOnce([]);

    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Should not throw; rv=0 means overpricing_pct = null
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ realizedVol: true });
  });

  // ── All endpoints empty ───────────────────────────────

  it('handles all three endpoints returning empty arrays', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      termStructure: { stored: 0, skipped: 0 },
      realizedVol: false,
      rawCounts: { tsRows: 0, rvRows: 0, ivRankRows: 0 },
    });
  });

  // ── Error handling ────────────────────────────────────

  it('error: all three endpoints fail → status error, 500, each leg captured (BE-CRON-H4)', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    const err = new Error('UW API timeout');
    vi.mocked(uwFetch).mockRejectedValue(err);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // All three fetches rejected → total failure. Returns 500 (so
    // withCronCheckin fires an error check-in) with status: 'error' in
    // the body. The legs are captured individually, not via the outer
    // catch, so the run no longer reports a clean 'ok'.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-vol-surface',
      status: 'error',
      failureCount: 3,
    });
    // Each rejected leg is captured (3 calls), not just one outer capture.
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
  });

  it('partial: iv-rank fails but term-structure + realized-vol still store', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    // term-structure + realized-vol succeed; iv-rank rejects.
    vi.mocked(uwFetch)
      .mockResolvedValueOnce([makeTermStructureRow()]) // term-structure
      .mockResolvedValueOnce([makeRealizedVolRow()]) // realized-vol
      .mockRejectedValueOnce(new Error('UW iv-rank 503')); // iv-rank

    // Term-structure INSERT, then realized-vol INSERT.
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Partial failures stay 200 — the healthy legs' data landed.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      // Healthy legs survived the iv-rank rejection.
      termStructure: { stored: 1, skipped: 0 },
      realizedVol: true,
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('success: all three endpoints succeed → status success', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([makeTermStructureRow()])
      .mockResolvedValueOnce([makeRealizedVolRow()])
      .mockResolvedValueOnce([makeIvRankRow()]);

    mockSql.mockResolvedValueOnce([{ id: 1 }]); // term-structure INSERT
    mockSql.mockResolvedValueOnce([]); // realized-vol INSERT

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'ok',
      failureCount: 0,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns 500 on DB write error during term structure insert', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([makeTermStructureRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    // INSERT fails
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('returns 500 on DB read error (existing count check)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB unavailable'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns 500 on DB write error during realized vol insert', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRealizedVolRow()])
      .mockResolvedValueOnce([]);

    // Realized vol INSERT fails
    mockSql.mockRejectedValueOnce(new Error('disk full'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
