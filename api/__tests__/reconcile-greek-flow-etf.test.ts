// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

describe('reconcile-greek-flow-etf handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockUwFetch.mockResolvedValue([makeTick()]);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    mockSql.mockResolvedValue([{ was_insert: false }]);
  });

  it('passes marketHours: false to cronGuard so it can run after close', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    // Check the third arg (guard options) on the cronGuard mock
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

  it('fetches both tickers via /stock/{T}/greek-flow and reports updated counts', async () => {
    // Both tickers return one tick each that already exists in DB ⇒ updated
    mockUwFetch
      .mockResolvedValueOnce([makeTick({ ticker: 'SPY' })])
      .mockResolvedValueOnce([makeTick({ ticker: 'QQQ' })]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'reconcile-greek-flow-etf',
      date: '2026-04-27',
      tickers: {
        SPY: { ticks: 1, inserted: 0, updated: 1, failed: 0 },
        QQQ: { ticks: 1, inserted: 0, updated: 1, failed: 0 },
      },
    });

    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(urls.some((u) => u.includes('/stock/SPY/greek-flow'))).toBe(true);
    expect(urls.some((u) => u.includes('/stock/QQQ/greek-flow'))).toBe(true);
  });

  it('counts new rows as inserted when no prior data exists', async () => {
    mockSql.mockResolvedValue([{ was_insert: true }]);
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      tickers: {
        SPY: { inserted: 1, updated: 0, failed: 0 },
        QQQ: { inserted: 1, updated: 0, failed: 0 },
      },
    });
  });

  it('counts upsert error as failed; handler still returns 200', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB upsert failed'));
    mockUwFetch
      .mockResolvedValueOnce([makeTick({ ticker: 'SPY' })])
      .mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { inserted: 0, updated: 0, failed: 1 },
        QQQ: { inserted: 0, updated: 0, failed: 0 },
      },
    });
  });
});
