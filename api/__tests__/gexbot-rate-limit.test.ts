// @vitest-environment node

/**
 * A live-route GEXBot 429 is retried: `withRetry` backs off, bounded, waiting
 * out `Retry-After` when sent. The vendor documents both a per-account
 * short-window limit (429 with `Retry-After`) and daily/monthly pool quotas
 * (429 with none, lasting until midnight ET), and the one burst seen was
 * transient, so a retry is the right first response and the exhausted event
 * carries the `Retry-After` it saw. Every 429 is counted
 * (`gexbot.rate_limited`); the two GEXBot crons file the failure that is left
 * when the retries run out (see their tests). The EOD report route treats a
 * 429 as a quota and does not retry it.
 *
 * The real `gexbot-client.ts`, `uw-fetch.ts` (`withRetry`) and `sentry.ts` run
 * here; only `@sentry/node` is faked, so the assertions read what reaches it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentry = vi.hoisted(() => ({
  counts: [] as Array<{ name: string; value: number; attributes: unknown }>,
  captured: [] as unknown[],
}));

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  httpIntegration: vi.fn(() => ({})),
  withScope: (cb: (scope: unknown) => void) => {
    sentry.captured.push('withScope');
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTag: vi.fn() });
  },
  captureMessage: (message: string) => {
    sentry.captured.push(message);
  },
  captureException: (err: unknown) => {
    sentry.captured.push(err);
  },
  setTag: vi.fn(),
  metrics: {
    count: (name: string, value: number, opts?: { attributes?: unknown }) => {
      sentry.counts.push({ name, value, attributes: opts?.attributes });
    },
    distribution: vi.fn(),
    gauge: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// uw-fetch.ts imports these two Redis-backed gates; neither is reached here.
vi.mock('../_lib/uw-rate-limit.js', () => ({ acquireUWSlot: vi.fn() }));
vi.mock('../_lib/uw-concurrency.js', () => ({
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
}));

import {
  classifyGexbotError,
  fetchOrderflow,
  GexbotHttpError,
  gexbotFailureLevel,
  gexbotRetryAfterTags,
  parseRetryAfterMs,
} from '../_lib/gexbot-client.js';
import { withRetry } from '../_lib/uw-fetch.js';

function res429(retryAfter: string | null = null): Response {
  return {
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h === 'retry-after' ? retryAfter : null) },
    text: () => Promise.resolve('{"error": "Rate limit exceeded."}'),
  } as unknown as Response;
}

function res200(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ticker: 'SPX', timestamp: 1_700_000_000 }),
  } as unknown as Response;
}

const fetchOnce = () => withRetry(() => fetchOrderflow('k', 'SPX'));

/** Start `fetchOnce`, with its outcome captured so a rejection is not unhandled. */
function start() {
  return fetchOnce().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('GEXBot 429 retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
    // 0 puts no jitter on the wait, so the backoff numbers read exactly.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    sentry.counts.length = 0;
    sentry.captured.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a 429 then a 200 returns the data, counts the 429 and reports nothing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res429())
      .mockResolvedValueOnce(res200());
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({
      ok: true,
      value: { ticker: 'SPX', timestamp: 1_700_000_000 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentry.counts).toEqual([
      {
        name: 'gexbot.rate_limited',
        value: 1,
        attributes: { endpoint: '/{ticker}/orderflow/orderflow' },
      },
    ]);
    expect(sentry.captured).toEqual([]);
  });

  it('is retried with a 1 s then 2 s backoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res429());
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 1000 ms: first retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 2000 ms later: second retry
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const out = await pending;
    expect(out.ok).toBe(false);
  });

  it('gives up after the third 429, with a typed error the crons classify as http-429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res429());
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await pending;

    // Bounded: 3 attempts (2 retries), however long we wait.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.ok).toBe(false);
    const err = (out as { error: unknown }).error;
    expect(err).toBeInstanceOf(GexbotHttpError);
    expect(classifyGexbotError(err).statusClass).toBe('http-429');
    // Counted every time, reported by the library never: the crons report.
    expect(sentry.counts).toHaveLength(3);
    expect(sentry.captured).toEqual([]);
  });

  it('waits at least Retry-After before retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res429('2'))
      .mockResolvedValueOnce(res200());
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await pending).ok).toBe(true);
  });

  it('does not wait for a Retry-After longer than 3 s: one call, the error thrown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res429('30'));
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    expect((out as { error: GexbotHttpError }).error.retryAfterMs).toBe(30_000);
  });

  it('adds up to 250 ms of jitter to the wait', async () => {
    vi.mocked(Math.random).mockReturnValue(0.999);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res429())
      .mockResolvedValueOnce(res200());
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('counts a 429 that is not retried (no retry loop around the call)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res429()));

    await expect(fetchOrderflow('k', 'SPX')).rejects.toBeInstanceOf(
      GexbotHttpError,
    );
    expect(sentry.counts).toHaveLength(1);
  });

  it('keeps the endpoint attribute to the route: the ticker is not in it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res429()));

    await fetchOrderflow('k', 'NQ_NDX').catch(() => undefined);
    await fetchOrderflow('k', 'SPY').catch(() => undefined);

    expect(sentry.counts.map((c) => c.attributes)).toEqual([
      { endpoint: '/{ticker}/orderflow/orderflow' },
      { endpoint: '/{ticker}/orderflow/orderflow' },
    ]);
  });

  it('still never retries the orderflow "null or zero length" 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () =>
        Promise.resolve('Failed to get redis chart data: null or zero length'),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const pending = start();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentry.counts).toEqual([]);
  });
});

