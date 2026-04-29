// @vitest-environment node

/**
 * Authenticated proxy for private TRACE-live blob images. Tests cover:
 *
 *   - Method gate (405 on non-GET)
 *   - Auth + rate-limit guards
 *   - Query-param validation (id integer, chart enum)
 *   - Missing token env var
 *   - DB row lookup (not-found / no-image-for-chart)
 *   - Blob fetch failure → 502
 *   - Happy path streams bytes with image/png + immutable cache headers
 *   - Catch-all → 500
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

import handler from '../trace-live-image.js';
import {
  guardOwnerOrGuestEndpoint,
  rejectIfRateLimited,
} from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, BLOB_READ_WRITE_TOKEN: 'test-token' };
  mockSql.mockReset();
  vi.mocked(guardOwnerOrGuestEndpoint).mockReset().mockResolvedValue(false);
  vi.mocked(rejectIfRateLimited).mockReset().mockResolvedValue(false);
  vi.mocked(Sentry.captureException).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('GET /api/trace-live-image — guards', () => {
  it('returns 405 for non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('exits when guardOwnerOrGuestEndpoint rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(mockSql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('GET /api/trace-live-image — query validation', () => {
  it('returns 400 when id is missing', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/Provide \?id=N/);
  });

  it('returns 400 when id is non-integer', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: 'abc', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when chart is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { id: '1' } }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(
      /\?chart=gamma\|charm\|delta/,
    );
  });

  it('returns 400 when chart is not in the enum', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'unknown' } }),
      res,
    );
    expect(res._status).toBe(400);
  });
});

describe('GET /api/trace-live-image — config + DB', () => {
  it('returns 500 when BLOB_READ_WRITE_TOKEN is missing', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Server configuration error' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 when the analysis row does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '99999', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Analysis not found' });
  });

  it('returns 404 when the requested chart is not stored on the row', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: { gamma: 'https://b/g.png' } },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '42', chart: 'charm' } }),
      res,
    );
    expect(res._status).toBe(404);
    expect((res._json as { error: string }).error).toMatch(
      /No charm image stored/,
    );
  });

  it('parses image_urls when DB returns serialized JSON string', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: '{"gamma":"https://b/g.png"}' },
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: {} as never,
      headers: new Map([['content-length', '1024']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '42', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('image/png');
  });

  it('returns 404 when image_urls JSON is malformed', async () => {
    mockSql.mockResolvedValueOnce([{ image_urls: '{not-json' }]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '42', chart: 'gamma' } }),
      res,
    );
    // parseJsonbField returns null → fallback to {} → no url → 404
    expect(res._status).toBe(404);
  });
});

describe('GET /api/trace-live-image — blob fetch', () => {
  it('returns 502 when blob fetch is not OK', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: { gamma: 'https://blob.private/x.png' } },
    ]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, body: null });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'Failed to fetch image' });
  });

  it('returns 502 when blob response has no body', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: { gamma: 'https://blob/x.png' } },
    ]);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(502);
  });

  it('streams bytes with image/png + immutable cache on success', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: { gamma: 'https://blob/x.png' } },
    ]);
    const buf = new ArrayBuffer(16);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: {} as never,
      headers: new Map([['content-length', '16']]),
      arrayBuffer: () => Promise.resolve(buf),
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('image/png');
    expect(res._headers['Cache-Control']).toBe(
      'private, max-age=86400, immutable',
    );
    expect(res._headers['Content-Length']).toBe('16');
    // Authorization header passed through with the bearer token
    const fetchCall = fetchMock.mock.calls[0];
    expect(
      (fetchCall?.[1] as { headers: Record<string, string> }).headers,
    ).toEqual({ Authorization: 'Bearer test-token' });
  });

  it('skips Content-Length when blob does not provide it', async () => {
    mockSql.mockResolvedValueOnce([
      { image_urls: { gamma: 'https://blob/x.png' } },
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: {} as never,
      headers: new Map(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers['Content-Length']).toBeUndefined();
  });
});

describe('GET /api/trace-live-image — error path', () => {
  it('returns 500 + Sentry capture when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { id: '1', chart: 'gamma' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
