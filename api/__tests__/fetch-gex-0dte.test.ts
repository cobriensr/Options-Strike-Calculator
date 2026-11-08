// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockQuery = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
  query: typeof mockQuery;
};
mockSql.transaction = mockTransaction;
mockSql.query = mockQuery;

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

// Phase 4A: mock the feature helper so cron tests exercise only the
// raw snapshot path by default. Specific tests override these mocks to
// cover the feature-write branches.
const mockLoadSnapshotHistory = vi.fn();
const mockWriteFeatureRows = vi.fn();
vi.mock('../_lib/gex-target-features.js', () => ({
  loadSnapshotHistory: (...args: unknown[]) => mockLoadSnapshotHistory(...args),
  writeFeatureRows: (...args: unknown[]) => mockWriteFeatureRows(...args),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    schwabCall: vi.fn(() => () => {}),
    tokenRefresh: vi.fn(),
    rateLimited: vi.fn(),
    uwRateLimit: vi.fn(),
    increment: vi.fn(),
  },
}));

import handler from '../cron/fetch-gex-0dte.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');

function makeStrikeRow(overrides = {}) {
  return {
    strike: '5800',
    price: '5800.5',
    time: '2026-03-24T14:30:00Z',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    call_gamma_vol: '100000',
    put_gamma_vol: '-50000',
    call_gamma_ask: '200000',
    call_gamma_bid: '150000',
    put_gamma_ask: '-100000',
    put_gamma_bid: '-80000',
    call_charm_oi: '50000',
    put_charm_oi: '-40000',
    call_charm_vol: '25000',
    put_charm_vol: '-20000',
    call_delta_oi: '100000',
    put_delta_oi: '-75000',
    call_vanna_oi: '25000',
    put_vanna_oi: '-15000',
    call_vanna_vol: '12000',
    put_vanna_vol: '-8000',
    ...overrides,
  };
}

/** One /spot-exposures minute row: the live SPX spot. */
function makeSpotRow(overrides = {}) {
  return { price: '5800.5', time: '2026-03-24T14:29:00Z', ...overrides };
}

const uwOk = (data: unknown[]) => ({ ok: true, json: async () => ({ data }) });
const uwError = (status: number) => ({
  ok: false,
  status,
  text: async () => 'upstream error',
});

type Answer = unknown[] | ReturnType<typeof uwError>;

/**
 * Route the global fetch by UW path: `data` answers
 * /spot-exposures/expiry-strike, `spot` answers /spot-exposures (default:
 * one live row at 5800.5). Either may be a ready-made error response.
 */
