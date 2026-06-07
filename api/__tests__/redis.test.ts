// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `safeRedis` increments the `redis.error` metric on throw. Stub sentry so we
// can assert on it. logger is stubbed to keep the createRedis fallback quiet.
const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { safeRedis } from '../_lib/redis.js';

describe('safeRedis', () => {
  beforeEach(() => {
    mockIncrement.mockReset();
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
    expect(mockIncrement).toHaveBeenCalledWith('redis.error');
  });
});
