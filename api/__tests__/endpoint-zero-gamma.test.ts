// @vitest-environment node

/**
 * HTTP-level tests for GET /api/zero-gamma (the read endpoint).
 *
 * The sibling file `zero-gamma.test.ts` tests the pure computeZeroGammaLevel()
 * calculator from Task A; this file exercises the request handler: method
 * guard, bot check, owner-gate, Zod validation, and the happy path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import handler from '../zero-gamma.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/zero-gamma', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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

  it('returns 403 when botid detects a bot', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(403).json({ error: 'Access denied' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    // Owner gate must fire before any DB read.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid ticker with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { ticker: 'not-a-ticker!' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns empty payload for owner when no rows exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as {
      latest: unknown;
      history: unknown[];
    };
    expect(body.latest).toBeNull();
    expect(body.history).toEqual([]);
  });

  it('returns latest + history for owner on happy path', async () => {
    // Rows come back DESC by ts (latest first) — matches the SQL query.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SPX',
        spot: '7105.25',
        zero_gamma: '7102.5',
        confidence: '0.82',
        net_gamma_at_spot: '-150000000',
        gamma_curve: [
          { spot: 7100, netGamma: 1_000_000 },
          { spot: 7110, netGamma: -1_000_000 },
        ],
        ts: '2026-04-23T14:30:00Z',
      },
      {
        ticker: 'SPX',
        spot: '7104.0',
        zero_gamma: '7101.0',
        confidence: '0.75',
        net_gamma_at_spot: '-120000000',
        gamma_curve: [
          { spot: 7100, netGamma: 900_000 },
          { spot: 7110, netGamma: -900_000 },
        ],
        ts: '2026-04-23T14:25:00Z',
      },
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      latest: {
        ticker: string;
        spot: number;
        zeroGamma: number | null;
        confidence: number | null;
        netGammaAtSpot: number | null;
        ts: string;
      };
      history: Array<{ ticker: string; ts: string }>;
    };
    expect(body.latest.ticker).toBe('SPX');
    expect(body.latest.spot).toBe(7105.25);
    expect(body.latest.zeroGamma).toBe(7102.5);
    expect(body.latest.confidence).toBe(0.82);
    expect(body.latest.netGammaAtSpot).toBe(-150_000_000);
    expect(body.latest.ts).toBe('2026-04-23T14:30:00.000Z');
    expect(body.history).toHaveLength(2);
  });

  it('rejects malformed date with 400', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '04/22/2026' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('filters by ET calendar date — boundary row that rolls over to next UTC day', async () => {
    // 2026-04-23T01:00:00Z = 2026-04-22 21:00 ET (a Tuesday afternoon
    // write). The query must match `date=2026-04-22` against the ET date,
    // not the UTC date. Mock returns the row as if the SQL filter accepted
    // it; the assertion is that the handler's query template uses the
    // AT TIME ZONE conversion (a no-op at this layer, but the row coming
    // back without throwing means the handler accepted the date param).
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SPX',
        spot: '7100.0',
        zero_gamma: '7095.0',
        confidence: '0.6',
        net_gamma_at_spot: '0',
        gamma_curve: [],
        ts: '2026-04-23T01:00:00Z',
      },
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-22' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      latest: { ts: string };
      history: unknown[];
    };
    expect(body.latest.ts).toBe('2026-04-23T01:00:00.000Z');
    expect(body.history).toHaveLength(1);

    // Verify the handler used the ET-converted comparison in its query
    // template. The first arg to the tagged-template `mockSql` call is the
    // strings array; we look for the AT TIME ZONE clause.
    const sqlStrings = (mockSql.mock.calls[0]?.[0] ?? []) as string[];
    const fullSql = sqlStrings.join('?');
    expect(fullSql).toMatch(/AT TIME ZONE 'America\/New_York'/);
  });

  it('uses ASC order and last-of-day as latest when date is provided', async () => {
    // For a date query the handler issues an ASC-ordered SELECT and treats
    // the LAST row as `latest`. Mock returns rows in chronological order.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SPX',
        spot: '7100.0',
        zero_gamma: '7095.0',
        confidence: '0.6',
        net_gamma_at_spot: '0',
        gamma_curve: [],
        ts: '2026-04-22T13:30:00Z',
      },
      {
        ticker: 'SPX',
        spot: '7115.0',
        zero_gamma: '7102.0',
        confidence: '0.7',
        net_gamma_at_spot: '0',
        gamma_curve: [],
        ts: '2026-04-22T20:55:00Z',
      },
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-22' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as {
      latest: { spot: number; ts: string };
      history: unknown[];
    };
    // Last of the day = highest ts in the mocked ASC array.
    expect(body.latest.spot).toBe(7115.0);
    expect(body.latest.ts).toBe('2026-04-22T20:55:00.000Z');
    expect(body.history).toHaveLength(2);
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
