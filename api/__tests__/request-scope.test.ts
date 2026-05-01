// @vitest-environment node

/**
 * Unit tests for api/_lib/request-scope.ts (Phase 1f).
 *
 * Covers the shared endpoint preamble:
 *   - Sentry isolation scope wrapping
 *   - Transaction name set to "<METHOD> <path>"
 *   - metrics.request invoked with the path
 *   - 405 short-circuit on method mismatch
 *   - done() handed to the inner handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransactionName = vi.fn();
const mockScope = { setTransactionName: mockTransactionName };
const mockDone = vi.fn();

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn(
      async (cb: (scope: typeof mockScope) => unknown) => {
        return await cb(mockScope);
      },
    ),
  },
  metrics: {
    request: vi.fn(() => mockDone),
  },
}));

import { withRequestScope } from '../_lib/request-scope.js';
import { Sentry, metrics } from '../_lib/sentry.js';

describe('withRequestScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps the handler in Sentry.withIsolationScope', async () => {
    const handler = vi.fn();
    const wrapped = withRequestScope('GET', '/api/foo', handler);

    await wrapped(mockRequest({ method: 'GET' }), mockResponse());

    expect(Sentry.withIsolationScope).toHaveBeenCalledTimes(1);
  });

  it('sets the transaction name to "<METHOD> <path>"', async () => {
    const handler = vi.fn();
    const wrapped = withRequestScope('GET', '/api/bar', handler);

    await wrapped(mockRequest({ method: 'GET' }), mockResponse());

    expect(mockTransactionName).toHaveBeenCalledWith('GET /api/bar');
  });

  it('calls metrics.request with the path', async () => {
    const handler = vi.fn();
    const wrapped = withRequestScope('GET', '/api/baz', handler);

    await wrapped(mockRequest({ method: 'GET' }), mockResponse());

    expect(metrics.request).toHaveBeenCalledWith('/api/baz');
  });

  it('passes the done() callback into the inner handler', async () => {
    const handler = vi.fn(async (_req, _res, done) => {
      done({ status: 200 });
    });
    const wrapped = withRequestScope('GET', '/api/foo', handler);

    await wrapped(mockRequest({ method: 'GET' }), mockResponse());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledWith({ status: 200 });
  });

  it('returns 405 when method does not match (GET only)', async () => {
    const handler = vi.fn();
    const wrapped = withRequestScope('GET', '/api/foo', handler);

    const res = mockResponse();
    await wrapped(mockRequest({ method: 'POST' }), res);

    expect(handler).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledWith({ status: 405 });
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 405 when method does not match (POST only)', async () => {
    const handler = vi.fn();
    const wrapped = withRequestScope('POST', '/api/foo', handler);

    const res = mockResponse();
    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(handler).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledWith({ status: 405 });
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('does NOT call done() automatically when the handler runs (caller owns it)', async () => {
    const handler = vi.fn(); // does not call done
    const wrapped = withRequestScope('GET', '/api/foo', handler);

    await wrapped(mockRequest({ method: 'GET' }), mockResponse());

    expect(mockDone).not.toHaveBeenCalled();
  });
});
