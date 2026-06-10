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
    captureException: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => mockDone),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { withDbReader, withRequestScope } from '../_lib/request-scope.js';
import { TransientDbError } from '../_lib/db.js';
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

describe('withDbReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the inner handler with the scoped req/res/done; no catch on success', async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader('/api/zero-gamma', 'zero_gamma', handler);

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(handler).toHaveBeenCalledTimes(1);
    // The handler received the wrapper's own res + done.
    const [, handlerRes, handlerDone] = handler.mock.calls[0]!;
    expect(handlerRes).toBe(res);
    expect(handlerDone).toBe(mockDone);
    expect(mockDone).toHaveBeenCalledWith({ status: 200 });
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    // Soft-degrade catch did not fire.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('degrades a TransientDbError to 503 with Retry-After, records done(503), no Sentry', async () => {
    const res = mockResponse();
    const handler = vi.fn(async () => {
      throw new TransientDbError(new Error('db attempt timeout'));
    });
    const wrapped = withDbReader('/api/zero-gamma', 'zero_gamma', handler);

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(mockDone).toHaveBeenCalledWith({ status: 503 });
    expect(metrics.increment).toHaveBeenCalledWith('zero_gamma.db_timeout');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('degrades a genuine Error to 500 with the default body, records done(500), captures in Sentry', async () => {
    const res = mockResponse();
    const err = new Error('boom');
    const handler = vi.fn(async () => {
      throw err;
    });
    const wrapped = withDbReader('/api/zero-gamma', 'zero_gamma', handler);

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(res._headers['Retry-After']).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith({ status: 500 });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('uses a custom serverErrorBody on a genuine 500 when provided', async () => {
    const res = mockResponse();
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const wrapped = withDbReader('/api/journal', 'journal', handler, {
      serverErrorBody: { error: 'Query failed' },
    });

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Query failed' });
    expect(mockDone).toHaveBeenCalledWith({ status: 500 });
  });

  it('returns 405 on a non-GET request and never calls the inner handler', async () => {
    const res = mockResponse();
    const handler = vi.fn();
    const wrapped = withDbReader('/api/zero-gamma', 'zero_gamma', handler);

    await wrapped(mockRequest({ method: 'POST' }), res);

    expect(handler).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledWith({ status: 405 });
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    // No error path ran.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
