// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockUwFetch, mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: mockWithRetry,
}));

import handler from '../cron/reconcile-greek-flow-etf.js';

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-27' };

function makeTick(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-04-27T14:32:00Z',
    ticker: 'SPY',
    total_delta_flow: '5000000',
    dir_delta_flow: '-3000000',
    total_vega_flow: '200000',
    dir_vega_flow: '-100000',
    otm_total_delta_flow: '3000000',
    otm_dir_delta_flow: '-1500000',
    otm_total_vega_flow: '150000',
    otm_dir_vega_flow: '-75000',
    transactions: 4500,
    volume: 120000,
    ...overrides,
  };
}

// Live UW field is `expires` (OpenAPI spec says `expiry` — wrong).
const NON_EXPIRY_BREAKDOWN = [
  { expires: '2026-04-29', chains: 100, open_interest: 1000, volume: 5000 },
];
const EXPIRY_TODAY_BREAKDOWN = [
  { expires: '2026-04-27', chains: 200, open_interest: 5000, volume: 80000 },
];

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

function setupMocks(opts: {
  spyAll?: ReturnType<typeof makeTick>[];
  qqqAll?: ReturnType<typeof makeTick>[];
  spyBreakdown?: typeof NON_EXPIRY_BREAKDOWN;
  qqqBreakdown?: typeof NON_EXPIRY_BREAKDOWN;
  spyExpiry?: ReturnType<typeof makeTick>[];
  qqqExpiry?: ReturnType<typeof makeTick>[];
}) {
  mockUwFetch
    .mockResolvedValueOnce(opts.spyAll ?? [makeTick({ ticker: 'SPY' })])
    .mockResolvedValueOnce(opts.qqqAll ?? [makeTick({ ticker: 'QQQ' })])
    .mockResolvedValueOnce(opts.spyBreakdown ?? NON_EXPIRY_BREAKDOWN)
    .mockResolvedValueOnce(opts.qqqBreakdown ?? NON_EXPIRY_BREAKDOWN);
  if (opts.spyExpiry) mockUwFetch.mockResolvedValueOnce(opts.spyExpiry);
  if (opts.qqqExpiry) mockUwFetch.mockResolvedValueOnce(opts.qqqExpiry);
}

describe('reconcile-greek-flow-etf handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    mockSql.mockResolvedValue([{ was_insert: false }]);
  });

  it('passes marketHours: false to cronGuard so it can run after close', async () => {
    setupMocks({});
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    const guardOpts = mockCronGuard.mock.calls[0]?.[2];
    expect(guardOpts).toMatchObject({ marketHours: false });
  });

  it('exits early when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('non-expiry day: fetches all-DTE + expiry-breakdown, skips per-expiry', async () => {
    setupMocks({
      spyAll: [makeTick({ ticker: 'SPY' })],
      qqqAll: [makeTick({ ticker: 'QQQ' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockUwFetch).toHaveBeenCalledTimes(4);
    expect(res._json).toMatchObject({
      job: 'reconcile-greek-flow-etf',
      date: '2026-04-27',
      tickers: {
        SPY: {
          all: { ticks: 1, inserted: 0, updated: 1, failed: 0 },
          expiry: null,
        },
        QQQ: {
          all: { ticks: 1, inserted: 0, updated: 1, failed: 0 },
          expiry: null,
        },
      },
    });
  });

  it('expiry day: also reconciles per-expiry rows for both tickers', async () => {
    setupMocks({
      spyAll: [makeTick({ ticker: 'SPY' })],
      qqqAll: [makeTick({ ticker: 'QQQ' })],
      spyBreakdown: EXPIRY_TODAY_BREAKDOWN,
      qqqBreakdown: EXPIRY_TODAY_BREAKDOWN,
      spyExpiry: [makeTick({ ticker: 'SPY' })],
      qqqExpiry: [makeTick({ ticker: 'QQQ' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockUwFetch).toHaveBeenCalledTimes(6);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: {
          all: { ticks: 1 },
          expiry: { ticks: 1, updated: 1 },
        },
        QQQ: {
          all: { ticks: 1 },
          expiry: { ticks: 1, updated: 1 },
        },
      },
    });
  });

  it('counts new rows as inserted when no prior data exists', async () => {
    mockSql.mockResolvedValue([{ was_insert: true }]);
    setupMocks({});

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      tickers: {
        SPY: { all: { inserted: 1, updated: 0, failed: 0 } },
        QQQ: { all: { inserted: 1, updated: 0, failed: 0 } },
      },
    });
  });

  it('counts upsert error as failed; handler still returns 200', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB upsert failed'));
    setupMocks({
      spyAll: [makeTick({ ticker: 'SPY' })],
      qqqAll: [],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { all: { inserted: 0, updated: 0, failed: 1 } },
        QQQ: { all: { inserted: 0, updated: 0, failed: 0 } },
      },
    });
  });
});
