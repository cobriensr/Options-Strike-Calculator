// @vitest-environment node

/**
 * POST /api/snapshot-close — the owner's page tells the server it was closed,
 * so `check-live-snapshots` does not report the silence that follows as a
 * stall. The write is one Redis key per ET date holding the close time.
 *
 * Mocks sit at the external boundaries: the Upstash clients (the marker write
 * and the rate limiter's counter), BotID, Sentry and the logger. The real
 * owner guard and rate limiter run, so the 401 for a guest or a stranger, the
 * 403 for a bot and the 429 come from the same code production uses. Only
 * `Date` is faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockRedisSet,
  mockPipeline,
  mockIncr,
  mockExec,
  mockCheckBotId,
  mockDone,
  mockSentry,
  mockMetrics,
  mockLogger,
} = vi.hoisted(() => ({
  mockRedisSet: vi.fn(),
  mockPipeline: vi.fn(),
  mockIncr: vi.fn(),
  mockExec: vi.fn(),
  mockCheckBotId: vi.fn(),
  mockDone: vi.fn(),
  mockSentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  mockMetrics: {
    request: vi.fn(),
    rateLimited: vi.fn(),
    increment: vi.fn(),
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/redis.js', () => ({
  redis: { set: mockRedisSet },
  limiterRedis: { pipeline: mockPipeline },
}));

vi.mock('botid/server', () => ({ checkBotId: mockCheckBotId }));

// auth-helpers re-exports guest-auth, which reaches the Schwab and UW modules
// through the api-helpers barrel; stub them as auth-helpers-rate-limit.test.ts
// does. This endpoint touches neither.
vi.mock('../_lib/schwab.js', () => ({ getAccessToken: vi.fn() }));
vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: mockMetrics,
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

import handler from '../snapshot-close.js';

const OWNER_SECRET = 'owner-secret-for-tests';
const GUEST_KEY = 'guest-key-for-tests';
const OWNER_COOKIE = `sc-owner=${OWNER_SECRET}`;
const IP = '203.0.113.7';
const MARKER_TTL_SEC = 24 * 60 * 60;
const RATE_LIMIT_PER_MINUTE = 30;

// Wed Nov 11 2026, 2:30 PM CT (15:30 ET, EST).
const NOW = '2026-11-11T20:30:00.000Z';
const TODAY = '2026-11-11';

/** A POST from `IP`; `null` sends no cookie at all (`undefined` would default). */
function post(
  cookie: string | null = OWNER_COOKIE,
  extra: Parameters<typeof mockRequest>[0] = {},
) {
  return mockRequest({
    method: 'POST',
    headers: {
      'x-real-ip': IP,
      ...(cookie === null ? {} : { cookie }),
    },
    ...extra,
  });
}

async function call(req: ReturnType<typeof mockRequest>) {
  const res = mockResponse();
  await handler(req, res);
  return res;
}

