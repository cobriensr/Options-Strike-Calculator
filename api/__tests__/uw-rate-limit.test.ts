// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPipeline, mockIncrement } = vi.hoisted(() => ({
  mockPipeline: {
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(),
  },
  mockIncrement: vi.fn(),
}));

vi.mock('../_lib/schwab.js', () => ({
  redis: {
    pipeline: vi.fn(() => mockPipeline),
  },
  getAccessToken: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  acquireUWSlot,
  UW_PER_SECOND_CAP,
  UW_PER_MINUTE_CAP,
  MAX_WAIT_ATTEMPTS,
} from '../_lib/uw-rate-limit.js';

describe('uw-rate-limit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockPipeline.exec.mockReset();
    mockIncrement.mockReset();
    process.env = {
      ...originalEnv,
      KV_REST_API_URL: 'https://test.upstash.io',
      KV_REST_API_TOKEN: 'test-token',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('grants a slot immediately when both buckets are under cap', async () => {
    // First call → per-second bucket returns 1; second call → per-minute returns 1.
    mockPipeline.exec
      .mockResolvedValueOnce([1, 1]) // per-second
      .mockResolvedValueOnce([1, 1]); // per-minute

    await acquireUWSlot();

    expect(mockPipeline.exec).toHaveBeenCalledTimes(2);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('waits and retries when per-second cap is exceeded', async () => {
    // Attempt 1: per-sec over cap → wait, retry. Attempt 2: under cap, per-min ok.
    mockPipeline.exec
      .mockResolvedValueOnce([UW_PER_SECOND_CAP + 1, 1]) // per-sec exceeded
      .mockResolvedValueOnce([1, 1]) // per-sec ok on retry
      .mockResolvedValueOnce([1, 1]); // per-min ok

    await acquireUWSlot();

    expect(mockPipeline.exec).toHaveBeenCalledTimes(3);
    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.wait.second');
  });

  it('throws after MAX_WAIT_ATTEMPTS when per-second cap is persistently exceeded', async () => {
    // Every attempt sees per-sec over cap. Limiter should bail after MAX_WAIT_ATTEMPTS.
    for (let i = 0; i < MAX_WAIT_ATTEMPTS; i++) {
      mockPipeline.exec.mockResolvedValueOnce([UW_PER_SECOND_CAP + 5, 1]);
    }

    await expect(acquireUWSlot()).rejects.toThrow(/per-second cap blocked/);
    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.throw.second');
  }, 10_000);

  it('throws immediately when per-minute cap is exceeded', async () => {
    // per-second under cap, per-minute over cap → throw, no retry.
    mockPipeline.exec
      .mockResolvedValueOnce([1, 1]) // per-sec ok
      .mockResolvedValueOnce([UW_PER_MINUTE_CAP + 1, 1]); // per-min exceeded

    await expect(acquireUWSlot()).rejects.toThrow(/per-minute cap/);
    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.throw.minute');
    // Only 2 redis pipeline runs — no retry.
    expect(mockPipeline.exec).toHaveBeenCalledTimes(2);
  });

  it('fails open when redis pipeline throws', async () => {
    mockPipeline.exec.mockRejectedValueOnce(new Error('redis down'));

    // Should resolve, not throw.
    await acquireUWSlot();

    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.redis_error');
  });

  it('fails open when redis pipeline returns a non-numeric count', async () => {
    mockPipeline.exec.mockResolvedValueOnce([null, 1]);

    await acquireUWSlot();

    // Treated as Redis hiccup → fail open, no throw, no retry.
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
  });
});
