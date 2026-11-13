// @vitest-environment node

/**
 * /api/snapshot-close — the owner's page tells the server about the one
 * marker `check-live-snapshots` reads (one Redis key per ET date):
 *   - POST: "the page was closed" writes the key with the close time, so the
 *     silence that follows is not reported as a stall.
 *   - DELETE: "a tab of the app is open" removes today's key, so a reload or
 *     a second tab's close never hides a stall.
 *
 * Mocks sit at the external boundaries: the Upstash clients (the marker write
 * and delete, and the rate limiter's counter), BotID, Sentry and the logger.
 * The real owner guard and rate limiter run, so the 401 for a guest or a
 * stranger, the 403 for a bot and the 429 come from the same code production
 * uses. Only `Date` is faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockRedisSet,
  mockRedisDel,
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
  mockRedisDel: vi.fn(),
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
  redis: { set: mockRedisSet, del: mockRedisDel },
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
const TODAY_KEY = `snapshot-app-closed:${TODAY}`;

/**
 * A request from `IP`; a `null` cookie sends none at all (`undefined` would
 * take the owner default).
 */
function request(
  method: string,
  cookie: string | null = OWNER_COOKIE,
  extra: Parameters<typeof mockRequest>[0] = {},
) {
  return mockRequest({
    method,
    headers: {
      'x-real-ip': IP,
      ...(cookie === null ? {} : { cookie }),
    },
    ...extra,
  });
}

function post(
  cookie?: string | null,
  extra?: Parameters<typeof mockRequest>[0],
) {
  return request('POST', cookie, extra);
}

function del(
  cookie?: string | null,
  extra?: Parameters<typeof mockRequest>[0],
) {
  return request('DELETE', cookie, extra);
}

async function call(req: ReturnType<typeof mockRequest>) {
  const res = mockResponse();
  await handler(req, res);
  return res;
}

/**
 * A rate-limit counter that remembers: each pipeline `incr` on a key bumps
 * that key's count and `exec` answers with it, as Upstash does within one
 * minute bucket (the fake clock never leaves it).
 */
function useCountingLimiter() {
  const counts = new Map<string, number>();
  mockPipeline.mockImplementation(() => {
    let key = '';
    const pipe = {
      incr: (k: string) => {
        key = k;
        mockIncr(k);
        return pipe;
      },
      expire: () => pipe,
      exec: async () => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return [count, 1];
      },
    };
    return pipe;
  });
}

