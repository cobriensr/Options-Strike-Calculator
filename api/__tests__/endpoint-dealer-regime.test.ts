// @vitest-environment node

/**
 * HTTP-level tests for GET /api/dealer-regime.
 *
 * Covers: method guard, owner-or-guest gate, strict-schema rejection of
 * unexpected query params, happy path with mapped numeric rows,
 * empty-table path, and error propagation. The query helper
 * (getLatestDealerRegime) is fully exercised through this endpoint.
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

import handler from '../dealer-regime.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function fakeRow(
  ticker: 'SPX' | 'NDX' | 'SPY' | 'QQQ',
  overrides: Record<string, unknown> = {},
) {
  return {
    ticker,
    ts: '2026-05-01T20:04:33.280Z',
    spot: '7230.0000',
    zero_gamma: '7187.4727',
    confidence: '0.392',
    net_gamma_at_spot: '3500000000.00',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  mockSql.mockReset();
});

describe('GET /api/dealer-regime', () => {
  // ── Method guard ────────────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('short-circuits when owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when an unexpected query param is supplied', async () => {
    // The endpoint takes no query params; the strict schema rejects
    // anything passed so probes can't smuggle data through the URL.
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  // ── Empty path ─────────────────────────────────────────────

  it('returns 200 with empty rows when table has no data', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      rows: [],
      asOf: expect.any(String),
    });
  });

  // ── Happy path ─────────────────────────────────────────────

  it('returns mapped rows ordered to match ZERO_GAMMA_TICKERS', async () => {
    // Return out of order; the helper re-orders to match the canonical
    // SPX, NDX, SPY, QQQ sequence.
    mockSql.mockResolvedValueOnce([
      fakeRow('QQQ', { spot: '674.0000', zero_gamma: '667.3309' }),
      fakeRow('SPX', { spot: '7230.0000', zero_gamma: null }),
      fakeRow('NDX', { spot: '27710.0000', zero_gamma: '27269.9407' }),
      fakeRow('SPY', { spot: '720.6000', zero_gamma: '705.6628' }),
    ]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      rows: Array<Record<string, unknown>>;
      asOf: string;
    };
    const rows = body.rows;
    expect(rows.map((r) => r.ticker)).toEqual(['SPX', 'NDX', 'SPY', 'QQQ']);

    // Spot-check numeric coercion on the SPX row (zero_gamma was null).
    expect(rows[0]).toMatchObject({
      ticker: 'SPX',
      spot: 7230,
      zeroGamma: null,
      confidence: 0.392,
      netGammaAtSpot: 3500000000,
    });
    expect(rows[1]).toMatchObject({ ticker: 'NDX', spot: 27710 });
  });

  it('omits absent tickers without padding the response', async () => {
    // Cron has only run for SPX; the response should contain just SPX.
    mockSql.mockResolvedValueOnce([fakeRow('SPX')]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { rows: Array<{ ticker: string }> };
    expect(body.rows.map((r) => r.ticker)).toEqual(['SPX']);
  });

  // ── Error propagation ──────────────────────────────────────

  it('returns 500 when the DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('Connection refused'));
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
