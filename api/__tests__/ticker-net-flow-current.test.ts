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

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: mockCaptureException, setTag: vi.fn() },
}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import handler from '../ticker-net-flow-current.js';

const TSLA_ROW = {
  ticker: 'TSLA',
  ts: '2026-05-01T19:00:00.000Z',
  cum_ncp: '12345.67',
  cum_npp: '-2222.00',
};

const AAPL_ROW = {
  ticker: 'AAPL',
  ts: '2026-05-01T18:55:00.000Z',
  cum_ncp: '500.00',
  cum_npp: '1500.00',
};

describe('ticker-net-flow-current endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
    mockSql.mockResolvedValue([]);
  });

  it('returns transformed snapshots with cum-* columns coerced to numbers', async () => {
    mockSql.mockResolvedValueOnce([TSLA_ROW, AAPL_ROW]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA,AAPL', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      requestedTickers: string[];
      count: number;
      snapshots: Array<Record<string, unknown>>;
    };
    expect(body.date).toBe('2026-05-01');
    expect(body.requestedTickers).toEqual(['TSLA', 'AAPL']);
    expect(body.count).toBe(2);
    expect(body.snapshots[0]).toMatchObject({
      ticker: 'TSLA',
      asOfTs: '2026-05-01T19:00:00.000Z',
      cumNcp: 12345.67,
      cumNpp: -2222,
    });
    expect(body.snapshots[1]).toMatchObject({
      ticker: 'AAPL',
      cumNcp: 500,
      cumNpp: 1500,
    });
  });

  it('defaults date to ET-today when omitted', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('dedupes + uppercases + trims tickers before query', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: ' tsla , TSLA, aapl ,aapl' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { requestedTickers: string[] };
    expect(body.requestedTickers).toEqual(['TSLA', 'AAPL']);
  });

  it('rejects missing tickers param', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects empty tickers string', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { tickers: '' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects malformed date', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA', date: '04/21/2026' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('rejects tickers list exceeding 100', async () => {
    const tickers = Array.from({ length: 101 }, (_, i) => `T${i}`).join(',');
    const req = mockRequest({
      method: 'GET',
      query: { tickers },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('handles empty result set without crashing', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'NOTHING' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { count: number; snapshots: unknown[] };
    expect(body.count).toBe(0);
    expect(body.snapshots).toEqual([]);
  });

  it('honors guard short-circuit', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('issues a SQL query that unions ws + history tables and takes latest per ticker', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA,AAPL', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const sqlText = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(sqlText).toContain('ws_net_flow_per_ticker');
    expect(sqlText).toContain('net_flow_per_ticker_history');
    expect(sqlText).toContain('PARTITION BY ticker');
    expect(sqlText).toContain('DISTINCT ON');
  });

  it('handles TIMESTAMPTZ returned as Date objects', async () => {
    const ROW_WITH_DATE_OBJ = {
      ...TSLA_ROW,
      ts: new Date('2026-05-01T19:00:00.000Z'),
    };
    mockSql.mockResolvedValueOnce([ROW_WITH_DATE_OBJ]);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { snapshots: Array<{ asOfTs: string }> };
    expect(body.snapshots[0]!.asOfTs).toBe('2026-05-01T19:00:00.000Z');
  });

  it('returns 500 + reports to Sentry on SQL failure', async () => {
    const boom = new Error('relation "ws_net_flow_per_ticker" does not exist');
    mockSql.mockRejectedValueOnce(boom);

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'relation "ws_net_flow_per_ticker" does not exist',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(boom);
    expect(mockLogError).toHaveBeenCalledWith(
      { err: boom },
      'ticker-net-flow-current error',
    );
  });

  it('stringifies non-Error throwables in the 500 payload', async () => {
    mockSql.mockRejectedValueOnce('boom-as-string');

    const req = mockRequest({
      method: 'GET',
      query: { tickers: 'TSLA', date: '2026-05-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'boom-as-string' });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
