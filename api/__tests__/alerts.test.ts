// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(),
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
  default: { error: vi.fn() },
}));

import handler from '../alerts.js';
import { rejectIfNotOwnerOrGuest } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/alerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 405 for PUT', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns unacknowledged alerts for today when no since param', async () => {
    const alertRow = {
      id: 1,
      date: '2026-04-01',
      timestamp: '2026-04-01T15:30:00Z',
      type: 'flow_ratio',
      severity: 'high',
      direction: 'bearish',
      title: 'Put flow spike',
      body: 'P/C ratio exceeded threshold',
      current_values: { ratio: 1.8 },
      delta_values: { ratio: 0.5 },
      acknowledged: false,
      created_at: '2026-04-01T15:30:00Z',
    };
    mockSql.mockResolvedValue([alertRow]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ alerts: [alertRow] });
  });

  it('returns alerts since timestamp when ?since= is provided', async () => {
    const alertRow = {
      id: 5,
      date: '2026-04-01',
      timestamp: '2026-04-01T16:00:00Z',
      type: 'iv_spike',
      severity: 'medium',
      direction: 'neutral',
      title: 'IV surge',
      body: 'ATM IV spiked',
      current_values: {},
      delta_values: {},
      acknowledged: false,
      created_at: '2026-04-01T16:00:00Z',
    };
    mockSql.mockResolvedValue([alertRow]);

    const since = '2026-04-01T15:00:00Z';
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { since } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ alerts: [alertRow] });
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns { alerts: [] } when no alerts exist', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ alerts: [] });
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as any).mockImplementation((cb: any) =>
      cb({ setTransactionName }),
    );
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith('GET /api/alerts');
  });
});
