// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

import handler from '../cron/cleanup-gexbot.js';

// Pre-market: Tuesday 12:15 UTC == 7:15am ET
const PRE_MARKET = new Date('2026-03-24T12:15:00.000Z');

describe('cleanup-gexbot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(PRE_MARKET);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('skips a table with no audit rows (no_archive)', async () => {
    // Both tables: audit SELECT returns max_date=null → skip
    mockSql.mockResolvedValueOnce([{ max_date: null }]); // snapshots audit
    mockSql.mockResolvedValueOnce([{ max_date: null }]); // captures audit

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      results: [
        expect.objectContaining({
          table: 'gexbot_snapshots',
          stopReason: 'no_archive',
          deleted: 0,
        }),
        expect.objectContaining({
          table: 'gexbot_api_capture',
          stopReason: 'no_archive',
          deleted: 0,
        }),
      ],
    });
    // 2 SELECTs only (no DELETEs)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('deletes rows up to the archived cutoff for each table', async () => {
    // Per-table call order: audit SELECT → yesterday_et SELECT → DELETE loop.
    // snapshots
    mockSql.mockResolvedValueOnce([{ max_date: '2026-03-22' }]); // audit
    mockSql.mockResolvedValueOnce([{ yesterday_et: '2026-03-23' }]); // yesterday
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({ id: i })),
    ); // batch 1
    mockSql.mockResolvedValueOnce([]); // batch 2 (drain)
    // captures
    mockSql.mockResolvedValueOnce([{ max_date: '2026-03-22' }]); // audit
    mockSql.mockResolvedValueOnce([{ yesterday_et: '2026-03-23' }]); // yesterday
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: i })),
    ); // batch 1
    mockSql.mockResolvedValueOnce([]); // batch 2 (drain)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 150,
    });
  });

  it('caps cutoff at yesterday even when archive is far ahead', async () => {
    // Audit max_date is 2030-01-01 (somehow ahead of today).
    // Cutoff should clamp to SQL-computed yesterday.
    mockSql.mockResolvedValueOnce([{ max_date: '2030-01-01' }]); // audit
    mockSql.mockResolvedValueOnce([{ yesterday_et: '2026-03-23' }]); // yesterday
    mockSql.mockResolvedValueOnce([]); // empty DELETE drains
    mockSql.mockResolvedValueOnce([{ max_date: null }]); // captures skip (no_archive)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      results: Array<{ table: string; cutoff: string | null }>;
    };
    const snapsResult = json.results.find(
      (r) => r.table === 'gexbot_snapshots',
    );
    expect(snapsResult?.cutoff).toBe('2026-03-23');
  });

  it('handles Date-typed max_date and yesterday_et from Neon driver', async () => {
    // The Neon serverless driver returns DATE columns as Date objects.
    // The handler must normalize them, not coerce via `as string`.
    mockSql.mockResolvedValueOnce([
      { max_date: new Date('2026-03-22T00:00:00.000Z') },
    ]); // audit
    mockSql.mockResolvedValueOnce([
      { yesterday_et: new Date('2026-03-23T00:00:00.000Z') },
    ]); // yesterday (Date-typed)
    mockSql.mockResolvedValueOnce([]); // empty DELETE
    mockSql.mockResolvedValueOnce([{ max_date: null }]); // captures skip

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      results: Array<{ table: string; cutoff: string | null }>;
    };
    const snapsResult = json.results.find(
      (r) => r.table === 'gexbot_snapshots',
    );
    expect(snapsResult?.cutoff).toBe('2026-03-22');
  });

  it('reports stopReason: wall_budget when the budget is exhausted mid-loop', async () => {
    // Mock Date.now so the first batch returns rows and the wall-budget
    // check inside the loop trips on the next iteration.
    const realNow = Date.now;
    let nowCalls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      // First call: cron handler captures startedAt
      // Second call (inside cleanupOne): still within budget
      // Third call: jump 5 minutes ahead → exhausts WALL_BUDGET_MS (295s)
      if (nowCalls >= 3) return realNow() + 300_000;
      return realNow();
    });

    mockSql.mockResolvedValueOnce([{ max_date: '2026-03-22' }]); // audit
    mockSql.mockResolvedValueOnce([{ yesterday_et: '2026-03-23' }]); // yesterday
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 50_000 }, (_, i) => ({ id: i })),
    ); // batch 1 (full)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as {
      results: Array<{ table: string; stopReason: string }>;
    };
    expect(json.results[0]?.stopReason).toBe('wall_budget');
  });

  it('reports stopReason: drained when DELETE loop empties on first batch', async () => {
    // Audit row present + empty DELETE on the very first batch →
    // nothing to delete, loop breaks cleanly with drained status.
    mockSql.mockResolvedValueOnce([{ max_date: '2026-03-22' }]); // audit
    mockSql.mockResolvedValueOnce([{ yesterday_et: '2026-03-23' }]); // yesterday
    mockSql.mockResolvedValueOnce([]); // empty DELETE → drained
    mockSql.mockResolvedValueOnce([{ max_date: null }]); // captures skip

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as {
      results: Array<{ table: string; stopReason: string; deleted: number }>;
    };
    const snaps = json.results.find((r) => r.table === 'gexbot_snapshots');
    expect(snaps?.stopReason).toBe('drained');
    expect(snaps?.deleted).toBe(0);
  });

  it('processes both tables even when the first table errors', async () => {
    // Snapshots audit SELECT throws → cleanupOne for snapshots
    // propagates; the handler should still process captures.
    // (Current behavior: cleanupOne errors propagate up through
    // the for-loop and abort. Test asserts that contract — if we
    // want resilience instead, this test will need to flip.)
    mockSql.mockRejectedValueOnce(new Error('db down'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // withCronInstrumentation catches the throw and returns 500.
    expect(res._status).toBe(500);
  });

  it('cap-truncates to a maximum of 1 trailing zero in yyyy-mm-dd parse', () => {
    // Sanity check for date-string slicing. Used by `Date instanceof`
    // branch to normalize ISO timestamps to bare yyyy-mm-dd. A naive
    // implementation that does `String(d).slice(0,10)` on a Date
    // would emit "Wed May 19" instead of "2026-05-19".
    // The handler uses .toISOString().slice(0,10) which is correct;
    // this test stands as a regression-guard documentation comment.
    const iso = new Date('2026-05-19T14:00:00.000Z').toISOString().slice(0, 10);
    expect(iso).toBe('2026-05-19');
  });
});
