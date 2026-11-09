// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SCHWAB_BASE,
  SchwabAuthError,
  getSchwabAccessToken,
  readSchwabEnv,
  redactBody,
  schwabCronsBusyRefusal,
} from './schwab-local.mjs';

const CREDS = { clientId: 'client-id', clientSecret: 'client-secret' };
const NOW = Date.parse('2026-11-06T12:00:00Z');

function atTime(iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

/** A stored token record that is still good for `validForMs`. */
function record(overrides = {}) {
  return {
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    expiresAt: NOW + 20 * 60_000,
    refreshExpiresAt: NOW + 3 * 86_400_000,
    ...overrides,
  };
}

/** The one Upstash client surface the module uses: get and eval. */
function fakeRedis({ get = [record()], evalResult = 1 } = {}) {
  const gets = [...get];
  return {
    get: vi.fn(async () => (gets.length > 1 ? gets.shift() : gets[0])),
    eval: vi.fn(async () => evalResult),
  };
}

function tokenResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── the idle-window guard ──────────────────────────────────

describe('schwabCronsBusyRefusal', () => {
  it.each([
    // 2026-11-06 is a Friday; 2026-11-07 a Saturday; 2026-11-09 a Monday.
    ['Friday 12:59 UTC', '2026-11-06T12:59:00Z', false],
    ['Friday 13:00 UTC', '2026-11-06T13:00:00Z', true],
    ['Friday 17:30 UTC', '2026-11-06T17:30:00Z', true],
    ['Friday 21:59 UTC', '2026-11-06T21:59:00Z', true],
    // fetch-market-internals settles at 22:30 UTC (vercel.json `30 22 * * 1-5`).
    ['Friday 22:00 UTC', '2026-11-06T22:00:00Z', true],
    ['Friday 22:30 UTC (the settle cron)', '2026-11-06T22:30:00Z', true],
    ['Friday 22:59 UTC', '2026-11-06T22:59:00Z', true],
    ['Friday 23:00 UTC', '2026-11-06T23:00:00Z', false],
    ['Saturday 15:00 UTC', '2026-11-07T15:00:00Z', false],
    ['Sunday 15:00 UTC', '2026-11-08T15:00:00Z', false],
    ['Monday 13:00 UTC', '2026-11-09T13:00:00Z', true],
    ['Monday 03:00 UTC', '2026-11-09T03:00:00Z', false],
  ])('%s (%s) → refused: %s', (_label, iso, refused) => {
    atTime(iso);
    const message = schwabCronsBusyRefusal();
    expect(message !== null).toBe(refused);
    if (refused) {
      expect(message).toContain('13:00–22:59 UTC');
      expect(message).toContain('--allow-market-hours');
    }
  });
});

// ── env ────────────────────────────────────────────────────

describe('readSchwabEnv', () => {
  const full = {
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    SCHWAB_CLIENT_ID: 'id',
    SCHWAB_CLIENT_SECRET: 'secret',
  };

  /** Make these the only Redis and Schwab names set, and read them. */
  function readWith(env) {
    for (const name of [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
      'SCHWAB_CLIENT_ID',
      'SCHWAB_CLIENT_SECRET',
    ]) {
      vi.stubEnv(name, env[name]);
    }
    return readSchwabEnv();
  }

  afterEach(() => vi.unstubAllEnvs());

  it('reads the Upstash names', () => {
    expect(readWith(full)).toEqual({
      problem: null,
      redisUrl: 'https://redis.example',
      redisToken: 'redis-token',
      clientId: 'id',
      clientSecret: 'secret',
    });
  });

  it('falls back to the Vercel KV names', () => {
    const env = {
      KV_REST_API_URL: 'https://kv.example',
      KV_REST_API_TOKEN: 'kv-token',
      SCHWAB_CLIENT_ID: 'id',
      SCHWAB_CLIENT_SECRET: 'secret',
    };
    const read = readWith(env);
    expect(read.problem).toBeNull();
    expect(read.redisUrl).toBe('https://kv.example');
    expect(read.redisToken).toBe('kv-token');
  });

  it.each([
    [
      'no Redis URL',
      { ...full, UPSTASH_REDIS_REST_URL: undefined },
      'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN',
    ],
    [
      'no Redis token',
      { ...full, UPSTASH_REDIS_REST_TOKEN: '' },
      'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN',
    ],
    [
      'no client id',
      { ...full, SCHWAB_CLIENT_ID: undefined },
      'Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET',
    ],
    [
      'no client secret',
      { ...full, SCHWAB_CLIENT_SECRET: undefined },
      'Missing SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET',
    ],
  ])('names the problem: %s', (_label, env, problem) => {
    expect(readWith(env).problem).toBe(problem);
  });
});

// ── redactBody ─────────────────────────────────────────────

describe('redactBody', () => {
  it('masks token-like runs and caps the length', () => {
    expect(redactBody('error: abcdefghijklmnopqrstuvwxyz0123456789 bad')).toBe(
      'error: [redacted] bad',
    );
    const long = redactBody('x '.repeat(300));
    expect(long.length).toBeLessThan(260);
    expect(long).toContain('(600 chars)');
  });

  it('leaves a short plain body alone', () => {
    expect(redactBody('invalid_client')).toBe('invalid_client');
  });
});

// ── getSchwabAccessToken ───────────────────────────────────

describe('getSchwabAccessToken', () => {
  it('exports the Schwab market-data base', () => {
    expect(SCHWAB_BASE).toBe('https://api.schwabapi.com/marketdata/v1');
  });

  it('returns the stored access token while it is still good, with no network call', async () => {
    atTime('2026-11-06T12:00:00Z');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const redis = fakeRedis();

    await expect(getSchwabAccessToken(redis, CREDS)).resolves.toBe(
      'stored-access',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token and stores it with the compare-and-set', async () => {
    atTime('2026-11-06T12:00:00Z');
    const fetchMock = vi.fn(async () =>
      tokenResponse({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 1800,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const stored = record({ expiresAt: NOW - 1000 });
    const redis = fakeRedis({ get: [stored] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(getSchwabAccessToken(redis, CREDS)).resolves.toBe(
      'fresh-access',
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.schwabapi.com/v1/oauth/token');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    expect(init.body.get('grant_type')).toBe('refresh_token');
    expect(init.body.get('refresh_token')).toBe('stored-refresh');

    // The write is the compare-and-set: it names the key and the refresh
    // token the refresh used, and the new record keeps the 7-day window.
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, keys, argv] = redis.eval.mock.calls[0];
    expect(script).toContain('string.find(raw, ARGV[1], 1, true)');
    expect(keys).toEqual(['schwab:tokens']);
    expect(argv[0]).toBe('"refreshToken":"stored-refresh"');
    const written = JSON.parse(argv[1]);
    expect(written).toMatchObject({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      refreshExpiresAt: stored.refreshExpiresAt,
    });
    expect(written.expiresAt).toBe(NOW + 1_800_000);
    expect(Number(argv[2])).toBeGreaterThanOrEqual(3600);
  });

  it('keeps the stored refresh token when Schwab omits one', async () => {
    atTime('2026-11-06T12:00:00Z');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ access_token: 'fresh-access', expires_in: 1800 }),
      ),
    );
    const redis = fakeRedis({ get: [record({ expiresAt: NOW - 1 })] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await getSchwabAccessToken(redis, CREDS);

    expect(JSON.parse(redis.eval.mock.calls[0][2][1]).refreshToken).toBe(
      'stored-refresh',
    );
  });

  it('uses the record a re-login wrote mid-refresh instead of overwriting it', async () => {
    atTime('2026-11-06T12:00:00Z');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ access_token: 'fresh-access', expires_in: 1800 }),
      ),
    );
    const relogin = record({ accessToken: 'relogin-access' });
    const redis = fakeRedis({
      get: [record({ expiresAt: NOW - 1 }), relogin],
      evalResult: 2,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(getSchwabAccessToken(redis, CREDS)).resolves.toBe(
      'relogin-access',
    );
  });

  it.each([
    ['key cleared', 0, null],
    ['different token, itself expired', 2, { expiresAt: NOW - 1 }],
  ])(
    'refuses to overwrite a changed record (%s)',
    async (_label, evalResult, current) => {
      atTime('2026-11-06T12:00:00Z');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          tokenResponse({ access_token: 'fresh-access', expires_in: 1800 }),
        ),
      );
      const redis = fakeRedis({
        get: [record({ expiresAt: NOW - 1 }), current ? record(current) : null],
        evalResult,
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(getSchwabAccessToken(redis, CREDS)).rejects.toThrow(
        /changed or was cleared during refresh/,
      );
    },
  );

  it('throws a SchwabAuthError when Redis holds no tokens', async () => {
    const redis = fakeRedis({ get: [null] });

    const err = await getSchwabAccessToken(redis, CREDS).catch((e) => e);

    expect(err).toBeInstanceOf(SchwabAuthError);
    expect(err.message).toContain('No Schwab tokens in Redis');
  });

  it('throws a SchwabAuthError when the refresh token has lapsed, without calling Schwab', async () => {
    atTime('2026-11-06T12:00:00Z');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const redis = fakeRedis({
      get: [record({ refreshExpiresAt: NOW - 1 })],
    });

    await expect(getSchwabAccessToken(redis, CREDS)).rejects.toThrow(
      /refresh token expired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a refused refresh and masks token-like text in the body', async () => {
    atTime('2026-11-06T12:00:00Z');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant abcdefghijklmnopqrstuvwxyz012345',
      })),
    );
    const redis = fakeRedis({ get: [record({ expiresAt: NOW - 1 })] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const err = await getSchwabAccessToken(redis, CREDS).catch((e) => e);

    expect(err).toBeInstanceOf(SchwabAuthError);
    expect(err.message).toContain('Token refresh failed (400)');
    expect(err.message).toContain('invalid_grant [redacted]');
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it.each([
    ['no access_token', { expires_in: 1800 }],
    ['an empty access_token', { access_token: '', expires_in: 1800 }],
    ['no expires_in', { access_token: 'fresh-access' }],
  ])(
    'throws on a malformed refresh response (%s) and stores nothing',
    async (_label, body) => {
      atTime('2026-11-06T12:00:00Z');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => tokenResponse(body)),
      );
      const redis = fakeRedis({ get: [record({ expiresAt: NOW - 1 })] });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(getSchwabAccessToken(redis, CREDS)).rejects.toThrow(
        /malformed response/,
      );
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );
});
