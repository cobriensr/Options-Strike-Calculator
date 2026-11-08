// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

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
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
    uwRateLimit: vi.fn(),
    uwBudget: vi.fn(),
  },
}));

import handler from '../cron/fetch-spot-gex.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// EDT (UTC-4): the last second before, and the first second of, 09:40 ET.
const BEFORE_0940_ET = new Date('2026-03-24T13:39:59.000Z');
const AT_0940_ET = new Date('2026-03-24T13:40:00.000Z');
// Fixed "outside hours" date: Tuesday 6:00 AM ET
const OFF_HOURS_TIME = new Date('2026-03-24T11:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

function makeSpotRow(overrides: Partial<Record<string, string>> = {}) {
  return {
    time: '2026-03-24T14:00:00.000Z',
    start_time: '2026-03-24T14:00:00.000Z',
    price: '5750.25',
    gamma_per_one_percent_move_oi: '1000000',
    gamma_per_one_percent_move_vol: '500000',
    gamma_per_one_percent_move_dir: '300000',
    charm_per_one_percent_move_oi: '200000',
    charm_per_one_percent_move_vol: '100000',
    charm_per_one_percent_move_dir: '80000',
    vanna_per_one_percent_move_oi: '50000',
    vanna_per_one_percent_move_vol: '25000',
    vanna_per_one_percent_move_dir: '15000',
    ...overrides,
  };
}

const ZERO_VALUES = {
  gamma_per_one_percent_move_oi: '0',
  gamma_per_one_percent_move_vol: '0.00',
  gamma_per_one_percent_move_dir: '-0',
  charm_per_one_percent_move_oi: '0',
  charm_per_one_percent_move_vol: '0',
  charm_per_one_percent_move_dir: '0',
  vanna_per_one_percent_move_oi: '0',
  vanna_per_one_percent_move_vol: '0',
  vanna_per_one_percent_move_dir: '0',
};

/** A minute row at `hhmm` UTC on 2026-03-24 (EDT: 13:30Z is 09:30 ET). */
const minute = (
  hhmm: string,
  overrides: Partial<Record<string, string>> = {},
) =>
  makeSpotRow({
    start_time: `2026-03-24T${hhmm}:00.000Z`,
    time: `2026-03-24T${hhmm}:00.000Z`,
    ...overrides,
  });

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function stubFetch(data: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data }),
    }),
  );
}

describe('fetch-spot-gex handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: return a row satisfying data-quality SELECT shapes
    mockSql.mockResolvedValue([{ total: 0, nonzero: 0 }]);
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
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is set and header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    stubFetch();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours guard ────────────────────────────────────

  it('skips when outside market hours (early morning)', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('stores latest spot exposure and returns 200', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeSpotRow()]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 1,
      stored: 1,
      timestamp: expect.any(String),
    });
    // 1 HWM SELECT + 1 INSERT + 1 data-quality SELECT = 3
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('bulk-inserts all rows newer than the DB high-water-mark', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // Four distinct 1-minute ticks; HWM mock returns null (first run)
    // so every row should be inserted.
    stubFetch([
      makeSpotRow({ start_time: '2026-03-24T14:00:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:01:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:04:00.000Z' }),
      makeSpotRow({ start_time: '2026-03-24T14:05:00.000Z', price: '5760.00' }),
    ]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 4,
      stored: 4,
    });
    // 1 HWM SELECT + 4 INSERTs + 1 data-quality SELECT = 6
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('returns stored 0 for empty API response', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticks: 0,
      stored: 0,
    });
    // No INSERTs, no HWM query (short-circuits on empty), 1 data-quality SELECT
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('uses time field when start_time is absent', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const row = makeSpotRow();
    delete (row as Record<string, unknown>).start_time;
    stubFetch([row]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
    // 1 HWM SELECT + 1 INSERT + 1 data-quality = 3
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 when API returns error status', async () => {
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

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when API returns 429', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when fetch throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when DB insert throws', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeSpotRow()]);
    const dbError = new Error('DB connection lost');
    mockSql.mockRejectedValue(dbError);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  it('returns 500 with the parse error captured when UW answers 2xx but the body is not JSON', async () => {
    process.env.UW_API_KEY = 'uwkey';
    const parseError = new SyntaxError('Unexpected token < in JSON');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(parseError),
      }),
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(parseError);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── R-zero (F14): all-zero rows are not stored ─────────────

  it('does not store an all-zero newest row, warns, counts the metric and reports skipped', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(BEFORE_0940_ET);
    stubFetch([minute('13:31', ZERO_VALUES)]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      ticks: 1,
      stored: 0,
      zeroSkipped: 1,
    });
    expect(res._json).not.toMatchObject({ status: 'success' });
    // 1 HWM SELECT + 1 data-quality SELECT: no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        zeroSkipped: 1,
        zeroFrom: '2026-03-24T13:31:00.000Z',
        newestIsZero: true,
      }),
      expect.stringContaining('all-zero'),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spot_gex.zero_row_skip',
    );
    // Before 09:40 ET (the rollover): quiet in Sentry.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('sends a Sentry error from 09:40 ET when the newest row is all-zero', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(AT_0940_ET);
    stubFetch([minute('13:39', ZERO_VALUES)]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'skipped', stored: 0 });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('newest UW spot-exposure row'),
      'error',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spot_gex.zero_row_skip',
    );
  });

  it('treats null, blank and missing columns as zero', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      minute('13:31', {
        ...ZERO_VALUES,
        gamma_per_one_percent_move_oi: null as unknown as string,
        gamma_per_one_percent_move_vol: '',
        charm_per_one_percent_move_oi: undefined,
      }),
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'skipped', zeroSkipped: 1 });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('stores a row with a single non-zero value column', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([
      minute('13:31', { ...ZERO_VALUES, vanna_per_one_percent_move_dir: '1' }),
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'success', stored: 1 });
    expect(res._json).not.toMatchObject({ zeroSkipped: 1 });
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('stores the real rows around an all-zero opening minute and stays quiet in Sentry', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(AT_0940_ET);
    // 09:30 and 09:31 ET are zero (the rollover); 09:32 and 09:33 are real.
    stubFetch([
      minute('13:30', ZERO_VALUES),
      minute('13:31', ZERO_VALUES),
      minute('13:32'),
      minute('13:33'),
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    // The newest row is real, so after 09:40 there is no Sentry error, but
    // the two zero rows are still counted and warned.
    expect(res._json).toMatchObject({
      status: 'success',
      ticks: 4,
      stored: 2,
      zeroSkipped: 2,
      timestamp: '2026-03-24T13:33:00.000Z',
    });
    // 1 HWM SELECT + 2 INSERTs + 1 data-quality SELECT = 4
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spot_gex.zero_row_skip',
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('leaves a gap: a skipped minute is not re-read once a later row is stored', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // The mark is already at 09:33 (the earlier run stored it). UW now sends
    // 09:31 with real values, but it is at or behind the mark.
    mockSql.mockResolvedValueOnce([{ max_ts: '2026-03-24T13:33:00.000Z' }]);
    stubFetch([minute('13:31'), minute('13:33')]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ stored: 0 });
    // HWM SELECT + data-quality SELECT only.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('picks a minute up on a later run while no later row has been stored', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // 09:31 was all-zero, so nothing was stored and the mark stayed at 09:29.
    // On this run UW has filled 09:31's values in.
    mockSql.mockResolvedValueOnce([{ max_ts: '2026-03-24T13:29:00.000Z' }]);
    stubFetch([minute('13:31')]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'success', stored: 1 });
  });
});
