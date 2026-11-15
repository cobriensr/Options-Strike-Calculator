// @vitest-environment node

/**
 * How a UW 429 reaches Sentry (sentry-noise-fixes-2026-11-13, Phase 4).
 *
 * Every 429 is counted (`uw.rate_limited`, attribute `endpoint` = a path
 * template) and nothing else. A warning goes out only when `withRetry` gives up
 * on a 429: one stable message and fingerprint, the endpoint in a tag.
 *
 * The real `uw-fetch.ts` and `sentry.ts` run here; only the module boundaries
 * under them are mocked (`@sentry/node`, the Redis-backed gates, the logger).
 * `@sentry/node` is faked so a scope records what is set on it, and
 * `captureMessage` snapshots the scope: the assertions read the event Sentry
 * would receive, not the calls made to build it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

interface SentryEvent {
  message: string;
  level: string | undefined;
  fingerprint: string[] | undefined;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

const sentry = vi.hoisted(() => {
  const events: Array<{
    message: string;
    level: string | undefined;
    fingerprint: string[] | undefined;
    tags: Record<string, string>;
    extra: Record<string, unknown>;
  }> = [];
  const counts: Array<{ name: string; value: number; attributes: unknown }> =
    [];
  const exceptions: unknown[] = [];
  let current: {
    level?: string;
    fingerprint?: string[];
    tags: Record<string, string>;
    extra: Record<string, unknown>;
  } | null = null;
  return {
    events,
    counts,
    exceptions,
    init: vi.fn(),
    withScope: (cb: (scope: unknown) => void) => {
      const state = {
        level: undefined as string | undefined,
        fingerprint: undefined as string[] | undefined,
        tags: {} as Record<string, string>,
        extra: {} as Record<string, unknown>,
      };
      current = state;
      const scope = {
        setLevel: (l: string) => {
          state.level = l;
        },
        setFingerprint: (f: string[]) => {
          state.fingerprint = f;
        },
        setTag: (k: string, v: string) => {
          state.tags[k] = v;
        },
        setExtra: (k: string, v: unknown) => {
          state.extra[k] = v;
        },
      };
      try {
        cb(scope);
      } finally {
        current = null;
      }
    },
    captureMessage: (message: string, level?: string) => {
      events.push({
        message,
        level: level ?? current?.level,
        fingerprint: current?.fingerprint,
        tags: { ...current?.tags },
        extra: { ...current?.extra },
      });
    },
    metrics: {
      count: (name: string, value: number, opts?: { attributes?: unknown }) => {
        counts.push({ name, value, attributes: opts?.attributes });
      },
      distribution: vi.fn(),
      gauge: vi.fn(),
    },
  };
});

vi.mock('@sentry/node', () => ({
  init: sentry.init,
  httpIntegration: vi.fn(() => ({})),
  withScope: sentry.withScope,
  captureMessage: sentry.captureMessage,
  captureException: (err: unknown) => {
    sentry.exceptions.push(err);
  },
  setTag: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  metrics: sentry.metrics,
}));

vi.mock('../_lib/uw-rate-limit.js', () => ({
  acquireUWSlot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue('slot'),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// The cron under test takes the real retry loop and the real uwFetch; only
// the guard is stubbed, so the market-hours window does not matter.
const { mockCronGuard } = vi.hoisted(() => ({ mockCronGuard: vi.fn() }));
vi.mock('../_lib/api-helpers.js', async () => {
  const uw = await import('../_lib/uw-fetch.js');
  return {
    uwFetch: uw.uwFetch,
    withRetry: uw.withRetry,
    cronGuard: mockCronGuard,
    cronJitter: vi.fn(() => Promise.resolve()),
  };
});

import { uwEndpointTemplate, uwFetch, withRetry } from '../_lib/uw-fetch.js';
import handler from '../cron/fetch-nope.js';
import { reportCronRun } from '../_lib/axiom.js';

const CONCURRENT_BODY =
  'You have exceeded 3 concurrent requests, the maximum allowed for your current plan';

function uw429(retryAfter: string | null = null): Response {
  return {
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h === 'retry-after' ? retryAfter : null) },
    text: () => Promise.resolve(CONCURRENT_BODY),
  } as unknown as Response;
}

function uwOk(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({ data: [{ a: 1 }] }),
  } as unknown as Response;
}

function uw500(): Response {
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: () => Promise.resolve('upstream connect error'),
  } as unknown as Response;
}

/** Run `fn`, step the retry sleeps, and settle with its outcome. */
async function run<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const pending = fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // Concurrent-429 backoff is 250-500 ms per retry, 1-2 s for a 5xx.
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

const rateLimitedCounts = () =>
  sentry.counts.filter((c) => c.name === 'uw.rate_limited');

describe('uwEndpointTemplate', () => {
  it.each([
    // Query string dropped; a ticker is a variable segment.
    ['/stock/SPY/greek-flow?date=2026-11-13', '/stock/{id}/greek-flow'],
    ['/stock/QQQ/greek-flow?date=2026-11-12', '/stock/{id}/greek-flow'],
    // An ISO date segment is its own template.
    ['/option-trades/full-tape/2026-11-13', '/option-trades/full-tape/{date}'],
    // Option symbol, futures contract, candle size, group flow expiry.
    [
      '/option-contract/SPXW261113C06800000/intraday?date=2026-11-13',
      '/option-contract/{id}/intraday',
    ],
    ['/futures/ESZ6/trades?limit=500', '/futures/{id}/trades'],
    ['/stock/SPY/ohlc/1m?date=2026-11-13', '/stock/{id}/ohlc/{id}'],
    [
      '/group-flow/semi/greek-flow/2026-11-13',
      '/group-flow/semi/greek-flow/{date}',
    ],
    // A percent-encoded symbol is variable, whatever it decodes to.
    ['/stock/%5ESPX/max-pain', '/stock/{id}/max-pain'],
    // Fixed routes pass through.
    ['/market/economic-calendar', '/market/economic-calendar'],
    ['/stock/SPX/greek-exposure/strike', '/stock/{id}/greek-exposure/strike'],
    // A full URL keeps only its path, without the `/api` prefix.
    [
      'https://api.unusualwhales.com/api/stock/SPX/flow?date=2026-04-13',
      '/stock/{id}/flow',
    ],
  ])('%s -> %s', (path, template) => {
    expect(uwEndpointTemplate(path)).toBe(template);
  });

  it('collapses an unparseable absolute URL to a fixed label', () => {
    expect(uwEndpointTemplate('http://[bad')).toBe('other');
  });
});

