// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
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

import handler from '../trace-live-get.js';

const exampleAnalysis = {
  timestamp: '2026-04-23T19:30:00Z',
  spot: 6605,
  stabilityPct: 67,
  regime: 'range_bound_positive_gamma',
};

const exampleRow = {
  id: '42',
  captured_at: '2026-04-23T19:30:00Z',
  spot: '6605.20',
  stability_pct: '67.3',
  regime: 'range_bound_positive_gamma',
  predicted_close: '6605.00',
  confidence: 'high',
  override_applied: true,
  headline: 'Pin at 6605',
  image_urls: { gamma: 'https://b/g.png', charm: 'https://b/c.png' },
  full_response: exampleAnalysis,
  model: 'claude-sonnet-4-6',
  input_tokens: '1000',
  output_tokens: '500',
  cache_read_tokens: '14000',
  cache_write_tokens: '0',
  duration_ms: '4500',
  created_at: '2026-04-23T19:30:05Z',
};

beforeEach(() => {
  mockSql.mockReset();
});

describe('GET /api/trace-live-get', () => {
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

  it('returns 400 for negative id', async () => {
    const req = mockRequest({ method: 'GET', query: { id: '-5' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 404 when row does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { id: '99999' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it('returns the parsed row when found', async () => {
    mockSql.mockResolvedValueOnce([exampleRow]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.id).toBe(42);
    expect(body.spot).toBe(6605.2);
    expect(body.stabilityPct).toBe(67.3);
    expect(body.overrideApplied).toBe(true);
    expect(body.imageUrls).toEqual({
      gamma: 'https://b/g.png',
      charm: 'https://b/c.png',
    });
    expect(body.analysis).toEqual(exampleAnalysis);
    expect(body.cacheReadTokens).toBe(14000);
  });

  it('parses jsonb fields from string when DB returns serialized text', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...exampleRow,
        image_urls: '{"gamma":"https://b/g.png"}',
        full_response: JSON.stringify(exampleAnalysis),
      },
    ]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.imageUrls).toEqual({ gamma: 'https://b/g.png' });
    expect(body.analysis).toEqual(exampleAnalysis);
  });

  it('returns empty {} for imageUrls when DB row is null', async () => {
    mockSql.mockResolvedValueOnce([{ ...exampleRow, image_urls: null }]);
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect((res._json as { imageUrls: unknown }).imageUrls).toEqual({});
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
