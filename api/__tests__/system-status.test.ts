// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────
const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
}));

const mockPing = vi.fn();
const mockGetAccessToken = vi.fn();
vi.mock('../_lib/schwab.js', () => ({
  redis: { ping: (...args: unknown[]) => mockPing(...args) },
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/guest-auth.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(() => false),
}));

import handler from '../system-status.js';
import { checkBot } from '../_lib/api-helpers.js';
import { rejectIfNotOwnerOrGuest } from '../_lib/guest-auth.js';

// ── Helpers ───────────────────────────────────────────────────

/** Set up mocks for a healthy service layer + fresh data */
function mockAllHealthy(opts?: { freshnessOverrides?: unknown[][] }) {
  // Service checks: SELECT 1, redis.ping, getAccessToken
  mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
  mockPing.mockResolvedValueOnce('PONG');
  mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });

  // Freshness queries (7 tables in parallel)
  const now = new Date().toISOString();
  const defaults = [
    [{ ts: now }], // flow_data
    [{ ts: now }], // spot_exposures
    [{ ts: now }], // strike_exposures
    [{ ts: now }], // dark_pool_levels
    [{ ts: now }], // training_features
    [{ ts: now }], // outcomes
    [{ ts: now }], // ml_findings
  ];
  const rows = opts?.freshnessOverrides ?? defaults;
  for (const row of rows) {
    mockDbFn.mockResolvedValueOnce(row);
  }
}

