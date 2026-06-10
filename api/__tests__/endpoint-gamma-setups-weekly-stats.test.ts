// @vitest-environment node

/**
 * HTTP-level tests for GET /api/gamma-setups/weekly-stats.
 *
 * Covers method guard, owner-or-guest gate, ?days= validation (allow
 * list + default), cache header, and 500 on aggregator error.
 *
 * The pure aggregator (`aggregateFireStats` + `detectDrift`) has its
 * own coverage in `gamma-stats.test.ts`; this file mocks it and
 * focuses on the request handler shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse, isolationScopeStub } from './helpers';

// ── Mocks ────────────────────────────────────────────────

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
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../_lib/gamma-stats.js', () => ({
  aggregateFireStats: vi.fn(),
  loadFireStatsRows: vi.fn(),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-21'),
}));

import handler from '../gamma-setups/weekly-stats.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';
import { Sentry } from '../_lib/sentry.js';
import { aggregateFireStats, loadFireStatsRows } from '../_lib/gamma-stats.js';

// ── Fixtures ──────────────────────────────────────────────

function makeStats(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    from: '2026-04-21',
    to: '2026-05-21',
    n_total: 8,
    n_with_outcome: 6,
    n_winners: 4,
    win_rate: 4 / 6,
    mean_edge_pts: 3.1,
    by_signal: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gamma-setups/weekly-stats', () => {
  beforeEach(() => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockSql.mockReset();
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(aggregateFireStats).mockReset();
    vi.mocked(loadFireStatsRows).mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    expect(loadFireStatsRows).not.toHaveBeenCalled();
  });

  it('returns 401 when the owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(loadFireStatsRows).not.toHaveBeenCalled();
  });

  it('falls back to the 30-day default when no ?days= is provided', async () => {
    vi.mocked(loadFireStatsRows).mockResolvedValueOnce([]);
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { from: string; to: string };
    expect(body.from).toBe('2026-04-21');
    expect(body.to).toBe('2026-05-21');
    // 30 days back from 2026-05-21 mocked clock — exact value depends on
    // the mocked timezone helper, but loadFireStatsRows must have been
    // called with TWO date strings (from, to).
    const call = vi.mocked(loadFireStatsRows).mock.calls[0];
    expect(call).toBeDefined();
    expect(typeof call![1]).toBe('string'); // from
    expect(call![2]).toBe('2026-05-21'); // to (today)
  });

  it.each([7, 14, 30, 60, 90])(
    'accepts allowed ?days=%i',
    async (days: number) => {
      vi.mocked(loadFireStatsRows).mockResolvedValueOnce([]);
      vi.mocked(aggregateFireStats).mockReturnValueOnce(
        makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
      );

      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { days: String(days) } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(loadFireStatsRows).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['1', '0', '-7', 'abc', '180', ''])(
    'falls back to default for invalid ?days=%s',
    async (raw: string) => {
      vi.mocked(loadFireStatsRows).mockResolvedValueOnce([]);
      vi.mocked(aggregateFireStats).mockReturnValueOnce(
        makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
      );

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', query: { days: raw } }), res);
      // Default branch never throws — it just returns 200 with the
      // 30-day window. The contract is that bad input is sanitized, not
      // rejected, so the tile renders something useful.
      expect(res._status).toBe(200);
    },
  );

  it('sets a private 30s edge-cache header on the success response', async () => {
    vi.mocked(loadFireStatsRows).mockResolvedValueOnce([]);
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      makeStats() as unknown as ReturnType<typeof aggregateFireStats>,
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('private, max-age=30');
  });

  it('returns the aggregator output verbatim as JSON', async () => {
    const stats = makeStats({ n_total: 42, win_rate: 0.61 });
    vi.mocked(loadFireStatsRows).mockResolvedValueOnce([]);
    vi.mocked(aggregateFireStats).mockReturnValueOnce(
      stats as unknown as ReturnType<typeof aggregateFireStats>,
    );

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual(stats);
  });

  it('returns 500 and captures exception on aggregator error', async () => {
    const err = new Error('pg gone');
    vi.mocked(loadFireStatsRows).mockRejectedValueOnce(err);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    vi.mocked(loadFireStatsRows).mockRejectedValueOnce(new TransientDbError());

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(503);
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(res._headers['Retry-After']).toBe('5');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
