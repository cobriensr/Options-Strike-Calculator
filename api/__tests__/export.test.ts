// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

import handler from '../ml/export.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';

describe('GET /api/ml/export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 when rejectIfNotOwner returns true', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 for invalid after date param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { after: 'not-a-date' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'after must be YYYY-MM-DD' });
  });

  it('returns 400 for invalid before date param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { before: '03-25-2026' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'before must be YYYY-MM-DD' });
  });

  it('returns JSON data with normalized dates', async () => {
    mockSql.mockResolvedValue([
      {
        date: new Date('2026-03-01'),
        feature_completeness: 0.85,
        settlement: 5700,
      },
      {
        date: new Date('2026-03-02'),
        feature_completeness: 0.9,
        settlement: 5720,
      },
    ]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const rows = res._json as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe('2026-03-01');
    expect(rows[1]!.date).toBe('2026-03-02');
    expect(rows[0]!.feature_completeness).toBe(0.85);
    expect(rows[0]!.settlement).toBe(5700);
  });

  it('sets Cache-Control: no-store for JSON responses', async () => {
    mockSql.mockResolvedValue([
      { date: new Date('2026-03-01'), feature_completeness: 0.85 },
    ]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns empty JSON array when no rows', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual([]);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns CSV format with proper headers and Content-Type', async () => {
    mockSql.mockResolvedValue([
      {
        date: new Date('2026-03-01'),
        feature_completeness: 0.85,
        settlement: 5700,
      },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { format: 'csv' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._headers['Content-Disposition']).toBe(
      'attachment; filename="ml-training-data.csv"',
    );
    const lines = res._body.split('\n');
    expect(lines[0]).toBe('date,feature_completeness,settlement');
    expect(lines[1]).toBe('2026-03-01,0.85,5700');
  });

  it('CSV escapes values with commas, quotes, and newlines', async () => {
    mockSql.mockResolvedValue([
      {
        date: new Date('2026-03-01'),
        notes: 'has, comma',
        desc: 'has "quotes"',
        multi: 'line\nbreak',
      },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { format: 'csv' } }),
      res,
    );
    expect(res._status).toBe(200);
    const lines = res._body.split('\n');
    // Header row
    expect(lines[0]).toBe('date,notes,desc,multi');
    // Data row: commas get quoted, quotes get doubled, newlines get quoted
    expect(lines[1]).toContain('"has, comma"');
    expect(lines[1]).toContain('"has ""quotes"""');
    // The newline value gets quoted so the field appears across lines 1 and 2
    expect(res._body).toContain('"line\nbreak"');
  });

  it('handles null values in CSV', async () => {
    mockSql.mockResolvedValue([
      {
        date: new Date('2026-03-01'),
        settlement: null,
        vix_close: null,
      },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { format: 'csv' } }),
      res,
    );
    expect(res._status).toBe(200);
    const lines = res._body.split('\n');
    expect(lines[0]).toBe('date,settlement,vix_close');
    expect(lines[1]).toBe('2026-03-01,,');
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValue(new Error('connection refused'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });

  it('returns generic error message for non-Error throws', async () => {
    mockSql.mockRejectedValue('unexpected');
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });

  it('passes minFeatureCompleteness and minLabelCompleteness params', async () => {
    mockSql.mockResolvedValue([
      {
        date: new Date('2026-03-01'),
        feature_completeness: 0.95,
        label_completeness: 0.8,
      },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          minFeatureCompleteness: '0.9',
          minLabelCompleteness: '0.7',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // Verify mockSql was called (the handler calls sql`...` which is mockSql)
    expect(mockSql).toHaveBeenCalledTimes(1);
    // The rows come back normalized
    const rows = res._json as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-03-01');
  });

  it('passes after and before date filters to query', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { after: '2026-01-01', before: '2026-03-01' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toEqual([]);
  });
});
