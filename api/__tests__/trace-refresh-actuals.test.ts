// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn() },
}));

const mockSchwabFetch = vi.fn();
vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: (...args: unknown[]) => mockSchwabFetch(...args),
  // rejectIfNotOwner returns false = owner check passes (single-owner app)
  rejectIfNotOwner: vi.fn(() => false),
}));

import handler from '../trace/refresh-actuals.js';

// ---------------------------------------------------------------------------
// Schwab response fixture
// ---------------------------------------------------------------------------

/** Build a Schwab priceHistory response for the given dates. */
function schwabHistory(
  rows: Array<{ date: string; open: number; close: number }>,
) {
  return {
    ok: true,
    data: {
      symbol: '$SPX',
      empty: false,
      candles: rows.map((r) => ({
        open: r.open,
        high: r.open + 10,
        low: r.open - 10,
        close: r.close,
        // Build an epoch ms that maps to r.date in ET (noon UTC = 8 AM ET)
        datetime: new Date(`${r.date}T12:00:00Z`).getTime(),
      })),
    },
  };
}

describe('POST /api/trace/refresh-actuals', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSchwabFetch.mockReset();
    vi.restoreAllMocks();
  });

  it('returns 405 for GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns updated: 0 when no rows need refreshing', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ updated: 0 });
  });

  it('updates rows with data returned from Schwab', async () => {
    mockSql
      .mockResolvedValueOnce([{ date: '2026-01-15' }]) // SELECT missing rows
      .mockResolvedValueOnce([]); // UPDATE row

    mockSchwabFetch.mockResolvedValue(
      schwabHistory([{ date: '2026-01-15', open: 5880, close: 5920 }]),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      updated: number;
      attempted: number;
      found: number;
    };
    expect(body.attempted).toBe(1);
    expect(body.found).toBe(1);
    expect(body.updated).toBe(1);
  });

  it('returns updated: 0 when Schwab has no candles for the requested dates', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-01-15' }]);
    mockSchwabFetch.mockResolvedValue({
      ok: true,
      data: { symbol: '$SPX', empty: true, candles: [] },
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { updated: number; found: number };
    expect(body.updated).toBe(0);
    expect(body.found).toBe(0);
  });

  it('returns 500 when Schwab returns an error', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-01-15' }]);
    mockSchwabFetch.mockResolvedValue({ ok: false, error: 'Unauthorized' });

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Failed to refresh actuals' });
  });

  it('returns 500 when the database SELECT fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Failed to refresh actuals' });
  });

  it('handles multiple dates — updates those found, skips missing', async () => {
    mockSql
      .mockResolvedValueOnce([{ date: '2026-01-14' }, { date: '2026-01-15' }])
      .mockResolvedValueOnce([]) // UPDATE 2026-01-14
      .mockResolvedValueOnce([]); // UPDATE 2026-01-15

    // Only 2026-01-14 in Schwab response (2026-01-15 is a weekend/holiday)
    mockSchwabFetch.mockResolvedValue(
      schwabHistory([{ date: '2026-01-14', open: 5860, close: 5900 }]),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      updated: number;
      attempted: number;
      found: number;
    };
    expect(body.attempted).toBe(2);
    expect(body.found).toBe(1);
    expect(body.updated).toBe(1);
  });
});
