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

import handler from '../../push/subscribe.js';
import { rejectIfNotOwner, checkBot } from '../../_lib/api-helpers.js';
import { Sentry } from '../../_lib/sentry.js';
import logger from '../../_lib/logger.js';

const VALID_BODY = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc-def-123',
  keys: {
    p256dh: 'BPw-XyZ0123456789abcdef',
    auth: 'AbCdEf0123456789',
  },
};

describe('POST /api/push/subscribe', () => {
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
    await handler(
      mockRequest({
        method: 'POST',
        body: { keys: VALID_BODY.keys },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid request body' });
  });

  it('returns 400 when endpoint is not a URL', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { ...VALID_BODY, endpoint: 'not-a-url' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when keys.p256dh is empty', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { ...VALID_BODY, keys: { ...VALID_BODY.keys, p256dh: '' } },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('upserts a new subscription (happy path, below cap)', async () => {
    // existing lookup — new endpoint
    mockSql.mockResolvedValueOnce([]);
    // count
    mockSql.mockResolvedValueOnce([{ count: 2 }]);
    // upsert insert
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    // 3 calls: existing lookup, count, insert
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('skips cap check when endpoint already exists (refresh upsert)', async () => {
    // existing lookup — present
    mockSql.mockResolvedValueOnce([{ exists: 1 }]);
    // upsert insert
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    // Only 2 calls: existing lookup + insert (count + delete skipped)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('deletes oldest row when cap is reached before insert', async () => {
    // existing lookup — new endpoint
    mockSql.mockResolvedValueOnce([]);
    // count — at cap (5)
    mockSql.mockResolvedValueOnce([{ count: 5 }]);
    // delete oldest
    mockSql.mockResolvedValueOnce([]);
    // upsert insert
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('deletes enough rows when table is over cap (defensive)', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ count: 7 }]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: VALID_BODY }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    expect(mockSql).toHaveBeenCalledTimes(4);
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
