// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (vi.mock is hoisted; use vi.hoisted for the fns) ───────

const { mockSendNotification, mockSql } = vi.hoisted(() => ({
  mockSendNotification: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: { sendNotification: mockSendNotification },
  sendNotification: mockSendNotification,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    setTag: vi.fn(),
  },
}));

import {
  sendPushToAll,
  SUBSCRIPTION_FAILURE_LIMIT,
} from '../_lib/web-push-client.js';
import type { AlertEvent } from '../../src/utils/futures-gamma/alerts.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Fixtures ─────────────────────────────────────────────────────

const TEST_EVENT: AlertEvent = {
  id: 'REGIME_FLIP::2026-04-21T15:00:00.000Z',
  type: 'REGIME_FLIP',
  title: 'Regime flip: POSITIVE → NEGATIVE',
  body: 'Net GEX flipped negative — dealers amplify moves.',
  severity: 'urgent',
  ts: '2026-04-21T15:00:00.000Z',
};

function makeRow(
  overrides: Partial<{
    endpoint: string;
    p256dh: string;
    auth: string;
    failure_count: number;
  }> = {},
) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc-123',
    p256dh: 'BPwXyZ-fakekey',
    auth: 'AbCdEf-fakeauth',
    failure_count: 0,
    ...overrides,
  };
}

class MockWebPushError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('sendPushToAll', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset();
    mockSendNotification.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      VAPID_PUBLIC_KEY: 'test-public-key',
      VAPID_PRIVATE_KEY: 'test-private-key',
      VAPID_SUBJECT: 'mailto:test@example.com',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── Missing VAPID env ────────────────────────────────────────

  it('returns zero counts and does not call sendNotification when VAPID env is missing', async () => {
    delete process.env.VAPID_PUBLIC_KEY;

    const result = await sendPushToAll(TEST_EVENT);

    expect(result).toEqual({
      delivered: 0,
      errors: 0,
      deliveredEndpoints: [],
    });
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    // The warn is logged once (module-level guard).
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        hasPublic: false,
      }),
      expect.stringContaining('VAPID env vars missing'),
    );
  });

  // ── Empty subscriptions ──────────────────────────────────────

  it('returns zero counts and does not call sendNotification when no subscriptions exist', async () => {
    mockSql.mockResolvedValueOnce([]); // listActiveSubscriptions

    const result = await sendPushToAll(TEST_EVENT);

    expect(result).toEqual({
      delivered: 0,
      errors: 0,
      deliveredEndpoints: [],
    });
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Happy path ───────────────────────────────────────────────

  it('calls sendNotification per subscription on the happy path', async () => {
    const rowA = makeRow({ endpoint: 'https://push.example/a' });
    const rowB = makeRow({ endpoint: 'https://push.example/b' });

    mockSql
      .mockResolvedValueOnce([rowA, rowB]) // listActiveSubscriptions
      .mockResolvedValue([]); // markDelivered UPDATEs

    mockSendNotification.mockResolvedValue({
      statusCode: 201,
      body: '',
      headers: {},
    });

    const result = await sendPushToAll(TEST_EVENT);

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://push.example/a',
        keys: expect.objectContaining({ p256dh: rowA.p256dh, auth: rowA.auth }),
      }),
      JSON.stringify(TEST_EVENT),
      expect.objectContaining({
        TTL: 3600,
        timeout: 5000,
        vapidDetails: expect.objectContaining({
          subject: 'mailto:test@example.com',
        }),
      }),
    );
    expect(result.delivered).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.deliveredEndpoints).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ]);
  });

  // ── 410 Gone ─────────────────────────────────────────────────

  it('deletes the subscription row when the push service returns 410', async () => {
    const row = makeRow({ endpoint: 'https://push.example/dead' });

    mockSql
      .mockResolvedValueOnce([row]) // listActiveSubscriptions
      .mockResolvedValueOnce([]); // DELETE push_subscriptions

    mockSendNotification.mockRejectedValueOnce(
      new MockWebPushError('Gone', 410),
    );

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.delivered).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.deliveredEndpoints).toEqual([]);
    // 1 SELECT + 1 DELETE = 2 SQL calls
    expect(mockSql).toHaveBeenCalledTimes(2);
    // 410 is a "subscription gone" signal — should NOT be reported to Sentry
    // as that drowns the dashboard with normal device-uninstall events.
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it('deletes the subscription row when the push service returns 404', async () => {
    const row = makeRow({ endpoint: 'https://push.example/missing' });

    mockSql
      .mockResolvedValueOnce([row]) // listActiveSubscriptions
      .mockResolvedValueOnce([]); // DELETE

    mockSendNotification.mockRejectedValueOnce(
      new MockWebPushError('Not Found', 404),
    );

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.errors).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── 5xx → failure_count increments ──────────────────────────

  it('increments failure_count on 5xx (below limit)', async () => {
    const row = makeRow({ failure_count: 0 });

    mockSql
      .mockResolvedValueOnce([row]) // listActiveSubscriptions
      .mockResolvedValueOnce([]); // UPDATE failure_count

    mockSendNotification.mockRejectedValueOnce(
      new MockWebPushError('Server Error', 503),
    );

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.errors).toBe(1);
    // 1 SELECT + 1 UPDATE = 2 SQL calls (no DELETE because count = 1 < 3)
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  it('deletes the row when the 3rd consecutive 5xx pushes failure_count to the limit', async () => {
    const row = makeRow({
      failure_count: SUBSCRIPTION_FAILURE_LIMIT - 1, // == 2
    });

    mockSql
      .mockResolvedValueOnce([row]) // listActiveSubscriptions
      .mockResolvedValueOnce([]); // DELETE

    mockSendNotification.mockRejectedValueOnce(
      new MockWebPushError('Bad Gateway', 502),
    );

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.errors).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Transport errors (no statusCode) ─────────────────────────

  it('treats transport errors with no statusCode as 5xx (increments failure_count)', async () => {
    const row = makeRow({ failure_count: 0 });

    mockSql
      .mockResolvedValueOnce([row]) // listActiveSubscriptions
      .mockResolvedValueOnce([]); // UPDATE

    mockSendNotification.mockRejectedValueOnce(new Error('socket timeout'));

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.errors).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Concurrent delivery isolation ────────────────────────────

  it('does not let one failed delivery poison the others (Promise.allSettled)', async () => {
    const rowOk = makeRow({ endpoint: 'https://push.example/ok' });
    const rowGone = makeRow({
      endpoint: 'https://push.example/gone',
      failure_count: 0,
    });

    mockSql
      .mockResolvedValueOnce([rowOk, rowGone]) // listActiveSubscriptions
      .mockResolvedValue([]); // UPDATE markDelivered + DELETE 410

    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
      .mockRejectedValueOnce(new MockWebPushError('Gone', 410));

    const result = await sendPushToAll(TEST_EVENT);

    expect(result.delivered).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.deliveredEndpoints).toEqual(['https://push.example/ok']);
  });

  // ── DB SELECT failure ────────────────────────────────────────

  it('returns zero counts when the subscription SELECT fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const result = await sendPushToAll(TEST_EVENT);

    expect(result).toEqual({
      delivered: 0,
      errors: 0,
      deliveredEndpoints: [],
    });
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });
});
