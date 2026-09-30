// @vitest-environment node

/**
 * End-to-end fail-open behaviour of `uwFetch` when the Redis behind BOTH UW
 * limiters is down (Sentry HE — the 2026-09-29 Upstash connect-timeout
 * outage). Runs the REAL `uw-rate-limit` + `uw-concurrency` modules against a
 * mocked `limiterRedis` whose every call rejects, and asserts the UW request
 * still goes out, the data comes back, and the two fail-open captures group
 * under one fingerprint per limiter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockExec,
  mockEval,
  mockZrem,
  mockDefaultClientCall,
  mockCaptureException,
  mockIncrement,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockEval: vi.fn(),
  mockZrem: vi.fn(),
  mockDefaultClientCall: vi.fn(),
  mockCaptureException: vi.fn(),
  mockIncrement: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  redis: {
    pipeline: mockDefaultClientCall,
    eval: mockDefaultClientCall,
    zrem: mockDefaultClientCall,
  },
  limiterRedis: {
    pipeline: vi.fn(() => ({
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: mockExec,
    })),
    eval: mockEval,
    zrem: mockZrem,
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    increment: mockIncrement,
    uwMinuteCount: vi.fn(),
    uwBudget: vi.fn(),
    uwRateLimit: vi.fn(),
  },
  Sentry: {
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    metrics: { distribution: vi.fn() },
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { uwFetch } from '../_lib/uw-fetch.js';

describe('uwFetch during a limiter Redis outage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      KV_REST_API_URL: 'https://test.upstash.io',
      KV_REST_API_TOKEN: 'test-token',
    };
    const timeout = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    mockExec.mockRejectedValue(timeout);
    mockEval.mockRejectedValue(timeout);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('still fetches from UW and returns the data when both limiters fail open', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [{ strike: 5800 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uwFetch('uw-key', '/stock/SPX/spot-exposures'),
    ).resolves.toEqual([{ strike: 5800 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // One call per limiter — neither limiter re-tries its own Redis call.
    // (Upstash's transport retries sit below this mock; they are pinned by
    // redis-limiter-client.test.ts against the real client.)
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockEval).toHaveBeenCalledTimes(1);
    // The fail-open acquire returned no slot, so there is nothing to release.
    expect(mockZrem).not.toHaveBeenCalled();
    expect(mockDefaultClientCall).not.toHaveBeenCalled();
  });

  it('groups the fail-open captures into one warning issue per limiter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: [] }),
      }),
    );

    await uwFetch('uw-key', '/stock/SPX/spot-exposures');

    const contexts = mockCaptureException.mock.calls.map((call) => call[1]);
    expect(contexts).toEqual([
      {
        level: 'warning',
        fingerprint: ['uw-limiter-redis-unavailable', 'rate-limit'],
        tags: { limiter: 'rate-limit' },
      },
      {
        level: 'warning',
        fingerprint: ['uw-limiter-redis-unavailable', 'concurrency'],
        tags: { limiter: 'concurrency' },
      },
    ]);
    expect(mockIncrement).toHaveBeenCalledWith('uw.rate_limit.redis_error');
    expect(mockIncrement).toHaveBeenCalledWith('uw.concurrency.redis_error');
  });

  it('surfaces a genuine UW error unchanged even while the limiters are down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => 'no healthy upstream',
      }),
    );

    await expect(
      uwFetch('uw-key', '/stock/SPX/spot-exposures'),
    ).rejects.toThrow('UW API 503: no healthy upstream');
  });
});
