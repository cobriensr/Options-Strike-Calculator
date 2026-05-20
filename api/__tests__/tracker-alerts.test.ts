// @vitest-environment node

/**
 * Unit tests for the Contract Tracker alert endpoints:
 *
 *   - GET  /api/tracker/alerts/unread
 *   - POST /api/tracker/alerts/[id]/ack
 *
 * Auth is short-circuited by mocking `guardOwnerOrGuestEndpoint`. DB is
 * mocked via `vi.mocked(getDb)` returning a single `mockSql` per call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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

import unreadHandler from '../tracker/alerts/unread.js';
import ackHandler from '../tracker/alerts/[id]/ack.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  mockSql.mockReset();
});

// ============================================================
// GET /api/tracker/alerts/unread
// ============================================================

describe('GET /api/tracker/alerts/unread', () => {
  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await unreadHandler(mockRequest({ method: 'POST' }), res);
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
    await unreadHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns joined alert + contract rows', async () => {
    const joined = {
      id: 7,
      contract_id: 1,
      fired_at: '2026-05-17T16:00:00Z',
      alert_type: 'up_pct',
      threshold: '50',
      price_at_fire: '6.45',
      underlying_at_fire: '595.20',
      acknowledged: false,
      occ_symbol: 'NVDA  260522P00225000',
      ticker: 'NVDA',
      expiry: '2026-05-22',
      strike: '225.00',
      side: 'P',
      direction: 'long',
      entry_price: '4.3000',
      quantity: 5,
      contract_status: 'active',
    };
    mockSql.mockResolvedValueOnce([joined]);

    const res = mockResponse();
    await unreadHandler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { alerts: unknown[]; count: number };
    expect(body.count).toBe(1);
    expect(body.alerts[0]).toEqual(joined);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns empty list when no unacknowledged alerts', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await unreadHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { alerts: unknown[]; count: number };
    expect(body.count).toBe(0);
    expect(body.alerts).toEqual([]);
  });

  it('returns 500 when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('db down'));
    const res = mockResponse();
    await unreadHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// ============================================================
// POST /api/tracker/alerts/[id]/ack
// ============================================================

describe('POST /api/tracker/alerts/[id]/ack', () => {
  it('returns 405 for GET', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'GET', query: { id: '1' } }), res);
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
    await ackHandler(mockRequest({ method: 'POST', query: { id: '1' } }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for non-numeric id', async () => {
    const res = mockResponse();
    await ackHandler(
      mockRequest({ method: 'POST', query: { id: 'xyz' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for non-positive id', async () => {
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', query: { id: '0' } }), res);
    expect(res._status).toBe(400);
  });

  it('happy path: marks the alert acknowledged and returns 200', async () => {
    mockSql.mockResolvedValueOnce([{ id: 42, acknowledged: true }]);
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', query: { id: '42' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ acknowledged: 42 });
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 404 when alert id does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await ackHandler(
      mockRequest({ method: 'POST', query: { id: '999' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('returns 500 when DB throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('db down'));
    const res = mockResponse();
    await ackHandler(mockRequest({ method: 'POST', query: { id: '1' } }), res);
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
