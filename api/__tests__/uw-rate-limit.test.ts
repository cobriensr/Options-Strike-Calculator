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

import { acquireUWSlot, UW_PER_MINUTE_CAP } from '../_lib/uw-rate-limit.js';

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

  it('grants a slot when per-minute count is under cap', async () => {
    // Single INCR for the per-minute bucket — concurrency is enforced
    // separately by the semaphore in uw-concurrency.ts.
    mockPipeline.exec.mockResolvedValueOnce([1, 1]);

    await acquireUWSlot();

    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('throws immediately when per-minute cap is exceeded', async () => {
    mockPipeline.exec.mockResolvedValueOnce([UW_PER_MINUTE_CAP + 1, 1]);

    await expect(acquireUWSlot()).rejects.toThrow(/per-minute cap/);
    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.throw.minute');
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
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
