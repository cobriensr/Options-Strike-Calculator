// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryCapture: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

import handler from '../cron/fetch-gexbot-strikes.js';
import { GEXBOT_TICKERS, STATE_CATEGORIES } from '../_lib/gexbot-client.js';

const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/state/gamma_zero')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'upstream gone',
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
});
