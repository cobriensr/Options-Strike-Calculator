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

import handler from '../lottery-finder-ticker-counts.js';

describe('lottery-finder-ticker-counts handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns chain-deduped counts sorted by count desc', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'TSLA',
        count: 3,
        peak_best_pct: '303.2',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
      {
        ticker: 'NVDA',
        count: 1,
        peak_best_pct: '45.0',
        latest_trigger_time_ct: '2026-05-14T14:30:00Z',
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
        latestTriggerTimeCt: string;
      }[];
    };
    expect(body.date).toBe('2026-05-14');
    expect(body.tickers).toHaveLength(2);
    expect(body.tickers[0]?.ticker).toBe('TSLA');
    expect(body.tickers[0]?.count).toBe(3);
    expect(body.tickers[0]?.peakBestPct).toBe(303.2);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns empty tickers array when no fires match', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { tickers: unknown[] };
    expect(body.tickers).toEqual([]);
  });

  it('echoes filters and forwards mode + minScore', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SMCI',
        count: 2,
        peak_best_pct: '110.0',
        latest_trigger_time_ct: '2026-05-14T15:30:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-05-14',
        mode: 'A_intraday_0DTE',
        minScore: '18',
        reload: 'true',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: {
        mode: string | null;
        minScore: number | null;
        reload: boolean | null;
      };
    };
    expect(body.filters.mode).toBe('A_intraday_0DTE');
    expect(body.filters.minScore).toBe(18);
    expect(body.filters.reload).toBe(true);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('distinguishes reload=false from reload absent', async () => {
    // The zod transform maps 'false' → false (explicit) and missing →
    // undefined. The SQL gate handles them differently: explicit false
    // restricts to `reload_tagged = false`; absent passes the gate. A
    // future schema refactor could collapse one into the other; this
    // test fails loudly if that happens.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAPL',
        count: 1,
        peak_best_pct: '50.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', reload: 'false' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { reload: boolean | null };
    };
    expect(body.filters.reload).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('binds minFireCount to the ranked-CTE filter + echoes it in filters', async () => {
    // Server-side push of the Burst chip — chip counts must stay
    // aligned with the burst-filtered feed, so the ranked CTE filters
    // on fc (window-function fire count) at WHERE rn = 1. Without this
    // binding the chip strip would overstate ticker counts when Burst
    // is active. Pattern mirrors the count subquery in
    // /api/lottery-finder so a chain in the feed and a chain in the
    // strip are the same population.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'TSLA',
        count: 4,
        peak_best_pct: '85.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minFireCount: '8' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { minFireCount: number | null };
    };
    expect(body.filters.minFireCount).toBe(8);

    // SQL uses the ranked-CTE pattern (WITH ranked ... WHERE rn = 1
    // AND fc >= ...) and binds the floor value to the mocked sql call.
    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('WITH ranked');
    expect(sql).toContain('WHERE rn = 1');
    expect(sql).toContain('fc >=');
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(8);
  });

  it('binds minTakeitProb to the ranked-CTE filter + echoes it in filters', async () => {
    // Server-side push of the TAKE-IT chip. Filters on the LATEST
    // fire's takeit_prob per chain so chip counts stay aligned with
    // the feed. Default UI value is 0.70 — the prior client-side
    // filter dropped 40+ of 50 fires per page and made pagination
    // meaningless.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'NVDA',
        count: 2,
        peak_best_pct: '110.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minTakeitProb: '0.7' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { minTakeitProb: number | null };
    };
    expect(body.filters.minTakeitProb).toBe(0.7);

    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('takeit_prob >=');
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(0.7);
  });

  it('omits minTakeitProb from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { minTakeitProb: number | null } };
    expect(body.filters.minTakeitProb).toBeNull();
  });

  it('omits minFireCount from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { minFireCount: number | null } };
    expect(body.filters.minFireCount).toBeNull();
  });

  it('rejects minFireCount below 1 with 400 (Zod min(1))', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minFireCount: '0' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid date', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('binds MIN_ALERT_ENTRY_PRICE + the Q1/Q2 inversion suppression into the SQL', async () => {
    // Chip totals must mirror /api/lottery-finder so the count and
    // the visible feed agree. Two server-side filters are load-bearing:
    //   1. entry_price >= MIN_ALERT_ENTRY_PRICE (penny-option floor)
    //   2. Phase 3 inversion-quality suppression — LEFT JOIN
    //      lottery_ticker_stats + inversion_quintile > 2 unless showAll
    // This test fails loudly if either is dropped or refactored away.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAPL',
        count: 1,
        peak_best_pct: '40.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('entry_price >=');
    expect(sql).toContain('LEFT JOIN lottery_ticker_stats');
    expect(sql).toContain('inversion_quintile');
    // showAll default is false; the bind value must reach the SQL call.
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(false);

    const body = res._json as { filters: { showAll: boolean } };
    expect(body.filters.showAll).toBe(false);
  });

  it('passes showAll=true through to the SQL bind and the filter echo', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', showAll: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(true);
    const body = res._json as { filters: { showAll: boolean } };
    expect(body.filters.showAll).toBe(true);
  });

  it('handles peak_best_pct = null without throwing', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'XYZ',
        count: 1,
        peak_best_pct: null,
        latest_trigger_time_ct: '2026-05-14T13:30:00Z',
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
