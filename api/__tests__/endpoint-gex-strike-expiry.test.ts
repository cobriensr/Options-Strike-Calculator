// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gex-strike-expiry.
 *
 * Covers method guard, owner-or-guest gate, Zod validation paths,
 * empty-result path, happy path (with and without `at`), and error
 * propagation. The query helper itself is light enough not to need a
 * separate unit-test file — its behavior is fully exercised through
 * the endpoint here.
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

import handler from '../gex-strike-expiry.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function fakeRow(strike: number, ts: string) {
  return {
    ticker: 'SPY',
    expiry: '2026-05-01',
    strike: String(strike),
    ts_minute: ts,
    price: '722.18',
    call_gamma_oi: '174792.59',
    put_gamma_oi: '-1172037.66',
    call_charm_oi: '85658181.72',
    put_charm_oi: '-315259003.37',
    call_vanna_oi: '-6103.51',
    put_vanna_oi: '1337727.64',
    call_gamma_vol: '15596.81',
    put_gamma_vol: '-236.69',
    call_charm_vol: '-326871.58',
    put_charm_vol: '-68457.78',
    call_vanna_vol: '2063.13',
    put_vanna_vol: '845.06',
    call_gamma_ask_vol: '-4064.62',
    call_gamma_bid_vol: '11532.18',
    put_gamma_ask_vol: '-140.95',
    put_gamma_bid_vol: '95.73',
    call_charm_ask_vol: '85184.72',
    call_charm_bid_vol: '-241686.87',
    put_charm_ask_vol: '-59412.37',
    put_charm_bid_vol: '9045.42',
    call_vanna_ask_vol: '-537.66',
    call_vanna_bid_vol: '1525.46',
    put_vanna_ask_vol: '523.79',
    put_vanna_bid_vol: '-321.27',
  };
}

beforeEach(() => {
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  mockSql.mockReset();
});

describe('GET /api/gex-strike-expiry', () => {
  // ── Method guard ────────────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({
      method: 'POST',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('short-circuits when owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when ticker is missing', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for unsupported ticker', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'IWM', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when expiry format is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '05/01/2026' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('YYYY-MM-DD'),
    });
  });

  it('returns 400 when at parameter is not a valid ISO datetime', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01', at: 'noon' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  // ── Empty path ─────────────────────────────────────────────

  it('returns 200 with empty rows when table has no data for the date', async () => {
    // Two queries fire in parallel: latest-per-strike + timestamps.
    // Order of resolution doesn't matter, but mockResolvedValueOnce
    // returns by call order, so seed both.
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      expiry: '2026-05-01',
      at: null,
      rows: [],
      timestamps: [],
    });
  });

  // ── Happy path (no `at`) ───────────────────────────────────

  it('returns mapped rows with numeric coercion on the happy path', async () => {
    mockSql
      .mockResolvedValueOnce([
        fakeRow(722, '2026-05-01T20:14:00Z'),
        fakeRow(723, '2026-05-01T20:14:00Z'),
      ])
      .mockResolvedValueOnce([
        { ts_minute: '2026-05-01T20:13:00Z' },
        { ts_minute: '2026-05-01T20:14:00Z' },
      ]);
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      expiry: '2026-05-01',
      at: null,
    });
    const body = res._json as {
      rows: Array<Record<string, unknown>>;
      timestamps: string[];
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      strike: 722,
      price: 722.18,
      call_gamma_oi: 174792.59,
      put_gamma_oi: -1172037.66,
    });
    expect(body.timestamps).toEqual([
      '2026-05-01T20:13:00.000Z',
      '2026-05-01T20:14:00.000Z',
    ]);
  });

  // ── Happy path with `at` ───────────────────────────────────

  it('passes the at parameter through to the SQL query', async () => {
    mockSql
      .mockResolvedValueOnce([fakeRow(722, '2026-05-01T19:30:00Z')])
      .mockResolvedValueOnce([{ ts_minute: '2026-05-01T19:30:00Z' }]);
    const req = mockRequest({
      method: 'GET',
      query: {
        ticker: 'QQQ',
        expiry: '2026-05-01',
        at: '2026-05-01T19:30:00Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'QQQ',
      expiry: '2026-05-01',
      at: '2026-05-01T19:30:00Z',
      timestamps: ['2026-05-01T19:30:00.000Z'],
    });
  });

  // ── Error propagation ──────────────────────────────────────

  it('returns 500 when the DB query throws', async () => {
    // Both parallel queries reject; Promise.all surfaces the first.
    mockSql
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Connection refused'));
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'SPY', expiry: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
