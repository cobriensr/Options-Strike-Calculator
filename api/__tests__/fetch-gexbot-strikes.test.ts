// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, mockSentryMessage } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryCapture: vi.fn(),
  mockSentryMessage: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: mockSentryMessage,
  },
  metrics: { uwRateLimit: vi.fn() },
}));

import handler from '../cron/fetch-gexbot-strikes.js';
import { GEXBOT_TICKERS, STATE_CATEGORIES } from '../_lib/gexbot-client.js';

const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');
// 15:55 ET (EDT) — last minutes before the 16:00 ET cash close.
const PRE_CLOSE_TIME = new Date('2026-03-24T19:55:00.000Z');
// 16:30 ET (EDT) — GexBot's snapshot is frozen at the close by now.
const POST_CLOSE_TIME = new Date('2026-03-24T20:30:00.000Z');
const TOTAL_TASKS = GEXBOT_TICKERS.length * STATE_CATEGORIES.length; // 128

function makeStateBody(ticker: string, category: string) {
  return {
    timestamp: 1_700_000_000,
    ticker,
    category,
    spot: 100.5,
    strikes: [
      [100, 50, 0.1, [0.09, 0.08, 0.07]],
      [101, 60, 0.12, [0.11, 0.1, 0.09]],
    ],
  };
}

function stubFetchHappyPath() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      const segs = url.split('/');
      const ticker =
        segs.find((s) => GEXBOT_TICKERS.includes(s as never)) ?? 'SPX';
      const category = segs[segs.length - 1] ?? 'gamma_zero';
      return {
        ok: true,
        status: 200,
        json: async () => makeStateBody(ticker, category),
      } as Response;
    }),
  );
}

