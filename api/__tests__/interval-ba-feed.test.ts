// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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
  default: { error: vi.fn() },
}));

import handler, { _internal } from '../interval-ba-feed.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const RAW_ROW = {
  id: 1,
  option_chain: 'SPXW260327C05800000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: '5800.000',
  expiry: new Date('2026-03-27T00:00:00Z'),
  bucket_start: new Date('2026-03-27T17:05:00Z'),
  bucket_end: new Date('2026-03-27T17:10:00Z'),
  fired_at: new Date('2026-03-27T17:06:24Z'),
  ratio_pct: '85.50',
  ask_premium: '1200000.00',
  total_premium: '1400000.00',
  trade_count: 8,
  top_trade_premium: '600000.00',
  top_trade_size: 1000,
  top_trade_executed_at: new Date('2026-03-27T17:06:23Z'),
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: '5795.00',
};

describe('GET /api/interval-ba-feed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 for non-owner-or-guest', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when date is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for malformed date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026/03/27' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 for malformed time', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', startTime: '8:30am' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when endTime <= startTime', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          date: '2026-03-27',
          startTime: '12:00',
          endTime: '12:00',
        },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns shaped alerts + summary on success', async () => {
    mockSql.mockResolvedValue([RAW_ROW]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: Record<string, unknown>[];
      summary: Record<string, number>;
    };
    expect(body.alerts).toHaveLength(1);
    const alert = body.alerts[0]!;
    expect(alert.option_chain).toBe('SPXW260327C05800000');
    expect(alert.strike).toBe(5800);
    expect(alert.ratio_pct).toBe(85.5);
    expect(alert.total_premium).toBe(1400000);
    expect(alert.severity).toBe('extreme');
    expect(alert.expiry).toBe('2026-03-27');
    expect(body.summary).toEqual({
      count: 1,
      total_premium: 1400000,
      extreme: 1,
      critical: 0,
      warning: 0,
    });
  });

  it('filters by option_type when provided', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', optionType: 'P' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    // The SQL branch with the option_type filter was used (1 call).
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid optionType (treats as both)', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-03-27', optionType: 'X' },
      }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('sets Cache-Control: no-store', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 + captures on DB error', async () => {
    mockSql.mockRejectedValue(new Error('pg down'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-03-27' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe('summary derivation', () => {
  it('counts by severity bucket', () => {
    const make = (tp: number) =>
      _internal.shapeRow({ ...RAW_ROW, total_premium: tp });
    const alerts = [
      make(2_000_000), // extreme
      make(900_000), // critical
      make(700_000), // critical
      make(300_000), // warning
      make(50_000), // warning
    ];
    const s = _internal.buildSummary(alerts);
    expect(s).toEqual({
      count: 5,
      total_premium: 2_000_000 + 900_000 + 700_000 + 300_000 + 50_000,
      extreme: 1,
      critical: 2,
      warning: 2,
    });
  });
});
