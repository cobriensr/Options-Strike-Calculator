// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../trace/refresh-actuals.js';

// ---------------------------------------------------------------------------
// Stooq CSV fixture
// ---------------------------------------------------------------------------

function stooqCsv(rows: Array<{ date: string; open: number; close: number }>) {
  const header = 'Date,Open,High,Low,Close,Volume';
  const lines = rows.map(
    (r) => `${r.date},${r.open},${r.open + 10},${r.open - 10},${r.close},0`,
  );
  return [header, ...lines].join('\n');
}

describe('POST /api/trace/refresh-actuals', () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.restoreAllMocks();
  });

  it('returns 405 for GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns updated: 0 when no rows need refreshing', async () => {
    // SELECT returns empty — nothing is missing actuals
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ updated: 0 });
  });

  it('updates rows with data returned from Stooq', async () => {
    mockSql
      .mockResolvedValueOnce([{ date: '2026-01-15' }]) // SELECT missing rows
      .mockResolvedValueOnce([]) // UPDATE row
      .mockResolvedValueOnce([]); // (extra guard)

    const csv = stooqCsv([{ date: '2026-01-15', open: 5880, close: 5920 }]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(csv) }),
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

  it('returns updated: 0 when Stooq has no data for the requested dates', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-01-15' }]);

    // Stooq returns CSV with no matching date rows
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('Date,Open,High,Low,Close,Volume\n'),
      }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { updated: number; found: number };
    expect(body.updated).toBe(0);
    expect(body.found).toBe(0);
  });

  it('returns 500 when Stooq fetch fails', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-01-15' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

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

    const csv = stooqCsv([
      { date: '2026-01-14', open: 5860, close: 5900 },
      // 2026-01-15 intentionally absent from Stooq data (e.g. weekend)
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(csv) }),
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
    expect(body.found).toBe(1); // only 2026-01-14 in CSV
    expect(body.updated).toBe(1); // only that one was updated
  });
});
