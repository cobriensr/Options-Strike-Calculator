// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/auth-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
}));

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

import handler from '../silent-boom-export.js';

interface ExportRow {
  id: number;
  date: Date;
  bucket_ct: Date;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string;
  expiry: Date;
  dte: number;
  spike_volume: number;
  baseline_volume: string;
  spike_ratio: string;
  ask_pct: string;
  vol_oi: string;
  entry_price: string;
  open_interest: number;
  score: number;
  score_tier: 'tier1' | 'tier2' | 'tier3';
}

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1,
    date: new Date('2026-05-07T00:00:00Z'),
    bucket_ct: new Date('2026-05-07T13:30:00Z'),
    option_chain_id: 'SNDK260507C01175000',
    underlying_symbol: 'SNDK',
    option_type: 'C',
    strike: '1175',
    expiry: new Date('2026-05-07T00:00:00Z'),
    dte: 0,
    spike_volume: 2000,
    baseline_volume: '100',
    spike_ratio: '20',
    ask_pct: '0.95',
    vol_oi: '0.4',
    entry_price: '0.5',
    open_interest: 5000,
    score: 24,
    score_tier: 'tier1',
    ...overrides,
  };
}

describe('silent-boom-export handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects non-GET methods with 405', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 200 + CSV with the expected filename and headers', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/csv');
    expect(res._headers['Content-Disposition']).toContain(
      'silent-boom-2026-05-07.csv',
    );
    // Header row + data row.
    expect(res._body).toMatch(/^id,date,bucket_ct,/);
    expect(res._body).toContain('SNDK');
    expect(res._body).toContain('tier1');
  });

  it('returns JSON when format=json with normalized dates', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', format: 'json' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      rows: { date: string; expiry: string; bucket_ct: string }[];
    };
    expect(body.count).toBe(1);
    // DATE columns → YYYY-MM-DD; TIMESTAMPTZ → full ISO.
    expect(body.rows[0]?.date).toBe('2026-05-07');
    expect(body.rows[0]?.expiry).toBe('2026-05-07');
    expect(body.rows[0]?.bucket_ct).toBe('2026-05-07T13:30:00.000Z');
  });

  it('returns empty CSV (status 200, empty body) on no matches', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-07' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toBe('');
  });

  it('binds tod into the SQL when supplied (regression vs feed bug)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', tod: 'AM_open' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const strings = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const sqlText = strings.join(' ');
    expect(sqlText).toContain("AT TIME ZONE 'America/Chicago'");
  });

  it('rejects invalid query params with 400', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('embeds the ticker in the filename when supplied', async () => {
    mockSql.mockResolvedValueOnce([makeRow()]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-07', ticker: 'SNDK' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._headers['Content-Disposition']).toContain(
      'silent-boom-2026-05-07-SNDK.csv',
    );
  });
});
