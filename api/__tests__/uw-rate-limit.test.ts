// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPipeline, mockIncrement, mockMinuteCount } = vi.hoisted(() => ({
  mockPipeline: {
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(),
  },
  mockIncrement: vi.fn(),
  mockMinuteCount: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  redis: {
    pipeline: vi.fn(() => mockPipeline),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement, uwMinuteCount: mockMinuteCount },
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  acquireUWSlot,
  getPerMinuteCap,
  UW_PER_MINUTE_CAP,
} from '../_lib/uw-rate-limit.js';

describe('uw-rate-limit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockPipeline.exec.mockReset();
    mockIncrement.mockReset();
    mockMinuteCount.mockReset();
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

  it('defaults the cap to UW_PER_MINUTE_CAP when no override is set', () => {
    delete process.env.UW_PER_MINUTE_CAP;
    expect(getPerMinuteCap()).toBe(UW_PER_MINUTE_CAP);
  });

  it('honours a numeric UW_PER_MINUTE_CAP override', async () => {
    process.env.UW_PER_MINUTE_CAP = '5';
    expect(getPerMinuteCap()).toBe(5);

    // 6 > 5 → the override, not the 2000 default, decides.
    mockPipeline.exec.mockResolvedValueOnce([6, 1]);
    await expect(acquireUWSlot()).rejects.toThrow(
      /per-minute cap \(5\) exceeded/,
    );
  });

  it('ignores a non-numeric or non-positive override', () => {
    process.env.UW_PER_MINUTE_CAP = 'not-a-number';
    expect(getPerMinuteCap()).toBe(UW_PER_MINUTE_CAP);

    process.env.UW_PER_MINUTE_CAP = '0';
    expect(getPerMinuteCap()).toBe(UW_PER_MINUTE_CAP);

    process.env.UW_PER_MINUTE_CAP = '-10';
    expect(getPerMinuteCap()).toBe(UW_PER_MINUTE_CAP);
  });

  it('does not throttle traffic that the old 115 cap would have rejected', async () => {
    // Regression guard for the 2026-09-07 retune: UW lifted its 120/min cap,
    // so a 200-request minute must pass rather than throw.
    delete process.env.UW_PER_MINUTE_CAP;
    mockPipeline.exec.mockResolvedValueOnce([200, 1]);

    await expect(acquireUWSlot()).resolves.toBeUndefined();
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('emits the observed per-minute count even when under cap', async () => {
    mockPipeline.exec.mockResolvedValueOnce([37, 1]);

    await acquireUWSlot();

    expect(mockMinuteCount).toHaveBeenCalledWith(37);
  });

  it('does not emit a count when redis fails open', async () => {
    mockPipeline.exec.mockResolvedValueOnce([null, 1]);

    await acquireUWSlot();

    expect(mockMinuteCount).not.toHaveBeenCalled();
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
