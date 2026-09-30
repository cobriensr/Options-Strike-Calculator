// @vitest-environment node

/**
 * Behavioural tests for `limiterRedis` against the REAL `@upstash/redis`
 * client (NOT mocked). `redis.test.ts` pins the config shape; these pin what
 * that config actually does inside Upstash 1.38's HttpClient, which is the
 * load-bearing part of the fail-fast fix (Sentry HE):
 *
 *   - `retry: { retries: 0 }` → a transport failure is one fetch, not six.
 *   - `signal` as a function → an aborted request REJECTS, instead of the
 *     fabricated HTTP 200 `{ result: "Aborted" }` a static signal produces.
 *
 * Only the network edge (global `fetch`) is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type RedisModule = typeof import('../_lib/redis.js');

describe('limiterRedis against the real Upstash client', () => {
  const originalEnv = process.env;
  let limiterRedis: RedisModule['limiterRedis'];

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      KV_REST_API_URL: 'https://limiter-test.upstash.io',
      KV_REST_API_TOKEN: 'limiter-test-token',
    };
    // The clients are module-scoped singletons built at import time, so
    // re-import after setting env to get a configured (non-fallback) client.
    vi.resetModules();
    ({ limiterRedis } = await import('../_lib/redis.js'));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('makes exactly one fetch and rejects when the transport fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(limiterRedis.get('k')).rejects.toThrow('fetch failed');

    // Upstash's default would retry 5 more times with exponential backoff.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /^https:\/\/limiter-test\.upstash\.io\b/,
    );
  });

  it('rejects on an aborted per-request signal instead of resolving "Aborted"', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(),
    );
    // Mirror fetch's abort contract: an already-aborted signal rejects with
    // its reason before any I/O.
    const fetchMock = vi.fn(
      (_url: string, init: { signal?: AbortSignal }): Promise<Response> =>
        init.signal?.aborted
          ? Promise.reject(init.signal.reason as Error)
          : Promise.resolve(Response.json({ result: null })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = limiterRedis.get('k');

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(true);
  });
});
