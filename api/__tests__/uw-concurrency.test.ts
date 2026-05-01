// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockEval, mockZrem, mockIncrement, mockDistribution } = vi.hoisted(
  () => ({
    mockEval: vi.fn(),
    mockZrem: vi.fn(),
    mockIncrement: vi.fn(),
    mockDistribution: vi.fn(),
  }),
);

vi.mock('../_lib/schwab.js', () => ({
  redis: {
    eval: mockEval,
    zrem: mockZrem,
  },
  getAccessToken: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
  Sentry: {
    captureException: vi.fn(),
    metrics: { distribution: mockDistribution },
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  UW_CONCURRENCY_CAP,
  MAX_ACQUIRE_ATTEMPTS,
} from '../_lib/uw-concurrency.js';

describe('uw-concurrency', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockEval.mockReset();
    mockZrem.mockReset();
    mockIncrement.mockReset();
    mockDistribution.mockReset();
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

  // ── acquireConcurrencySlot ─────────────────────────────────────

  it('grants a slot immediately when cap is free', async () => {
    // Lua returns [1, 1] — granted, 1 in use after the add
    mockEval.mockResolvedValueOnce([1, 1]);

    const slotId = await acquireConcurrencySlot();

    expect(slotId).toBeTruthy();
    expect(slotId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(mockEval).toHaveBeenCalledTimes(1);

    // Verify the EVAL was invoked with KEYS=['uw:cc'] and 4 ARGV slots
    const [, keys, args] = mockEval.mock.calls[0]!;
    expect(keys).toEqual(['uw:cc']);
    expect(args).toHaveLength(4);
    expect(args![0]).toBe(slotId); // slotId is ARGV[1]
    expect(args![3]).toBe(String(UW_CONCURRENCY_CAP)); // cap is ARGV[4]

    // in_use gauge and wait_ms histogram both emitted on grant
    expect(mockDistribution).toHaveBeenCalledWith('uw.concurrency.in_use', 1);
    expect(mockDistribution).toHaveBeenCalledWith(
      'uw.concurrency.wait_ms',
      expect.any(Number),
    );
  });

  it('blocks then succeeds when a slot frees up mid-wait', async () => {
    // First attempt: at cap → [0, 3]. Second attempt: free → [1, 3].
    // Use fake timers so the WAIT_BASE_MS sleep doesn't burn real wall time.
    vi.useFakeTimers();
    mockEval
      .mockResolvedValueOnce([0, UW_CONCURRENCY_CAP])
      .mockResolvedValueOnce([1, UW_CONCURRENCY_CAP]);

    const promise = acquireConcurrencySlot();
    // Mark rejection handled defensively
    promise.catch(() => {});

    // First attempt resolves immediately (microtask). Then the sleep fires.
    // Advance past the max possible WAIT_BASE_MS + WAIT_JITTER_MS.
    await vi.advanceTimersByTimeAsync(600);

    const slotId = await promise;
    expect(slotId).toBeTruthy();
    expect(mockEval).toHaveBeenCalledTimes(2);
    expect(mockIncrement).toHaveBeenCalledWith('uw.concurrency.wait');
  });

  it('throws after MAX_ACQUIRE_ATTEMPTS when cap stays saturated', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_ACQUIRE_ATTEMPTS; i++) {
      mockEval.mockResolvedValueOnce([0, UW_CONCURRENCY_CAP]);
    }

    const promise = acquireConcurrencySlot();
    promise.catch(() => {});

    // Drain MAX_ACQUIRE_ATTEMPTS sleeps. Each iteration: eval microtask + sleep.
    for (let i = 0; i < MAX_ACQUIRE_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(600);
    }

    await expect(promise).rejects.toThrow(/saturated/);
    expect(mockIncrement).toHaveBeenCalledWith('uw.concurrency.timeout');
  });

  it('fails open when Redis EVAL throws', async () => {
    mockEval.mockRejectedValueOnce(new Error('redis down'));

    const slotId = await acquireConcurrencySlot();

    // Empty string signals "no slot taken; caller proceeds without limiting"
    expect(slotId).toBe('');
    expect(mockIncrement).toHaveBeenCalledWith('uw.concurrency.redis_error');
    // No retry — failed open after one attempt
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis is not configured', async () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;

    const slotId = await acquireConcurrencySlot();

    expect(slotId).toBe('');
    expect(mockEval).not.toHaveBeenCalled();
  });

  // ── releaseConcurrencySlot ─────────────────────────────────────

  it('releases a slot via ZREM', async () => {
    mockZrem.mockResolvedValueOnce(1);

    await releaseConcurrencySlot('slot-uuid-123');

    expect(mockZrem).toHaveBeenCalledWith('uw:cc', 'slot-uuid-123');
  });

  it('release is a no-op for empty slotId (the no-op acquire path)', async () => {
    await releaseConcurrencySlot('');

    expect(mockZrem).not.toHaveBeenCalled();
  });

  it('release swallows errors — lease auto-expires', async () => {
    mockZrem.mockRejectedValueOnce(new Error('redis down'));

    // Should not throw — release is best-effort
    await expect(
      releaseConcurrencySlot('slot-uuid-123'),
    ).resolves.not.toThrow();

    expect(mockIncrement).toHaveBeenCalledWith('uw.concurrency.release_error');
  });
});
