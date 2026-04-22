// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from '../helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(async () => ({ isBot: false })),
}));

const mockSql = vi.fn();
vi.mock('../../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../../push/unsubscribe.js';
import { rejectIfNotOwner, checkBot } from '../../_lib/api-helpers.js';
import { Sentry } from '../../_lib/sentry.js';
import logger from '../../_lib/logger.js';

const VALID_BODY = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc-def-123',
};

describe('POST /api/push/unsubscribe', () => {
  beforeEach(() => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 403 when botid detects a bot', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);
    expect(res._status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when endpoint is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid request body' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when endpoint is not a URL', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { endpoint: 'nope' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 200 and deletes the row on happy path', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 200 even when row does not exist (idempotent)', async () => {
    // Neon's DELETE returns an empty array when no rows matched — same
    // code path, same response shape. We assert the endpoint does NOT
    // surface that distinction to the caller.
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { endpoint: 'https://example.com/push/missing' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
  });

  it('returns 500 on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });
});
