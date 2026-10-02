// @vitest-environment node

/**
 * /api/cron/schwab-reauth-reminder — pushes a re-auth reminder 24 h and 2 h
 * before the Schwab refresh token lapses, then once per CT day while lapsed.
 *
 * Mocks sit at the external boundaries: the Upstash client (token record +
 * claim keys) and the web-push fan-out. The real `getSchwabAuthStatus`
 * runs, so a malformed record and a Redis outage go through the same code
 * production does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockRedisGet,
  mockRedisSet,
  mockRedisEval,
  mockSendPush,
  mockSentry,
  mockLogger,
} = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisEval: vi.fn(),
  mockSendPush: vi.fn(),
  mockSentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    get = mockRedisGet;
    set = mockRedisSet;
    eval = mockRedisEval;
  },
}));

vi.mock('../_lib/push.js', () => ({ sendPushToOwner: mockSendPush }));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: { increment: vi.fn() },
}));

import handler from '../cron/schwab-reauth-reminder.js';

const HOUR_MS = 60 * 60 * 1000;
// Thu Oct 1, 11:30 PM CT (04:30 UTC on Fri Oct 2).
const NOW = Date.parse('2026-10-02T04:30:00Z');
// The lapsed nag day at NOW (it rolls over at 07:00 CT, not midnight).
const NAG_DAY = '2026-10-01';
const CLAIM_TTL_SEC = 48 * 60 * 60;
const PUSH_TTL_SEC = 6 * 60 * 60;

function storedTokens(refreshExpiresAt: unknown) {
  return {
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    expiresAt: NOW + 20 * 60 * 1000,
    refreshExpiresAt,
  };
}

async function runCron() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

function bodyOf(res: ReturnType<typeof mockResponse>) {
  return res._json as { status: string; message?: string; kind?: string };
}

/** The claim token this run wrote with SET NX. */
function claimToken(): string {
  return mockRedisSet.mock.calls[0]![1] as string;
}

