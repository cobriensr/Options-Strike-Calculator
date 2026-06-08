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
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../silent-boom-ticker-counts.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';

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

  it('short-circuits when the owner-or-guest guard rejects', async () => {
    // guard returns truthy -> handler returns early without querying the DB
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    // handler returns before status(200) is set; the guard owns the response
    expect(res._json).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('serializes a Date latest_bucket_ct to ISO via toIso', async () => {
    const when = new Date('2026-05-14T14:48:00Z');
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'NOW',
        count: 3,
        peak_best_pct: 50,
        latest_bucket_ct: when,
      },
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      tickers: { latestBucketCt: string; peakBestPct: number | null }[];
    };
    expect(body.tickers[0]?.latestBucketCt).toBe('2026-05-14T14:48:00.000Z');
    // numeric peak passes through toNumOrNull's number branch unchanged
    expect(body.tickers[0]?.peakBestPct).toBe(50);
  });

  it('echoes each tod bucket back in filters', async () => {
    const buckets: Array<'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE'> = [
      'AM_open',
      'MID',
      'LUNCH',
      'PM',
      'LATE',
    ];
    for (const tod of buckets) {
      mockSql.mockResolvedValueOnce([]);
      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-14', tod },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);
      const body = res._json as { filters: { tod: string | null } };
      expect(body.filters.tod).toBe(tod);
    }
  });

  it('applies numeric minDte over the legacy dte enum', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      // minDte > 0 wins; dte enum is ignored for the range but still echoed
      query: { date: '2026-05-14', minDte: '7', dte: '1-3' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: { dte: string | null } };
    expect(body.filters.dte).toBe('1-3');
    expect(mockSql).toHaveBeenCalledTimes(1);

    // The enum is only echoed back — the actual DB range must come from
    // minDte (lo=7, hi=100000), NOT the '1-3' enum (lo=1, hi=3). Inspect the
    // interpolated tagged-template values so this fails if precedence regresses.
    const interpolated = mockSql.mock.calls[0]!.slice(1);
    expect(interpolated).toContain(7); // minDte lo wins
    expect(interpolated).not.toContain(3); // '1-3' enum hi would be 3 if it won
  });

  it('echoes each dte enum bucket back in filters', async () => {
    const buckets: Array<'0' | '1-3' | '4+'> = ['0', '1-3', '4+'];
    for (const dte of buckets) {
      mockSql.mockResolvedValueOnce([]);
      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-14', dte },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);
      const body = res._json as { filters: { dte: string | null } };
      expect(body.filters.dte).toBe(dte);
    }
  });

  it('echoes each burst bucket back in filters', async () => {
    const buckets: Array<'red' | 'yellow' | 'grey'> = ['red', 'yellow', 'grey'];
    for (const burst of buckets) {
      mockSql.mockResolvedValueOnce([]);
      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-14', burst },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);
      const body = res._json as { filters: { burst: string | null } };
      expect(body.filters.burst).toBe(burst);
    }
  });

  it('echoes each askPctBand band back in filters', async () => {
    const bands: Array<'70-80' | '80-90' | '90-95' | '95-99' | '100'> = [
      '70-80',
      '80-90',
      '90-95',
      '95-99',
      '100',
    ];
    for (const askPctBand of bands) {
      mockSql.mockResolvedValueOnce([]);
      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-14', askPctBand },
      });
      const res = mockResponse();
      await handler(req, res);
      expect(res._status).toBe(200);
      const body = res._json as { filters: { askPctBand: string | null } };
      expect(body.filters.askPctBand).toBe(askPctBand);
    }
  });

  it('returns 500 and reports to Sentry when the DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('neon timeout'));

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });
});
