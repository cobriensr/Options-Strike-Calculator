// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../trace-live-analogs.js';

// After the perf fix, the seed query returns the embedding as a TEXT-cast
// pgvector literal (e.g. '[0.1,0.2,...]') so the KNN can bind it once
// instead of re-running the subquery 3×. Tests don't compute distances —
// any non-empty literal satisfies the "has embedding" branch.
const seedExists = [{ embedding_text: '[0.1,0.2,0.3]' }];

const analogRowA = {
  id: '101',
  captured_at: '2026-04-22T18:30:00Z',
  spot: '6580.00',
  regime: 'range_bound_positive_gamma',
  predicted_close: '6582.00',
  actual_close: '6585.50',
  confidence: 'high',
  headline: 'Pin at 6582',
  distance: '0.0123',
};

const analogRowB = {
  id: '102',
  captured_at: '2026-04-22T19:00:00Z',
  spot: '6588.00',
  regime: 'trending_positive_gamma',
  predicted_close: '6590.00',
  actual_close: null, // today's row, outcome unknown
  confidence: 'medium',
  headline: 'Drift toward 6590',
  distance: '0.0455',
};

const analogRowC = {
  id: '103',
  captured_at: '2026-04-21T17:00:00Z',
  spot: '6500.00',
  regime: null,
  predicted_close: null,
  actual_close: '6510.00',
  confidence: null,
  headline: null,
  distance: '0.1200',
};

beforeEach(() => {
  mockSql.mockReset();
});

describe('GET /api/trace-live-analogs', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: { id: '1' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 400 when id is missing', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/Provide \?id/);
  });

  it('returns 400 for non-integer id', async () => {
    const req = mockRequest({ method: 'GET', query: { id: 'abc' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for negative id (regex rejects sign)', async () => {
    const req = mockRequest({ method: 'GET', query: { id: '-5' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for non-numeric k', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { id: '42', k: 'twelve' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for k=0 (out of range)', async () => {
    const req = mockRequest({ method: 'GET', query: { id: '42', k: '0' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for k>50 (out of range)', async () => {
    const req = mockRequest({ method: 'GET', query: { id: '42', k: '51' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 404 when row does not exist', async () => {
    mockSql.mockResolvedValueOnce([]); // seed lookup -> no row
    const req = mockRequest({ method: 'GET', query: { id: '99999' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it('returns 404 when row exists but has no embedding', async () => {
    mockSql.mockResolvedValueOnce([{ embedding_text: null }]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
    expect((res._json as { error: string }).error).toMatch(/no embedding/i);
  });

  it('returns analogs in distance-ascending order with default k=10', async () => {
    mockSql.mockResolvedValueOnce(seedExists); // seed row
    mockSql.mockResolvedValueOnce([analogRowA, analogRowB, analogRowC]); // KNN
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);

    const body = res._json as {
      id: number;
      k: number;
      analogs: Array<Record<string, unknown>>;
    };
    expect(body.id).toBe(42);
    expect(body.k).toBe(10);
    expect(body.analogs).toHaveLength(3);

    // Distance-ascending order preserved as the SQL ORDER BY supplies it.
    expect(body.analogs[0]!.id).toBe(101);
    expect(body.analogs[1]!.id).toBe(102);
    expect(body.analogs[2]!.id).toBe(103);

    // Field projection sanity
    const first = body.analogs[0]!;
    expect(first.spot).toBe(6580);
    expect(first.regime).toBe('range_bound_positive_gamma');
    expect(first.predictedClose).toBe(6582);
    expect(first.actualClose).toBe(6585.5);
    expect(first.confidence).toBe('high');
    expect(first.headline).toBe('Pin at 6582');
    expect(first.distance).toBeCloseTo(0.0123, 4);
  });

  it('respects ?k= override', async () => {
    mockSql.mockResolvedValueOnce(seedExists);
    mockSql.mockResolvedValueOnce([analogRowA]);
    const req = mockRequest({ method: 'GET', query: { id: '42', k: '5' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { k: number };
    expect(body.k).toBe(5);
  });

  it('computes error = actualClose - predictedClose when both present', async () => {
    mockSql.mockResolvedValueOnce(seedExists);
    mockSql.mockResolvedValueOnce([analogRowA]); // 6585.50 - 6582.00 = 3.50
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { analogs: Array<{ error: number | null }> };
    expect(body.analogs[0]!.error).toBeCloseTo(3.5, 4);
  });

  it("returns null error when actualClose is null (today's analogs)", async () => {
    mockSql.mockResolvedValueOnce(seedExists);
    mockSql.mockResolvedValueOnce([analogRowB]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { analogs: Array<{ error: number | null }> };
    expect(body.analogs[0]!.error).toBeNull();
  });

  it('returns null error when predictedClose is null', async () => {
    mockSql.mockResolvedValueOnce(seedExists);
    mockSql.mockResolvedValueOnce([analogRowC]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { analogs: Array<{ error: number | null }> };
    expect(body.analogs[0]!.error).toBeNull();
  });

  it('sets a private 5-minute cache header', async () => {
    mockSql.mockResolvedValueOnce(seedExists);
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('private, max-age=300');
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
