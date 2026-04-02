// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../alerts-ack.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────────
describe('POST /api/alerts-ack', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 405 for PUT', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { id: 1 } }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when id is missing from body', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 400 when id is a string', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: '42' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 400 when id is null', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: null } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 400 when id is undefined', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: undefined } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 400 when id is NaN', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: Number.NaN } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 400 when id is Infinity', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { id: Number.POSITIVE_INFINITY },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Missing or invalid alert id' });
  });

  it('returns 404 when alert ID does not exist', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: 999 } }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Alert not found' });
  });

  it('returns 200 with { acknowledged: id } on success', async () => {
    mockSql.mockResolvedValue([{ id: 42 }]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: 42 } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ acknowledged: 42 });
  });

  it('sets Cache-Control: no-store header on success', async () => {
    mockSql.mockResolvedValue([{ id: 7 }]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: 7 } }),
      res,
    );
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: 1 } }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as any).mockImplementation((cb: any) =>
      cb({ setTransactionName }),
    );
    mockSql.mockResolvedValue([{ id: 1 }]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { id: 1 } }),
      res,
    );

    expect(setTransactionName).toHaveBeenCalledWith(
      'POST /api/alerts-ack',
    );
  });
});