describe('/api/snapshot-close', () => {
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
    mockRedisDel.mockReset().mockResolvedValue(1);
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

  describe('POST: an owner close', () => {
    it('answers 204 and writes the ET date’s marker with the close time and a 24 h expiry', async () => {
      const res = await call(post());

      expect(res._status).toBe(204);
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      // Exactly { ex }: no NX, so a later close overwrites (the last write wins).
      expect(mockRedisSet).toHaveBeenCalledWith(TODAY_KEY, NOW, {
        ex: MARKER_TTL_SEC,
      });
      expect(mockRedisDel).not.toHaveBeenCalled();
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
      expect(mockRedisSet.mock.calls).toEqual([
        [TODAY_KEY, '2026-11-11T20:30:00.000Z', { ex: MARKER_TTL_SEC }],
        [TODAY_KEY, '2026-11-11T20:45:00.000Z', { ex: MARKER_TTL_SEC }],
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
      expect(mockRedisSet).toHaveBeenCalledWith(TODAY_KEY, NOW, {
        ex: MARKER_TTL_SEC,
      });
    });
  });

  describe('DELETE: a tab of the app is open', () => {
    it('answers 204 and deletes the ET date’s marker, writing nothing', async () => {
      const res = await call(del());

      expect(res._status).toBe(204);
      expect(mockRedisDel).toHaveBeenCalledTimes(1);
      expect(mockRedisDel).toHaveBeenCalledWith(TODAY_KEY);
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(mockMetrics.request).toHaveBeenCalledWith('/api/snapshot-close');
      expect(mockDone).toHaveBeenCalledTimes(1);
      expect(mockDone).toHaveBeenCalledWith({ status: 204 });
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('answers 204 when there is no marker to delete, again and again', async () => {
      // Upstash answers DEL with the number of keys removed: 0 for a missing one.
      mockRedisDel.mockResolvedValue(0);

      const first = await call(del());
      const second = await call(del());

      expect(first._status).toBe(204);
      expect(second._status).toBe(204);
      expect(mockRedisDel).toHaveBeenCalledTimes(2);
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('keys the delete on the ET date, not the UTC date', async () => {
      // 22:30 ET on Nov 11 is already Nov 12 in UTC.
      vi.setSystemTime(new Date('2026-11-12T03:30:00.000Z'));

      await call(del());

      expect(mockRedisDel).toHaveBeenCalledWith(
        'snapshot-app-closed:2026-11-11',
      );
    });

    it('ignores anything in the body or query: the server picks the key', async () => {
      const res = await call(
        del(OWNER_COOKIE, {
          body: { date: '2020-01-01' },
          query: { date: '2020-01-01', key: 'snapshot-app-closed:2020-01-01' },
        }),
      );

      expect(res._status).toBe(204);
      expect(mockRedisDel).toHaveBeenCalledTimes(1);
      expect(mockRedisDel).toHaveBeenCalledWith(TODAY_KEY);
    });

    it('removes the marker a close wrote: close, then open, leaves none', async () => {
      const store = new Map<string, string>();
      mockRedisSet.mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      });
      mockRedisDel.mockImplementation(async (key: string) =>
        store.delete(key) ? 1 : 0,
      );

      await call(post());
      expect([...store.keys()]).toEqual([TODAY_KEY]);

      const res = await call(del());

      expect(res._status).toBe(204);
      expect(store.size).toBe(0);
    });
  });

  describe('methods', () => {
    it.each(['GET', 'PUT', 'PATCH'])(
      'answers 405 to a %s, with no guard, no rate limit, no write and no delete',
      async (method) => {
        const res = await call(mockRequest({ method, headers: {} }));

        expect(res._status).toBe(405);
        expect(res._json).toEqual({ error: 'POST or DELETE only' });
        expect(mockDone).toHaveBeenCalledWith({ status: 405 });
        expect(mockPipeline).not.toHaveBeenCalled();
        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(mockRedisDel).not.toHaveBeenCalled();
      },
    );
  });

  describe.each([
    ['POST', post],
    ['DELETE', del],
  ])('%s from a caller that is not the owner', (_method, send) => {
    it.each([
      ['a guest key', `sc-guest=${GUEST_KEY}`],
      ['no cookie', null],
      ['a wrong owner cookie', 'sc-owner=not-the-secret'],
      ['an empty owner cookie', 'sc-owner='],
    ])('answers 401 to %s and touches nothing', async (_label, cookie) => {
      const res = await call(send(cookie));

      expect(res._status).toBe(401);
      expect(mockDone).toHaveBeenCalledWith({ status: 401 });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockRedisDel).not.toHaveBeenCalled();
      expect(mockPipeline).not.toHaveBeenCalled();
    });

    it('answers 401 to an empty owner cookie when OWNER_SECRET is unset', async () => {
      delete process.env.OWNER_SECRET;

      const res = await call(send('sc-owner='));

      expect(res._status).toBe(401);
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockRedisDel).not.toHaveBeenCalled();
    });

    it('answers 403 to a bot and touches nothing', async () => {
      // BotID is consulted only on Vercel, and not for a valid owner cookie.
      process.env.VERCEL = '1';
      mockCheckBotId.mockResolvedValue({ isBot: true });

      const res = await call(send(`sc-guest=${GUEST_KEY}`));

      expect(res._status).toBe(403);
      expect(mockDone).toHaveBeenCalledWith({ status: 403 });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockRedisDel).not.toHaveBeenCalled();
    });
  });

  describe('rate limit', () => {
    it.each([
      ['POST', post],
      ['DELETE', del],
    ])('counts a %s under the snapshot-close key', async (_method, send) => {
      await call(send());

      expect(mockIncr).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^ratelimit:snapshot-close:${IP}:\\d+$`),
        ),
      );
    });

    it.each([
      ['POST', post, () => mockRedisSet],
      ['DELETE', del, () => mockRedisDel],
    ])('allows the 30th %s of the minute', async (_method, send, write) => {
      mockExec.mockResolvedValue([RATE_LIMIT_PER_MINUTE, 1]);

      const res = await call(send());

      expect(res._status).toBe(204);
      expect(write()).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['POST', post, () => mockRedisSet],
      ['DELETE', del, () => mockRedisDel],
    ])(
      'answers 429 to the 31st %s and writes nothing',
      async (_m, send, write) => {
        mockExec.mockResolvedValue([RATE_LIMIT_PER_MINUTE + 1, 1]);

        const res = await call(send());

        expect(res._status).toBe(429);
        expect(res._headers['Retry-After']).toBeDefined();
        expect(mockMetrics.rateLimited).toHaveBeenCalledWith('snapshot-close');
        expect(mockDone).toHaveBeenCalledWith({ status: 429 });
        expect(write()).not.toHaveBeenCalled();
        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(mockRedisDel).not.toHaveBeenCalled();
      },
    );

    it('shares one bucket between POST and DELETE: 30 mixed requests pass, the 31st of either kind is 429', async () => {
      useCountingLimiter();

      for (let i = 0; i < RATE_LIMIT_PER_MINUTE / 2; i++) {
        expect((await call(post()))._status).toBe(204);
        expect((await call(del()))._status).toBe(204);
      }
      expect(mockRedisSet).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE / 2);
      expect(mockRedisDel).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE / 2);

      const blockedDelete = await call(del());
      const blockedPost = await call(post());

      expect(blockedDelete._status).toBe(429);
      expect(blockedPost._status).toBe(429);
      // The two blocked requests wrote and deleted nothing more.
      expect(mockRedisSet).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE / 2);
      expect(mockRedisDel).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE / 2);
      // One counter key served all 32 requests.
      expect(new Set(mockIncr.mock.calls.map(([key]) => key)).size).toBe(1);
    });
  });

  describe('failure modes', () => {
    it('POST answers 500 and captures the error when the Redis write rejects', async () => {
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

    it('DELETE answers 500 and captures the error when the Redis delete rejects', async () => {
      const boom = new Error('redis down');
      mockRedisDel.mockRejectedValueOnce(boom);

      const res = await call(del());

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal error' });
      expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: boom },
        'snapshot-close: marker delete failed',
      );
      expect(mockDone).toHaveBeenCalledTimes(1);
      expect(mockDone).toHaveBeenCalledWith({ status: 500 });
      expect(mockRedisSet).not.toHaveBeenCalled();
    });
  });
});
