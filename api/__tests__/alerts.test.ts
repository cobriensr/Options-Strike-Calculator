// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse, isolationScopeStub } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
// The guard now runs inside withDbReader, which imports it directly from
// `../_lib/guest-auth.js`. Mock THAT module so the wrapper's guard call is
// intercepted (mocking the `api-helpers.js` re-export barrel would not).
vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
const { TransientDbError } = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(cause?: unknown) {
      super('db attempt timeout');
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  }
  return { TransientDbError };
});
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb(isolationScopeStub())),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

import handler from '../alerts.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/alerts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
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

  it('returns 403 when bot detected (via guard)', async () => {
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

  it('returns 401 for non-owner (via guard)', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
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

  it('returns 503 + Retry-After + no Sentry on a TransientDbError', async () => {
    vi.mocked(Sentry.captureException).mockClear();
    mockSql.mockRejectedValue(new TransientDbError());

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({ transient: true });
    expect(res._headers['Retry-After']).toBe('5');
    expect(metrics.increment).toHaveBeenCalledWith('alerts.db_timeout');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as any).mockImplementation((cb: any) =>
      cb({ setTransactionName, setTag: vi.fn() }),
    );
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith('GET /api/alerts');
  });
});
