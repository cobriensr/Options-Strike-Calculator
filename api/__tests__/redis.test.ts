// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `safeRedis` increments the `redis.error` metric on throw (or
// `redis.quota_exceeded` for Upstash's over-quota error). Stub sentry so we
// can assert on it. logger is stubbed so the once-per-process quota warn is
// assertable and the createRedis fallback stays quiet.
const { mockIncrement, mockWarn } = vi.hoisted(() => ({
  mockIncrement: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import {
  safeRedis,
  safeRedisVoid,
  isQuotaError,
  recordRedisError,
  _resetQuotaWarnForTests,
} from '../_lib/redis.js';

/** Verbatim shape of the Upstash REST error when the plan's command quota is hit. */
const QUOTA_MESSAGE =
  'ERR max requests limit exceeded. Limit: 500000, Usage: 500000';

describe('safeRedis', () => {
  beforeEach(() => {
    mockIncrement.mockReset();
    mockWarn.mockReset();
    _resetQuotaWarnForTests();
  });

  it('returns the op result on success and does not increment redis.error', async () => {
    const result = await safeRedis(async () => 42, -1);
    expect(result).toBe(42);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('returns the resolved value even when it is falsy/null', async () => {
    const result = await safeRedis<string | null>(async () => null, 'fallback');
    expect(result).toBeNull();
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('returns the fallback and increments redis.error when op throws', async () => {
    const result = await safeRedis(async () => {
      throw new Error('KV unavailable');
    }, 'fallback');
    expect(result).toBe('fallback');
    expect(mockIncrement).toHaveBeenCalledWith('redis.error');
  });

  it('returns the fallback and increments redis.error when op rejects', async () => {
    const result = await safeRedis(
      () => Promise.reject(new Error('quota exceeded')),
      [] as number[],
    );
    expect(result).toEqual([]);
    // A generic "quota exceeded" string is NOT Upstash's over-quota
    // marker — it stays in the generic bucket.
    expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    expect(mockIncrement).not.toHaveBeenCalledWith('redis.quota_exceeded');
  });

  it('routes the Upstash over-quota error to redis.quota_exceeded (not redis.error)', async () => {
    const result = await safeRedis(
      () => Promise.reject(new Error(QUOTA_MESSAGE)),
      'fallback',
    );
    expect(result).toBe('fallback');
    expect(mockIncrement).toHaveBeenCalledWith('redis.quota_exceeded');
    expect(mockIncrement).not.toHaveBeenCalledWith('redis.error');
  });

  it('logs the quota warn ONCE per process, but counts the metric every time', async () => {
    for (let i = 0; i < 3; i++) {
      await safeRedis(() => Promise.reject(new Error(QUOTA_MESSAGE)), null);
    }
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(
      mockIncrement.mock.calls.filter(
        ([name]) => name === 'redis.quota_exceeded',
      ),
    ).toHaveLength(3);
  });

  it('safeRedisVoid swallows the quota error the same way', async () => {
    await expect(
      safeRedisVoid(() => Promise.reject(new Error(QUOTA_MESSAGE))),
    ).resolves.toBeUndefined();
    expect(mockIncrement).toHaveBeenCalledWith('redis.quota_exceeded');
  });
});

describe('isQuotaError', () => {
  it('matches the Upstash "max requests limit exceeded" error', () => {
    expect(isQuotaError(new Error(QUOTA_MESSAGE))).toBe(true);
  });

  it('is case-insensitive and accepts a bare string throw', () => {
    expect(isQuotaError('ERR Max Requests Limit Exceeded.')).toBe(true);
    expect(isQuotaError(new Error('MAX REQUESTS LIMIT EXCEEDED'))).toBe(true);
  });

  it('matches an error-like object carrying the message', () => {
    expect(isQuotaError({ message: QUOTA_MESSAGE })).toBe(true);
  });

  it('rejects unrelated errors and non-error values', () => {
    expect(isQuotaError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isQuotaError(new Error('quota exceeded'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError(42)).toBe(false);
    expect(isQuotaError({})).toBe(false);
  });
});

describe('recordRedisError', () => {
  beforeEach(() => {
    mockIncrement.mockReset();
    mockWarn.mockReset();
    _resetQuotaWarnForTests();
  });

  it("returns 'quota' + increments redis.quota_exceeded for the quota error", () => {
    expect(recordRedisError(new Error(QUOTA_MESSAGE))).toBe('quota');
    expect(mockIncrement).toHaveBeenCalledWith('redis.quota_exceeded');
    expect(mockIncrement).not.toHaveBeenCalledWith('redis.error');
  });

  it("returns 'error' + increments redis.error for anything else", () => {
    expect(recordRedisError(new Error('ECONNRESET'))).toBe('error');
    expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns once per process across repeated quota errors', () => {
    recordRedisError(new Error(QUOTA_MESSAGE));
    recordRedisError(new Error(QUOTA_MESSAGE));
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('quota'),
    );
  });
});
