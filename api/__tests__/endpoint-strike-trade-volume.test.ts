// @vitest-environment node

/**
 * HTTP-level tests for GET /api/strike-trade-volume (Phase 2 read
 * endpoint of the tape-side volume exit signal feature).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
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
    withIsolationScope: vi.fn(
      (cb: (s: { setTag: (k: string, v: string) => void }) => unknown) =>
        cb({ setTag: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../strike-trade-volume.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: 'SPY',
    strike: '705',
    side: 'put',
    ts: '2026-04-23T16:30:00Z',
    bid_side_vol: '120',
    ask_side_vol: '300',
    mid_vol: '5',
    total_vol: '425',
    ...over,
  };
}

describe('GET /api/strike-trade-volume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  });

  it('returns 405 for non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 403 when bot detected', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Owner only' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('returns 400 on missing ticker', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { since: '2026-04-23T13:30:00Z' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 on strike-without-side (and vice versa)', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { ticker: 'SPY', since: '2026-04-23T13:30:00Z', strike: '705' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns empty series when DB has no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { ticker: 'SPY', since: '2026-04-23T13:30:00Z' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ series: [] });
  });

  it('groups bulk-mode rows by (strike, side) into series', async () => {
    mockSql.mockResolvedValueOnce([
      makeRow({ strike: '705', side: 'put', ts: '2026-04-23T16:30:00Z' }),
      makeRow({ strike: '705', side: 'put', ts: '2026-04-23T16:31:00Z' }),
      makeRow({
        strike: '704',
        side: 'put',
        ts: '2026-04-23T16:30:00Z',
        ask_side_vol: '50',
      }),
      makeRow({
        strike: '710',
        side: 'call',
        ts: '2026-04-23T16:30:00Z',
        ask_side_vol: '200',
      }),
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { ticker: 'SPY', since: '2026-04-23T13:30:00Z' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      series: Array<{
        strike: number;
        side: string;
        data: Array<{ bidSideVol: number; askSideVol: number }>;
      }>;
    };
    expect(body.series).toHaveLength(3);
    const spy705put = body.series.find(
      (s) => s.strike === 705 && s.side === 'put',
    );
    expect(spy705put?.data).toHaveLength(2);
  });

  it('returns single-key mode when strike + side supplied', async () => {
    mockSql.mockResolvedValueOnce([makeRow({ strike: '705', side: 'put' })]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          ticker: 'SPY',
          strike: '705',
          side: 'put',
          since: '2026-04-23T13:30:00Z',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as { series: Array<{ data: unknown[] }> };
    expect(body.series).toHaveLength(1);
    expect(body.series[0]?.data).toHaveLength(1);
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { ticker: 'SPY', since: '2026-04-23T13:30:00Z' },
      }),
      res,
    );
    expect(res._status).toBe(500);
  });
});