describe('cron schwab-reauth-reminder', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    mockRedisGet.mockReset();
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisEval.mockReset().mockResolvedValue(1);
    mockSendPush
      .mockReset()
      .mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 401 without the cron secret and reads nothing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  describe('thresholds', () => {
    it('sends nothing while more than 24 h remain', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 3 * 24 * HOUR_MS));
      const res = await runCron();
      expect(bodyOf(res).status).toBe('success');
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('sends the 24h reminder, claimed on the login expiry', async () => {
      const refreshExpiresAt = NOW + 10 * HOUR_MS; // Fri 9:30 AM CT
      mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));

      const res = await runCron();

      expect(mockRedisSet).toHaveBeenCalledWith(
        `schwab:reauth-reminder:24h:${refreshExpiresAt}`,
        expect.any(String),
        { nx: true, ex: CLAIM_TTL_SEC },
      );
      expect(mockSendPush).toHaveBeenCalledWith(
        {
          title: 'Schwab login expires within 24 hours',
          body: 'Expires Fri 9:30 AM CT. Tap to re-authenticate.',
          tag: `schwab-reauth-24h-${refreshExpiresAt}`,
          requireInteraction: true,
          url: '/api/auth/init',
        },
        { ttlSec: PUSH_TTL_SEC },
      );
      expect(bodyOf(res)).toMatchObject({ status: 'success', kind: '24h' });
    });

    it('claims before it sends', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      await runCron();
      expect(mockRedisSet.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendPush.mock.invocationCallOrder[0]!,
      );
    });

    it('sends the 2h reminder once 2 h or less remain', async () => {
      const refreshExpiresAt = NOW + 90 * 60 * 1000; // Fri 1:00 AM CT
      mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));

      await runCron();

      expect(mockRedisSet).toHaveBeenCalledWith(
        `schwab:reauth-reminder:2h:${refreshExpiresAt}`,
        expect.any(String),
        { nx: true, ex: CLAIM_TTL_SEC },
      );
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Schwab login expires in under 2 hours',
          body: 'Expires Fri 1:00 AM CT. Tap to re-authenticate.',
          tag: `schwab-reauth-2h-${refreshExpiresAt}`,
          url: '/api/auth/init',
        }),
        { ttlSec: PUSH_TTL_SEC },
      );
    });

    it('sends the lapsed reminder once expired', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW - HOUR_MS));

      const res = await runCron();

      expect(mockRedisSet).toHaveBeenCalledWith(
        `schwab:reauth-reminder:lapsed:${NAG_DAY}`,
        expect.any(String),
        { nx: true, ex: CLAIM_TTL_SEC },
      );
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Schwab login expired',
          body: 'Expired Thu 10:30 PM CT; live Schwab data is off. Tap to re-authenticate.',
          tag: `schwab-reauth-lapsed-${NAG_DAY}`,
          requireInteraction: true,
          url: '/api/auth/init',
        }),
        { ttlSec: PUSH_TTL_SEC },
      );
      expect(bodyOf(res)).toMatchObject({ status: 'success', kind: 'lapsed' });
    });

    it('sends the lapsed reminder when no token record is stored', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      await runCron();
      expect(mockRedisSet).toHaveBeenCalledWith(
        `schwab:reauth-reminder:lapsed:${NAG_DAY}`,
        expect.any(String),
        { nx: true, ex: CLAIM_TTL_SEC },
      );
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Live Schwab data is off. Tap to re-authenticate.',
        }),
        { ttlSec: PUSH_TTL_SEC },
      );
    });

    it('never puts token values in the push payload', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      await runCron();
      const sent = JSON.stringify(mockSendPush.mock.calls[0]);
      expect(sent).not.toContain('secret-access-token');
      expect(sent).not.toContain('secret-refresh-token');
    });
  });

  describe('the lapsed nag day rolls over at 07:00 CT', () => {
    it.each([
      [
        '11:30 PM CT, the run after a lapse',
        '2026-10-02T04:30:00Z',
        '2026-10-01',
      ],
      [
        '00:30 CT: midnight is not a rollover',
        '2026-10-02T05:30:00Z',
        '2026-10-01',
      ],
      // ET and UTC have both rolled to Oct 2 here; only a CT bucket has not.
      [
        '06:30 CT: still the previous nag day',
        '2026-10-02T11:30:00Z',
        '2026-10-01',
      ],
      ['07:30 CT: the next nag day', '2026-10-02T12:30:00Z', '2026-10-02'],
      // Fall-back Sunday (Nov 1 2026, 02:00 CDT → 01:00 CST): the 7 h
      // shift rolls the day at 06:00 CST.
      ['fall-back Sun 05:07 CST', '2026-11-01T11:07:00Z', '2026-10-31'],
      ['fall-back Sun 06:07 CST', '2026-11-01T12:07:00Z', '2026-11-01'],
      ['the Monday after, 06:30 CST', '2026-11-02T12:30:00Z', '2026-11-01'],
      ['the Monday after, 07:07 CST', '2026-11-02T13:07:00Z', '2026-11-02'],
      // Spring-forward Sunday (Mar 14 2027, 02:00 CST → 03:00 CDT): the
      // day rolls at 08:00 CDT.
      ['spring-forward Sun 07:07 CDT', '2027-03-14T12:07:00Z', '2027-03-13'],
      ['spring-forward Sun 08:07 CDT', '2027-03-14T13:07:00Z', '2027-03-14'],
      ['the Monday after, 06:30 CDT', '2027-03-15T11:30:00Z', '2027-03-14'],
      ['the Monday after, 07:07 CDT', '2027-03-15T12:07:00Z', '2027-03-15'],
    ])('%s → %s', async (_label, iso, nagDay) => {
      vi.setSystemTime(Date.parse(iso));
      mockRedisGet.mockResolvedValueOnce(null);

      await runCron();

      expect(mockRedisSet).toHaveBeenCalledWith(
        `schwab:reauth-reminder:lapsed:${nagDay}`,
        expect.any(String),
        { nx: true, ex: CLAIM_TTL_SEC },
      );
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({ tag: `schwab-reauth-lapsed-${nagDay}` }),
        { ttlSec: PUSH_TTL_SEC },
      );
    });
  });

  describe('idempotency', () => {
    it('skips without pushing when the claim is already held', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      mockRedisSet.mockResolvedValueOnce(null);

      const res = await runCron();

      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockRedisEval).not.toHaveBeenCalled();
      expect(bodyOf(res)).toMatchObject({ status: 'skipped', kind: '24h' });
    });

    it('keeps the claim when at least one device received it', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      mockSendPush.mockResolvedValueOnce({ sent: 1, expired: 0, failed: 1 });

      const res = await runCron();

      expect(mockRedisEval).not.toHaveBeenCalled();
      expect(bodyOf(res).status).toBe('partial');
    });
  });

  describe('failure modes', () => {
    it('no subscriptions: releases its own claim, captures, reports error', async () => {
      const refreshExpiresAt = NOW + 10 * HOUR_MS;
      mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));
      mockSendPush.mockResolvedValueOnce({ sent: 0, expired: 0, failed: 0 });

      const res = await runCron();

      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('DEL', KEYS[1])"),
        [`schwab:reauth-reminder:24h:${refreshExpiresAt}`],
        [claimToken()],
      );
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.reauth_reminder.undelivered',
        expect.objectContaining({
          extra: expect.objectContaining({ reason: 'no push subscriptions' }),
        }),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('every send failed: releases the claim, captures, reports error', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      mockSendPush.mockResolvedValueOnce({ sent: 0, expired: 0, failed: 2 });

      const res = await runCron();

      expect(mockRedisEval).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.reauth_reminder.undelivered',
        expect.objectContaining({
          extra: expect.objectContaining({ reason: 'every send failed' }),
        }),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('every subscription expired (410/404): releases the claim and says so', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      mockSendPush.mockResolvedValueOnce({ sent: 0, expired: 2, failed: 0 });

      const res = await runCron();

      expect(mockRedisEval).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.reauth_reminder.undelivered',
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: 'every subscription expired',
          }),
        }),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('send throws (push_subscriptions read rejected): releases the claim, 500, captured', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW - HOUR_MS));
      const err = new Error('Neon: connection refused');
      mockSendPush.mockRejectedValueOnce(err);

      const res = await runCron();

      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        [`schwab:reauth-reminder:lapsed:${NAG_DAY}`],
        [claimToken()],
      );
      expect(mockSentry.captureException).toHaveBeenCalledWith(err);
      expect(res._status).toBe(500);
    });

    it('a failed claim release is captured (the reminder is then not retried)', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      mockSendPush.mockResolvedValueOnce({ sent: 0, expired: 0, failed: 0 });
      const releaseErr = new Error('ECONNRESET');
      mockRedisEval.mockRejectedValueOnce(releaseErr);

      const res = await runCron();

      expect(mockSentry.captureException).toHaveBeenCalledWith(releaseErr);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: releaseErr }),
        expect.stringContaining('claim release failed'),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('Redis down on the status read: no claim, no push, captured, error', async () => {
      mockRedisGet.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      const res = await runCron();

      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.reauth_reminder.status_unknown',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('malformed token record: no claim, no push, captured, error', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens('next tuesday'));

      const res = await runCron();

      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'schwab.reauth_reminder.status_unknown',
        expect.anything(),
      );
      expect(bodyOf(res).status).toBe('error');
    });

    it('Redis down on the claim: fails closed (no push), 500, captured', async () => {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 10 * HOUR_MS));
      const err = new Error('ETIMEDOUT');
      mockRedisSet.mockRejectedValueOnce(err);

      const res = await runCron();

      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockSentry.captureException).toHaveBeenCalledWith(err);
      expect(res._status).toBe(500);
    });
  });
});
