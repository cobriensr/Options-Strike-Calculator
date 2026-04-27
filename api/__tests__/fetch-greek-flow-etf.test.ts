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
  withRetry: mockWithRetry,
}));

import handler from '../cron/fetch-greek-flow-etf.js';

// ── Fixtures ──────────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-27' };

function makeGreekFlowTick(overrides: Record<string, unknown> = {}) {
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

describe('fetch-greek-flow-etf handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: cronGuard returns valid guard (market open, auth ok)
    mockCronGuard.mockReturnValue(GUARD);
    // Default: uwFetch returns one tick for both tickers
    mockUwFetch.mockResolvedValue([makeGreekFlowTick()]);
    // Default: withRetry passes through
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    // Default: SQL INSERT returns a row (stored)
    mockSql.mockResolvedValue([{ id: 1 }]);
  });

  // ── Guard delegation ───────────────────────────────────────

  it('exits early without fetching when cronGuard returns null', async () => {
    // cronGuard owns 405/401/skip responses; the handler's contract is
    // simply to short-circuit when guard returns null. Real 405/401
    // behavior is exercised in api/__tests__/api-helpers.test.ts.
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('passes auth when CRON_SECRET matches', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours gate ─────────────────────────────────────

  it('skips when outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(500).json({ error: 'UW_API_KEY not configured' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches both tickers, stores both, returns 200 with per-ticker counts', async () => {
    const spyTick = makeGreekFlowTick({
      ticker: 'SPY',
      timestamp: '2026-04-27T14:32:00Z',
    });
    const qqqTick = makeGreekFlowTick({
      ticker: 'QQQ',
      timestamp: '2026-04-27T14:32:00Z',
    });

    // First call returns SPY tick, second returns QQQ tick
    mockUwFetch
      .mockResolvedValueOnce([spyTick])
      .mockResolvedValueOnce([qqqTick]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-greek-flow-etf',
      tickers: {
        SPY: { ticks: 1, stored: 1, skipped: 0 },
        QQQ: { ticks: 1, stored: 1, skipped: 0 },
      },
    });
    // 2 INSERT calls (1 per ticker)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Verifies both endpoints are called ────────────────────

  it('calls both /stock/SPY/greek-flow and /stock/QQQ/greek-flow endpoints', async () => {
    mockUwFetch.mockResolvedValue([]);
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(urls.some((u) => u.includes('/stock/SPY/greek-flow'))).toBe(true);
    expect(urls.some((u) => u.includes('/stock/QQQ/greek-flow'))).toBe(true);
  });

  // ── Empty data ────────────────────────────────────────────

  it('handles empty data for both tickers (returns all zeros)', async () => {
    mockUwFetch.mockResolvedValue([]);
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { ticks: 0, stored: 0, skipped: 0 },
        QQQ: { ticks: 0, stored: 0, skipped: 0 },
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── ON CONFLICT (duplicate) path ──────────────────────────

  it('counts ON CONFLICT rows as skipped, not stored', async () => {
    // Empty result array = ON CONFLICT DO NOTHING (no row returned)
    mockSql.mockResolvedValue([]);
    mockUwFetch
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'SPY' })])
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'QQQ' })]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { stored: 0, skipped: 1 },
        QQQ: { stored: 0, skipped: 1 },
      },
    });
  });

  // ── Insert error handling ─────────────────────────────────

  it('counts insert error as skipped; whole handler still returns 200', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB insert failed'));
    mockUwFetch
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'SPY' })])
      .mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { stored: 0, skipped: 1 },
        QQQ: { stored: 0, skipped: 0 },
      },
    });
  });

  // ── UW API errors ─────────────────────────────────────────

  it('returns 500 when UW API returns non-ok response', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('UW API 500: Server error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when UW fetch throws a network error', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('Network error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  // ── 8-field INSERT column regression test ────────────────

  it('persists all 8 vega+delta columns in the INSERT (field coverage regression)', async () => {
    // Regression guard: ensures all 8 vega/delta fields specified in the spec
    // are present in the SQL and that the interpolated values array carries the
    // actual tick data. If a column is ever dropped from the INSERT, this fails.
    const tick = makeGreekFlowTick({
      ticker: 'SPY',
      dir_vega_flow: '-100000',
      otm_dir_vega_flow: '-75000',
      total_vega_flow: '200000',
      otm_total_vega_flow: '150000',
      dir_delta_flow: '-3000000',
      otm_dir_delta_flow: '-1500000',
      total_delta_flow: '5000000',
      otm_total_delta_flow: '3000000',
    });
    mockUwFetch.mockResolvedValueOnce([tick]).mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Inspect the tagged-template call: call[0] is the strings array.
    const [strings, ...values] = mockSql.mock.calls[0]!;
    const sqlText = (strings as readonly string[]).join('?');

    // All 8 column names must appear in the SQL
    expect(sqlText).toContain('dir_vega_flow');
    expect(sqlText).toContain('otm_dir_vega_flow');
    expect(sqlText).toContain('total_vega_flow');
    expect(sqlText).toContain('otm_total_vega_flow');
    expect(sqlText).toContain('dir_delta_flow');
    expect(sqlText).toContain('otm_dir_delta_flow');
    expect(sqlText).toContain('total_delta_flow');
    expect(sqlText).toContain('otm_total_delta_flow');

    // Interpolated values must include all 8 field values from the fixture
    expect(values).toContain('-100000'); // dir_vega_flow
    expect(values).toContain('-75000'); // otm_dir_vega_flow
    expect(values).toContain('200000'); // total_vega_flow
    expect(values).toContain('150000'); // otm_total_vega_flow
    expect(values).toContain('-3000000'); // dir_delta_flow
    expect(values).toContain('-1500000'); // otm_dir_delta_flow
    expect(values).toContain('5000000'); // total_delta_flow
    expect(values).toContain('3000000'); // otm_total_delta_flow
  });

  // ── No 5-min downsampling ─────────────────────────────────

  it('stores each minute bar as a separate INSERT (no 5-min downsampling)', async () => {
    // Two ticks at different minutes in the same 5-min window —
    // both should be inserted (1-min resolution, unlike SPX cron).
    const tick1 = makeGreekFlowTick({ timestamp: '2026-04-27T14:31:00Z' });
    const tick2 = makeGreekFlowTick({ timestamp: '2026-04-27T14:33:00Z' });
    mockUwFetch.mockResolvedValueOnce([tick1, tick2]).mockResolvedValueOnce([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both minute bars must be stored separately
    expect(res._json).toMatchObject({
      tickers: { SPY: { ticks: 2, stored: 2, skipped: 0 } },
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
