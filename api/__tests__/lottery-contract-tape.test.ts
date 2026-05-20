// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import handler from '../lottery-contract-tape.js';

const ROW = {
  bucket: '2026-05-01T19:00:00.000Z',
  ask_vol: 132,
  bid_vol: 68,
  mid_vol: 12,
  no_side_vol: 0,
  total_vol: 212,
  avg_price: '1.34',
  high_price: '1.65',
  low_price: '1.20',
};

describe('lottery-contract-tape endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
    mockSql.mockResolvedValue([]);
  });

  it('returns transformed per-minute series with side-split volumes', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA260501C00395000', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      chain: string;
      date: string;
      count: number;
      series: Array<Record<string, unknown>>;
    };
    expect(body.chain).toBe('TSLA260501C00395000');
    expect(body.date).toBe('2026-05-01');
    expect(body.count).toBe(1);
    expect(body.series[0]).toMatchObject({
      ts: '2026-05-01T19:00:00.000Z',
      askVol: 132,
      bidVol: 68,
      midVol: 12,
      noSideVol: 0,
      totalVol: 212,
      avgPrice: 1.34,
      highPrice: 1.65,
      lowPrice: 1.2,
    });
  });

  it('defaults date to ET-today when omitted', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA260501C00395000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('honors from + to HH:MM CT bounds', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: {
        chain: 'TSLA260501C00395000',
        date: '2026-05-01',
        from: '12:30',
        to: '14:00',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { from: string; to: string };
    expect(body.from).toBe('2026-05-01T17:30:00.000Z');
    expect(body.to).toBe('2026-05-01T19:00:00.000Z');
  });

  it('rejects missing chain', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects malformed chain (lowercase)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { chain: 'tsla260501c00395000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects malformed chain (special chars)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA-260501-C-395' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('handles empty result set without crashing', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { chain: 'NONEXIST260501C00100000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { count: number; series: unknown[] };
    expect(body.count).toBe(0);
    expect(body.series).toEqual([]);
  });

  it('handles TIMESTAMPTZ columns returned as Date objects', async () => {
    const ROW_WITH_DATE_OBJ = {
      ...ROW,
      bucket: new Date('2026-05-01T19:00:00.000Z'),
    };
    mockSql.mockResolvedValueOnce([ROW_WITH_DATE_OBJ]);

    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA260501C00395000', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { series: Array<{ ts: string }> };
    expect(body.series[0]!.ts).toBe('2026-05-01T19:00:00.000Z');
  });

  it('preserves null avg_price for empty buckets', async () => {
    // Edge case: if total_vol = 0 (shouldn't happen but defensive),
    // SUM(price * size) / NULLIF(SUM(size), 0) returns NULL.
    const NULL_PRICE_ROW = {
      ...ROW,
      avg_price: null,
      high_price: null,
      low_price: null,
    };
    mockSql.mockResolvedValueOnce([NULL_PRICE_ROW]);

    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA260501C00395000', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { series: Array<Record<string, unknown>> };
    expect(body.series[0]!.avgPrice).toBeNull();
    expect(body.series[0]!.highPrice).toBeNull();
    expect(body.series[0]!.lowPrice).toBeNull();
  });

  it('honors guard short-circuit', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const req = mockRequest({
      method: 'GET',
      query: { chain: 'TSLA260501C00395000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });
});
