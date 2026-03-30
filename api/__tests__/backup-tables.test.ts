// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockUnsafe, mockPut, mockList, mockDel } = vi.hoisted(() => ({
  mockUnsafe: vi.fn(),
  mockPut: vi.fn(),
  mockList: vi.fn(),
  mockDel: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => ({ unsafe: mockUnsafe })),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('@vercel/blob', () => ({
  put: mockPut,
  list: mockList,
  del: mockDel,
}));

import handler from '../cron/backup-tables.js';
import { Sentry } from '../_lib/sentry.js';

// Fixed date: Sunday 5 AM UTC (typical cron run)
const BACKUP_TIME = new Date('2026-03-29T05:00:00.000Z');

describe('backup-tables handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockUnsafe.mockResolvedValue([]);
    mockPut.mockResolvedValue({ url: 'https://blob.test/file' });
    mockList.mockResolvedValue({ blobs: [] });
    mockDel.mockResolvedValue(undefined);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(BACKUP_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  it('returns 405 for PUT requests', async () => {
    const req = mockRequest({ method: 'PUT' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer anything' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  // ── Happy path: successful backup ─────────────────────────

  it('exports all 16 tables and returns expected response shape', async () => {
    const fakeRow = { id: 1, name: 'test' };
    mockUnsafe.mockResolvedValue([fakeRow]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2026-03-29');
    expect(json.totalRows).toBe(16); // 1 row x 16 tables
    expect(json.pruned).toBe(0);
    expect(json.errors).toBeUndefined();

    // All 16 tables should appear in results
    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    expect(Object.keys(tables)).toHaveLength(16);
    expect(tables.market_snapshots).toEqual({
      rows: 1,
      bytes: expect.any(Number),
    });
    expect(tables.schema_migrations).toEqual({
      rows: 1,
      bytes: expect.any(Number),
    });
  });

  it('calls sql.unsafe with SELECT * FROM for each table', async () => {
    mockUnsafe.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // 16 tables = 16 sql.unsafe calls
    expect(mockUnsafe).toHaveBeenCalledTimes(16);
    expect(mockUnsafe).toHaveBeenCalledWith('SELECT * FROM market_snapshots');
    expect(mockUnsafe).toHaveBeenCalledWith('SELECT * FROM schema_migrations');
  });

  it('calls put() with correct path, options, and JSONL content', async () => {
    const rows = [
      { id: 1, value: 'alpha' },
      { id: 2, value: 'beta' },
    ];
    mockUnsafe.mockResolvedValue(rows);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Check the first put call (market_snapshots)
    const firstCall = mockPut.mock.calls[0]!;
    expect(firstCall[0]).toBe('backups/2026-03-29/market_snapshots.jsonl');

    const expectedJsonl =
      JSON.stringify(rows[0]) + '\n' + JSON.stringify(rows[1]);
    expect(firstCall[1]).toBe(expectedJsonl);
    expect(firstCall[2]).toEqual({
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/x-ndjson',
    });

    // 16 put calls total
    expect(mockPut).toHaveBeenCalledTimes(16);
  });

  it('computes totalBytes correctly from JSONL content', async () => {
    const row = { id: 1 };
    mockUnsafe.mockResolvedValue([row]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as Record<string, unknown>;
    const expectedPerTable = JSON.stringify(row).length;
    // 16 tables, each with one row
    expect(json.totalBytes).toBe(expectedPerTable * 16);
  });

  it('handles empty tables (zero rows) gracefully', async () => {
    mockUnsafe.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.totalRows).toBe(0);
    expect(json.totalBytes).toBe(0);
    expect(json.errors).toBeUndefined();

    // put() is still called with empty string for each table
    expect(mockPut).toHaveBeenCalledTimes(16);
    const firstCall = mockPut.mock.calls[0]!;
    expect(firstCall[1]).toBe('');
  });

  // ── Individual table failure ──────────────────────────────

  it('continues when a single table export fails', async () => {
    let callCount = 0;
    mockUnsafe.mockImplementation(async () => {
      callCount++;
      // Fail on the 3rd table (outcomes)
      if (callCount === 3) {
        throw new Error('relation "outcomes" does not exist');
      }
      return [{ id: 1 }];
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;

    // 15 successful, 1 failed
    const tables = json.tables as Record<string, unknown>;
    expect(Object.keys(tables)).toHaveLength(15);
    expect(tables.outcomes).toBeUndefined();

    // errors array should contain the failed table
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('outcomes');
    expect(errors[0]).toContain('relation "outcomes" does not exist');

    // Sentry should capture the exception
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // put() should only be called 15 times (not for the failed table)
    expect(mockPut).toHaveBeenCalledTimes(15);
  });

  it('continues when put() fails for a table', async () => {
    mockUnsafe.mockResolvedValue([{ id: 1 }]);
    let putCallCount = 0;
    mockPut.mockImplementation(async () => {
      putCallCount++;
      if (putCallCount === 2) {
        throw new Error('Blob upload failed');
      }
      return { url: 'https://blob.test/file' };
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;

    // 15 successful tables, 1 failed
    const tables = json.tables as Record<string, unknown>;
    expect(Object.keys(tables)).toHaveLength(15);

    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Blob upload failed');
  });

  it('handles non-Error throws in table export', async () => {
    let callCount = 0;
    mockUnsafe.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw 'string error';
      }
      return [];
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown error');
  });

  it('reports multiple table failures', async () => {
    let callCount = 0;
    mockUnsafe.mockImplementation(async () => {
      callCount++;
      // Fail on 1st and 4th tables
      if (callCount === 1 || callCount === 4) {
        throw new Error(`Table ${callCount} failed`);
      }
      return [{ id: 1 }];
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  // ── Pruning logic ────────────────────────────────────────

  it('prunes blobs older than 4 weeks', async () => {
    // Current date is 2026-03-29, cutoff = 2026-03-01
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/2026-02-15/market_snapshots.jsonl',
          url: 'https://blob.test/old1',
        },
        {
          pathname: 'backups/2026-02-28/analyses.jsonl',
          url: 'https://blob.test/old2',
        },
        {
          pathname: 'backups/2026-03-22/analyses.jsonl',
          url: 'https://blob.test/recent',
        },
      ],
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({ prefix: 'backups/' });

    // Two old blobs should be deleted
    expect(mockDel).toHaveBeenCalledWith([
      'https://blob.test/old1',
      'https://blob.test/old2',
    ]);

    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(2);
  });

  it('does not delete blobs within retention window', async () => {
    // Current date is 2026-03-29, cutoff = 2026-03-01
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/2026-03-08/analyses.jsonl',
          url: 'https://blob.test/keep1',
        },
        {
          pathname: 'backups/2026-03-15/analyses.jsonl',
          url: 'https://blob.test/keep2',
        },
        {
          pathname: 'backups/2026-03-22/analyses.jsonl',
          url: 'https://blob.test/keep3',
        },
      ],
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  it('skips blobs with non-matching pathname format', async () => {
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/not-a-date/file.jsonl',
          url: 'https://blob.test/weird',
        },
        {
          pathname: 'other-prefix/2020-01-01/file.jsonl',
          url: 'https://blob.test/other',
        },
      ],
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  it('handles pruning failure without crashing the backup', async () => {
    mockList.mockRejectedValue(new Error('Blob list failed'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    // Pruning error appears in errors array
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('Blob list failed');

    // Sentry should capture the pruning error
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // Backup data should still be present
    expect(json.totalRows).toBeDefined();
    expect(json.pruned).toBe(0);
  });

  it('handles non-Error throws in pruning', async () => {
    mockList.mockRejectedValue('blob service down');

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('Unknown');
  });

  // ── Date in backup path ───────────────────────────────────

  it('uses the current date in the backup path', async () => {
    vi.setSystemTime(new Date('2026-12-25T05:00:00.000Z'));
    mockUnsafe.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2026-12-25');

    // Verify the path includes the correct date
    const firstPutPath = mockPut.mock.calls[0]![0];
    expect(firstPutPath).toMatch(/^backups\/2026-12-25\//);
  });

  // ── Response structure completeness ───────────────────────

  it('returns all required fields in the response', async () => {
    mockUnsafe.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    const json = res._json as Record<string, unknown>;
    expect(json).toHaveProperty('date');
    expect(json).toHaveProperty('tables');
    expect(json).toHaveProperty('totalRows');
    expect(json).toHaveProperty('totalBytes');
    expect(json).toHaveProperty('pruned');
    // errors should be undefined when there are none
    expect(json.errors).toBeUndefined();
  });

  it('includes errors field only when there are errors', async () => {
    // Success case: no errors field
    mockUnsafe.mockResolvedValue([]);
    const req1 = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res1 = mockResponse();
    await handler(req1, res1);
    expect((res1._json as Record<string, unknown>).errors).toBeUndefined();

    // Error case: errors field present
    vi.resetAllMocks();
    mockUnsafe.mockRejectedValue(new Error('DB down'));
    mockList.mockResolvedValue({ blobs: [] });
    const req2 = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res2 = mockResponse();
    await handler(req2, res2);
    expect((res2._json as Record<string, unknown>).errors).toBeDefined();
  });
});
