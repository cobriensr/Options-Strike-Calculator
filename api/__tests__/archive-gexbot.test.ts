// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryCapture, mockPut, mockHead, mockWriteParquet } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockSentryCapture: vi.fn(),
    mockPut: vi.fn(),
    mockHead: vi.fn(),
    mockWriteParquet: vi.fn(),
  }));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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

import handler from '../cron/archive-gexbot.js';

// Post-close time (Tuesday 21:30 UTC = 4:30pm CT)
const POST_CLOSE = new Date('2026-03-24T21:30:00.000Z');

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
    });
    // 2 put() calls (snapshots + captures)
    expect(mockPut).toHaveBeenCalledTimes(2);
    // 2 head() calls for size verification
    expect(mockHead).toHaveBeenCalledTimes(2);
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('records partial status when one table archive throws', async () => {
    // snapshots succeeds, captures fails on put()
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
    expect(res._json).toMatchObject({ status: 'partial' });
    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
  });

  it('throws when blob HEAD size does not match upload size', async () => {
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
});
