// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// `notify.ts` calls sendPushToOwner — mock it.
const mockSendPushToOwner = vi.hoisted(() => vi.fn());
vi.mock('../_lib/push.js', () => ({
  sendPushToOwner: mockSendPushToOwner,
}));

import subscribeHandler from '../push/subscribe.js';
import unsubscribeHandler from '../push/unsubscribe.js';
import notifyHandler from '../push/notify.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';

const VALID_SUBSCRIBE_BODY = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BJsxxx', auth: 'zzz' },
  user_agent: 'Mozilla/5.0 ...',
};

const VALID_NOTIFY_BODY = {
  title: 'SPXW 7360C 71% ASK',
  body: '$1.33M premium / 5 trades',
  tag: 'interval-ba-42',
  requireInteraction: true,
};

describe('POST /api/push/subscribe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await subscribeHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await subscribeHandler(
      mockRequest({ method: 'POST', body: VALID_SUBSCRIBE_BODY }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for missing endpoint', async () => {
    const res = mockResponse();
    await subscribeHandler(
      mockRequest({
        method: 'POST',
        body: { keys: { p256dh: 'x', auth: 'y' } },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for missing keys', async () => {
    const res = mockResponse();
    await subscribeHandler(
      mockRequest({
        method: 'POST',
        body: { endpoint: 'https://example.com/abc' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('UPSERTs the subscription and returns 200', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await subscribeHandler(
      mockRequest({ method: 'POST', body: VALID_SUBSCRIBE_BODY }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ subscribed: true });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('accepts subscription without user_agent', async () => {
    mockSql.mockResolvedValue([]);
    const withoutUA = {
      endpoint: VALID_SUBSCRIBE_BODY.endpoint,
      keys: VALID_SUBSCRIBE_BODY.keys,
    };
    const res = mockResponse();
    await subscribeHandler(
      mockRequest({ method: 'POST', body: withoutUA }),
      res,
    );
    expect(res._status).toBe(200);
  });
});

describe('POST /api/push/unsubscribe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await unsubscribeHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await unsubscribeHandler(
      mockRequest({
        method: 'POST',
        body: { endpoint: 'https://example.com/x' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('returns 400 for missing endpoint', async () => {
    const res = mockResponse();
    await unsubscribeHandler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('returns 200 even when endpoint is not on file (idempotent)', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await unsubscribeHandler(
      mockRequest({
        method: 'POST',
        body: { endpoint: 'https://example.com/never-existed' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ unsubscribed: true });
  });
});

describe('POST /api/push/notify', () => {
  const REAL_SECRET = 'super-secret-token-32-chars-aaaa';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSql.mockReset();
    mockSendPushToOwner.mockReset();
    process.env.INTERNAL_NOTIFY_SECRET = REAL_SECRET;
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await notifyHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when secret header is missing', async () => {
    const res = mockResponse();
    await notifyHandler(
      mockRequest({ method: 'POST', body: VALID_NOTIFY_BODY }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSendPushToOwner).not.toHaveBeenCalled();
  });

  it('returns 401 when secret header is wrong', async () => {
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: VALID_NOTIFY_BODY,
        headers: { 'x-internal-notify-secret': 'wrong-token' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSendPushToOwner).not.toHaveBeenCalled();
  });

  it('returns 401 when INTERNAL_NOTIFY_SECRET env var is unset', async () => {
    delete process.env.INTERNAL_NOTIFY_SECRET;
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: VALID_NOTIFY_BODY,
        headers: { 'x-internal-notify-secret': 'anything' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('returns 400 for missing title', async () => {
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: { body: 'no title' },
        headers: { 'x-internal-notify-secret': REAL_SECRET },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for missing body', async () => {
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: { title: 'no body' },
        headers: { 'x-internal-notify-secret': REAL_SECRET },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('fans out and returns the result on valid secret + body', async () => {
    mockSendPushToOwner.mockResolvedValue({
      sent: 2,
      expired: 0,
      failed: 0,
    });
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: VALID_NOTIFY_BODY,
        headers: { 'x-internal-notify-secret': REAL_SECRET },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ sent: 2, expired: 0, failed: 0 });
    expect(mockSendPushToOwner).toHaveBeenCalledWith(VALID_NOTIFY_BODY);
  });

  it('returns 500 if sendPushToOwner throws (e.g. VAPID unset)', async () => {
    mockSendPushToOwner.mockRejectedValue(new Error('web-push not configured'));
    const res = mockResponse();
    await notifyHandler(
      mockRequest({
        method: 'POST',
        body: VALID_NOTIFY_BODY,
        headers: { 'x-internal-notify-secret': REAL_SECRET },
      }),
      res,
    );
    expect(res._status).toBe(500);
  });
});