describe('UW 429 reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    sentry.events.length = 0;
    sentry.counts.length = 0;
    sentry.exceptions.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a 429 then a 200 reports nothing to Sentry and counts one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uw429())
      .mockResolvedValueOnce(uwOk());
    vi.stubGlobal('fetch', fetchMock);

    const out = await run(() =>
      withRetry(() => uwFetch('k', '/stock/SPY/greek-flow?date=2026-11-13')),
    );

    expect(out).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rateLimitedCounts()).toEqual([
      {
        name: 'uw.rate_limited',
        value: 1,
        attributes: { endpoint: '/stock/{id}/greek-flow' },
      },
    ]);
    expect(sentry.events).toEqual([]);
    expect(sentry.exceptions).toEqual([]);
  });

  it('retries that run out give exactly one warning, with the stable fingerprint and the endpoint tag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(uw429('30'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await run(() =>
      withRetry(() => uwFetch('k', '/stock/SPY/greek-flow?date=2026-11-13')),
    );

    // The caller still gets the failure: it is not swallowed.
    expect(out.ok).toBe(false);
    expect((out as { error: Error }).error.message).toMatch(/^UW API 429:/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every 429 is counted; only the last one is reported.
    expect(rateLimitedCounts()).toHaveLength(3);
    expect(sentry.events).toEqual([
      {
        message: 'UW 429: retries exhausted',
        level: 'warning',
        fingerprint: ['uw-rate-limit-exhausted'],
        tags: { 'uw.endpoint': '/stock/{id}/greek-flow' },
        extra: { retry_after_s: '30' },
      },
    ]);
  });

  it('two endpoints that run out of retries share one fingerprint and message, with two tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uw429()));

    const a = await run(() =>
      withRetry(() => uwFetch('k', '/stock/SPY/greek-flow?date=2026-11-13')),
    );
    const b = await run(() =>
      withRetry(() => uwFetch('k', '/market/QQQ/etf-tide')),
    );

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    const events = sentry.events as SentryEvent[];
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.message))).toEqual(
      new Set(['UW 429: retries exhausted']),
    );
    expect(events.map((e) => e.fingerprint)).toEqual([
      ['uw-rate-limit-exhausted'],
      ['uw-rate-limit-exhausted'],
    ]);
    expect(events.map((e) => e.tags['uw.endpoint'])).toEqual([
      '/stock/{id}/greek-flow',
      '/market/{id}/etf-tide',
    ]);
  });

  it('puts neither the endpoint nor a ticker in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uw429()));

    await run(() =>
      withRetry(() => uwFetch('k', '/stock/AAPL/greek-flow?date=2026-11-13')),
    );

    const [event] = sentry.events as SentryEvent[];
    expect(event?.message).not.toMatch(/AAPL|greek-flow/);
    expect(event?.tags['uw.endpoint']).not.toMatch(/AAPL/);
  });

  it('a 429 with no retry loop is counted but warns nothing: no retries ran out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uw429()));

    const out = await run(() => uwFetch('k', '/stock/SPY/greek-flow'));

    expect(out.ok).toBe(false);
    expect(rateLimitedCounts()).toHaveLength(1);
    expect(sentry.events).toEqual([]);
  });

  it('a 5xx that runs out of retries is not reported as a rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uw500()));

    const out = await run(() =>
      withRetry(() => uwFetch('k', '/stock/SPY/greek-flow')),
    );

    expect(out.ok).toBe(false);
    expect(rateLimitedCounts()).toEqual([]);
    expect(sentry.events).toEqual([]);
  });

  it('a 429 error thrown by something other than uwFetch warns nothing (no endpoint to name)', async () => {
    const out = await run(() =>
      withRetry(() => Promise.reject(new Error('UW API 429: from elsewhere'))),
    );

    expect(out.ok).toBe(false);
    expect(sentry.events).toEqual([]);
  });
});

describe('a cron that ends on an exhausted UW 429', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T18:46:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    sentry.events.length = 0;
    sentry.counts.length = 0;
    sentry.exceptions.length = 0;
    vi.mocked(reportCronRun).mockClear();
    mockCronGuard.mockReturnValue({ apiKey: 'k', today: '2026-04-14' });
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails the run instead of reporting success, and files the one warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(uw429()));
    const res = mockResponse();

    const pending = handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ job: 'fetch-nope' });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-nope',
      expect.objectContaining({
        status: 'error',
        message: expect.stringMatching(/^UW API 429:/),
      }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-nope',
      expect.objectContaining({ status: 'success' }),
    );
    // The warning, plus the cron wrapper's own capture of the thrown error.
    expect(sentry.events).toHaveLength(1);
    expect((sentry.events[0] as SentryEvent).fingerprint).toEqual([
      'uw-rate-limit-exhausted',
    ]);
    expect(sentry.exceptions).toHaveLength(1);
  });
});
