// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `safeRedis` increments the `redis.error` metric on throw. Stub sentry so we
// can assert on it. logger is stubbed to keep the createRedis fallback quiet.
const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Record the config each client is built with so the limiter client's
// fail-fast tuning can be asserted without touching the network.
vi.mock('@upstash/redis', () => ({
  Redis: class {
    readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  },
}));

import { limiterRedis, redis, safeRedis } from '../_lib/redis.js';

interface RecordedConfig {
  url: string;
  token: string;
  retry?: unknown;
  signal?: unknown;
}

function configOf(client: unknown): RecordedConfig {
  return (client as { config: RecordedConfig }).config;
}

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

describe('limiterRedis (fail-fast client for the UW limiters)', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('disables Upstash retries so an outage costs one attempt, not six', () => {
    expect(configOf(limiterRedis).retry).toEqual({ retries: 0 });
  });

  it('passes the timeout as a FUNCTION so each request gets a fresh signal', () => {
    // A static signal would be shared by every request and, once aborted,
    // makes Upstash fabricate a 200 `{ result: "Aborted" }` instead of throwing.
    expect(typeof configOf(limiterRedis).signal).toBe('function');
  });

  it('mints a new 1.5 s timeout signal on every call', () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const makeSignal = configOf(limiterRedis).signal as () => AbortSignal;

    const first = makeSignal();
    const second = makeSignal();

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(1_500);
    expect(first).not.toBe(second);
    expect(first.aborted).toBe(false);
  });

  it('leaves the shared default client on Upstash defaults', () => {
    // Schwab token storage etc. keep the built-in retry/backoff.
    expect(configOf(redis).retry).toBeUndefined();
    expect(configOf(redis).signal).toBeUndefined();
  });

  it('applies the same fail-fast tuning when KV is configured', async () => {
    process.env = {
      ...originalEnv,
      KV_REST_API_URL: 'https://kv.example.upstash.io',
      KV_REST_API_TOKEN: 'kv-token',
    };
    vi.resetModules();
    const fresh = await import('../_lib/redis.js');

    expect(configOf(fresh.limiterRedis)).toMatchObject({
      url: 'https://kv.example.upstash.io',
      token: 'kv-token',
      retry: { retries: 0 },
    });
    expect(typeof configOf(fresh.limiterRedis).signal).toBe('function');
    expect(configOf(fresh.redis)).toEqual({
      url: 'https://kv.example.upstash.io',
      token: 'kv-token',
    });
  });
});
