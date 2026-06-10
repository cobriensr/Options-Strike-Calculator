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
const mockSetTag = vi.fn();
const mockScope = {
  setTransactionName: mockTransactionName,
  setTag: mockSetTag,
};
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

vi.mock('../_lib/auth-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn(async () => false),
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn(async () => false),
}));

import { withDbReader, withRequestScope } from '../_lib/request-scope.js';
import { TransientDbError } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { guardOwnerEndpoint } from '../_lib/auth-helpers.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';

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
    // clearAllMocks wipes implementations too — restore the default
    // "guard passed" behavior so tests not exercising rejection proceed.
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  });

  it('runs the inner handler with the scoped req/res/done; no catch on success', async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(handler).toHaveBeenCalledTimes(1);
    // The handler received the wrapper's own res. `done` is the latch
    // wrapper (not the raw metrics done), but calling it forwards to mockDone.
    const [, handlerRes] = handler.mock.calls[0]!;
    expect(handlerRes).toBe(res);
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
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

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
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

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
    const wrapped = withDbReader(
      '/api/journal',
      'journal',
      'owner-or-guest',
      handler,
      {
        serverErrorBody: { error: 'Query failed' },
      },
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Query failed' });
    expect(mockDone).toHaveBeenCalledWith({ status: 500 });
  });

  it('returns 405 on a non-GET request and never calls the inner handler', async () => {
    const res = mockResponse();
    const handler = vi.fn();
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'POST' }), res);

    expect(handler).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledWith({ status: 405 });
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    // No error path ran.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("auth='public' → neither guard is called, the handler runs", async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader(
      '/api/ml/plots',
      'ml_plots',
      'public',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(guardOwnerEndpoint).not.toHaveBeenCalled();
    expect(guardOwnerOrGuestEndpoint).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
  });

  it("auth='owner-or-guest' → runs guardOwnerOrGuestEndpoint; rejection skips the handler and the catch", async () => {
    const res = mockResponse();
    // Guard rejects: it has already written its own 401/403 + recorded done.
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(true);
    const handler = vi.fn();
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(guardOwnerOrGuestEndpoint).toHaveBeenCalledTimes(1);
    expect(guardOwnerEndpoint).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // No soft-degrade catch fired on a clean guard rejection.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it("auth='owner-or-guest' → runs the guard and then the handler when it passes", async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(guardOwnerOrGuestEndpoint).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("auth='owner' → runs guardOwnerEndpoint, not the guest guard", async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader('/api/journal', 'journal', 'owner', handler);

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(guardOwnerEndpoint).toHaveBeenCalledTimes(1);
    expect(guardOwnerOrGuestEndpoint).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('latches done(): a handler that records 200 then throws records done exactly once (200), and the catch still sends a 500 body', async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, _r, done) => {
      done({ status: 200 });
      throw new Error('boom after success');
    });
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    // First done() wins — exactly one recorded status, the 200.
    expect(mockDone).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledWith({ status: 200 });
    // The catch still ran sendDbErrorResponse: a 500 body is written
    // (headersSent is false in the mock) and Sentry captured the error...
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // ...but its done({status:500}) was a no-op (latched).
  });

  it("sets the 'endpoint' Sentry tag to the path", async () => {
    const res = mockResponse();
    const handler = vi.fn(async (_req, r, done) => {
      done({ status: 200 });
      r.status(200).json({ ok: true });
    });
    const wrapped = withDbReader(
      '/api/zero-gamma',
      'zero_gamma',
      'owner-or-guest',
      handler,
    );

    await wrapped(mockRequest({ method: 'GET' }), res);

    expect(mockSetTag).toHaveBeenCalledWith('endpoint', '/api/zero-gamma');
  });
});