function stubFetch(
  data: Answer = [],
  spot: Answer = [makeSpotRow()],
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    const answer = url.pathname.endsWith('/spot-exposures/expiry-strike')
      ? data
      : url.pathname.endsWith('/spot-exposures')
        ? spot
        : undefined;
    if (answer === undefined) throw new Error(`unexpected UW url ${input}`);
    return Array.isArray(answer) ? uwOk(answer) : answer;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls as unknown[][]).map((c) => new URL(String(c[0])));

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('fetch-gex-0dte handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default tagged-template response covers the post-insert data-quality
    // SELECT (handler lines ~181-198) which reads { total, nonzero }.
    mockSql.mockResolvedValue([{ total: 0, nonzero: 0 }]);
    mockSql.transaction = mockTransaction;
    mockSql.query = mockQuery;
    // Default: every submitted row gets an id back (all inserted, no conflicts)
    mockQuery.mockImplementation(
      async (_text: string, params: unknown[] = []) => {
        const COLUMNS_PER_ROW = 22;
        const rowCount = Math.floor(params.length / COLUMNS_PER_ROW);
        return Array.from({ length: rowCount }, (_v, i) => ({ id: i + 1 }));
      },
    );
    // Default: no snapshot history → feature helper is a no-op. Specific
    // tests override these to drive the write path.
    mockLoadSnapshotHistory.mockResolvedValue([]);
    mockWriteFeatureRows.mockResolvedValue({
      written: 0,
      skipped: 0,
      modes: {
        oi: { written: 0, skipped: 0 },
        vol: { written: 0, skipped: 0 },
        dir: { written: 0, skipped: 0 },
      },
    });
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches 0DTE strikes, stores, and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-gex-0dte',
      success: true,
      price: 5800.5,
      stored: 1,
      skipped: 0,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('counts skipped duplicates correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Simulate ON CONFLICT DO NOTHING hitting every row: RETURNING id yields []
    mockQuery.mockResolvedValueOnce([]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  it('filters out strikes beyond ±200 pts from ATM', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const nearStrike = makeStrikeRow({
      strike: '5800',
      price: '5800.5',
    });
    const farStrike = makeStrikeRow({
      strike: '6100',
      price: '5800.5',
    });
    stubFetch([nearStrike, farStrike]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Only near strike stored — 6100 is >200 pts away
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
  });

  // ── UW stale-cache workaround (2026-04-23) ────────────────

  it('reads the spot from the per-minute series and bounds the main call with min_strike/max_strike', async () => {
    // UW's /spot-exposures/expiry-strike serves stale cached data unless
    // the request carries a narrow strike window. The cron reads the spot
    // from /spot-exposures first, then passes ±ATM_RANGE around it as
    // min_strike/max_strike on the main call to hit UW's live path.
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // Two fetches: spot, then the main call for expiry-strike
    const [spotUrl, mainUrl] = callUrls(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spotUrl!.pathname).toBe('/api/stock/SPX/spot-exposures');
    expect(mainUrl!.pathname).toBe(
      '/api/stock/SPX/spot-exposures/expiry-strike',
    );
    // spot=5800.5, ATM_RANGE=200 → min=floor(5600.5)=5600, max=ceil(6000.5)=6001
    expect(mainUrl!.searchParams.get('min_strike')).toBe('5600');
    expect(mainUrl!.searchParams.get('max_strike')).toBe('6001');
    expect(mainUrl!.searchParams.get('expirations[]')).toBe('2026-03-24');
  });

  // ── The spot is loud (it used to fail open into an unbounded request) ──

  it.each([
    ['no rows', [] as unknown[]],
    ['a NaN price', [makeSpotRow({ price: 'not-a-number' })]],
    ['a zero price', [makeSpotRow({ price: '0' })]],
  ])(
    'is an error run with a Sentry error and a metric, and asks for no strikes, when the spot has %s',
    async (_n, spot) => {
      process.env.UW_API_KEY = 'uwkey';
      const fetchMock = stubFetch([makeStrikeRow()], spot);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._json).toMatchObject({
        status: 'error',
        stored: false,
        reason: 'spot_null',
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no usable SPX spot'),
        'error',
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        'fetch_gex_0dte.spot_null',
      );
      // No unbounded fallback: the strike endpoint is never called.
      expect(callUrls(fetchMock).map((u) => u.pathname)).toEqual([
        '/api/stock/SPX/spot-exposures',
      ]);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it('is a 500 with the exception captured, and no strike request, when the spot request is rejected', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 422 is not retried.
    const fetchMock = stubFetch([makeStrikeRow()], uwError(422));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 422'),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── One rule for every ladder that is not stored (R4) ─────

  const YESTERDAY = '2026-03-23T19:55:00Z';
  const BEFORE_0940_ET = new Date('2026-03-24T13:39:59.000Z');
  const AT_0940_ET = new Date('2026-03-24T13:40:00.000Z');
  const ZERO_GAMMA = { call_gamma_oi: '0', put_gamma_oi: '0' };

  // Each kind, the UW answers that produce it, and the metric it counts.
  const SKIP_KINDS: Array<{
    kind: string;
    metric: string;
    strikes: unknown[];
    spot?: unknown[];
  }> = [
    {
      kind: 'stale',
      metric: 'stale_cache_skip',
      strikes: [makeStrikeRow({ time: YESTERDAY })],
    },
    {
      kind: 'stale_spot',
      metric: 'stale_spot_skip',
      strikes: [makeStrikeRow()],
      spot: [makeSpotRow({ time: YESTERDAY })],
    },
    {
      kind: 'all_zero',
      metric: 'zero_snapshot_skip',
      strikes: [makeStrikeRow(ZERO_GAMMA), makeStrikeRow(ZERO_GAMMA)],
    },
    { kind: 'empty', metric: 'empty_ladder_skip', strikes: [] },
    {
      kind: 'outside_window',
      metric: 'outside_window_skip',
      strikes: [makeStrikeRow({ strike: '4000' })],
    },
  ];

  it.each(SKIP_KINDS)(
    '$kind: stores nothing and reports skipped, never success, with a warning and the $metric metric',
    async ({ kind, metric, strikes, spot }) => {
      process.env.UW_API_KEY = 'uwkey';
      stubFetch(strikes, spot);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'skipped',
        stored: false,
        reason: kind,
      });
      expect(res._json).not.toMatchObject({ success: true });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockLoadSnapshotHistory).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind, ticker: 'SPX' }),
        expect.stringContaining('skipping store'),
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        `fetch_gex_0dte.${metric}`,
      );
    },
  );

  it.each(SKIP_KINDS)(
    '$kind: sends a Sentry error naming the kind from 09:40 ET',
    async ({ kind, strikes, spot }) => {
      process.env.UW_API_KEY = 'uwkey';
      vi.setSystemTime(AT_0940_ET);
      stubFetch(strikes, spot);

      await handler(authedReq(), mockResponse());

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining(`fetch-gex-0dte: ${kind} ladder for SPX`),
        'error',
      );
    },
  );

  it.each(SKIP_KINDS)(
    '$kind: stays quiet in Sentry before 09:40 ET (the rollover), still warns and counts',
    async ({ kind, metric, strikes, spot }) => {
      process.env.UW_API_KEY = 'uwkey';
      vi.setSystemTime(BEFORE_0940_ET);
      stubFetch(strikes, spot);

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._json).toMatchObject({ status: 'skipped', reason: kind });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      expect(metrics.increment).toHaveBeenCalledWith(
        `fetch_gex_0dte.${metric}`,
      );
    },
  );

  it('stale: names the data ET day and its time (the F5 replay)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The 09:28 ET poll gets Monday 03-23 15:55 ET.
    stubFetch([makeStrikeRow({ time: YESTERDAY })]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      status: 'skipped',
      reason: 'stale',
      dataEtDate: '2026-03-23',
      snapshotTime: '2026-03-23T19:55:00.000Z',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        dataEtDate: '2026-03-23',
        today: '2026-03-24',
      }),
      expect.stringContaining('stale UW cache'),
    );
  });

  it('stale_spot: asks for no ladder', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fetchMock = stubFetch(
      [makeStrikeRow()],
      [makeSpotRow({ time: YESTERDAY })],
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      reason: 'stale_spot',
      spotTime: YESTERDAY,
      dataEtDate: '2026-03-23',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('judges staleness on the ET day, not the CT day: a ladder stamped 00:30 ET today is today', async () => {
    // 2026-03-24 04:30Z = 00:30 EDT on the 24th = 23:30 CDT on the 23rd.
    // The old wall-clock CT-date check called it stale; the ET day (the day
    // the row is stored under) says it is today.
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow({ time: '2026-03-24T04:30:00Z' })]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ success: true, stored: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('keys the INSERT on the newest UW row time, not the run time', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeStrikeRow({ strike: '5800', time: '2026-03-24T14:21:00Z' }),
      makeStrikeRow({ strike: '5805', time: '2026-03-24T14:34:00Z' }),
    ]);

    await handler(authedReq(), mockResponse());

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // Both rows share the newest UW time (a snapshot has one timestamp), never
    // MARKET_TIME (14:00:00Z, the run time).
    expect(p[1]).toBe('2026-03-24T14:34:00.000Z');
    expect(p[22 + 1]).toBe('2026-03-24T14:34:00.000Z');
  });

  it('stores a ladder with at least one in-range strike carrying gamma', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      makeStrikeRow({ strike: '5795', ...ZERO_GAMMA }),
      makeStrikeRow({ strike: '5800' }),
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ success: true, stored: 2 });
  });

  it('is a 500 naming the payload when no strike row has a parseable time', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeStrikeRow({ time: 'garbage' })]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('parseable time'),
      }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['spot', 'strike'] as const)(
    'is a 500 with the parse error captured when UW answers 2xx but the %s body is not JSON',
    async (which) => {
      process.env.UW_API_KEY = 'uwkey';
      const parseError = new SyntaxError('Unexpected token < in JSON');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const isStrike = new URL(input).pathname.endsWith('/expiry-strike');
          if ((which === 'strike') === isStrike) {
            return { ok: true, json: () => Promise.reject(parseError) };
          }
          return uwOk(isStrike ? [makeStrikeRow()] : [makeSpotRow()]);
        }),
      );

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(500);
      expect(res._json).toMatchObject({ error: 'Internal error' });
      expect(Sentry.captureException).toHaveBeenCalledWith(parseError);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when UW API fails', async () => {
    // The mocked 500 is retried by withRetry (1 s + 2 s backoff). Fake
    // setTimeout so the retries don't burn wall time; Date is faked too so
    // the market-hours clock can be re-pinned on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(MARKET_TIME);
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const res = mockResponse();
    const run = handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('reports an error run, not success, when the strike INSERT fails (R4)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The production failure: 0DTE charm past the NUMERIC column cap.
    const overflow = Object.assign(new Error('numeric field overflow'), {
      code: '22003',
    });
    mockQuery.mockRejectedValueOnce(overflow);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    // Surfaced once, by the cron wrapper.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(overflow);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: overflow }),
      'fetch-gex-0dte error',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_gex_0dte.batch_insert_error',
    );
    // Deterministic, so withRetry does not repeat it; nothing runs after it.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockLoadSnapshotHistory).not.toHaveBeenCalled();
  });

  // ── Multi-row INSERT (BE-CRON-005) ────────────────────────

  it('issues a single multi-row INSERT for many strikes (no N+1)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Build 150 strikes in the ±200 window around price 5800.5
    const rows = Array.from({ length: 150 }, (_v, i) =>
      makeStrikeRow({ strike: String(5700 + i), price: '5800.5' }),
    );
    stubFetch(rows);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, stored: 150, skipped: 0 });
    // Exactly one INSERT call — not 150
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();

    // Params array length = rowCount * 22 columns
    const [text, params] = mockQuery.mock.calls[0]!;
    expect(typeof text).toBe('string');
    expect(text).toMatch(/INSERT INTO gex_strike_0dte/);
    expect(text).toMatch(/ON CONFLICT \(date, timestamp, strike\) DO NOTHING/);
    expect(Array.isArray(params)).toBe(true);
    expect((params as unknown[]).length).toBe(150 * 22);
    // Placeholder count matches params: ensure the final placeholder is $3300
    expect(text).toContain('$3300');
  });

  it('dedupes duplicate strikes in a single batch (last-write-wins)', async () => {
    // UW occasionally restates a strike across paging boundaries.
    // (date, timestamp, strike) collapses to `strike` within one INSERT
    // (date + timestamp are constants for the batch), so the upstream
    // duplicate must be removed before reaching Postgres — otherwise
    // ON CONFLICT raises cardinality_violation.
    process.env.UW_API_KEY = 'uwkey';
    const stale = makeStrikeRow({ strike: '5800', call_gamma_oi: '111' });
    const fresh = makeStrikeRow({ strike: '5800', call_gamma_oi: '999' });
    stubFetch([stale, fresh]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // 1 deduped row * 22 columns = 22 — NOT 44
    expect(p).toHaveLength(22);
    // Last-write-wins: the fresh row's call_gamma_oi (index 4) survives
    expect(p[4]).toBe('999');
    expect(res._json).toMatchObject({ success: true, stored: 1, skipped: 0 });
    // Observability: the dropped duplicate is surfaced (log + metric) so
    // a UW pagination regression doesn't silently absorb rows.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ duplicates: 1, kept: 1 }),
      'fetch-gex-0dte: dropped duplicate strikes pre-INSERT',
    );
  });

  it('does NOT issue an INSERT when every strike is outside the window, and is skipped, not a success', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // All strikes far outside ±200 window from ATM
    const rows = [
      makeStrikeRow({ strike: '6500', price: '5800.5' }),
      makeStrikeRow({ strike: '5000', price: '5800.5' }),
    ];
    stubFetch(rows);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      stored: false,
      reason: 'outside_window',
      rows: 2,
    });
    expect(res._json).not.toMatchObject({ success: true });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('pins column order: params match the documented 22-column layout', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeStrikeRow({ strike: '5800', price: '5800.5' });
    stubFetch([row]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // Column order must match the old one-row-at-a-time INSERT:
    // date, timestamp, strike, price,
    // call_gamma_oi, put_gamma_oi,
    // call_gamma_vol, put_gamma_vol,
    // call_gamma_ask, call_gamma_bid,
    // put_gamma_ask, put_gamma_bid,
    // call_charm_oi, put_charm_oi,
    // call_charm_vol, put_charm_vol,
    // call_delta_oi, put_delta_oi,
    // call_vanna_oi, put_vanna_oi,
    // call_vanna_vol, put_vanna_vol
    expect(p).toHaveLength(22);
    expect(p[0]).toBe('2026-03-24'); // today (from cronGuard on MARKET_TIME)
    expect(p[1]).toBe(new Date(row.time).toISOString()); // timestamp
    expect(p[2]).toBe(row.strike);
    expect(p[3]).toBe(row.price);
    expect(p[4]).toBe(row.call_gamma_oi);
    expect(p[5]).toBe(row.put_gamma_oi);
    expect(p[6]).toBe(row.call_gamma_vol);
    expect(p[7]).toBe(row.put_gamma_vol);
    expect(p[8]).toBe(row.call_gamma_ask);
    expect(p[9]).toBe(row.call_gamma_bid);
    expect(p[10]).toBe(row.put_gamma_ask);
    expect(p[11]).toBe(row.put_gamma_bid);
    expect(p[12]).toBe(row.call_charm_oi);
    expect(p[13]).toBe(row.put_charm_oi);
    expect(p[14]).toBe(row.call_charm_vol);
    expect(p[15]).toBe(row.put_charm_vol);
    expect(p[16]).toBe(row.call_delta_oi);
    expect(p[17]).toBe(row.put_delta_oi);
    expect(p[18]).toBe(row.call_vanna_oi);
    expect(p[19]).toBe(row.put_vanna_oi);
    expect(p[20]).toBe(row.call_vanna_vol);
    expect(p[21]).toBe(row.put_vanna_vol);
  });

  // ── Feature writes (Phase 4A) ─────────────────────────────

  it('loads snapshot history and writes features after a successful raw insert', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const fakeSnapshots = [
      { timestamp: '2026-03-24T14:29:00.000Z', price: 5800, strikes: [] },
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ];
    mockLoadSnapshotHistory.mockResolvedValueOnce(fakeSnapshots);
    mockWriteFeatureRows.mockResolvedValueOnce({
      written: 27,
      skipped: 3,
      modes: {
        oi: { written: 10, skipped: 0 },
        vol: { written: 9, skipped: 1 },
        dir: { written: 8, skipped: 2 },
      },
    });

    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Helper was invoked with (today, timestamp, FEATURE_HISTORY_SIZE)
    expect(mockLoadSnapshotHistory).toHaveBeenCalledTimes(1);
    const [loadDate, loadTs, loadSize] = mockLoadSnapshotHistory.mock.calls[0]!;
    expect(loadDate).toBe('2026-03-24');
    expect(loadTs).toBe('2026-03-24T14:30:00.000Z');
    expect(loadSize).toBe(61);

    expect(mockWriteFeatureRows).toHaveBeenCalledTimes(1);
    const [writeSnapshots, writeDate, writeTs] =
      mockWriteFeatureRows.mock.calls[0]!;
    expect(writeSnapshots).toBe(fakeSnapshots);
    expect(writeDate).toBe('2026-03-24');
    expect(writeTs).toBe('2026-03-24T14:30:00.000Z');

    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      features: {
        written: 27,
        skipped: 3,
        modes: {
          oi: { written: 10, skipped: 0 },
          vol: { written: 9, skipped: 1 },
          dir: { written: 8, skipped: 2 },
        },
      },
    });
  });

  it('skips writeFeatureRows when snapshot history is too short (<2)', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockLoadSnapshotHistory.mockResolvedValueOnce([
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(mockLoadSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(mockWriteFeatureRows).not.toHaveBeenCalled();
    // features left null when the helper wasn't called (short history)
    expect((res._json as { features: unknown }).features).toBeNull();
    // But the raw snapshot fields are still populated
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
    });
  });

  it('does NOT run feature helpers when the raw insert stored 0 rows', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // ON CONFLICT → every row dropped → stored = 0 → feature helpers skipped
    mockQuery.mockResolvedValueOnce([]);
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 0, skipped: 1 });
    expect(mockLoadSnapshotHistory).not.toHaveBeenCalled();
    expect(mockWriteFeatureRows).not.toHaveBeenCalled();
  });

  it('returns 200 with features.error when the feature helper throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    mockLoadSnapshotHistory.mockResolvedValueOnce([
      { timestamp: '2026-03-24T14:29:00.000Z', price: 5800, strikes: [] },
      { timestamp: '2026-03-24T14:30:00.000Z', price: 5800.5, strikes: [] },
    ]);
    mockWriteFeatureRows.mockRejectedValueOnce(new Error('scoring boom'));
    stubFetch([makeStrikeRow()]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );

    // Raw snapshot response fields must still be populated
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true,
      stored: 1,
      skipped: 0,
      features: { error: true },
    });

    // Sentry received the feature-phase tag
    expect(Sentry.setTag).toHaveBeenCalledWith('feature.phase', 'write');
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'fetch-gex-0dte: feature write threw unexpectedly',
    );
  });
});
