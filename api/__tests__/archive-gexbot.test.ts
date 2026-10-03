// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockSql,
  mockSentryCapture,
  mockPut,
  mockHead,
  mockWriteParquet,
  mockListUnarchived,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockPut: vi.fn(),
  mockHead: vi.fn(),
  mockWriteParquet: vi.fn(),
  mockListUnarchived: vi.fn(),
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
  buildSnapshotSchema: vi.fn(() => ({ snapshot: true })),
  buildCaptureSchema: vi.fn(() => ({ capture: true })),
}));

vi.mock('../_lib/gexbot-archive-dates.js', () => ({
  GEXBOT_ARCHIVE_TABLES: ['gexbot_snapshots', 'gexbot_api_capture'],
  listUnarchivedDates: mockListUnarchived,
}));

import handler from '../cron/archive-gexbot.js';

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
    async (_sql: unknown, table: string) => byTable[table] ?? [],
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

function setupSuccessfulRun(rowsPerPage: Record<string, unknown>[]) {
  // Each table does: page 1 (rows), page 2 (empty), then 1 INSERT.
  // Call order for two tables: page, page, insert, page, page, insert.
  mockSql.mockResolvedValueOnce(rowsPerPage); // snapshots page 1
  mockSql.mockResolvedValueOnce([]); // snapshots page 2 (terminates)
  mockSql.mockResolvedValueOnce([]); // snapshots audit INSERT
  mockSql.mockResolvedValueOnce(rowsPerPage); // captures page 1
  mockSql.mockResolvedValueOnce([]); // captures page 2 (terminates)
  mockSql.mockResolvedValueOnce([]); // captures audit INSERT

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

describe('archive-gexbot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    vi.setSystemTime(POST_CLOSE);
    process.env.CRON_SECRET = 'test-secret';
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
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
  });

  it('records partial status when one table archive throws', async () => {
    // snapshots succeeds, captures fails on put()
    pendingForBoth(['2026-03-23']);
    mockSql.mockResolvedValueOnce([{ id: 1, ticker: 'SPX' }]); // snapshots page 1
    mockSql.mockResolvedValueOnce([]); // snapshots page 2
    mockSql.mockResolvedValueOnce([]); // snapshots audit INSERT
    mockSql.mockResolvedValueOnce([{ id: 1, ticker: 'SPX' }]); // captures page 1
    mockSql.mockResolvedValueOnce([]); // captures page 2

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

  it('throws when blob HEAD size does not match upload size', async () => {
    pendingForBoth(['2026-03-23']);
    mockSql.mockResolvedValueOnce([{ id: 1, ticker: 'SPX' }]); // page 1
    mockSql.mockResolvedValueOnce([]); // page 2 terminates

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

    // HEAD returns wrong size → throws inside archiveOneTable
    mockHead.mockResolvedValue({
      url: 'https://blob.example/gexbot_snapshots',
      pathname: 'x',
      size: 999, // mismatch!
      uploadedAt: new Date(),
      contentType: '',
      contentDisposition: '',
    });

    // captures call set still must satisfy SQL mocks even though
    // snapshots throws — withCronInstrumentation continues per-table.
    mockSql.mockResolvedValueOnce([]); // captures page 1 (empty day)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'partial' });
    expect(mockSentryCapture).toHaveBeenCalled();
    const captured = mockSentryCapture.mock.calls[0]?.[0] as Error;
    expect(captured.message).toMatch(/size mismatch/i);

    // Critical: the audit row must NOT be written when HEAD verify
    // fails. cleanup-gexbot.ts uses gexbot_archive_audit as its
    // "safe to delete" signal — recording a bad archive would defeat
    // the safety gate. Verify no INSERT was issued for that table.
    const sqlCalls = mockSql.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sqlCalls).not.toMatch(/INSERT INTO gexbot_archive_audit/);
  });

  it('archives an empty day cleanly (still writes audit row with row_count=0)', async () => {
    pendingForBoth(['2026-03-23']);
    // No rows to archive → streamRows generator yields nothing →
    // writeRowsToParquet still produces a (schema-only) buffer →
    // audit row with row_count=0 still lands so cleanup knows the
    // date is "accounted for".
    mockSql.mockResolvedValueOnce([]); // snapshots page 1 (empty)
    mockSql.mockResolvedValueOnce([]); // snapshots audit INSERT
    mockSql.mockResolvedValueOnce([]); // captures page 1 (empty)
    mockSql.mockResolvedValueOnce([]); // captures audit INSERT

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
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
    expect(mockPut).toHaveBeenCalledTimes(2);
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

    describe('override never shrinks an existing archive', () => {
      function setupAudit(existing: number | null, freshRows: number) {
        setupEmptyDays(0);
        mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
          const text = strings.join(' ');
          if (text.includes('SELECT row_count FROM gexbot_archive_audit')) {
            return existing === null ? [] : [{ row_count: existing }];
          }
          return [];
        });
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
        setupAudit(1000, 10);

        const res = await runOverride();

        expect(res._json).toMatchObject({ status: 'partial', failed: 2 });
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

      it.each([
        ['equal', 10, 10],
        ['smaller', 5, 10],
      ])('archives normally when the audited count is %s', async (_n, e, f) => {
        setupAudit(e, f);

        const res = await runOverride();

        expect(res._json).toMatchObject({ status: 'success', failed: 0 });
        expect(mockPut).toHaveBeenCalledTimes(2);
      });

      it('archives normally when there is no audit row', async () => {
        setupAudit(null, 0);

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
