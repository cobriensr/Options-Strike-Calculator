// @vitest-environment node

/**
 * Unit tests for the Contract Tracker CRUD endpoints:
 *
 *   - GET  /api/tracker/contracts
 *   - POST /api/tracker/contracts (structured + free-text bodies)
 *   - PATCH /api/tracker/contracts/[id]
 *   - DELETE /api/tracker/contracts/[id]
 *
 * Each test mocks `getDb()` via `vi.mocked` and sequences SQL responses
 * with `mockResolvedValueOnce`. Auth is short-circuited by mocking
 * `guardOwnerOrGuestEndpoint` to allow (return false).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import listCreateHandler from '../tracker/contracts.js';
import idHandler from '../tracker/contracts/[id].js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const SAMPLE_ROW = {
  id: 1,
  occ_symbol: 'NVDA  260522P00225000',
  ticker: 'NVDA',
  expiry: '2026-05-22',
  strike: '225.00',
  side: 'P',
  direction: 'long',
  entry_price: '4.3000',
  quantity: 5,
  notes: null,
  status: 'active',
  closed_at: null,
  closed_price: null,
  up_thresholds: null,
  down_thresholds: null,
  spot_alerts: null,
  created_at: '2026-05-17T15:00:00Z',
  updated_at: '2026-05-17T15:00:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  mockSql.mockReset();
});

// ============================================================
// GET /api/tracker/contracts
// ============================================================

describe('GET /api/tracker/contracts', () => {
  it('returns 405 for unsupported method (PUT)', async () => {
    const res = mockResponse();
    await listCreateHandler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when guest auth rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await listCreateHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('defaults status filter to active when none is passed', async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_ROW]);
    const res = mockResponse();
    await listCreateHandler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(200);
    const body = res._json as { contracts: unknown[]; count: number };
    expect(body.count).toBe(1);
    // The active filter is bound as the second template-string arg.
    const call = mockSql.mock.calls[0]!;
    expect(call[1]).toBe('active');
  });

  it('passes the status filter to the query', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'GET', query: { status: 'closed' } }),
      res,
    );
    expect(res._status).toBe(200);
    const call = mockSql.mock.calls[0]!;
    expect(call[1]).toBe('closed');
  });

  it('returns 400 for an invalid status value', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'GET', query: { status: 'pending' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 500 when the DB rejects', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const res = mockResponse();
    await listCreateHandler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('list query joins the latest tracker_contract_ticks row per contract', async () => {
    const SAMPLE_ROW_WITH_TICK = {
      ...SAMPLE_ROW,
      latest_last: '6.45',
      latest_bid: '6.40',
      latest_ask: '6.50',
      latest_underlying: '225.10',
      latest_fetched_at: '2026-05-17T15:05:00Z',
    };
    mockSql.mockResolvedValueOnce([SAMPLE_ROW_WITH_TICK]);
    const res = mockResponse();
    await listCreateHandler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(200);
    // Inspect the template-strings array of the tagged-template call.
    // The strings array is the first arg (a TemplateStringsArray); we
    // join it to verify the LATERAL join is present.
    const call = mockSql.mock.calls[0]!;
    const sqlText = Array.isArray(call[0])
      ? call[0].join('?')
      : String(call[0]);
    expect(sqlText).toContain('LEFT JOIN LATERAL');
    expect(sqlText).toContain('tracker_contract_ticks');
    expect(sqlText).toContain('ORDER BY fetched_at DESC');
    // The latest_* columns flow through unchanged to the response.
    const body = res._json as {
      contracts: Array<Record<string, unknown>>;
    };
    expect(body.contracts[0]?.latest_last).toBe('6.45');
    expect(body.contracts[0]?.latest_fetched_at).toBe('2026-05-17T15:05:00Z');
  });
});

// ============================================================
// POST /api/tracker/contracts — structured body
// ============================================================

describe('POST /api/tracker/contracts (structured)', () => {
  const validBody = {
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: 225,
    side: 'P',
    direction: 'long',
    entry_price: 4.3,
    quantity: 5,
  };

  it('returns 401 when guest auth rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: validBody }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('happy path: inserts row and returns 201 with the new contract', async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_ROW]);
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: validBody }),
      res,
    );
    expect(res._status).toBe(201);
    const body = res._json as { contract: unknown };
    expect(body.contract).toEqual(SAMPLE_ROW);
    // Verify OCC symbol was generated and passed as first arg.
    const call = mockSql.mock.calls[0]!;
    expect(call[1]).toBe('NVDA  260522P00225000');
  });

  it('returns 400 when ticker is missing', async () => {
    const res = mockResponse();
    const partial: Record<string, unknown> = { ...validBody };
    delete partial.ticker;
    await listCreateHandler(
      mockRequest({ method: 'POST', body: partial }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when strike is non-finite (Infinity)', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { ...validBody, strike: Number.POSITIVE_INFINITY },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when entry_price is zero', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: { ...validBody, entry_price: 0 } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when up_thresholds contains a negative number', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { ...validBody, up_thresholds: [50, -10] },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when down_thresholds contains a positive number', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { ...validBody, down_thresholds: [-30, 10] },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 409 when occ_symbol already exists (ON CONFLICT)', async () => {
    mockSql.mockResolvedValueOnce([]); // empty result = conflict path
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: validBody }),
      res,
    );
    expect(res._status).toBe(409);
    const body = res._json as { error: string; occ_symbol: string };
    expect(body.occ_symbol).toBe('NVDA  260522P00225000');
  });

  it('returns 500 when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: validBody }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('accepts up_thresholds + down_thresholds + spot_alerts', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...SAMPLE_ROW,
        up_thresholds: ['50', '100'],
        down_thresholds: ['-30'],
        spot_alerts: [{ op: '>=', level: 595 }],
      },
    ]);
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: {
          ...validBody,
          up_thresholds: [50, 100],
          down_thresholds: [-30],
          spot_alerts: [{ op: '>=', level: 595 }],
        },
      }),
      res,
    );
    expect(res._status).toBe(201);
  });

  it('rejects ticker with spaces', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { ...validBody, ticker: 'NV DA' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });
});

// ============================================================
// POST /api/tracker/contracts — free-text body
// ============================================================

describe('POST /api/tracker/contracts (free-text)', () => {
  it('happy path: parses free-text and inserts', async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_ROW]);
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { input: 'NVDA 225P 05/22/26 @ 4.30 x 5 long' },
      }),
      res,
    );
    expect(res._status).toBe(201);
    const call = mockSql.mock.calls[0]!;
    expect(call[1]).toBe('NVDA  260522P00225000');
  });

  it('returns 400 when free-text is malformed', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: { input: 'this is gibberish' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 when input is empty', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({ method: 'POST', body: { input: '' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when free-text omits entry price', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { input: 'NVDA 225P 05/22/26 x 5' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toMatch(/entry price/i);
  });

  it('returns 400 when free-text omits quantity', async () => {
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { input: 'NVDA 225P 05/22/26 @ 4.30' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toMatch(/quantity/i);
  });

  it('returns 409 when the contract already exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await listCreateHandler(
      mockRequest({
        method: 'POST',
        body: { input: 'NVDA 225P 05/22/26 @ 4.30 x 5' },
      }),
      res,
    );
    expect(res._status).toBe(409);
  });
});

// ============================================================
// PATCH /api/tracker/contracts/[id]
// ============================================================

describe('PATCH /api/tracker/contracts/[id]', () => {
  it('returns 401 when guest auth rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: { notes: 'hi' },
      }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await idHandler(mockRequest({ method: 'GET', query: { id: '1' } }), res);
    expect(res._status).toBe(405);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: 'abc' },
        body: { notes: 'hi' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for empty body (no fields to update)', async () => {
    const res = mockResponse();
    await idHandler(
      mockRequest({ method: 'PATCH', query: { id: '1' }, body: {} }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('updates thresholds and returns the row', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...SAMPLE_ROW,
        up_thresholds: ['75', '150'],
        down_thresholds: ['-25'],
      },
    ]);
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: {
          up_thresholds: [75, 150],
          down_thresholds: [-25],
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as { contract: { up_thresholds: unknown } };
    expect(body.contract.up_thresholds).toEqual(['75', '150']);
  });

  it('closes contract when status=closed + closed_price', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...SAMPLE_ROW,
        status: 'closed',
        closed_price: '7.50',
        closed_at: '2026-05-17T20:00:00Z',
      },
    ]);
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: { status: 'closed', closed_price: 7.5 },
      }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as {
      contract: { status: string; closed_price: string };
    };
    expect(body.contract.status).toBe('closed');
    expect(body.contract.closed_price).toBe('7.50');
  });

  it('rejects status=closed without closed_price', async () => {
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: { status: 'closed' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toMatch(/closed_price/);
  });

  it('rejects status set to a non-closed value (e.g. active)', async () => {
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: { status: 'active' },
      }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 404 when id does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '999' },
        body: { notes: 'gone' },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('returns 500 when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('db down'));
    const res = mockResponse();
    await idHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: '1' },
        body: { notes: 'x' },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// ============================================================
// DELETE /api/tracker/contracts/[id]
// ============================================================

describe('DELETE /api/tracker/contracts/[id]', () => {
  it('returns 401 when guest auth rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await idHandler(mockRequest({ method: 'DELETE', query: { id: '1' } }), res);
    expect(res._status).toBe(401);
  });

  it('happy path: deletes row and returns 200', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    const res = mockResponse();
    await idHandler(mockRequest({ method: 'DELETE', query: { id: '1' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ deleted: 1 });
  });

  it('returns 404 when id does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await idHandler(
      mockRequest({ method: 'DELETE', query: { id: '999' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('returns 400 for invalid id (negative)', async () => {
    const res = mockResponse();
    await idHandler(
      mockRequest({ method: 'DELETE', query: { id: '-1' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 500 when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('db down'));
    const res = mockResponse();
    await idHandler(mockRequest({ method: 'DELETE', query: { id: '1' } }), res);
    expect(res._status).toBe(500);
  });
});