// ── Tests ─────────────────────────────────────────────────────
describe('GET /api/system-status', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    mockPing.mockReset();
    mockGetAccessToken.mockReset();
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
  });

  it('returns 403 when bot check flags the request', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it('returns 401 when caller is neither owner nor guest', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it('returns 200 healthy with fresh data when all services are up', async () => {
    mockAllHealthy();

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.status).toBe('healthy');
    expect(json.services).toMatchObject({
      postgres: { status: 'ok' },
      redis: { status: 'ok' },
      schwab: { status: 'ok' },
    });
    expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 503 degraded when Postgres is down', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('connection refused'));
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });
    // Freshness queries will also fail since DB is down — caught in try/catch

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        postgres: { status: 'error', error: 'connection refused' },
      },
    });
  });

  it('returns 503 degraded when Redis is down', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });
    // Freshness queries still work
    for (let i = 0; i < 7; i++) {
      mockDbFn.mockResolvedValueOnce([{ ts: new Date().toISOString() }]);
    }

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        redis: { status: 'error', error: 'ECONNREFUSED' },
      },
    });
  });

  it('returns 503 degraded when Schwab token is expired', async () => {
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({
      error: { type: 'expired_refresh', message: 'Refresh token expired' },
    });
    for (let i = 0; i < 7; i++) {
      mockDbFn.mockResolvedValueOnce([{ ts: new Date().toISOString() }]);
    }

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._json).toMatchObject({
      status: 'degraded',
      services: {
        schwab: { status: 'error', error: 'Refresh token expired' },
      },
    });
  });

  it('includes dataFreshness with checks and staleCount', async () => {
    mockAllHealthy();

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      dataFreshness: {
        checks: Array<{
          table: string;
          stale: boolean;
          ageMinutes: number | null;
        }>;
        staleCount: number;
        allFresh: boolean;
      };
    };
    expect(json.dataFreshness.checks).toHaveLength(7);
    expect(json.dataFreshness.checks[0]!.table).toBe('flow_data');
    expect(json.dataFreshness.staleCount).toBe(0);
    expect(json.dataFreshness.allFresh).toBe(true);
  });

  it('marks tables as stale when data is old', async () => {
    const staleTs = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 min ago
    mockAllHealthy({
      freshnessOverrides: [
        [{ ts: staleTs }], // flow_data — stale (threshold 15 min)
        [{ ts: staleTs }], // spot_exposures — stale
        [{ ts: new Date().toISOString() }], // strike_exposures — fresh
        [{ ts: new Date().toISOString() }], // dark_pool_levels — fresh
        [{ ts: new Date().toISOString() }], // training_features — fresh (threshold 1800 min)
        [{ ts: new Date().toISOString() }], // outcomes — fresh
        [{ ts: new Date().toISOString() }], // ml_findings — fresh
      ],
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // Status is still 200 — stale data doesn't cause 503
    expect(res._status).toBe(200);
    const json = res._json as {
      dataFreshness: {
        checks: Array<{ table: string; stale: boolean }>;
        staleCount: number;
        allFresh: boolean;
      };
    };
    expect(json.dataFreshness.staleCount).toBe(2);
    expect(json.dataFreshness.allFresh).toBe(false);
    expect(json.dataFreshness.checks[0]!.stale).toBe(true);
    expect(json.dataFreshness.checks[1]!.stale).toBe(true);
    expect(json.dataFreshness.checks[2]!.stale).toBe(false);
  });

  it('handles null freshness records (empty tables)', async () => {
    mockAllHealthy({
      freshnessOverrides: [
        [{ ts: null }], // flow_data — no data
        [{ ts: null }], // spot_exposures — no data
        [{ ts: null }], // strike_exposures — no data
        [{ ts: null }], // dark_pool_levels — no data
        [{ ts: null }], // training_features — no data
        [{ ts: null }], // outcomes — no data
        [], // ml_findings — no rows
      ],
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      dataFreshness: {
        checks: Array<{
          table: string;
          latestRecord: string | null;
          ageMinutes: number | null;
          stale: boolean;
        }>;
        staleCount: number;
      };
    };
    // All null records are marked stale
    expect(json.dataFreshness.staleCount).toBe(7);
    for (const check of json.dataFreshness.checks) {
      expect(check.latestRecord).toBeNull();
      expect(check.ageMinutes).toBeNull();
      expect(check.stale).toBe(true);
    }
  });

  it('handles freshness query failure gracefully (empty checks)', async () => {
    // Service checks succeed
    mockDbFn.mockResolvedValueOnce([{ '?column?': 1 }]);
    mockPing.mockResolvedValueOnce('PONG');
    mockGetAccessToken.mockResolvedValueOnce({ token: 'tok_123' });
    // Freshness queries throw (tables don't exist yet)
    mockDbFn.mockRejectedValueOnce(
      new Error('relation "flow_data" does not exist'),
    );

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      dataFreshness: { checks: unknown[]; staleCount: number };
    };
    expect(json.dataFreshness.checks).toHaveLength(0);
    expect(json.dataFreshness.staleCount).toBe(0);
  });

  it('includes mlPipeline with lastRun and ageHours', async () => {
    const recentTs = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2 hours ago
    mockAllHealthy({
      freshnessOverrides: [
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: recentTs }], // ml_findings — 2 hours ago
      ],
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      mlPipeline: { lastRun: string | null; ageHours: number | null };
    };
    expect(json.mlPipeline.lastRun).toBe(new Date(recentTs).toISOString());
    expect(json.mlPipeline.ageHours).toBe(2);
  });

  it('returns null mlPipeline when no ml_findings exist', async () => {
    mockAllHealthy({
      freshnessOverrides: [
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: new Date().toISOString() }],
        [{ ts: null }], // ml_findings — no data
      ],
    });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      mlPipeline: { lastRun: string | null; ageHours: number | null };
    };
    expect(json.mlPipeline.lastRun).toBeNull();
    expect(json.mlPipeline.ageHours).toBeNull();
  });

  it('includes latencyMs for each service', async () => {
    mockAllHealthy();

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      services: {
        postgres: { latencyMs?: number };
        redis: { latencyMs?: number };
        schwab: { latencyMs?: number };
      };
    };
    expect(json.services.postgres.latencyMs).toBeTypeOf('number');
    expect(json.services.redis.latencyMs).toBeTypeOf('number');
    expect(json.services.schwab.latencyMs).toBeTypeOf('number');
  });
});
