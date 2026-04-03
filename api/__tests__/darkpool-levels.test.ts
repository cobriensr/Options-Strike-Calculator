// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../darkpool-levels.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeDbRow(overrides = {}) {
  return {
    spx_approx: 6575,
    total_premium: '1300000000',
    trade_count: 13,
    total_shares: 2000000,
    latest_time: '2026-04-02T16:30:00Z',
    updated_at: '2026-04-02T16:35:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/darkpool-levels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('uses date query param when provided', async () => {
    mockSql.mockResolvedValue([makeDbRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-28' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toBe('2026-03-28');
  });

  it('rejects invalid date format', async () => {
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns levels sorted by premium', async () => {
    const rows = [
      makeDbRow({
        spx_approx: 6575,
        total_premium: '1300000000',
      }),
      makeDbRow({
        spx_approx: 6555,
        total_premium: '248000000',
      }),
    ];
    mockSql.mockResolvedValue(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      levels: Array<Record<string, unknown>>;
      date: string;
    };
    expect(body.levels).toHaveLength(2);
    expect(body.date).toBeDefined();

    expect(body.levels[0]).toMatchObject({
      spxLevel: 6575,
      totalPremium: 1_300_000_000,
      tradeCount: 13,
    });

    expect(body.levels[1]).toMatchObject({
      spxLevel: 6555,
      totalPremium: 248_000_000,
    });
  });

  it('converts string DB values to numbers', async () => {
    mockSql.mockResolvedValue([makeDbRow()]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const level = (res._json as { levels: Array<Record<string, unknown>> })
      .levels[0]!;
    expect(typeof level.spxLevel).toBe('number');
    expect(typeof level.totalPremium).toBe('number');
    expect(typeof level.tradeCount).toBe('number');
    expect(typeof level.totalShares).toBe('number');
  });

  it('returns empty levels when no data for today', async () => {
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { levels: unknown[] };
    expect(body.levels).toEqual([]);
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cb: (scope: {
          setTransactionName: typeof setTransactionName;
        }) => unknown,
      ) => cb({ setTransactionName }),
    );
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith(
      'GET /api/darkpool-levels',
    );
  });

  it('includes latestTime and updatedAt in response', async () => {
    mockSql.mockResolvedValue([
      makeDbRow({
        latest_time: '2026-04-02T18:00:00Z',
        updated_at: '2026-04-02T18:05:00Z',
      }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const level = (res._json as { levels: Array<Record<string, unknown>> })
      .levels[0]!;
    expect(level.latestTime).toBe('2026-04-02T18:00:00Z');
    expect(level.updatedAt).toBe('2026-04-02T18:05:00Z');
  });
});
