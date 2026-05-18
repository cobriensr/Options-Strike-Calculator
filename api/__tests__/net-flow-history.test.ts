// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  // Identity passthrough — tests assert on the underlying SQL result,
  // not retry/timeout behavior (that's covered in db.test.ts).
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

import handler from '../net-flow-history.js';

const ROW = {
  ts: '2026-05-01T19:00:00.000Z',
  net_call_prem: '1716.00',
  net_call_vol: 6,
  net_put_prem: '1990.00',
  net_put_vol: 17,
  cum_ncp: '1716.00',
  cum_ncv: 6,
  cum_npp: '1990.00',
  cum_npv: 17,
};

describe('net-flow-history endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
    mockSql.mockResolvedValue([]);
  });

  it('returns transformed series with cum-* columns coerced to numbers', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      date: string;
      count: number;
      series: Array<Record<string, unknown>>;
    };
    expect(body.ticker).toBe('TSLA');
    expect(body.date).toBe('2026-05-01');
    expect(body.count).toBe(1);
    expect(body.series[0]).toMatchObject({
      ts: '2026-05-01T19:00:00.000Z',
      ncp: 1716,
      ncv: 6,
      npp: 1990,
      npv: 17,
      cumNcp: 1716,
      cumNcv: 6,
      cumNpp: 1990,
      cumNpv: 17,
    });
  });

  it('defaults date to ET-today when omitted', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { ticker: 'TSLA' } });
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
        ticker: 'TSLA',
        date: '2026-05-01',
        from: '12:30',
        to: '14:00',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { from: string; to: string };
    // 12:30 CT on 2026-05-01 (CDT, UTC-5) = 17:30 UTC
    expect(body.from).toBe('2026-05-01T17:30:00.000Z');
    // 14:00 CT = 19:00 UTC
    expect(body.to).toBe('2026-05-01T19:00:00.000Z');
  });

  it('rejects missing ticker', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects lowercase ticker', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'tsla' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects malformed date', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'TSLA', date: '04/21/2026' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects malformed from (not HH:MM)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'TSLA', from: '9am' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('handles empty result set without crashing', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'NOTHING' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { count: number; series: unknown[] };
    expect(body.count).toBe(0);
    expect(body.series).toEqual([]);
  });

  it('honors guard short-circuit', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const req = mockRequest({ method: 'GET', query: { ticker: 'TSLA' } });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('issues a SQL query that unions ws + history tables', async () => {
    // Pins the union behavior — both tables must appear in the query
    // so historical fires (pre-daemon) get rows from the REST backfill.
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged-template first arg is the strings array; concat for inspection.
    const sqlText = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(sqlText).toContain('ws_net_flow_per_ticker');
    expect(sqlText).toContain('net_flow_per_ticker_history');
    expect(sqlText).toContain('DISTINCT ON');
  });

  it('handles DATE/TIMESTAMPTZ columns returned as Date objects', async () => {
    // neon-serverless can return TIMESTAMPTZ as Date — toIso() handles
    // both shapes. Pin the contract here.
    const ROW_WITH_DATE_OBJ = {
      ...ROW,
      ts: new Date('2026-05-01T19:00:00.000Z'),
    };
    mockSql.mockResolvedValueOnce([ROW_WITH_DATE_OBJ]);

    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { series: Array<{ ts: string }> };
    expect(body.series[0]!.ts).toBe('2026-05-01T19:00:00.000Z');
  });
});