describe('POST /api/snapshot-close', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    process.env = {
      ...originalEnv,
      OWNER_SECRET,
      GUEST_ACCESS_KEYS: GUEST_KEY,
      // Turns the rate limiter on; its counter is the pipeline fake below.
      KV_REST_API_URL: 'https://test.upstash.io',
      KV_REST_API_TOKEN: 'test-token',
    };
    delete process.env.VERCEL;

    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockIncr.mockReset();
    // Every request is the first of its minute unless a test says otherwise.
    mockExec.mockReset().mockResolvedValue([1, 1]);
    mockPipeline.mockReset().mockImplementation(() => {
      const pipe = {
        incr: (key: string) => {
          mockIncr(key);
          return pipe;
        },
        expire: () => pipe,
        exec: mockExec,
      };
      return pipe;
    });
    mockCheckBotId.mockReset().mockResolvedValue({ isBot: false });
    mockDone.mockReset();
    mockMetrics.request.mockReset().mockReturnValue(mockDone);
    mockMetrics.rateLimited.mockClear();
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe('an owner close', () => {
    it('answers 204 and writes the ET date’s marker with the close time and a 24 h expiry', async () => {
      const res = await call(post());

      expect(res._status).toBe(204);
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      // Exactly { ex }: no NX, so a later close overwrites (the last write wins).
      expect(mockRedisSet).toHaveBeenCalledWith(
        `snapshot-app-closed:${TODAY}`,
        NOW,
        { ex: MARKER_TTL_SEC },
      );
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(mockMetrics.request).toHaveBeenCalledWith('/api/snapshot-close');
      expect(mockDone).toHaveBeenCalledTimes(1);
      expect(mockDone).toHaveBeenCalledWith({ status: 204 });
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('keys the marker on the ET date, not the UTC date', async () => {
      // 22:30 ET on Nov 11 is already Nov 12 in UTC.
      vi.setSystemTime(new Date('2026-11-12T03:30:00.000Z'));

      await call(post());

      expect(mockRedisSet).toHaveBeenCalledWith(
        'snapshot-app-closed:2026-11-11',
        '2026-11-12T03:30:00.000Z',
        { ex: MARKER_TTL_SEC },
      );
    });

    it('lets a later close replace the earlier one under the same key', async () => {
      await call(post());
      vi.setSystemTime(new Date('2026-11-11T20:45:00.000Z'));
      await call(post());

      // Both are plain SET ... EX writes with no NX, so the later one wins.
      const key = `snapshot-app-closed:${TODAY}`;
      expect(mockRedisSet.mock.calls).toEqual([
        [key, '2026-11-11T20:30:00.000Z', { ex: MARKER_TTL_SEC }],
        [key, '2026-11-11T20:45:00.000Z', { ex: MARKER_TTL_SEC }],
      ]);
    });

    it('ignores anything in the body or query: the server picks the key and the time', async () => {
      const res = await call(
        post(OWNER_COOKIE, {
          body: { date: '2020-01-01', closedAt: '2020-01-01T00:00:00Z' },
          query: { date: '2020-01-01' },
        }),
      );

      expect(res._status).toBe(204);
      expect(mockRedisSet).toHaveBeenCalledWith(
        `snapshot-app-closed:${TODAY}`,
        NOW,
        { ex: MARKER_TTL_SEC },
      );
    });
  });

  describe('methods', () => {
    it.each(['GET', 'PUT', 'DELETE'])(
      'answers 405 to a %s, with no guard, no rate limit and no write',
      async (method) => {
        const res = await call(mockRequest({ method, headers: {} }));

        expect(res._status).toBe(405);
        expect(res._json).toEqual({ error: 'POST only' });
        expect(mockDone).toHaveBeenCalledWith({ status: 405 });
        expect(mockPipeline).not.toHaveBeenCalled();
        expect(mockRedisSet).not.toHaveBeenCalled();
      },
    );
  });

  describe('callers that are not the owner', () => {
    it.each([
      ['a guest key', `sc-guest=${GUEST_KEY}`],
      ['no cookie', null],
      ['a wrong owner cookie', 'sc-owner=not-the-secret'],
      ['an empty owner cookie', 'sc-owner='],
    ])('answers 401 to %s and writes nothing', async (_label, cookie) => {
      const res = await call(post(cookie));

      expect(res._status).toBe(401);
      expect(mockDone).toHaveBeenCalledWith({ status: 401 });
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('answers 401 to an empty owner cookie when OWNER_SECRET is unset', async () => {
      delete process.env.OWNER_SECRET;

      const res = await call(post('sc-owner='));

      expect(res._status).toBe(401);
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('answers 403 to a bot and writes nothing', async () => {
      // BotID is consulted only on Vercel, and not for a valid owner cookie.
      process.env.VERCEL = '1';
      mockCheckBotId.mockResolvedValue({ isBot: true });

      const res = await call(post(`sc-guest=${GUEST_KEY}`));

      expect(res._status).toBe(403);
      expect(mockDone).toHaveBeenCalledWith({ status: 403 });
      expect(mockRedisSet).not.toHaveBeenCalled();
    });
  });

  describe('rate limit', () => {
    it('counts the owner’s requests under the snapshot-close key', async () => {
      await call(post());

      expect(mockIncr).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^ratelimit:snapshot-close:${IP}:\\d+$`),
        ),
      );
    });

    it('allows the 30th request of the minute', async () => {
      mockExec.mockResolvedValue([RATE_LIMIT_PER_MINUTE, 1]);

      const res = await call(post());

      expect(res._status).toBe(204);
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
    });

    it('answers 429 to the 31st and writes nothing', async () => {
      mockExec.mockResolvedValue([RATE_LIMIT_PER_MINUTE + 1, 1]);

      const res = await call(post());

      expect(res._status).toBe(429);
      expect(res._headers['Retry-After']).toBeDefined();
      expect(mockMetrics.rateLimited).toHaveBeenCalledWith('snapshot-close');
      expect(mockDone).toHaveBeenCalledWith({ status: 429 });
      expect(mockRedisSet).not.toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('answers 500 and captures the error when the Redis write rejects', async () => {
      const boom = new Error('redis down');
      mockRedisSet.mockRejectedValueOnce(boom);

      const res = await call(post());

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal error' });
      expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: boom },
        'snapshot-close: marker write failed',
      );
      expect(mockDone).toHaveBeenCalledTimes(1);
      expect(mockDone).toHaveBeenCalledWith({ status: 500 });
    });
  });
});
