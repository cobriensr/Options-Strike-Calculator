// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockGet = vi.fn();
vi.mock('@vercel/blob', () => ({
  get: (...args: unknown[]) => mockGet(...args),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import handler from '../ml/plot-image.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────────
function makeStreamResult(
  data: Uint8Array,
  overrides: Record<string, unknown> = {},
) {
  let consumed = false;
  return {
    blob: {
      contentType: 'image/png',
      etag: '"abc123"',
      ...overrides,
    },
    statusCode: 200,
    stream: {
      getReader: () => ({
        read: async () => {
          if (!consumed) {
            consumed = true;
            return { done: false, value: data };
          }
          return { done: true, value: undefined };
        },
      }),
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/ml/plot-image', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGet.mockReset();
  });

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 400 when name parameter is missing', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing ?name= parameter' });
  });

  it('returns 400 when name parameter is empty string', async () => {
    const req = mockRequest({ method: 'GET', query: { name: '' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing ?name= parameter' });
  });

  it('returns 400 when name parameter is an array', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { name: ['a', 'b'] },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing ?name= parameter' });
  });

  it('returns 400 for name with invalid characters (path traversal)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { name: '../../../etc/passwd' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid plot name' });
  });

  it('returns 400 for name with spaces', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { name: 'bad name' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid plot name' });
  });

  it('returns 400 for name with special characters', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { name: 'plot<script>' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid plot name' });
  });

  it('allows names with underscores and hyphens', async () => {
    const imageData = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
    mockGet.mockResolvedValueOnce(makeStreamResult(imageData));

    const req = mockRequest({
      method: 'GET',
      query: { name: 'feature_importance-comparison' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith(
      'ml-plots/latest/feature_importance-comparison.png',
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('returns 404 when blob is not found', async () => {
    mockGet.mockResolvedValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      query: { name: 'correlations' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Plot not found' });
  });

  it('returns 304 when ETag matches (if-none-match)', async () => {
    mockGet.mockResolvedValueOnce({
      statusCode: 304,
      blob: { etag: '"abc123"', contentType: 'image/png' },
      stream: null,
    });

    const req = mockRequest({
      method: 'GET',
      query: { name: 'correlations' },
      headers: { 'if-none-match': '"abc123"' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(304);
    expect(res._headers['ETag']).toBe('"abc123"');
    expect(res._headers['Cache-Control']).toBe('public, max-age=3600');
    expect(mockGet).toHaveBeenCalledWith(
      'ml-plots/latest/correlations.png',
      expect.objectContaining({ ifNoneMatch: '"abc123"' }),
    );
  });

  it('streams image data on success', async () => {
    const imageData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    mockGet.mockResolvedValueOnce(makeStreamResult(imageData));

    const req = mockRequest({
      method: 'GET',
      query: { name: 'correlations' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('image/png');
    expect(res._headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res._headers['ETag']).toBe('"abc123"');
    expect(res._headers['Cache-Control']).toBe('public, max-age=3600');
    // The stream pump writes chunks via res.write
    expect(res._chunks).toHaveLength(1);
    expect(res._chunks[0]).toEqual(imageData);
  });

  it('streams multiple chunks', async () => {
    const chunk1 = new Uint8Array([137, 80]);
    const chunk2 = new Uint8Array([78, 71]);
    let readCount = 0;
    const result = {
      blob: { contentType: 'image/png', etag: '"multi"' },
      statusCode: 200,
      stream: {
        getReader: () => ({
          read: async () => {
            readCount++;
            if (readCount === 1) return { done: false, value: chunk1 };
            if (readCount === 2) return { done: false, value: chunk2 };
            return { done: true, value: undefined };
          },
        }),
      },
    };
    mockGet.mockResolvedValueOnce(result);

    const req = mockRequest({
      method: 'GET',
      query: { name: 'timeline' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._chunks).toHaveLength(2);
    expect(res._chunks[0]).toEqual(chunk1);
    expect(res._chunks[1]).toEqual(chunk2);
  });

  it('returns 500 when blob fetch throws', async () => {
    mockGet.mockRejectedValueOnce(new Error('Blob store unavailable'));

    const req = mockRequest({
      method: 'GET',
      query: { name: 'correlations' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch plot image' });
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('passes ifNoneMatch only when header is a string', async () => {
    const imageData = new Uint8Array([1, 2, 3]);
    mockGet.mockResolvedValueOnce(makeStreamResult(imageData));

    // No if-none-match header
    const req = mockRequest({
      method: 'GET',
      query: { name: 'correlations' },
      headers: {},
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockGet).toHaveBeenCalledWith(
      'ml-plots/latest/correlations.png',
      expect.objectContaining({ ifNoneMatch: undefined }),
    );
  });

  it('constructs correct blob path from plot name', async () => {
    mockGet.mockResolvedValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      query: { name: 'clusters_pca' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockGet).toHaveBeenCalledWith(
      'ml-plots/latest/clusters_pca.png',
      expect.any(Object),
    );
  });
});