describe('parseRetryAfterMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['2', 2000],
    ['0', 0],
    [' 3 ', 3000],
    ['1.5', 1500],
    // An HTTP date is read against the clock, never negative.
    ['Fri, 13 Nov 2026 15:00:02 GMT', 2000],
    ['Fri, 13 Nov 2026 14:59:00 GMT', 0],
  ])('%j -> %j ms', (value, ms) => {
    expect(parseRetryAfterMs(value)).toBe(ms);
  });

  it.each([[null], [undefined], [''], ['soon'], ['-1']])(
    '%j is no usable Retry-After',
    (value) => {
      expect(parseRetryAfterMs(value)).toBeNull();
    },
  );
});

describe('gexbotRetryAfterTags', () => {
  const TAG = 'gexbot.retry_after_ms';

  it.each([
    [2000, '2000'],
    [30_000, '30000'],
    // A Retry-After of 0 is a header that was sent, not an absent one.
    [0, '0'],
    [null, 'none'],
  ])('a 429 with Retry-After %j ms is tagged %j', (ms, tag) => {
    const err = new GexbotHttpError(429, '/SPX/orderflow/orderflow', '', ms);
    expect(gexbotRetryAfterTags(err)).toEqual({ [TAG]: tag });
  });

  it('tags nothing for a failure that is not a 429', () => {
    expect(
      gexbotRetryAfterTags(new GexbotHttpError(503, '/SPX/x', 'down')),
    ).toEqual({});
    // Even a 5xx that carried a Retry-After: the tag is for the 429 question.
    expect(
      gexbotRetryAfterTags(new GexbotHttpError(503, '/SPX/x', 'down', 5000)),
    ).toEqual({});
    expect(
      gexbotRetryAfterTags(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      ),
    ).toEqual({});
    expect(gexbotRetryAfterTags('not an error')).toEqual({});
  });

  describe('through the real fetch path', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function tagsAfter429(retryAfter: string | null) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res429(retryAfter)));
      const err = await fetchOrderflow('k', 'SPX').catch((e: unknown) => e);
      return gexbotRetryAfterTags(err);
    }

    it('reads the Retry-After header as ms', async () => {
      expect(await tagsAfter429('2')).toEqual({ [TAG]: '2000' });
    });

    it('says none when the 429 sent no Retry-After (the quota shape)', async () => {
      expect(await tagsAfter429(null)).toEqual({ [TAG]: 'none' });
    });

    it('says none when the Retry-After is unreadable', async () => {
      expect(await tagsAfter429('soon')).toEqual({ [TAG]: 'none' });
    });
  });
});

describe('gexbotFailureLevel', () => {
  it('files an exhausted 429 as a warning and everything else as an error', () => {
    expect(gexbotFailureLevel('http-429')).toBe('warning');
    for (const cls of [
      'http-4xx',
      'http-5xx',
      'no-data',
      'timeout',
      'other',
    ] as const) {
      expect(gexbotFailureLevel(cls)).toBe('error');
    }
  });
});
