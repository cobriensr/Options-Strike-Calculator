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

import handler from '../cron/fetch-gexbot-fast.js';
import {
  GEXBOT_TICKERS,
  MAXCHANGE_CATEGORIES,
  STATE_MAXCHANGE_CATEGORIES,
} from '../_lib/gexbot-client.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET (14:00 UTC during DST)
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');
// 15:55 ET (EDT) — last minutes before the 16:00 ET cash close.
const PRE_CLOSE_TIME = new Date('2026-03-24T19:55:00.000Z');
// 16:30 ET (EDT) — GexBot's snapshot is frozen at the close by now.
const POST_CLOSE_TIME = new Date('2026-03-24T20:30:00.000Z');

const CLASSIC_BASIC_COUNT = GEXBOT_TICKERS.length;
const CLASSIC_MAXCHANGE_COUNT =
  GEXBOT_TICKERS.length * MAXCHANGE_CATEGORIES.length;
const STATE_MAXCHANGE_COUNT =
  GEXBOT_TICKERS.length * STATE_MAXCHANGE_CATEGORIES.length;
const CAPTURE_COUNT = CLASSIC_MAXCHANGE_COUNT + STATE_MAXCHANGE_COUNT;
// Stored DB rows = orderflow snapshots + captures. The classic-basic calls
// enrich the snapshot rows (merged in) rather than creating rows of their own.
const STORED_ROWS = GEXBOT_TICKERS.length + CAPTURE_COUNT;
// Total outbound HTTP calls per tick (includes the 16 classic-basic merges).
const FETCH_TASKS = STORED_ROWS + CLASSIC_BASIC_COUNT;

// Distinctive classic-basic zero_gamma so the merge test can assert the value
// flows from the classic call (and is NOT sourced from orderflow).
const CLASSIC_ZERO_GAMMA = 4242;

// Realistic orderflow body — the LIVE payload omits zero_gamma / sum_gex_* /
// major_* / delta_risk_reversal / min_dte / sec_min_dte (spec-vs-live drift).
function makeOrderflowBody(ticker: string) {
  return {
    timestamp: 1_700_000_000,
    ticker,
    spot: 100.5,
    z_mlgamma: 102,
    z_msgamma: 98,
    zcvr: 1.25,
    zgr: 0.83,
    dexoflow: 1234.5,
    gexoflow: 567.8,
    cvroflow: 0.12,
  };
}

// classic gex_zero basic_response — the live source of the 10 aggregate fields.
function makeClassicBasicBody(ticker: string) {
  return {
    timestamp: 1_700_000_000,
    ticker,
    spot: 100.5,
    zero_gamma: CLASSIC_ZERO_GAMMA,
    sum_gex_vol: 111,
    sum_gex_oi: 222,
    major_pos_vol: 1,
    major_pos_oi: 2,
    major_neg_vol: 3,
    major_neg_oi: 4,
    delta_risk_reversal: 0.05,
    min_dte: 0,
    sec_min_dte: 1,
    strikes: [[100, 50]],
  };
}

function makeMaxchangeBody(ticker: string) {
  return {
    timestamp: 1_700_000_000,
    ticker,
    spot: 100.5,
    current: [100, 50],
    one: [100, 40],
    five: [101, 100],
  };
}

// /SPX/classic/gex_zero (basic) — but NOT /SPX/classic/gex_zero/maxchange.
const CLASSIC_BASIC_RE = /\/classic\/(gex_zero|gex_one|gex_full)$/;

/**
 * Stub fetch to return per-URL bodies. Each (ticker, endpoint) pair
 * gets the appropriate shape so happy-path inserts pick up both
 * snapshot and capture rows, and the classic-basic merge has real fields.
 */
function happyResponse(url: string): Response {
  const ticker =
    url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
    'SPX';
  let body: Record<string, unknown>;
  if (url.includes('/orderflow/orderflow')) {
    body = makeOrderflowBody(ticker);
  } else if (CLASSIC_BASIC_RE.test(url)) {
    body = makeClassicBasicBody(ticker);
  } else {
    body = makeMaxchangeBody(ticker);
  }
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetchHappyPath() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => happyResponse(String(input))),
  );
}

