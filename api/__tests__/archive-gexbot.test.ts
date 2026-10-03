// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockRequest, mockResponse } from './helpers';

const {
  mockSql,
  mockSentryCapture,
  mockPut,
  mockHead,
  mockWriteParquet,
  mockSweep,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockPut: vi.fn(),
  mockHead: vi.fn(),
  mockWriteParquet: vi.fn(),
  mockSweep: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

vi.mock('@vercel/blob', () => ({
  put: mockPut,
  head: mockHead,
}));

vi.mock('../_lib/gexbot-parquet.js', () => ({
  writeRowsToParquet: mockWriteParquet,
  sweepStaleTempFiles: mockSweep,
  buildSnapshotSchema: vi.fn(() => ({ snapshot: true })),
  buildCaptureSchema: vi.fn(() => ({ capture: true })),
}));

vi.mock('../_lib/gexbot-archive-dates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/gexbot-archive-dates.js')>()),
  listUnarchivedDates: vi.fn(),
}));

import { listUnarchivedDates } from '../_lib/gexbot-archive-dates.js';
import handler, { config } from '../cron/archive-gexbot.js';

const mockListUnarchived = vi.mocked(listUnarchivedDates);

// Post-close time (Tuesday 21:30 UTC = 4:30pm CT); ET date 2026-03-24
const POST_CLOSE = new Date('2026-03-24T21:30:00.000Z');

const AUTH = { authorization: 'Bearer test-secret' };

/** Both tables report the same pending dates. */
function pendingForBoth(dates: string[]) {
  mockListUnarchived.mockResolvedValue(dates);
}

/** Per-table pending dates, keyed by table name. */
function pendingByTable(byTable: Record<string, string[]>) {
  mockListUnarchived.mockImplementation(
    async (_sql, table) => byTable[table] ?? [],
  );
}

/**
 * Scripts an all-empty-days run: every page and audit INSERT resolves [],
 * parquet/put/head are consistent, and each writeRowsToParquet call
 * advances the mocked clock by `msPerTable`.
 */
function setupEmptyDays(msPerTable = 0) {
  mockSql.mockResolvedValue([]);
  mockWriteParquet.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + msPerTable);
    return { buffer: Buffer.alloc(0), bytes: 0, sha256: 'e', rowCount: 0 };
  });
  mockPut.mockImplementation(async (key: string) => ({
    url: `https://blob.example/${key}`,
    pathname: key,
    contentDisposition: '',
    contentType: '',
  }));
  mockHead.mockResolvedValue({ size: 0 });
}

function archivedKeys(): string[] {
  return mockPut.mock.calls.map((c) => String(c[0]));
}

/**
 * Queues one table's SQL for a run whose parquet writer drains the rows:
 * page 1 (rows), page 2 (empty, terminates), the shrink-guard audit SELECT
 * (no prior row), then the audit INSERT.
 */
function queueTableSql(rowsPerPage: Record<string, unknown>[]) {
  mockSql.mockResolvedValueOnce(rowsPerPage); // page 1
  mockSql.mockResolvedValueOnce([]); // page 2 (terminates)
  mockSql.mockResolvedValueOnce([]); // shrink-guard audit SELECT
  mockSql.mockResolvedValueOnce([]); // audit INSERT
}

/** SQL calls whose text is the audit INSERT, for the given table. */
function auditInsertsFor(table: string): unknown[][] {
  return mockSql.mock.calls.filter(
    (c) =>
      (c[0] as string[])
        .join(' ')
        .includes('INSERT INTO gexbot_archive_audit') && c[1] === table,
  );
}

/**
 * Parquet writer that drains the row stream (so page reads really run),
 * plus put/head mocks whose sizes match a single-row export.
 */
