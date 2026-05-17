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

import handler from '../cron/fetch-gexbot-fast.js';
import { GEXBOT_TICKERS, MAXCHANGE_CATEGORIES } from '../_lib/gexbot-client.js';

// Fixed "market hours" date: Tuesday 10:00 AM ET (14:00 UTC during DST)
const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');
// Fixed weekend date: Saturday
const WEEKEND_TIME = new Date('2026-03-28T14:00:00.000Z');

const TOTAL_TASKS = GEXBOT_TICKERS.length * (1 + MAXCHANGE_CATEGORIES.length); // 48

function makeOrderflowBody(ticker: string) {
  return {
    timestamp: 1_700_000_000,
    ticker,
    spot: 100.5,
    zero_gamma: 99.0,
    z_mlgamma: 102,
    z_msgamma: 98,
    zcvr: 1.25,
    zgr: 0.83,
    dexoflow: 1234.5,
    gexoflow: 567.8,
    cvroflow: 0.12,
    sum_gex_oi: 1_000_000,
    delta_risk_reversal: 0.05,
    min_dte: 0,
    sec_min_dte: 1,
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

/**
 * Stub fetch to return per-URL bodies. Each (ticker, endpoint) pair
 * gets the appropriate shape so happy-path inserts pick up both
 * snapshot and capture rows.
 */
function stubFetchHappyPath() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      const ticker =
        url.split('/').find((seg) => GEXBOT_TICKERS.includes(seg as never)) ??
        'SPX';
      const body = url.includes('/orderflow/orderflow')
        ? makeOrderflowBody(ticker)
        : makeMaxchangeBody(ticker);
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
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

  it('stores 16 orderflow snapshots + 32 maxchange captures', async () => {
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
      snapshots: GEXBOT_TICKERS.length,
      captures: GEXBOT_TICKERS.length * MAXCHANGE_CATEGORIES.length,
      failed: 0,
    });
    // 16 per-row snapshot INSERTs + 1 batched UNNEST captures INSERT = 17
    expect(mockSql).toHaveBeenCalledTimes(GEXBOT_TICKERS.length + 1);
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── Partial failure ───────────────────────────────────────

  it('continues on per-ticker fetch failures and reports partial', async () => {
    // Fetch fails for SPX/orderflow only; everyone else succeeds
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/SPX/orderflow/orderflow')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'upstream gone',
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
      rows: TOTAL_TASKS - 1,
      failed: 1,
    });
    // One Sentry capture for the SPX/orderflow 500
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
  });
});