describe('fetch-gexbot-fast handler', () => {
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

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

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

  // ── Missing API key ───────────────────────────────────────

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

  // ── Happy path ────────────────────────────────────────────

  it('stores orderflow snapshots + classic-maxchange + state-maxchange captures', async () => {
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
      rows: STORED_ROWS,
      snapshots: GEXBOT_TICKERS.length,
      captures: CAPTURE_COUNT,
      enriched: GEXBOT_TICKERS.length,
      failed: 0,
    });
    // GEXBOT_TICKERS.length per-row snapshot INSERTs + 1 batched UNNEST
    // captures INSERT. The classic-basic calls add no INSERTs (merged into
    // the snapshot rows). Stays correct when the ticker list grows.
    expect(mockSql).toHaveBeenCalledTimes(GEXBOT_TICKERS.length + 1);
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── Classic-basic merge ───────────────────────────────────

  it('merges classic gex_zero aggregate fields into the orderflow snapshot row', async () => {
    // The 10 fields orderflow omits (zero_gamma, sum_gex_*, major_*,
    // delta_risk_reversal, min_dte/sec_min_dte) must be sourced from the
    // classic gex_zero basic call and land in the same snapshot INSERT.
    stubFetchHappyPath();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    await handler(req, mockResponse());

    // Snapshot INSERTs are tagged-template calls; arg[1] is the ticker and
    // the VALUES order is (ticker, source_timestamp, spot, zero_gamma, …),
    // so zero_gamma is arg[4]. Find SPX's snapshot insert.
    const spxSnapshot = mockSql.mock.calls.find((c) => c[1] === 'SPX');
    expect(spxSnapshot).toBeDefined();
    expect(spxSnapshot?.[4]).toBe(CLASSIC_ZERO_GAMMA);
  });

  it('fails open: classic-basic failure for a ticker still stores its snapshot with NULL aggregates', async () => {
    // SPX/classic/gex_zero fails (400, non-retryable), but SPX/orderflow
    // succeeds. The SPX snapshot must still be stored — with zero_gamma NULL
    // (orderflow omits it) — and `enriched` must drop to 15, not 16.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/classic/gex_zero')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'bad request',
          } as Response;
        }
        const ticker =
          url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
          'SPX';
        let body: Record<string, unknown>;
        if (url.includes('/orderflow/orderflow')) {
          body = makeOrderflowBody(ticker);
        } else if (CLASSIC_BASIC_RE.test(url)) {
          body = makeClassicBasicBody(ticker);
        } else {
          body = makeMaxchangeBody(ticker);
        }
        return { ok: true, status: 200, json: async () => body } as Response;
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
      snapshots: GEXBOT_TICKERS.length, // orderflow still succeeded for all 16
      enriched: GEXBOT_TICKERS.length - 1, // SPX classic missing
      failed: 1,
    });
    // SPX snapshot stored, but zero_gamma is NULL (orderflow omits it and the
    // classic merge never happened for SPX).
    const spxSnapshot = mockSql.mock.calls.find((c) => c[1] === 'SPX');
    expect(spxSnapshot).toBeDefined();
    expect(spxSnapshot?.[4]).toBeNull();
  });

  // ── Partial failure ───────────────────────────────────────

  it('continues on per-ticker fetch failures and reports partial', async () => {
    // Fetch fails for SPX/orderflow only; everyone else succeeds.
    // Uses 400 (non-retryable) so withRetry exits on the first attempt —
    // 5xx would trigger backoff and stall under fake timers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/orderflow/orderflow')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'bad request',
          } as Response;
        }
        const ticker =
          url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
          'SPX';
        const body = url.includes('/orderflow/orderflow')
          ? makeOrderflowBody(ticker)
          : makeMaxchangeBody(ticker);
        return { ok: true, status: 200, json: async () => body } as Response;
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
      rows: STORED_ROWS - 1,
      failed: 1,
    });
    // One Sentry capture for the SPX/orderflow 500
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
  });

  it('hits all 3 endpoint families in a single tick', async () => {
    // Verifies fetch is called with at least one URL from each of:
    //   /orderflow/orderflow
    //   /classic/{gex_zero|gex_one|gex_full}/maxchange
    //   /state/{gex_zero|gex_one|gex_full}/maxchange
    // Regression guard for the wave-3c expansion where state-maxchange
    // routes were added and could be silently dropped.
    stubFetchHappyPath();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    await handler(req, mockResponse());

    const urls = (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => String(c[0]));

    const hasOrderflow = urls.some((u) => u.includes('/orderflow/orderflow'));
    const hasClassicBasic = urls.some((u) => CLASSIC_BASIC_RE.test(u));
    const hasClassicMax = urls.some((u) =>
      /\/classic\/(gex_zero|gex_one|gex_full)\/maxchange/.test(u),
    );
    const hasStateMax = urls.some((u) =>
      /\/state\/(gex_zero|gex_one|gex_full)\/maxchange/.test(u),
    );
    expect(hasOrderflow).toBe(true);
    expect(hasClassicBasic).toBe(true);
    expect(hasClassicMax).toBe(true);
    expect(hasStateMax).toBe(true);
    // 16 orderflow + 16 classic-basic + 48 classic-max + 48 state-max = 128
    expect(urls).toHaveLength(FETCH_TASKS);
  });

  it('tags Sentry with full per-failure context (ticker + endpoint + category)', async () => {
    // When SPX/state/gex_zero/maxchange fails, the captured Sentry
    // event must carry tags identifying which ticker + endpoint +
    // category exploded — needed for "is this a GEXBot-wide outage or
    // a single-symbol issue" triage during the trial. Uses 401
    // (non-retryable, auth class) so withRetry exits on first attempt.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/state/gex_zero/maxchange')) {
          return {
            ok: false,
            status: 401,
            text: async () => 'unauthorized',
          } as Response;
        }
        const ticker =
          url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
          'SPX';
        const body = url.includes('/orderflow/orderflow')
          ? makeOrderflowBody(ticker)
          : makeMaxchangeBody(ticker);
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    await handler(req, mockResponse());

    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    const opts = mockSentryCapture.mock.calls[0]?.[1] as {
      tags: Record<string, string>;
    };
    expect(opts.tags['gexbot.cron']).toBe('fast');
    expect(opts.tags['gexbot.ticker']).toBe('SPX');
    expect(opts.tags['gexbot.endpoint']).toBe('state-maxchange');
    expect(opts.tags['gexbot.category']).toBe('gex_zero');
  });

  // ── Retry on transient 5xx ────────────────────────────────

  it('retries on transient 503 and reports success without Sentry capture', async () => {
    // SPX/orderflow returns 503 on the first call, succeeds on the
    // retry. Validates the `withRetry` wrap suppresses single-fault
    // transient GEXBot timeouts (SENTRY-EMERALD-DESERT-8F regression).
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);

    const callsByPath = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        const path = new URL(url).pathname;
        const calls = (callsByPath.get(path) ?? 0) + 1;
        callsByPath.set(path, calls);
        if (path === '/v2/SPX/orderflow/orderflow' && calls === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => 'transient',
          } as Response;
        }
        const ticker =
          url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
          'SPX';
        const body = url.includes('/orderflow/orderflow')
          ? makeOrderflowBody(ticker)
          : makeMaxchangeBody(ticker);
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const pending = handler(req, res);
    // withRetry's first-attempt backoff is 1000 × (0 + 1) = 1000ms;
    // advance past it so the retry fires.
    await vi.advanceTimersByTimeAsync(1500);
    await pending;

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', failed: 0 });
    expect(mockSentryCapture).not.toHaveBeenCalled();
    expect(callsByPath.get('/v2/SPX/orderflow/orderflow')).toBe(2);
  });

  // ── Sentry grouping + failure modes ───────────────────────

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
        if (url.endsWith('/SPX/orderflow/orderflow')) {
          timeoutCalls += 1;
          throw new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          );
        }
        return happyResponse(url);
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
          'fetch-gexbot-fast',
          'TimeoutError',
        ],
        tags: expect.objectContaining({
          'gexbot.cron': 'fast',
          'gexbot.ticker': 'SPX',
          'gexbot.endpoint': 'orderflow',
        }),
      }),
    );
  });

  it('captures a malformed 2xx body (res.json() rejects) as a fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/QQQ/classic/gex_one/maxchange')) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON');
            },
          } as unknown as Response;
        }
        return happyResponse(url);
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
      rows: STORED_ROWS - 1,
      failed: 1,
    });
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SyntaxError' }),
      expect.objectContaining({
        fingerprint: [
          'gexbot-fetch-failure',
          'fetch-gexbot-fast',
          'SyntaxError',
        ],
      }),
    );
  });

  it('caps Sentry exceptions at 10 and emits one fingerprinted summary during a full outage', async () => {
    // 400 (non-retryable) so withRetry exits on the first attempt.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            text: async () => 'bad request',
          }) as Response,
      ),
    );
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ rows: 0, failed: FETCH_TASKS });
    expect(mockSentryCapture).toHaveBeenCalledTimes(10);
    expect(mockSentryMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryMessage).toHaveBeenCalledWith(
      `fetch-gexbot-fast: ${FETCH_TASKS - 10} additional failures suppressed (cap=10)`,
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['gexbot-failures-suppressed', 'fetch-gexbot-fast'],
      }),
    );
  });

  it('returns 500 and reports to Sentry when the snapshot INSERT rejects', async () => {
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