function setupDrainingWriter() {
  mockWriteParquet.mockImplementation(
    async (_unusedSchema, rows: AsyncIterable<Record<string, unknown>>) => {
      // Drain the async iterable to count rows; the real parquet
      // writer's rowCount is the only field downstream code asserts.
      const iter = rows[Symbol.asyncIterator]();
      let count = 0;
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        count += 1;
      }
      const buffer = Buffer.from(`parquet-${count}`);
      return {
        buffer,
        bytes: buffer.length,
        sha256: 'sha-' + count,
        rowCount: count,
      };
    },
  );

  mockPut.mockImplementation(async (key: string, body: Buffer) =>
    Promise.resolve({
      url: `https://blob.example/${key}`,
      pathname: key,
      contentDisposition: '',
      contentType: 'application/vnd.apache.parquet',
      // matching size for HEAD verify
      size: body.length,
    }),
  );

  mockHead.mockImplementation(async (url: string) =>
    // size mirrors the put() body length via our impl above
    Promise.resolve({
      url,
      pathname: url,
      size: Buffer.from('parquet-1').length, // matches single-row stream
      uploadedAt: new Date(),
      contentType: 'application/vnd.apache.parquet',
      contentDisposition: '',
    }),
  );
}

function setupSuccessfulRun(rowsPerPage: Record<string, unknown>[]) {
  queueTableSql(rowsPerPage); // snapshots
  queueTableSql(rowsPerPage); // captures
  setupDrainingWriter();
}

