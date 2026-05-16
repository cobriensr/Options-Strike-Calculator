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

import { isMarketOpen, setCacheHeaders } from '../_lib/api-helpers.js';

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
  ticker: 'SPX' | 'SPY' | 'QQQ',
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
  vi.mocked(isMarketOpen).mockReturnValue(false);
  vi.mocked(setCacheHeaders).mockClear();
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
    // Strict schema rejects unknown keys (date/at are the only allowed
    // optional params); anything else produces a clean 400.
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when date format is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '05/01/2026' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when at parameter is not a valid ISO datetime', async () => {
    const req = mockRequest({ method: 'GET', query: { at: 'noon' } });
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
      date: null,
      at: null,
      rows: [],
      asOf: expect.any(String),
    });
  });

  it('echoes date + at back in the response when scrubbed', async () => {
    mockSql.mockResolvedValueOnce([fakeRow('SPX')]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', at: '2026-05-01T20:00:00Z' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      date: '2026-05-01',
      at: '2026-05-01T20:00:00Z',
    });
  });

  // ── Happy path ─────────────────────────────────────────────

  it('returns mapped rows ordered to match ZERO_GAMMA_TICKERS', async () => {
    // Return out of order; the helper re-orders to match the canonical
    // SPX, SPY, QQQ sequence.
    mockSql.mockResolvedValueOnce([
      fakeRow('QQQ', { spot: '674.0000', zero_gamma: '667.3309' }),
      fakeRow('SPX', { spot: '7230.0000', zero_gamma: null }),
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
    expect(rows.map((r) => r.ticker)).toEqual(['SPX', 'SPY', 'QQQ']);

    // Spot-check numeric coercion on the SPX row (zero_gamma was null).
    expect(rows[0]).toMatchObject({
      ticker: 'SPX',
      spot: 7230,
      zeroGamma: null,
      confidence: 0.392,
      netGammaAtSpot: 3500000000,
    });
    expect(rows[1]).toMatchObject({ ticker: 'SPY', spot: 720.6 });
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

  // ── Cache headers ──────────────────────────────────────────

  it('uses 30s edge cache during market hours', async () => {
    vi.mocked(isMarketOpen).mockReturnValueOnce(true);
    mockSql.mockResolvedValueOnce([fakeRow('SPX')]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    // setCacheHeaders(res, sMaxAgeSec, swrSec) — match positional args.
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 30, 60);
  });

  it('uses 300s edge cache off-hours', async () => {
    vi.mocked(isMarketOpen).mockReturnValueOnce(false);
    mockSql.mockResolvedValueOnce([fakeRow('SPX')]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 300, 60);
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
