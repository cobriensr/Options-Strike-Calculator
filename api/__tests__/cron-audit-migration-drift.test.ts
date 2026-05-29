// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// Deterministic code-migration set: ids 1, 2, 3. The DB-applied set is
// controlled per-test via mockSql's resolved value.
vi.mock('../_lib/db-migrations.js', () => ({
  MIGRATIONS: [
    { id: 1, description: 'first' },
    { id: 2, description: 'second' },
    { id: 3, description: 'third' },
  ],
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

vi.mock('../_lib/cron-instrumentation.js', () => ({
  withCronCheckin: (_name: string, fn: unknown) => fn,
}));

import handler from '../cron/audit-migration-drift.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-29' };

beforeEach(() => {
  vi.clearAllMocks();
  mockCronGuard.mockReturnValue(GUARD);
  process.env.CRON_SECRET = 'test-secret';
});

describe('audit-migration-drift cron', () => {
  it('rejects requests when cronGuard returns null', async () => {
    mockCronGuard.mockImplementationOnce(
      (
        _req: unknown,
        res: { status: (code: number) => { json: (v: unknown) => unknown } },
      ) => {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
      },
    );
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('reports no drift when every code migration is applied', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      missing: number[];
      applied_max: number;
      code_max: number;
    };
    expect(body.missing).toEqual([]);
    expect(body.applied_max).toBe(3);
    expect(body.code_max).toBe(3);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('warns via Sentry when a code migration is missing from the DB', async () => {
    // DB has only 1 and 2 applied; code defines 1, 2, 3 → #3 is drift.
    mockSql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { missing: number[] };
    expect(body.missing).toEqual([3]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('3'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ 'cron.anomaly': 'migration-drift' }),
      }),
    );
  });

  it('does not flag applied ids that are absent from code (DB ahead of code)', async () => {
    // DB has an extra id 4 not defined in code — not a drift error.
    mockSql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { missing: number[]; applied_max: number };
    expect(body.missing).toEqual([]);
    expect(body.applied_max).toBe(4);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('returns 500 and captures exception when the DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('neon transient'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
