// @vitest-environment node

/**
 * Request rate limiter (`rejectIfRateLimited` in auth-helpers.ts).
 *
 * The Redis fake models key TTLs against the faked clock, so the window tests
 * assert behaviour (does a steady client ever get a 429?) rather than the
 * exact commands: the sliding-TTL bug this file guards against only shows up
 * when an EXPIRE actually pushes a key's lifetime out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockPipeline,
  mockIncr,
  mockExpire,
  mockExec,
  mockDefaultPipeline,
  mockRateLimited,
  mockIncrement,
  mockCaptureException,
  mockCaptureMessage,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  mockIncr: vi.fn(),
  mockExpire: vi.fn(),
  mockExec: vi.fn(),
  mockDefaultPipeline: vi.fn(),
  mockRateLimited: vi.fn(),
  mockIncrement: vi.fn(),
  mockCaptureException: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

// The limiter must use the fail-fast `limiterRedis` client; the shared
// retrying `redis` client is mocked separately so a regression back to it
// is caught.
vi.mock('../_lib/redis.js', () => ({
  redis: { pipeline: mockDefaultPipeline },
  limiterRedis: { pipeline: mockPipeline },
}));

vi.mock('botid/server', () => ({
  checkBotId: vi.fn().mockResolvedValue({ isBot: false }),
}));

// auth-helpers re-exports guest-auth, which imports the api-helpers barrel;
// stub the barrel's other network-facing dependencies like api-helpers.test.ts.
vi.mock('../_lib/schwab.js', () => ({ getAccessToken: vi.fn() }));
vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: {
    rateLimited: mockRateLimited,
    increment: mockIncrement,
  },
  Sentry: {
    setTag: vi.fn(),
    captureException: mockCaptureException,
    captureMessage: mockCaptureMessage,
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: mockLoggerWarn, error: vi.fn(), info: vi.fn() },
}));

import { rejectIfRateLimited } from '../_lib/auth-helpers.js';

const REDIS_ERROR_METRIC = 'api_helpers.rate_limit_redis_error';
const LIMITER_FINGERPRINT = ['request-limiter-redis-unavailable'];
const LIMITER_CONTEXT = {
  level: 'warning',
  fingerprint: LIMITER_FINGERPRINT,
  tags: { limiter: 'request' },
};

/** 2026-11-06T15:30:20Z, 20 s into epoch minute 29899650. */
const T0 = Date.UTC(2026, 10, 6, 15, 30, 20);
const T0_MINUTE = 29899650;

/** Epoch-ms of the first millisecond of the minute after `ms`. */
function nextMinuteStart(ms: number): number {
  return (Math.floor(ms / 60_000) + 1) * 60_000;
}

/** In-memory Upstash stand-in whose key TTLs follow the (faked) clock. */
const store = new Map<string, { value: number; expiresAt: number | null }>();

