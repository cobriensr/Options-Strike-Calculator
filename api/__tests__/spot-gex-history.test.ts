// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(async () => ({ isBot: false })),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
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
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../spot-gex-history.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/spot-gex-history', () => {
  beforeEach(() => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 403 when botid detects a bot', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid date format with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'bogus' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty payload when no dates exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      date: null;
      timestamp: null;
      series: unknown[];
      availableDates: unknown[];
    };
    expect(body.date).toBeNull();
    expect(body.timestamp).toBeNull();
    expect(body.series).toEqual([]);
    expect(body.availableDates).toEqual([]);
  });

  it('returns empty series with 200 for an empty-day path', async () => {
    // availableDates query returns one date
    mockSql.mockResolvedValueOnce([{ date: '2026-04-15' }]);
    // series query returns zero rows (e.g. scrubbed to a date in list
    // whose spot_exposures rows haven't landed yet)
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-15' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      timestamp: unknown;
      series: unknown[];
      availableDates: string[];
    };
    expect(body.date).toBe('2026-04-15');
    expect(body.timestamp).toBeNull();
    expect(body.series).toEqual([]);
    expect(body.availableDates).toEqual(['2026-04-15']);
  });

  it('returns full happy-path payload with canonical ISO timestamps', async () => {
    mockSql.mockResolvedValueOnce([
      { date: '2026-04-17' },
      { date: '2026-04-16' },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        timestamp: '2026-04-17T14:00:00Z',
        net_gex: '125000000000',
        spot: '5800.5',
      },
      {
        timestamp: '2026-04-17T14:05:00Z',
        net_gex: '132500000000',
        spot: '5801.25',
      },
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      timestamp: string;
      series: Array<{ ts: string; netGex: number; spot: number }>;
      availableDates: string[];
    };
    // Defaults to the most recent available date (first entry of DESC list)
    expect(body.date).toBe('2026-04-17');
    expect(body.timestamp).toBe('2026-04-17T14:05:00.000Z');
    expect(body.series).toHaveLength(2);
    expect(body.series[0]).toEqual({
      ts: '2026-04-17T14:00:00.000Z',
      netGex: 125_000_000_000,
      spot: 5800.5,
    });
    expect(body.series[1]).toEqual({
      ts: '2026-04-17T14:05:00.000Z',
      netGex: 132_500_000_000,
      spot: 5801.25,
    });
    expect(body.availableDates).toEqual(['2026-04-17', '2026-04-16']);
  });

  it('uses date query param instead of latest when provided', async () => {
    mockSql.mockResolvedValueOnce([
      { date: '2026-04-17' },
      { date: '2026-04-16' },
    ]);
    mockSql.mockResolvedValueOnce([
      {
        timestamp: new Date('2026-04-16T18:00:00Z'),
        net_gex: '-5000000000',
        spot: '5750',
      },
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-16' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      series: Array<{ ts: string; netGex: number }>;
    };
    expect(body.date).toBe('2026-04-16');
    // Date objects from the driver are normalized to canonical ISO 8601
    expect(body.series[0]!.ts).toBe('2026-04-16T18:00:00.000Z');
    expect(body.series[0]!.netGex).toBe(-5_000_000_000);
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });
});
