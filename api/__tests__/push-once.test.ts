// @vitest-environment node

/**
 * push-once — claim a Redis key with SET NX, push to the owner, release the
 * claim (fenced) when nothing was delivered.
 *
 * Mocks sit at the module boundaries: the shared Redis client, the web-push
 * fan-out, the logger and Sentry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRedisSet, mockRedisEval, mockSendPush, mockSentry, mockLogger } =
  vi.hoisted(() => ({
    mockRedisSet: vi.fn(),
    mockRedisEval: vi.fn(),
    mockSendPush: vi.fn(),
    mockSentry: { captureException: vi.fn() },
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

vi.mock('../_lib/redis.js', () => ({
  redis: { set: mockRedisSet, eval: mockRedisEval },
}));

vi.mock('../_lib/push.js', () => ({ sendPushToOwner: mockSendPush }));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({ Sentry: mockSentry }));

import { sendOwnerPushOnce, undeliveredReason } from '../_lib/push-once.js';
import type { FanOutResult, PushPayload } from '../_lib/push.js';

const KEY = 'test-job:2026-11-11';
const CLAIM_TTL_SEC = 24 * 60 * 60;
const PUSH_TTL_SEC = 60 * 60;
const PAYLOAD: PushPayload = {
  title: 'Something happened',
  body: 'Open the app.',
  tag: 'test-job-2026-11-11',
};

function run() {
  return sendOwnerPushOnce({
    key: KEY,
    claimTtlSec: CLAIM_TTL_SEC,
    payload: PAYLOAD,
    pushTtlSec: PUSH_TTL_SEC,
    job: 'test-job',
  });
}

/** The claim token the n-th run wrote with SET NX. */
function claimToken(call = 0): string {
  return mockRedisSet.mock.calls[call]![1] as string;
}

describe('sendOwnerPushOnce', () => {
  beforeEach(() => {
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisEval.mockReset().mockResolvedValue(1);
    mockSendPush
      .mockReset()
      .mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    mockSentry.captureException.mockReset();
    mockLogger.error.mockReset();
  });

  it('claims the key, pushes with the push TTL, and returns the result', async () => {
    const outcome = await run();

    expect(mockRedisSet).toHaveBeenCalledWith(KEY, expect.any(String), {
      nx: true,
      ex: CLAIM_TTL_SEC,
    });
    expect(mockSendPush).toHaveBeenCalledWith(PAYLOAD, {
      ttlSec: PUSH_TTL_SEC,
    });
    expect(outcome).toEqual({
      claimed: true,
      result: { sent: 1, expired: 0, failed: 0 },
    });
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  it('claims before it sends', async () => {
    await run();
    expect(mockRedisSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendPush.mock.invocationCallOrder[0]!,
    );
  });

  it('writes a fresh claim token on every run', async () => {
    await run();
    await run();
    expect(claimToken(0)).not.toBe(claimToken(1));
  });

  it('keeps the claim when at least one device received it', async () => {
    mockSendPush.mockResolvedValueOnce({ sent: 1, expired: 0, failed: 1 });

    const outcome = await run();

    expect(mockRedisEval).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      claimed: true,
      result: { sent: 1, expired: 0, failed: 1 },
    });
  });

  describe('claim taken by an earlier run', () => {
    it('returns claimed: false without pushing or releasing', async () => {
      mockRedisSet.mockResolvedValueOnce(null);

      const outcome = await run();

      expect(outcome).toEqual({ claimed: false });
      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockRedisEval).not.toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('SET NX throws (Redis down): fails closed, rethrows, no push', async () => {
      const err = new Error('ETIMEDOUT');
      mockRedisSet.mockRejectedValueOnce(err);

      await expect(run()).rejects.toBe(err);

      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockRedisEval).not.toHaveBeenCalled();
    });

    it('push throws: releases its own claim (fenced) and rethrows', async () => {
      const err = new Error('Neon: connection refused');
      mockSendPush.mockRejectedValueOnce(err);

      await expect(run()).rejects.toBe(err);

      expect(mockRedisEval).toHaveBeenCalledTimes(1);
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('DEL', KEYS[1])"),
        [KEY],
        [claimToken()],
      );
    });

    it('release script deletes only while the key still holds the token', async () => {
      mockSendPush.mockResolvedValueOnce({ sent: 0, expired: 0, failed: 0 });

      await run();

      const script = mockRedisEval.mock.calls[0]![0] as string;
      expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    });

    it.each<[string, FanOutResult]>([
      ['no subscriptions', { sent: 0, expired: 0, failed: 0 }],
      ['every send failed', { sent: 0, expired: 0, failed: 2 }],
      ['every subscription expired', { sent: 0, expired: 2, failed: 0 }],
    ])(
      'sent 0 (%s): releases its own claim and returns the result',
      async (_label, result) => {
        mockSendPush.mockResolvedValueOnce(result);

        const outcome = await run();

        expect(mockRedisEval).toHaveBeenCalledTimes(1);
        expect(mockRedisEval).toHaveBeenCalledWith(
          expect.any(String),
          [KEY],
          [claimToken()],
        );
        expect(outcome).toEqual({ claimed: true, result });
      },
    );

    it('a failed release after sent 0 is logged and captured, and the outcome is still returned', async () => {
      const result = { sent: 0, expired: 0, failed: 0 };
      mockSendPush.mockResolvedValueOnce(result);
      const releaseErr = new Error('ECONNRESET');
      mockRedisEval.mockRejectedValueOnce(releaseErr);

      const outcome = await run();

      expect(outcome).toEqual({ claimed: true, result });
      expect(mockSentry.captureException).toHaveBeenCalledWith(releaseErr);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: releaseErr, key: KEY },
        'test-job: claim release failed; the push will not be retried',
      );
    });

    it('a failed release after a push throw still rethrows the push error', async () => {
      const pushErr = new Error('Neon: connection refused');
      const releaseErr = new Error('ECONNRESET');
      mockSendPush.mockRejectedValueOnce(pushErr);
      mockRedisEval.mockRejectedValueOnce(releaseErr);

      await expect(run()).rejects.toBe(pushErr);

      expect(mockSentry.captureException).toHaveBeenCalledWith(releaseErr);
      expect(mockSentry.captureException).not.toHaveBeenCalledWith(pushErr);
    });
  });
});

describe('undeliveredReason', () => {
  it.each<[FanOutResult, string]>([
    [{ sent: 0, expired: 0, failed: 2 }, 'every send failed'],
    [{ sent: 0, expired: 2, failed: 0 }, 'every subscription expired'],
    [{ sent: 0, expired: 0, failed: 0 }, 'no push subscriptions'],
    // Failures outrank expiries: a failed send is the one worth acting on.
    [{ sent: 0, expired: 1, failed: 1 }, 'every send failed'],
  ])('%j → %s', (result, reason) => {
    expect(undeliveredReason(result)).toBe(reason);
  });
});