describe('fetch-gexbot-strikes handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
    process.env.GEXBOT_API_KEY = 'gxk_test_123';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips after the cash close without fetching (GexBot snapshot is frozen)', async () => {
    vi.setSystemTime(POST_CLOSE_TIME);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('returns 500 when GEXBOT_API_KEY is not set', async () => {
    delete process.env.GEXBOT_API_KEY;
    stubFetchHappyPath();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('stores 128 captures (16 tickers × 8 state categories)', async () => {
    stubFetchHappyPath();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: TOTAL_TASKS,
      captures: TOTAL_TASKS,
      failed: 0,
    });
    // Single batched UNNEST INSERT for all 128 rows.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('continues on per-(ticker,category) fetch failures with partial status', async () => {
    // Uses 400 (non-retryable) so withRetry exits on the first attempt —
    // 5xx would trigger backoff and stall under fake timers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/state/gamma_zero')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'bad request',
          } as Response;
        }
        const segs = url.split('/');
        const ticker =
          segs.find((s) => GEXBOT_TICKERS.includes(s as never)) ?? 'SPX';
        const category = segs[segs.length - 1] ?? 'gamma_zero';
        return {
          ok: true,
          status: 200,
          json: async () => makeStateBody(ticker, category),
        } as Response;
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: TOTAL_TASKS - 1,
      failed: 1,
    });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
  });

  it('emits one Sentry exception per failure and NO summary when failures are below the cap', async () => {
    // Below SENTRY_CAPTURE_CAP=10 → every failure gets its own stack
    // trace and the captureMessage summary stays silent. Guards against
    // an off-by-one in the `failed > SENTRY_CAPTURE_CAP` boundary.
    const FAILING_CATEGORIES = new Set([
      'gamma_zero',
      'delta_zero',
      'vanna_zero',
      'charm_zero',
      'gamma_one',
    ]); // 5 failures × 1 ticker = 5 total
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        const segs = url.split('/');
        const ticker =
          segs.find((s) => GEXBOT_TICKERS.includes(s as never)) ?? 'SPX';
        const category = segs[segs.length - 1] ?? 'gamma_zero';
        if (ticker === 'SPX' && FAILING_CATEGORIES.has(category)) {
          return {
            ok: false,
            status: 400,
            text: async () => 'bad request',
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => makeStateBody(ticker, category),
        } as Response;
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: TOTAL_TASKS - 5,
      failed: 5,
    });
    expect(mockSentryCapture).toHaveBeenCalledTimes(5);
    expect(mockSentryMessage).not.toHaveBeenCalled();
  });

  it('caps Sentry exceptions at 10 and emits a summary message during a full outage', async () => {
    // Simulate every GEXBot call failing — verifies the
    // SENTRY_CAPTURE_CAP suppression introduced after SENTRY-EMERALD-
    // DESERT-8F (144 events from a single slow minute). Without the
    // cap, 128 simultaneous timeouts would generate 128 captureException
    // calls per tick.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 400 (non-retryable) avoids stalling on withRetry's backoff
        // under fake timers; the cap behavior is the same regardless
        // of which non-2xx status the upstream returns.
        return {
          ok: false,
          status: 400,
          text: async () => 'bad request',
        } as Response;
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 0,
      failed: TOTAL_TASKS,
    });
    // Hard cap on per-tick stack traces, regardless of how many fail.
    expect(mockSentryCapture).toHaveBeenCalledTimes(10);
    // One summary message covering the suppressed remainder.
    expect(mockSentryMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryMessage).toHaveBeenCalledWith(
      expect.stringContaining(`additional failures suppressed (cap=10)`),
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['gexbot-failures-suppressed', 'fetch-gexbot-strikes'],
        tags: expect.objectContaining({
          'gexbot.cron': 'strikes',
          'gexbot.summary': 'true',
        }),
      }),
    );
  });

  it('reports a pre-close timeout to Sentry under the stable gexbot-fetch-failure fingerprint', async () => {
    // AbortSignal.timeout surfaces as a DOMException named TimeoutError.
    // withRetry retries it twice (1s + 2s backoff), then the failure must
    // still reach Sentry — grouped by (cron, err.name), not by stack/message.
    vi.useFakeTimers();
    vi.setSystemTime(PRE_CLOSE_TIME);
    let timeoutCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/state/gamma_zero')) {
          timeoutCalls += 1;
          throw new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          );
        }
        const segs = url.split('/');
        const ticker =
          segs.find((s) => GEXBOT_TICKERS.includes(s as never)) ?? 'SPX';
        const category = segs.at(-1) ?? 'gamma_zero';
        return {
          ok: true,
          status: 200,
          json: async () => makeStateBody(ticker, category),
        } as Response;
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const pending = handler(req, res);
    await vi.advanceTimersByTimeAsync(3500);
    await pending;

    expect(timeoutCalls).toBe(3);
    expect(res._json).toMatchObject({ status: 'partial', failed: 1 });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TimeoutError' }),
      expect.objectContaining({
        fingerprint: [
          'gexbot-fetch-failure',
          'fetch-gexbot-strikes',
          'TimeoutError',
        ],
        tags: expect.objectContaining({
          'gexbot.cron': 'strikes',
          'gexbot.ticker': 'SPX',
          'gexbot.category': 'gamma_zero',
        }),
      }),
    );
  });

  it('captures a malformed 2xx body (res.json() rejects) as a fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        const segs = url.split('/');
        const ticker =
          segs.find((s) => GEXBOT_TICKERS.includes(s as never)) ?? 'SPX';
        const category = segs.at(-1) ?? 'gamma_zero';
        if (url.endsWith('/SPX/state/charm_one')) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON');
            },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => makeStateBody(ticker, category),
        } as Response;
      }),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'partial',
      rows: TOTAL_TASKS - 1,
      failed: 1,
    });
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SyntaxError' }),
      expect.objectContaining({
        fingerprint: [
          'gexbot-fetch-failure',
          'fetch-gexbot-strikes',
          'SyntaxError',
        ],
      }),
    );
  });

  it('returns 500 and reports to Sentry when the capture INSERT rejects', async () => {
    stubFetchHappyPath();
    mockSql.mockRejectedValueOnce(new Error('neon: connection terminated'));
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'neon: connection terminated' }),
    );
  });
});
