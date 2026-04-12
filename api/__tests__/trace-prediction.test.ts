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

import handler from '../trace/prediction.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRow(overrides = {}) {
  return {
    date: '2026-01-15',
    predicted_close: 5900,
    confidence: 'high',
    notes: null,
    actual_close: null,
    current_price: null,
    created_at: '2026-01-15T09:00:00Z',
    ...overrides,
  };
}

describe('GET /api/trace/prediction', () => {
  beforeEach(() => mockSql.mockReset());

  it('returns rows from the database', async () => {
    const rows = [
      makeRow(),
      makeRow({ date: '2026-01-14', predicted_close: 5850 }),
    ];
    mockSql.mockResolvedValue(rows);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual(rows);
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Failed to load predictions' });
  });
});

describe('POST /api/trace/prediction', () => {
  beforeEach(() => mockSql.mockReset());

  it('inserts a new prediction and returns the row', async () => {
    const row = makeRow();
    mockSql.mockResolvedValue([row]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-01-15', predicted_close: 5900, confidence: 'high' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual(row);
  });

  it('accepts optional notes', async () => {
    const row = makeRow({ notes: 'gamma flip' });
    mockSql.mockResolvedValue([row]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: {
          date: '2026-01-15',
          predicted_close: 5900,
          confidence: 'medium',
          notes: 'gamma flip',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect((res._json as typeof row).notes).toBe('gamma flip');
  });

  it('returns 400 for a missing date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { predicted_close: 5900, confidence: 'high' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for a future date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2099-12-31', predicted_close: 5900, confidence: 'high' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid date format', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '01-15-2026', predicted_close: 5900, confidence: 'high' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for an invalid confidence value', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: {
          date: '2026-01-15',
          predicted_close: 5900,
          confidence: 'extreme',
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for non-positive predicted_close', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-01-15', predicted_close: -100, confidence: 'low' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB error'));
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-01-15', predicted_close: 5900, confidence: 'high' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Failed to save prediction' });
  });
});

describe('DELETE /api/trace/prediction', () => {
  beforeEach(() => mockSql.mockReset());

  it('deletes a row by date', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'DELETE', query: { date: '2026-01-15' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ deleted: '2026-01-15' });
  });

  it('returns 400 for missing date query param', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'DELETE', query: {} }), res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'DELETE', query: { date: 'not-a-date' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB error'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'DELETE', query: { date: '2026-01-15' } }),
      res,
    );
    expect(res._status).toBe(500);
  });
});

describe('unsupported methods', () => {
  it('returns 405 for PUT', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 405 for PATCH', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PATCH' }), res);
    expect(res._status).toBe(405);
  });
});
