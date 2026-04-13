// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from '../helpers';

// ── Mocks ─────────────────────────────────────────────────────

vi.mock('../../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../../ml/trigger-analyze.js';
import { checkBot } from '../../_lib/api-helpers.js';
import logger from '../../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────────

describe('POST /api/ml/trigger-analyze', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('returns 405 when method is not POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'Method not allowed' });
  });

  it('returns 405 for PUT method', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'Method not allowed' });
  });

  it('does not call checkBot when method is not POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(checkBot).not.toHaveBeenCalled();
  });

  it('returns 403 when checkBot identifies a bot', async () => {
    vi.mocked(checkBot).mockResolvedValue({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 500 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Server misconfigured' });
  });

  it('returns 202 and fires background fetch on happy path', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 202 }),
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(202);
    expect(res._json).toEqual({ message: 'Analysis started' });
  });

  it('fires fetch to the analyze-plots endpoint with Bearer token', async () => {
    process.env.CRON_SECRET = 'my-secret';
    process.env.VERCEL_URL = 'example.vercel.app';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.vercel.app/api/ml/analyze-plots',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer my-secret' },
      },
    );
  });

  it('uses http protocol when VERCEL_URL starts with localhost', async () => {
    process.env.CRON_SECRET = 'secret';
    process.env.VERCEL_URL = 'localhost:3000';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/^http:\/\/localhost/);
  });

  it('defaults to localhost:3000 when VERCEL_URL is not set', async () => {
    process.env.CRON_SECRET = 'secret';
    delete process.env.VERCEL_URL;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://localhost:3000/api/ml/analyze-plots');
  });

  it('logs error when background fetch rejects but still returns 202', async () => {
    process.env.CRON_SECRET = 'secret';
    const fetchError = new Error('network failure');
    const mockFetch = vi.fn().mockRejectedValue(fetchError);
    vi.stubGlobal('fetch', mockFetch);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    // Response must still be 202 — fire-and-forget
    expect(res._status).toBe(202);

    // Give the rejected promise a chance to settle so the .catch() fires
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      { err: fetchError },
      'trigger-analyze: background call failed',
    );
  });
});
