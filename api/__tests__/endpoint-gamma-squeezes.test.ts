// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gamma-squeezes.
 *
 * Sibling of endpoint-iv-anomalies.test.ts. Covers method/auth/validation
 * gates, list-mode shape, and DB error paths.
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

import handler from '../gamma-squeezes.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

function makeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    ticker: 'NVDA',
    strike: '212.50',
    side: 'call',
    expiry: '2026-04-28',
    ts: '2026-04-28T15:30:00Z',
    spot_at_detect: '211.40',
    pct_from_strike: '-0.0052',
    spot_trend_5m: '0.0012',
    vol_oi_15m: '8.4',
    vol_oi_15m_prior: '3.1',
    vol_oi_acceleration: '5.3',
    vol_oi_total: '11.5',
    net_gamma_sign: 'unknown',
    squeeze_phase: 'forming',
    context_snapshot: null,
    spot_at_close: null,
    reached_strike: null,
    max_call_pnl_pct: null,
    ...overrides,
  };
}

describe('GET /api/gamma-squeezes', () => {
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
  });

  it('blocks non-owner via guardOwnerOrGuestEndpoint', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid ticker with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'AMD' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty-keyed list when no rows exist', async () => {
    for (let i = 0; i < 14; i += 1) mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      mode: string;
      latest: Record<string, unknown>;
      history: Record<string, unknown[]>;
    };
    expect(body.mode).toBe('list');
    for (const t of [
      'SPXW',
      'NDXP',
      'SPY',
      'QQQ',
      'IWM',
      'SMH',
      'NVDA',
      'TSLA',
      'META',
      'MSFT',
      'GOOGL',
      'SNDK',
      'MSTR',
      'MU',
    ]) {
      expect(body.latest[t]).toBeNull();
      expect(body.history[t]).toEqual([]);
    }
  });

  it('returns latest + history grouped by ticker on happy path', async () => {
    // SPXW first (in STRIKE_IV_TICKERS order). Give SPXW two rows, NVDA one.
    mockSql
      .mockResolvedValueOnce([
        makeRow({
          id: 1,
          ticker: 'SPXW',
          strike: '7200.00',
          ts: '2026-04-28T15:35:00Z',
        }),
        makeRow({
          id: 2,
          ticker: 'SPXW',
          strike: '7200.00',
          ts: '2026-04-28T15:30:00Z',
        }),
      ])
      .mockResolvedValueOnce([]) // NDXP
      .mockResolvedValueOnce([]) // SPY
      .mockResolvedValueOnce([]) // QQQ
      .mockResolvedValueOnce([]) // IWM
      .mockResolvedValueOnce([]) // SMH
      .mockResolvedValueOnce([
        makeRow({ id: 3, ticker: 'NVDA', ts: '2026-04-28T15:35:00Z' }),
      ]) // NVDA
      .mockResolvedValueOnce([]) // TSLA
      .mockResolvedValueOnce([]) // META
      .mockResolvedValueOnce([]) // MSFT
      .mockResolvedValueOnce([]) // GOOGL
      .mockResolvedValueOnce([]) // SNDK
      .mockResolvedValueOnce([]) // MSTR
      .mockResolvedValueOnce([]); // MU

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      mode: string;
      latest: Record<
        string,
        { id: number; volOi15m: number; squeezePhase: string } | null
      >;
      history: Record<string, unknown[]>;
    };
    expect(body.mode).toBe('list');
    expect(body.latest.SPXW?.id).toBe(1);
    expect(body.latest.SPXW?.volOi15m).toBeCloseTo(8.4, 4);
    expect(body.latest.SPXW?.squeezePhase).toBe('forming');
    expect(body.history.SPXW).toHaveLength(2);
    expect(body.latest.NVDA?.id).toBe(3);
    expect(body.history.QQQ).toEqual([]);
  });

  it('narrows to a single ticker when query param is supplied', async () => {
    mockSql.mockResolvedValueOnce([makeRow({ id: 7, ticker: 'TSLA' })]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'TSLA' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      latest: Record<string, { id: number } | null>;
    };
    expect(body.latest.TSLA?.id).toBe(7);
    expect(body.latest.SPY).toBeNull();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and captures to Sentry on DB error', async () => {
    mockSql.mockRejectedValue(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