function liveEntry(key: string) {
  const entry = store.get(key);
  if (entry?.expiresAt != null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function storeIncr(key: string): number {
  const entry = liveEntry(key) ?? { value: 0, expiresAt: null };
  entry.value += 1;
  store.set(key, entry);
  return entry.value;
}

function storeExpire(key: string, seconds: number): number {
  const entry = liveEntry(key);
  if (!entry) return 0;
  entry.expiresAt = Date.now() + seconds * 1000;
  return 1;
}

/**
 * `limiterRedis.pipeline()` over the store. `mockIncr` / `mockExpire` record
 * the queued commands; `mockExec` is the round trip, and receives a `run`
 * closure that executes the queued commands, so a test can make the whole
 * round trip reject or answer with something else.
 */
function installRedisFake(): void {
  store.clear();
  mockExec.mockReset();
  mockExec.mockImplementation(async (run: () => number[]) => run());
  mockPipeline.mockReset();
  mockPipeline.mockImplementation(() => {
    const queued: Array<() => number> = [];
    const pipe = {
      incr(key: string) {
        mockIncr(key);
        queued.push(() => storeIncr(key));
        return pipe;
      },
      expire(key: string, seconds: number) {
        mockExpire(key, seconds);
        queued.push(() => storeExpire(key, seconds));
        return pipe;
      },
      exec: () => mockExec(() => queued.map((command) => command())),
    };
    return pipe;
  });
}

function request(ip = '203.0.113.7') {
  return mockRequest({ headers: { 'x-real-ip': ip } });
}

async function hit(
  endpoint = 'auth-init',
  max = 5,
  req = request(),
): Promise<ReturnType<typeof mockResponse> & { rejected: boolean }> {
  const res = mockResponse();
  const rejected = await rejectIfRateLimited(req, res, endpoint, max);
  return Object.assign(res, { rejected });
}

describe('rejectIfRateLimited', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    installRedisFake();
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

  describe('fixed per-minute window', () => {
    it('never blocks a client polling every 30 s under a limit of 5', async () => {
      // Two requests per minute against a limit of 5 for ten minutes. With a
      // TTL that slides forward on every request the counter never resets, and
      // the 6th request (150 s in) is the first 429.
      const statuses: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const res = await hit('auth-init', 5);
        statuses.push(res.rejected ? res._status : 200);
        vi.setSystemTime(Date.now() + 30_000);
      }

      expect(statuses).toEqual(Array.from({ length: 20 }, () => 200));
      // The limiter really ran on every request; it did not fail open.
      expect(mockIncr).toHaveBeenCalledTimes(20);
      expect(mockIncrement).not.toHaveBeenCalledWith(REDIS_ERROR_METRIC);
      expect(mockRateLimited).not.toHaveBeenCalled();
    });

    it('blocks the request after the limit, then resets at the next minute', async () => {
      expect((await hit('auth-init', 2)).rejected).toBe(false);
      expect((await hit('auth-init', 2)).rejected).toBe(false);
      const blocked = await hit('auth-init', 2);
      expect(blocked.rejected).toBe(true);
      expect(blocked._status).toBe(429);
      expect(mockRateLimited).toHaveBeenCalledWith('auth-init');

      vi.setSystemTime(nextMinuteStart(T0));

      const reset = await hit('auth-init', 2);
      expect(reset.rejected).toBe(false);
      expect(reset._status).toBe(200);
    });

    it('keeps a minute bucket intact until its last millisecond', async () => {
      vi.setSystemTime(nextMinuteStart(T0) - 1);
      expect((await hit('auth-init', 1)).rejected).toBe(false);
      expect((await hit('auth-init', 1)).rejected).toBe(true);

      vi.setSystemTime(nextMinuteStart(T0));
      expect((await hit('auth-init', 1)).rejected).toBe(false);
    });

    it('allows exactly the limit and blocks the next request', async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await hit('auth-init', 5)).rejected).toBe(false);
      }
      expect((await hit('auth-init', 5)).rejected).toBe(true);
    });

    it('counts each endpoint and each IP separately', async () => {
      expect((await hit('a', 1, request('198.51.100.1'))).rejected).toBe(false);
      // Same IP, other endpoint: own counter.
      expect((await hit('b', 1, request('198.51.100.1'))).rejected).toBe(false);
      // Same endpoint, other IP: own counter.
      expect((await hit('a', 1, request('198.51.100.2'))).rejected).toBe(false);
      // The first pair is now over its limit of 1.
      expect((await hit('a', 1, request('198.51.100.1'))).rejected).toBe(true);
    });
  });

  describe('Redis commands', () => {
    it('keys the counter on endpoint, IP and epoch-minute bucket', async () => {
      await hit('auth-init', 5, request('203.0.113.7'));

      expect(mockIncr).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledWith(
        `ratelimit:auth-init:203.0.113.7:${T0_MINUTE}`,
      );
    });

    it('moves to a new key when the minute changes', async () => {
      await hit('auth-init');
      vi.setSystemTime(nextMinuteStart(T0));
      await hit('auth-init');

      expect(mockIncr.mock.calls.map(([key]) => key)).toEqual([
        `ratelimit:auth-init:203.0.113.7:${T0_MINUTE}`,
        `ratelimit:auth-init:203.0.113.7:${T0_MINUTE + 1}`,
      ]);
    });

    it('sends INCR and a 120 s EXPIRE for the same key in one pipelined round trip', async () => {
      const key = `ratelimit:auth-init:203.0.113.7:${T0_MINUTE}`;

      await hit('auth-init');

      expect(mockPipeline).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledWith(key);
      expect(mockExpire).toHaveBeenCalledTimes(1);
      expect(mockExpire).toHaveBeenCalledWith(key, 120);
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('costs one round trip per request, however many it makes', async () => {
      await hit('auth-init');
      await hit('auth-init');
      await hit('auth-init');

      expect(mockPipeline).toHaveBeenCalledTimes(3);
      expect(mockExec).toHaveBeenCalledTimes(3);
      expect(mockIncr).toHaveBeenCalledTimes(3);
      expect(mockExpire).toHaveBeenCalledTimes(3);
    });

    it('uses the fail-fast limiter client, not the shared retrying one', async () => {
      await hit('auth-init');

      expect(mockPipeline).toHaveBeenCalledTimes(1);
      expect(mockDefaultPipeline).not.toHaveBeenCalled();
    });
  });

  describe('429 response', () => {
    it.each([
      ['at the start of the minute', 0, '60'],
      ['10 s in', 10_000, '50'],
      ['just past the half minute', 30_001, '30'],
      ['half a second before the next minute', 59_500, '1'],
      ['the last millisecond of the minute', 59_999, '1'],
    ])(
      'sends Retry-After as the seconds left in the minute, %s',
      async (_label, offsetMs, expected) => {
        vi.setSystemTime(Math.floor(T0 / 60_000) * 60_000 + offsetMs);

        const res = await hit('auth-init', 0);

        expect(res.rejected).toBe(true);
        expect(res._status).toBe(429);
        expect(res._headers['Retry-After']).toBe(expected);
        expect(res._json).toEqual({
          error: `Too many requests. Try again in ${expected} seconds.`,
        });
      },
    );

    it('is never cached', async () => {
      const res = await hit('auth-init', 0);

      expect(res._headers['Cache-Control']).toBe('no-store');
    });

    it('records the rate-limit metric under the endpoint name', async () => {
      await hit('periscope-chat', 0);

      expect(mockRateLimited).toHaveBeenCalledTimes(1);
      expect(mockRateLimited).toHaveBeenCalledWith('periscope-chat');
    });

    it('leaves the response untouched when the request is allowed', async () => {
      const res = await hit('auth-init', 5);

      expect(res.rejected).toBe(false);
      expect(res._status).toBe(200);
      expect(res._json).toBeNull();
      expect(res._headers).toEqual({});
      expect(mockRateLimited).not.toHaveBeenCalled();
    });
  });

  describe('client IP', () => {
    it.each([
      [
        'prefers x-real-ip over x-forwarded-for',
        { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' },
        '203.0.113.7',
      ],
      [
        'takes the first x-forwarded-for entry, trimmed',
        { 'x-forwarded-for': ' 198.51.100.9 , 10.0.0.1' },
        '198.51.100.9',
      ],
      [
        'falls back to x-forwarded-for when x-real-ip is empty',
        { 'x-real-ip': '', 'x-forwarded-for': '198.51.100.9' },
        '198.51.100.9',
      ],
      ['uses "unknown" when neither header is present', {}, 'unknown'],
    ])('%s', async (_label, headers, ip) => {
      await rejectIfRateLimited(
        mockRequest({ headers }),
        mockResponse(),
        'auth-init',
        5,
      );

      expect(mockIncr).toHaveBeenCalledWith(
        `ratelimit:auth-init:${ip}:${T0_MINUTE}`,
      );
    });
  });

  describe('Upstash not configured', () => {
    it('is a no-op without a KV REST URL', async () => {
      delete process.env.KV_REST_API_URL;
      delete process.env.UPSTASH_REDIS_REST_URL;

      const res = await hit('auth-init', 0);

      expect(res.rejected).toBe(false);
      expect(mockPipeline).not.toHaveBeenCalled();
      expect(mockDefaultPipeline).not.toHaveBeenCalled();
      expect(mockIncrement).not.toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('limits when only the UPSTASH_REDIS_REST_URL alias is set', async () => {
      delete process.env.KV_REST_API_URL;
      process.env.UPSTASH_REDIS_REST_URL = 'https://alias.upstash.io';

      const res = await hit('auth-init', 0);

      expect(res.rejected).toBe(true);
      expect(mockPipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe('failing open', () => {
    it('lets the request through when the pipeline rejects, and surfaces the failure', async () => {
      const err = new Error('connect timeout');
      mockExec.mockRejectedValueOnce(err);

      const res = await hit('auth-init', 0);

      expect(res.rejected).toBe(false);
      expect(res._status).toBe(200);
      expect(res._headers).toEqual({});
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { err },
        expect.stringContaining('failing open'),
      );
      expect(mockIncrement).toHaveBeenCalledWith(REDIS_ERROR_METRIC);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(err, LIMITER_CONTEXT);
      expect(mockRateLimited).not.toHaveBeenCalled();
    });

    it('lets the request through when the per-request timeout aborts the pipeline', async () => {
      const err = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      mockExec.mockRejectedValueOnce(err);

      const res = await hit('auth-init', 0);

      expect(res.rejected).toBe(false);
      expect(mockIncrement).toHaveBeenCalledWith(REDIS_ERROR_METRIC);
      expect(mockCaptureException).toHaveBeenCalledWith(err, LIMITER_CONTEXT);
    });

    it.each([
      ['an "Aborted" pseudo-result', ['Aborted', 1], 'Aborted'],
      ['a null count', [null, 1], null],
      ['an empty reply', [], undefined],
    ])(
      'treats %s as a failed call, not a count',
      async (_label, reply, count) => {
        mockExec.mockResolvedValueOnce(reply);

        const res = await hit('auth-init', 0);

        expect(res.rejected).toBe(false);
        expect(res._status).toBe(200);
        expect(mockRateLimited).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
          { count },
          expect.stringContaining('malformed INCR reply'),
        );
        expect(mockIncrement).toHaveBeenCalledWith(REDIS_ERROR_METRIC);
        expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          expect.stringContaining('malformed INCR reply'),
          LIMITER_CONTEXT,
        );
      },
    );

    it('reports every failure of an outage under one pinned fingerprint', async () => {
      mockExec.mockRejectedValue(new Error('upstash is down'));

      for (let i = 0; i < 3; i += 1) {
        await hit('auth-init', 5, request(`203.0.113.${i}`));
      }

      expect(mockCaptureException).toHaveBeenCalledTimes(3);
      const fingerprints = mockCaptureException.mock.calls.map(
        ([, context]) => (context as { fingerprint: string[] }).fingerprint,
      );
      expect(fingerprints).toEqual([
        LIMITER_FINGERPRINT,
        LIMITER_FINGERPRINT,
        LIMITER_FINGERPRINT,
      ]);
    });
  });
});