describe('archive-gexbot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    vi.setSystemTime(POST_CLOSE);
    process.env.CRON_SECRET = 'test-secret';
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
    mockSweep.mockResolvedValue(undefined);
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

  it('returns 500 when BLOB_READ_WRITE_TOKEN is unset', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('archives both tables and writes audit rows on happy path', async () => {
    pendingForBoth(['2026-03-23']);
    setupSuccessfulRun([{ id: 1, captured_at: new Date(), ticker: 'SPX' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2, // 1 row per table × 2 tables
      dates: ['2026-03-23'],
      failed: 0,
      remainingDates: 0,
      stopReason: 'drained',
    });
    expect(mockListUnarchived).toHaveBeenCalledWith(
      mockSql,
      'gexbot_snapshots',
      '2026-03-24',
    );
    expect(archivedKeys()).toEqual([
      'gexbot/gexbot_snapshots/2026-03-23.parquet',
      'gexbot/gexbot_api_capture/2026-03-23.parquet',
    ]);
    // 2 put() calls (snapshots + captures)
    expect(mockPut).toHaveBeenCalledTimes(2);
    // 2 head() calls for size verification
    expect(mockHead).toHaveBeenCalledTimes(2);
    expect(mockSentryCapture).not.toHaveBeenCalled();
    // Stale temp files from hard-killed runs are swept first, aged by the
    // function limit.
    expect(mockSweep).toHaveBeenCalledWith(300_000);
    expect(mockSweep.mock.invocationCallOrder[0]).toBeLessThan(
      mockWriteParquet.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('records partial status when one table archive throws', async () => {
    // snapshots succeeds, captures fails on put(). The parquet mock does not
    // drain the row stream, so no page reads are issued.
    pendingForBoth(['2026-03-23']);
    mockSql.mockResolvedValueOnce([]); // snapshots shrink-guard SELECT
    mockSql.mockResolvedValueOnce([]); // snapshots audit INSERT
    mockSql.mockResolvedValueOnce([]); // captures shrink-guard SELECT

    mockWriteParquet.mockResolvedValue({
      buffer: Buffer.from('p'),
      bytes: 1,
      sha256: 'abc',
      rowCount: 1,
    });

    mockPut
      .mockResolvedValueOnce({
        url: 'https://blob.example/gexbot_snapshots',
        pathname: 'x',
        contentDisposition: '',
        contentType: '',
        size: 1,
      })
      .mockRejectedValueOnce(new Error('blob upload denied'));

    mockHead.mockResolvedValueOnce({
      url: 'https://blob.example/gexbot_snapshots',
      pathname: 'x',
      size: 1,
      uploadedAt: new Date(),
      contentType: '',
      contentDisposition: '',
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failed: 1,
      dates: ['2026-03-23'],
    });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'gexbot.cron': 'archive',
        'gexbot.table': 'gexbot_api_capture',
        'gexbot.archive_date': '2026-03-23',
      },
    });
  });

  it('fails only that table when blob HEAD size does not match upload size', async () => {
    pendingForBoth(['2026-03-23']);
    // The parquet mock does not drain the row stream: no page reads.
    mockSql.mockResolvedValueOnce([]); // snapshots shrink-guard SELECT
    mockSql.mockResolvedValueOnce([]); // captures shrink-guard SELECT
    mockSql.mockResolvedValueOnce([]); // captures audit INSERT

    mockWriteParquet.mockResolvedValue({
      buffer: Buffer.from('parquet-data'),
      bytes: 12,
      sha256: 'abc',
      rowCount: 1,
    });

    mockPut.mockResolvedValue({
      url: 'https://blob.example/gexbot_snapshots',
      pathname: 'x',
      contentDisposition: '',
      contentType: '',
      size: 12,
    });

    // HEAD returns the wrong size for snapshots → throws inside
    // archiveOneTable; captures then verifies cleanly.
    const headMeta = {
      url: 'https://blob.example/gexbot_snapshots',
      pathname: 'x',
      uploadedAt: new Date(),
      contentType: '',
      contentDisposition: '',
    };
    mockHead
      .mockResolvedValueOnce({ ...headMeta, size: 999 }) // mismatch!
      .mockResolvedValueOnce({ ...headMeta, size: 12 });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'partial', failed: 1 });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    const captured = mockSentryCapture.mock.calls[0]?.[0] as Error;
    expect(captured.message).toMatch(/size mismatch/i);
    expect(mockSentryCapture).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        'gexbot.cron': 'archive',
        'gexbot.table': 'gexbot_snapshots',
        'gexbot.archive_date': '2026-03-23',
      },
    });

    // Critical: the audit row must NOT be written when HEAD verify
    // fails. cleanup-gexbot.ts uses gexbot_archive_audit as its
    // "safe to delete" signal — recording a bad archive would defeat
    // the safety gate. No INSERT for that table; the other table's lands.
    expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(0);
    expect(auditInsertsFor('gexbot_api_capture')).toHaveLength(1);
  });

  it('archives an empty ?date= day cleanly (still writes audit row with row_count=0)', async () => {
    // Only `?date=` reaches an empty day: the scheduled path picks days
    // with live rows. writeRowsToParquet still produces a (schema-only)
    // buffer and the audit row with row_count=0 still lands so cleanup
    // knows the date is "accounted for". The parquet mock does not drain
    // the row stream, so each table issues only the shrink-guard SELECT and
    // the audit INSERT.
    mockSql.mockResolvedValue([]);

    mockWriteParquet.mockResolvedValue({
      buffer: Buffer.alloc(0),
      bytes: 0,
      sha256: 'empty-sha',
      rowCount: 0,
    });
    mockPut.mockResolvedValue({
      url: 'https://blob.example/empty.parquet',
      pathname: 'x',
      contentDisposition: '',
      contentType: '',
      size: 0,
    });
    mockHead.mockResolvedValue({
      url: 'https://blob.example/empty.parquet',
      pathname: 'x',
      size: 0,
      uploadedAt: new Date(),
      contentType: '',
      contentDisposition: '',
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: { date: '2026-03-23' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    expect(mockPut).toHaveBeenCalledTimes(2);
    // INSERT values: table_name, archive_date, row_count, ...
    for (const table of ['gexbot_snapshots', 'gexbot_api_capture']) {
      expect(auditInsertsFor(table).map((c) => c[3])).toEqual([0]);
    }
  });

  it('fails only that table when its audit INSERT rejects after put and head', async () => {
    pendingForBoth(['2026-03-23']);
    const rows = [{ id: 1, captured_at: new Date(), ticker: 'SPX' }];
    setupDrainingWriter();
    mockSql.mockResolvedValueOnce(rows); // snapshots page 1
    mockSql.mockResolvedValueOnce([]); // snapshots page 2
    mockSql.mockResolvedValueOnce([]); // snapshots shrink-guard SELECT
    mockSql.mockRejectedValueOnce(new Error('audit insert failed')); // INSERT
    queueTableSql(rows); // captures

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failed: 1,
      rows: 1,
      dates: ['2026-03-23'],
    });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'audit insert failed' }),
      {
        tags: {
          'gexbot.cron': 'archive',
          'gexbot.table': 'gexbot_snapshots',
          'gexbot.archive_date': '2026-03-23',
        },
      },
    );
    // The failed INSERT is not retried by the cron; the other table lands.
    expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(1);
    expect(auditInsertsFor('gexbot_api_capture')).toHaveLength(1);
    expect(archivedKeys()).toEqual([
      'gexbot/gexbot_snapshots/2026-03-23.parquet',
      'gexbot/gexbot_api_capture/2026-03-23.parquet',
    ]);
  });

  it('fails only that table when a mid-day page read rejects', async () => {
    pendingForBoth(['2026-03-23']);
    const rows = [{ id: 1, captured_at: new Date(), ticker: 'SPX' }];
    setupDrainingWriter();
    mockSql.mockResolvedValueOnce(rows); // snapshots page 1
    mockSql.mockRejectedValueOnce(new Error('page read failed')); // page 2
    queueTableSql(rows); // captures

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'partial', failed: 1, rows: 1 });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'page read failed' }),
      {
        tags: {
          'gexbot.cron': 'archive',
          'gexbot.table': 'gexbot_snapshots',
          'gexbot.archive_date': '2026-03-23',
        },
      },
    );
    // No Blob and no audit row for the table whose read failed.
    expect(archivedKeys()).toEqual([
      'gexbot/gexbot_api_capture/2026-03-23.parquet',
    ]);
    expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(0);
    expect(auditInsertsFor('gexbot_api_capture')).toHaveLength(1);
  });

  it('reports error, not partial, when every table-date fails', async () => {
    pendingForBoth(['2026-03-20', '2026-03-23']);
    setupEmptyDays(0);
    mockPut.mockRejectedValue(new Error('blob down'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      failed: 4,
      rows: 0,
      dates: ['2026-03-20', '2026-03-23'],
      stopReason: 'drained',
    });
    expect(mockSentryCapture).toHaveBeenCalledTimes(4);
    expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(0);
    expect(auditInsertsFor('gexbot_api_capture')).toHaveLength(0);
  });

  it('issues the audit INSERT with ON CONFLICT UPDATE for idempotent re-runs', async () => {
    // Idempotency invariant: re-running on the same archive_date
    // must UPDATE the existing audit row rather than fail.
    // Verify the SQL shape carries the ON CONFLICT DO UPDATE clause.
    pendingForBoth(['2026-03-23']);
    setupSuccessfulRun([{ id: 1, captured_at: new Date(), ticker: 'SPX' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    // The audit INSERTs are the calls whose SQL contains
    // gexbot_archive_audit. Pull them and verify upsert shape.
    const auditCalls = mockSql.mock.calls.filter((call) => {
      const sqlStrings = (call[0] as string[]) ?? [];
      return sqlStrings.some((s) =>
        s.includes('INSERT INTO gexbot_archive_audit'),
      );
    });
    expect(auditCalls.length).toBe(2); // one per table
    for (const call of auditCalls) {
      const joinedSql = ((call[0] as string[]) ?? []).join(' ');
      expect(joinedSql).toMatch(
        /ON CONFLICT\s*\(\s*table_name,\s*archive_date\s*\)/,
      );
      expect(joinedSql).toMatch(/DO UPDATE SET/);
    }
  });

  describe('catch-up and date override', () => {
    it('stops on the time budget after a slow date and reports the backlog', async () => {
      pendingForBoth(['2026-03-20', '2026-03-21', '2026-03-22']);
      // 100 s per table = 200 s for the first date. Remaining
      // 300 - 200 = 100 s < 1.5 * 200 s + 15 s, so no second date.
      setupEmptyDays(100_000);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        dates: ['2026-03-20'],
        remainingDates: 2,
        stopReason: 'budget',
        failed: 0,
      });
      expect(archivedKeys()).toEqual([
        'gexbot/gexbot_snapshots/2026-03-20.parquet',
        'gexbot/gexbot_api_capture/2026-03-20.parquet',
      ]);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { remainingDates: 2, stopReason: 'budget' },
        'archive-gexbot backlog remains',
      );
    });

    it('archives a whole fast backlog oldest-first and drains', async () => {
      pendingForBoth(['2026-03-20', '2026-03-21', '2026-03-22']);
      setupEmptyDays(1_000);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        status: 'success',
        dates: ['2026-03-20', '2026-03-21', '2026-03-22'],
        remainingDates: 0,
        stopReason: 'drained',
      });
      expect(mockPut).toHaveBeenCalledTimes(6);
      expect(archivedKeys().at(0)).toBe(
        'gexbot/gexbot_snapshots/2026-03-20.parquet',
      );
      expect(archivedKeys().at(-1)).toBe(
        'gexbot/gexbot_api_capture/2026-03-22.parquet',
      );
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('caps a run at MAX_DATES_PER_RUN dates', async () => {
      pendingForBoth([
        '2026-03-16',
        '2026-03-17',
        '2026-03-18',
        '2026-03-19',
        '2026-03-20',
        '2026-03-23',
      ]);
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        status: 'success',
        dates: [
          '2026-03-16',
          '2026-03-17',
          '2026-03-18',
          '2026-03-19',
          '2026-03-20',
        ],
        remainingDates: 1,
        stopReason: 'max_dates',
      });
      expect(mockPut).toHaveBeenCalledTimes(10);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { remainingDates: 1, stopReason: 'max_dates' },
        'archive-gexbot backlog remains',
      );
    });

    it('re-archives only the missing table of a half-archived day', async () => {
      pendingByTable({
        gexbot_snapshots: [],
        gexbot_api_capture: ['2026-03-23'],
      });
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        status: 'success',
        dates: ['2026-03-23'],
        stopReason: 'drained',
      });
      expect(mockWriteParquet).toHaveBeenCalledTimes(1);
      expect(mockWriteParquet.mock.calls[0]?.[0]).toEqual({ capture: true });
      expect(archivedKeys()).toEqual([
        'gexbot/gexbot_api_capture/2026-03-23.parquet',
      ]);
    });

    it('does nothing and reports drained when nothing is pending', async () => {
      pendingForBoth([]);
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 0,
        dates: [],
        remainingDates: 0,
        stopReason: 'drained',
      });
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('archives both tables for ?date= without consulting the helper', async () => {
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: AUTH,
          query: { date: '2026-03-20' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(mockListUnarchived).not.toHaveBeenCalled();
      expect(res._json).toMatchObject({
        status: 'success',
        dates: ['2026-03-20'],
        stopReason: 'drained',
      });
      expect(archivedKeys()).toEqual([
        'gexbot/gexbot_snapshots/2026-03-20.parquet',
        'gexbot/gexbot_api_capture/2026-03-20.parquet',
      ]);
    });

    it('returns 500 and never touches Blob for a malformed ?date=', async () => {
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: AUTH,
          query: { date: '2026-3-2' },
        }),
        res,
      );

      expect(res._status).toBe(500);
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockListUnarchived).not.toHaveBeenCalled();
    });

    it('returns 500 and never touches Blob when listing pending dates fails', async () => {
      mockListUnarchived.mockRejectedValue(new Error('neon down'));
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._status).toBe(500);
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockWriteParquet).not.toHaveBeenCalled();
    });

    it('archives interleaved pending dates in ascending order', async () => {
      pendingByTable({
        gexbot_snapshots: ['2026-03-20', '2026-03-23'],
        gexbot_api_capture: ['2026-03-19', '2026-03-23'],
      });
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        dates: ['2026-03-19', '2026-03-20', '2026-03-23'],
        stopReason: 'drained',
      });
      expect(archivedKeys()).toEqual([
        'gexbot/gexbot_api_capture/2026-03-19.parquet',
        'gexbot/gexbot_snapshots/2026-03-20.parquet',
        'gexbot/gexbot_snapshots/2026-03-23.parquet',
        'gexbot/gexbot_api_capture/2026-03-23.parquet',
      ]);
    });

    it('measures the budget from handler start across dates', async () => {
      pendingForBoth([
        '2026-03-16',
        '2026-03-17',
        '2026-03-18',
        '2026-03-19',
        '2026-03-20',
        '2026-03-23',
      ]);
      // 60 s per date. After date 4, 240 s have elapsed and 60 s remain,
      // which is <= 1.5 * 60 + 15, so the run must stop before date 5.
      setupEmptyDays(30_000);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        dates: ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19'],
        remainingDates: 2,
        stopReason: 'budget',
      });
    });

    it('uses the slowest date so far, not the last, for the next-date estimate', async () => {
      pendingByTable({
        gexbot_snapshots: ['2026-03-16', '2026-03-17', '2026-03-18'],
        gexbot_api_capture: ['2026-03-16'],
      });
      setupEmptyDays(0);
      // Date 1 (both tables) takes 100 s; date 2 (snapshots only) takes
      // 40 s. After date 2: 140 s elapsed, 160 s remain. Last-date rule:
      // 160 > 1.5 * 40 + 15, so date 3 would start. Max rule:
      // 160 <= 1.5 * 100 + 15, so it must stop.
      const advances = [50_000, 50_000, 40_000];
      let call = 0;
      mockWriteParquet.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + (advances[call] ?? 0));
        call += 1;
        return { buffer: Buffer.alloc(0), bytes: 0, sha256: 'e', rowCount: 0 };
      });

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        dates: ['2026-03-16', '2026-03-17'],
        remainingDates: 1,
        stopReason: 'budget',
      });
    });

    it('rejects ?date= equal to today with no Blob put', async () => {
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: AUTH,
          query: { date: '2026-03-24' },
        }),
        res,
      );

      expect(res._status).toBe(500);
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockWriteParquet).not.toHaveBeenCalled();
    });

    it('rejects an impossible calendar date before touching the DB', async () => {
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: AUTH,
          query: { date: '2026-02-31' },
        }),
        res,
      );

      expect(res._status).toBe(500);
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      const err = mockSentryCapture.mock.calls[0]?.[0] as Error;
      expect(err.message).toBe('archive-gexbot: invalid date param');
    });

    it('rejects a repeated ?date= param instead of falling through to catch-up', async () => {
      pendingForBoth(['2026-03-23']);
      setupEmptyDays(0);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: AUTH,
          query: { date: ['2026-03-20', '2026-03-21'] },
        }),
        res,
      );

      expect(res._status).toBe(500);
      expect(mockListUnarchived).not.toHaveBeenCalled();
      expect(mockPut).not.toHaveBeenCalled();
    });

    describe('no path shrinks an existing archive', () => {
      /**
       * The shrink-guard SELECT returns `existing[table]` as `row_count`
       * (a string, the way Neon returns BIGINT), no row when the table is
       * absent, or rejects when it is an Error. Every other call is [].
       */
      function setupAudit(
        existing: Partial<Record<string, string | Error>>,
        freshRows: number,
      ) {
        setupEmptyDays(0);
        mockSql.mockImplementation(
          async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = strings.join(' ');
            if (text.includes('SELECT row_count FROM gexbot_archive_audit')) {
              const audited = existing[String(values[0])];
              if (audited instanceof Error) throw audited;
              return audited === undefined ? [] : [{ row_count: audited }];
            }
            return [];
          },
        );
        mockWriteParquet.mockImplementation(async () => ({
          buffer: Buffer.alloc(0),
          bytes: 0,
          sha256: 'e',
          rowCount: freshRows,
        }));
      }

      async function runOverride() {
        const res = mockResponse();
        await handler(
          mockRequest({
            method: 'GET',
            headers: AUTH,
            query: { date: '2026-03-23' },
          }),
          res,
        );
        return res;
      }

      it('fails a table whose fresh export is smaller than the audited count', async () => {
        setupAudit(
          { gexbot_snapshots: '1000', gexbot_api_capture: '1000' },
          10,
        );

        const res = await runOverride();

        // Both table-dates refused, so every attempt failed: error.
        expect(res._json).toMatchObject({ status: 'error', failed: 2 });
        expect(mockPut).not.toHaveBeenCalled();
        const err = mockSentryCapture.mock.calls[0]?.[0] as Error;
        expect(err.message).toMatch(/1000 rows/);
        expect(err.message).toMatch(/fresh export has 10/);
        expect(mockSentryCapture).toHaveBeenCalledWith(expect.any(Error), {
          tags: {
            'gexbot.cron': 'archive',
            'gexbot.table': 'gexbot_snapshots',
            'gexbot.archive_date': '2026-03-23',
          },
        });
        const auditWrites = mockSql.mock.calls.filter((c) =>
          (c[0] as string[]).join(' ').includes('INSERT INTO'),
        );
        expect(auditWrites).toHaveLength(0);
      });

      it('refuses a shrink on the scheduled path too', async () => {
        pendingForBoth(['2026-03-23']);
        setupAudit({ gexbot_snapshots: '1000' }, 10);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

        expect(res._json).toMatchObject({ status: 'partial', failed: 1 });
        expect(mockSentryCapture).toHaveBeenCalledTimes(1);
        expect(mockSentryCapture).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringMatching(
              /^Refusing to overwrite gexbot_snapshots 2026-03-23/,
            ),
          }),
          {
            tags: {
              'gexbot.cron': 'archive',
              'gexbot.table': 'gexbot_snapshots',
              'gexbot.archive_date': '2026-03-23',
            },
          },
        );
        expect(archivedKeys()).toEqual([
          'gexbot/gexbot_api_capture/2026-03-23.parquet',
        ]);
        expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(0);
      });

      it('fails that table by name when the shrink-guard SELECT rejects', async () => {
        pendingForBoth(['2026-03-23']);
        setupAudit({ gexbot_snapshots: new Error('audit select failed') }, 10);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

        expect(res._json).toMatchObject({ status: 'partial', failed: 1 });
        expect(mockSentryCapture).toHaveBeenCalledTimes(1);
        expect(mockSentryCapture).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'audit select failed' }),
          {
            tags: {
              'gexbot.cron': 'archive',
              'gexbot.table': 'gexbot_snapshots',
              'gexbot.archive_date': '2026-03-23',
            },
          },
        );
        // The guard runs before put: no Blob, no audit row for that table.
        expect(archivedKeys()).toEqual([
          'gexbot/gexbot_api_capture/2026-03-23.parquet',
        ]);
        expect(auditInsertsFor('gexbot_snapshots')).toHaveLength(0);
        expect(auditInsertsFor('gexbot_api_capture')).toHaveLength(1);
      });

      it.each([
        ['equal', '10', 10],
        ['smaller', '5', 10],
      ])('archives normally when the audited count is %s', async (_n, e, f) => {
        setupAudit({ gexbot_snapshots: e, gexbot_api_capture: e }, f);

        const res = await runOverride();

        expect(res._json).toMatchObject({ status: 'success', failed: 0 });
        expect(mockPut).toHaveBeenCalledTimes(2);
      });

      it('archives normally when there is no audit row', async () => {
        setupAudit({}, 0);

        const res = await runOverride();

        expect(res._json).toMatchObject({ status: 'success', failed: 0 });
        expect(mockPut).toHaveBeenCalledTimes(2);
      });
    });

    it('gives every parquet write its own temp file name', async () => {
      pendingForBoth(['2026-03-20', '2026-03-21']);
      setupEmptyDays(0);

      await handler(
        mockRequest({ method: 'GET', headers: AUTH }),
        mockResponse(),
      );

      const names = mockWriteParquet.mock.calls.map((c) => String(c[2]));
      expect(new Set(names).size).toBe(4);
      expect(names[0]).toMatch(
        /^gexbot_snapshots_2026-03-20_[0-9a-f-]{36}\.parquet$/,
      );
    });

    it('keeps archiving later dates and the other table after a table failure', async () => {
      pendingForBoth(['2026-03-20', '2026-03-23']);
      setupEmptyDays(0);
      // Fail the snapshots upload on the first date only.
      mockPut.mockImplementationOnce(async () => {
        throw new Error('blob upload denied');
      });

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: AUTH }), res);

      expect(res._json).toMatchObject({
        status: 'partial',
        dates: ['2026-03-20', '2026-03-23'],
        failed: 1,
        stopReason: 'drained',
      });
      expect(mockSentryCapture).toHaveBeenCalledTimes(1);
      expect(mockSentryCapture).toHaveBeenCalledWith(expect.any(Error), {
        tags: {
          'gexbot.cron': 'archive',
          'gexbot.table': 'gexbot_snapshots',
          'gexbot.archive_date': '2026-03-20',
        },
      });
      expect(mockPut).toHaveBeenCalledTimes(4);
    });
  });
});

describe('archive-gexbot config', () => {
  it('matches the maxDuration vercel.json grants the function', () => {
    // The time budget derives MAX_DURATION_MS from `config`, but Vercel
    // enforces vercel.json. If they drift, the budget plans against a limit
    // the platform does not grant.
    const vercel = JSON.parse(
      readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
    ) as { functions: Record<string, { maxDuration?: number }> };
    expect(vercel.functions['api/cron/archive-gexbot.ts']?.maxDuration).toBe(
      config.maxDuration,
    );
  });
});
