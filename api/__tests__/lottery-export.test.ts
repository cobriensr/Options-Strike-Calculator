// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: mockGuard,
}));

import handler from '../lottery-export.js';

const ROW = {
  id: 42,
  date: '2026-05-04',
  trigger_time_ct: '2026-05-04T19:00:00Z',
  underlying_symbol: 'NVDA',
  option_type: 'C',
  strike: '197.5',
  expiry: '2026-05-06',
  entry_price: '0.55',
  score: 20,
  realized_trail30_10_pct: '12.5',
  realized_eod_pct: '-100',
  peak_ceiling_pct: '40',
  ticker_n_fires: 8147,
  ticker_tier: 'reliable',
};

describe('GET /api/lottery-export', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
    mockSql.mockResolvedValue([]);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('short-circuits when guardOwnerEndpoint rejects', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed date', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '05/04/2026' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('returns 400 on bad ticker shape', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'nvda' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('serves CSV with attachment headers + filename including the date', async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-05-04' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._headers['Content-Disposition']).toBe(
      'attachment; filename="lottery-fires-2026-05-04.csv"',
    );
    expect(res._headers['Cache-Control']).toBe('no-store');
    const lines = res._body.split('\n');
    expect(lines[0]).toContain('id,date,trigger_time_ct');
    expect(lines[1]).toContain('NVDA');
  });

  it('appends ticker to the filename when filter is set', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-05-04', ticker: 'NVDA' },
      }),
      res,
    );
    expect(res._headers['Content-Disposition']).toBe(
      'attachment; filename="lottery-fires-2026-05-04-NVDA.csv"',
    );
  });

  it('returns empty CSV body (200) when no rows match', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-05-04' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe('');
  });

  it('format=json returns structured payload', async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-05-04', format: 'json' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      count: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.date).toBe('2026-05-04');
    expect(body.count).toBe(1);
    expect(body.rows[0]!.underlying_symbol).toBe('NVDA');
  });

  it('passes filter values into the SQL bindings', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          date: '2026-05-04',
          ticker: 'NVDA',
          minScore: '18',
          mode: 'A_intraday_0DTE',
          optionType: 'C',
          tod: 'PM',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls[0] as unknown[];
    const bindings = call.slice(1);
    expect(bindings).toContain('NVDA');
    expect(bindings).toContain(18);
    expect(bindings).toContain('A_intraday_0DTE');
    expect(bindings).toContain('C');
    expect(bindings).toContain('PM');
  });

  it('CSV escapes commas + quotes', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, note: 'has, comma', quoted: 'has "quote"' },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-05-04' } }),
      res,
    );
    expect(res._body).toContain('"has, comma"');
    expect(res._body).toContain('"has ""quote"""');
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-05-04' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });
});
