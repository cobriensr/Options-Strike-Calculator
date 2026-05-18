// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────
// vi.mock factories are hoisted; use vi.hoisted() so the spies are
// initialized before the factory runs and the same instance is
// referenced from both the factory and the test bodies below.
const { mockSendNotification, mockSetVapidDetails } = vi.hoisted(() => ({
  mockSendNotification: vi.fn(),
  mockSetVapidDetails: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: {
    sendNotification: mockSendNotification,
    setVapidDetails: mockSetVapidDetails,
  },
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { sendPushToOwner, __resetVapidForTests } from '../_lib/push.js';

const VAPID_ENV = {
  VAPID_SUBJECT: 'mailto:test@example.com',
  VAPID_PUBLIC_KEY: 'pub-key',
  VAPID_PRIVATE_KEY: 'priv-key',
};

describe('sendPushToOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVapidForTests();
    process.env.VAPID_SUBJECT = VAPID_ENV.VAPID_SUBJECT;
    process.env.VAPID_PUBLIC_KEY = VAPID_ENV.VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY = VAPID_ENV.VAPID_PRIVATE_KEY;
  });

  it('throws when VAPID env vars are missing', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    mockSql.mockResolvedValue([]);
    await expect(sendPushToOwner({ title: 'x', body: 'y' })).rejects.toThrow(
      'web-push not configured',
    );
  });

  it('returns zeros when no subscriptions exist', async () => {
    mockSql.mockResolvedValue([]);
    const result = await sendPushToOwner({ title: 'x', body: 'y' });
    expect(result).toEqual({ sent: 0, expired: 0, failed: 0 });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('fans out to every subscription, increments sent', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, endpoint: 'https://a/1', p256dh_key: 'p1', auth_key: 'a1' },
      { id: 2, endpoint: 'https://b/2', p256dh_key: 'p2', auth_key: 'a2' },
    ]);
    // Subsequent calls are the last_used_at UPDATE — return empty rows.
    mockSql.mockResolvedValueOnce([]);
    mockSendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await sendPushToOwner({
      title: 'SPXW 7360C 71% ASK',
      body: '$1.33M premium / 5 trades',
      tag: 'interval-ba-42',
    });

    expect(result.sent).toBe(2);
    expect(result.expired).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    // VAPID detail set once.
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      'mailto:test@example.com',
      'pub-key',
      'priv-key',
    );
    // Payload serialized as JSON for the push service.
    const [subscription, payload, options] =
      mockSendNotification.mock.calls[0]!;
    expect(subscription).toEqual({
      endpoint: 'https://a/1',
      keys: { p256dh: 'p1', auth: 'a1' },
    });
    expect(JSON.parse(payload as string)).toEqual({
      title: 'SPXW 7360C 71% ASK',
      body: '$1.33M premium / 5 trades',
      tag: 'interval-ba-42',
    });
    expect((options as { TTL: number }).TTL).toBe(60);
  });

  it('cleans up subscriptions returning 410 Gone', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, endpoint: 'https://a/1', p256dh_key: 'p1', auth_key: 'a1' },
      { id: 2, endpoint: 'https://b/2', p256dh_key: 'p2', auth_key: 'a2' },
    ]);
    // DELETE for expired
    mockSql.mockResolvedValueOnce([]);
    // UPDATE last_used_at for survivors
    mockSql.mockResolvedValueOnce([]);

    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(
        Object.assign(new Error('Gone'), { statusCode: 410 }),
      );

    const result = await sendPushToOwner({ title: 'x', body: 'y' });

    expect(result.sent).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.failed).toBe(0);
    // The DELETE was issued for the expired subscription.
    expect(mockSql).toHaveBeenCalledTimes(3); // SELECT + DELETE + UPDATE
  });

  it('counts 404 Not Found as expired (same cleanup path)', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, endpoint: 'https://a/1', p256dh_key: 'p1', auth_key: 'a1' },
    ]);
    mockSql.mockResolvedValueOnce([]);

    mockSendNotification.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { statusCode: 404 }),
    );

    const result = await sendPushToOwner({ title: 'x', body: 'y' });
    expect(result.expired).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.sent).toBe(0);
  });

  it('counts 5xx as failed (no cleanup)', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, endpoint: 'https://a/1', p256dh_key: 'p1', auth_key: 'a1' },
    ]);

    mockSendNotification.mockRejectedValueOnce(
      Object.assign(new Error('upstream down'), { statusCode: 503 }),
    );

    const result = await sendPushToOwner({ title: 'x', body: 'y' });
    expect(result.failed).toBe(1);
    expect(result.expired).toBe(0);
    // No DELETE since nothing expired. SELECT was the only DB call.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('only updates last_used_at for surviving subscriptions', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, endpoint: 'https://a/1', p256dh_key: 'p1', auth_key: 'a1' },
      { id: 2, endpoint: 'https://b/2', p256dh_key: 'p2', auth_key: 'a2' },
      { id: 3, endpoint: 'https://c/3', p256dh_key: 'p3', auth_key: 'a3' },
    ]);
    mockSql.mockResolvedValueOnce([]); // DELETE expired
    mockSql.mockResolvedValueOnce([]); // UPDATE last_used_at

    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(
        Object.assign(new Error('Gone'), { statusCode: 410 }),
      )
      .mockResolvedValueOnce({ statusCode: 201 });

    const result = await sendPushToOwner({ title: 'x', body: 'y' });
    expect(result.sent).toBe(2);
    expect(result.expired).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('caches VAPID config — does not call setVapidDetails twice', async () => {
    mockSql.mockResolvedValue([]);
    await sendPushToOwner({ title: 'x', body: 'y' });
    await sendPushToOwner({ title: 'x', body: 'y' });
    // setVapidDetails should fire ONCE across two calls.
    expect(mockSetVapidDetails).toHaveBeenCalledTimes(1);
  });

  it('normalizes VAPID keys before passing to the SDK (strips trailing =, swaps +/ → -_, trims whitespace)', async () => {
    // Common operator footgun: env var pasted with trailing `=` padding
    // (from `openssl base64`) or the standard-alphabet `+`/`/` instead
    // of URL-safe `-`/`_`. The web-push SDK rejects either with
    // `Vapid public key must be a URL safe Base 64 (without "=")`
    // (SENTRY-EMERALD-DESERT-7W).
    process.env.VAPID_PUBLIC_KEY = '  pub+key/sample==  ';
    process.env.VAPID_PRIVATE_KEY = 'priv/key+raw==';
    mockSql.mockResolvedValue([]);

    await sendPushToOwner({ title: 'x', body: 'y' });

    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      VAPID_ENV.VAPID_SUBJECT,
      'pub-key_sample',
      'priv_key-raw',
    );
  });
});
