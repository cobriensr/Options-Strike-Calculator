// @vitest-environment node

/**
 * HTTP-level tests for GET /api/greek-flow.
 *
 * The metrics module is exercised by `greek-flow-metrics.test.ts`; this
 * file covers the request handler: method guard, owner gate, Zod
 * validation, empty-table path, and the happy path with two-ticker
 * window-function rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../greek-flow.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// Two-row session per ticker, with cumulative columns matching what the
// Postgres window function would emit.
function fakeSessionRows() {
  return [
    {
      ticker: 'QQQ',
      timestamp: '2026-04-28T13:30:00Z',
      transactions: 100,
      volume: 500,
      dir_vega_flow: '10',
      total_vega_flow: '20',
      otm_dir_vega_flow: '5',
      otm_total_vega_flow: '8',
      dir_delta_flow: '3',
      total_delta_flow: '7',
      otm_dir_delta_flow: '1',
      otm_total_delta_flow: '2',
      cum_dir_vega_flow: '10',
      cum_total_vega_flow: '20',
      cum_otm_dir_vega_flow: '5',
      cum_otm_total_vega_flow: '8',
      cum_dir_delta_flow: '3',
      cum_total_delta_flow: '7',
      cum_otm_dir_delta_flow: '1',
      cum_otm_total_delta_flow: '2',
    },
    {
      ticker: 'QQQ',
      timestamp: '2026-04-28T13:31:00Z',
      transactions: 80,
      volume: 400,
      dir_vega_flow: '15',
      total_vega_flow: '25',
      otm_dir_vega_flow: '6',
      otm_total_vega_flow: '9',
      dir_delta_flow: '4',
      total_delta_flow: '8',
      otm_dir_delta_flow: '2',
      otm_total_delta_flow: '3',
      cum_dir_vega_flow: '25',
      cum_total_vega_flow: '45',
      cum_otm_dir_vega_flow: '11',
      cum_otm_total_vega_flow: '17',
      cum_dir_delta_flow: '7',
      cum_total_delta_flow: '15',
      cum_otm_dir_delta_flow: '3',
      cum_otm_total_delta_flow: '5',
    },
    {
      ticker: 'SPY',
      timestamp: '2026-04-28T13:30:00Z',
      transactions: 200,
      volume: 1000,
      dir_vega_flow: '-50',
      total_vega_flow: '-30',
      otm_dir_vega_flow: '-10',
      otm_total_vega_flow: '-20',
      dir_delta_flow: '-5',
      total_delta_flow: '-2',
      otm_dir_delta_flow: '-1',
      otm_total_delta_flow: '-3',
      cum_dir_vega_flow: '-50',
      cum_total_vega_flow: '-30',
      cum_otm_dir_vega_flow: '-10',
      cum_otm_total_vega_flow: '-20',
      cum_dir_delta_flow: '-5',
      cum_total_delta_flow: '-2',
      cum_otm_dir_delta_flow: '-1',
      cum_otm_total_delta_flow: '-3',
    },
    {
      ticker: 'SPY',
      timestamp: '2026-04-28T13:31:00Z',
      transactions: 180,
      volume: 900,
      dir_vega_flow: '-20',
      total_vega_flow: '-10',
      otm_dir_vega_flow: '-5',
      otm_total_vega_flow: '-7',
      dir_delta_flow: '-3',
      total_delta_flow: '-1',
      otm_dir_delta_flow: '-2',
      otm_total_delta_flow: '-1',
      cum_dir_vega_flow: '-70',
      cum_total_vega_flow: '-40',
      cum_otm_dir_vega_flow: '-15',
      cum_otm_total_vega_flow: '-27',
      cum_dir_delta_flow: '-8',
      cum_total_delta_flow: '-3',
      cum_otm_dir_delta_flow: '-3',
      cum_otm_total_delta_flow: '-4',
    },
  ];
}

describe('GET /api/greek-flow', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 403 when botid blocks the request', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid date with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'yesterday' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty-shape payload when the table has no rows', async () => {
    // First query (resolveLatestGreekFlowDate) returns []
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { date: string | null; tickers: unknown };
    expect(body.date).toBeNull();
    expect(body.tickers).toBeDefined();
  });

  it('returns SPY+QQQ rows + metrics + divergence on the happy path', async () => {
    // 1st query: latest date lookup
    mockSql.mockResolvedValueOnce([{ d: '2026-04-28' }]);
    // 2nd query: full session
    mockSql.mockResolvedValueOnce(fakeSessionRows());

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);

    const body = res._json as {
      date: string;
      tickers: {
        SPY: { rows: unknown[]; metrics: Record<string, unknown> };
        QQQ: { rows: unknown[]; metrics: Record<string, unknown> };
      };
      divergence: Record<
        string,
        { spySign: number; qqqSign: number; diverging: boolean }
      >;
    };

    expect(body.date).toBe('2026-04-28');
    expect(body.tickers.SPY.rows).toHaveLength(2);
    expect(body.tickers.QQQ.rows).toHaveLength(2);
    // SPY went deeper negative (-50 → -70), QQQ went higher positive
    // (10 → 25). Opposite signs → diverging on dir_vega_flow.
    expect(body.divergence.dir_vega_flow).toEqual({
      spySign: -1,
      qqqSign: 1,
      diverging: true,
    });
    // Metrics exist for every field.
    expect(Object.keys(body.tickers.SPY.metrics)).toContain('dir_vega_flow');
  });

  it('uses the user-provided date instead of falling back to latest', async () => {
    // No latest-date query because date is explicit; only the session
    // fetch fires.
    mockSql.mockResolvedValueOnce(fakeSessionRows());

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-25' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toBe('2026-04-25');
  });

  it('returns 500 and reports to Sentry on DB failure', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
  });
});
