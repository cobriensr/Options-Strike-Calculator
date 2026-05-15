// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
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

import handler from '../silent-boom-ticker-counts.js';

describe('silent-boom-ticker-counts handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns aggregated counts sorted by count desc', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'NOW',
        count: 6,
        peak_best_pct: '189.5',
        latest_bucket_ct: '2026-05-14T14:48:00Z',
      },
      {
        ticker: 'AMD',
        count: 2,
        peak_best_pct: '42.0',
        latest_bucket_ct: '2026-05-14T14:30:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      tickers: {
        ticker: string;
        count: number;
        peakBestPct: number | null;
        latestBucketCt: string;
      }[];
    };
    expect(body.date).toBe('2026-05-14');
    expect(body.tickers).toHaveLength(2);
    expect(body.tickers[0]?.ticker).toBe('NOW');
    expect(body.tickers[0]?.count).toBe(6);
    expect(body.tickers[0]?.peakBestPct).toBe(189.5);
    expect(body.tickers[1]?.ticker).toBe('AMD');
    expect(body.tickers[1]?.count).toBe(2);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns empty tickers array when no alerts match', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { tickers: unknown[] };
    expect(body.tickers).toEqual([]);
  });

  it('echoes filters in the response and forwards optionType', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'NVDA',
        count: 4,
        peak_best_pct: '88.2',
        latest_bucket_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', optionType: 'C', minScore: '21' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { optionType: string | null; minScore: number | null };
    };
    expect(body.filters.optionType).toBe('C');
    expect(body.filters.minScore).toBe(21);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns 400 on an invalid ticker query (chip strip should never send ticker, but reject if sent malformed)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('handles peak_best_pct = null without throwing', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'XYZ',
        count: 1,
        peak_best_pct: null,
        latest_bucket_ct: '2026-05-14T13:30:00Z',
      },
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      tickers: { peakBestPct: number | null }[];
    };
    expect(body.tickers[0]?.peakBestPct).toBeNull();
  });
});
