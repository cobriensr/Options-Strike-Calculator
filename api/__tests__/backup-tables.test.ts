// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockPut, mockList, mockDel } = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    unsafe: ReturnType<typeof vi.fn>;
  };
  fn.unsafe = vi.fn((raw: string) => raw);
  return {
    mockSql: fn,
    mockPut: vi.fn(),
    mockList: vi.fn(),
    mockDel: vi.fn(),
  };
});

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
    flush: vi.fn(),
  },
}));

vi.mock('@vercel/blob', () => ({
  put: mockPut,
  list: mockList,
  del: mockDel,
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

// withCronCheckin hands its completion check-in to waitUntil; outside a
// Vercel runtime there is nothing to hold open.
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

import handler from '../cron/backup-tables.js';
import { _resetDsnCacheForTest } from '../_lib/cron-instrumentation.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import logger from '../_lib/logger.js';

// Fixed date: Sunday 5 AM UTC (typical cron run). It is after
// PRUNE_PROTECTED_THROUGH (2026-11-15), so the folders these tests list are
// the 4-week rule's to judge; the floor has its own tests below.
const BACKUP_TIME = new Date('2027-03-28T05:00:00.000Z');

const TEST_DSN =
  'https://abcdef0123456789@o111111.ingest.us.sentry.io/4511060900642816';

// The export order is policy, so it is pinned whole. The three revision
// tables come first: once UW restates a value the first-seen number cannot be
// fetched again, so they are the only copy and must land before anything slow
// can starve them. The rest run smallest to largest, so a spent budget costs
// the biggest, re-derivable tables first. strike_exposures (74M rows) is
// absent on purpose.
const TABLE_ORDER = [
  'flow_data_revisions',
  'nope_ticks_revisions',
  'vega_flow_etf_revisions',
  'market_snapshots',
  'analyses',
  'outcomes',
  'positions',
  'lessons',
  'lesson_reports',
  'training_features',
  'day_labels',
  'economic_events',
  'schema_migrations',
  'spot_exposures',
  'flow_data',
  'greek_exposure',
] as const;

const FIRST_TABLE = TABLE_ORDER[0];

// Every Blob call (put, list, del) is aborted this long after the run starts.
const BLOB_DEADLINE_MS = 240_000;

// One folder past the 4-week retention window of BACKUP_TIME (cutoff
// 2027-02-28): the prune would delete it, so a test that expects the prune to
// be skipped can show nothing was listed or deleted.
const STALE_BACKUP = {
  blobs: [
    {
      pathname: 'backups/2027-02-14/market_snapshots.jsonl',
      url: 'https://blob.test/old1',
    },
  ],
};

// The Sentry check-in POSTs are the only fetch this handler makes, so the
// status of each one is what Sentry's cron monitor sees.
const fetchMock = vi.fn<typeof fetch>();

function checkInStatuses(): string[] {
  return fetchMock.mock.calls.map(
    ([, init]) => (JSON.parse(String(init?.body)) as { status: string }).status,
  );
}

// `vi.setSystemTime` without fake timers mocks Date only, as in beforeEach:
// the clock is frozen, so a test moves it by hand.
function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function runBackup() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

// runBackup plus the real milliseconds it took. `vi.setSystemTime` mocks Date
// only, so performance.now() still measures the handler's real timers.
async function runBackupTimed() {
  const start = performance.now();
  const res = await runBackup();
  return { res, elapsedMs: performance.now() - start };
}

// An abort test leaves the Blob call 50 ms. If the deadline in the handler
// were later than the tests assume, the abort would take that much longer.
const MAX_REAL_MS_AT_DEADLINE = 2_000;

describe('backup-tables handler', () => {
  const originalEnv = process.env;
  // The table the handler is querying: `sql.unsafe(name)` is evaluated just
  // before the tagged template runs, so a mock can key on it instead of on
  // call order.
  let currentTable = '';

  // Queries answer instantly, but the one for `table` first moves the frozen
  // clock to `msLeft` before the Blob deadline. The Blob call that follows is
  // then given a real `msLeft` ms by the handler's own timer.
  function jumpNearBlobDeadlineAt(table: string, msLeft: number): void {
    mockSql.mockImplementation(async () => {
      if (currentTable === table) advanceClock(BLOB_DEADLINE_MS - msLeft);
      return [{ id: 1 }];
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    currentTable = '';
    mockSql.unsafe = vi.fn((raw: string) => {
      currentTable = raw;
      return raw;
    });
    mockSql.mockResolvedValue([]);
    mockPut.mockResolvedValue({ url: 'https://blob.test/file' });
    mockList.mockResolvedValue({ blobs: [] });
    mockDel.mockResolvedValue(undefined);
    fetchMock.mockImplementation(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    process.env.SENTRY_DSN = TEST_DSN;
    _resetDsnCacheForTest();
    vi.setSystemTime(BACKUP_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
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

  // ── Table list ────────────────────────────────────────────

  it('exports the tables in the pinned order', async () => {
    await runBackup();

    expect(mockSql.unsafe.mock.calls.map(([name]) => name)).toEqual([
      ...TABLE_ORDER,
    ]);
  });

  it('backs up the three revision tables first and the largest table last', async () => {
    await runBackup();

    const order = mockSql.unsafe.mock.calls.map(([name]) => name);
    expect(order.slice(0, 3).sort()).toEqual([
      'flow_data_revisions',
      'nope_ticks_revisions',
      'vega_flow_etf_revisions',
    ]);
    expect(order.at(-1)).toBe('greek_exposure');
  });

  // strike_exposures is 74M rows (12 GB heap, ~48 GB as JSONL) and grows by
  // ~1M rows per trading day. Paged with OFFSET into one Buffer it killed the
  // function every Sunday after 2026-05-17 (504 at 300 s, or out of memory),
  // before the closing check-in. Its backup is a separate decision.
  it('does not export strike_exposures', async () => {
    mockSql.mockResolvedValue([{ id: 1 }]);

    const res = await runBackup();

    expect(mockSql.unsafe).not.toHaveBeenCalledWith('strike_exposures');
    expect(
      mockPut.mock.calls.some(([path]) => String(path).includes('strike')),
    ).toBe(false);
    const json = res._json as { tables: Record<string, unknown> };
    expect(json.tables).not.toHaveProperty('strike_exposures');
  });

  // ── Happy path: successful backup ─────────────────────────

  it('exports all 16 tables and returns expected response shape', async () => {
    const fakeRow = { id: 1, name: 'test' };
    mockSql.mockResolvedValue([fakeRow]);

    const res = await runBackup();

    expect(res._status).toBe(200);

    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2027-03-28');
    expect(json.totalRows).toBe(16); // 1 row x 16 tables
    expect(json.pruned).toBe(0);
    expect(json.status).toBe('ok');
    expect(json.errors).toBeUndefined();
    expect(json.skipped).toBeUndefined();
    expect(json.unfinished).toBeUndefined();
    expect(json.pruneSkipped).toBeUndefined();

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

    // A complete run is the only one Sentry's monitor sees as ok, and it
    // raises no incomplete-backup error.
    expect(checkInStatuses()).toEqual(['in_progress', 'ok']);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'ok', errors: 0 }),
    );
  });

  it('calls sql tagged template with unsafe table name for each table', async () => {
    mockSql.mockResolvedValue([]);

    await runBackup();

    // 16 tables = 16 tagged-template calls + 16 unsafe interpolations
    expect(mockSql).toHaveBeenCalledTimes(16);
    expect(mockSql.unsafe).toHaveBeenCalledTimes(16);
    expect(mockSql.unsafe).toHaveBeenCalledWith('market_snapshots');
    expect(mockSql.unsafe).toHaveBeenCalledWith('schema_migrations');
    // The revision log (spec P0.8) is the only copy of a first-seen value.
    expect(mockSql.unsafe).toHaveBeenCalledWith('flow_data_revisions');
    // And so are the logs of vega_flow_etf and nope_ticks (spec P0.9).
    expect(mockSql.unsafe).toHaveBeenCalledWith('vega_flow_etf_revisions');
    expect(mockSql.unsafe).toHaveBeenCalledWith('nope_ticks_revisions');
  });

  it('calls put() with correct path, options, and JSONL content', async () => {
    const rows = [
      { id: 1, value: 'alpha' },
      { id: 2, value: 'beta' },
    ];
    mockSql.mockResolvedValue(rows);

    await runBackup();

    // Check the first put call (the first table in the export order)
    const firstCall = mockPut.mock.calls[0]!;
    expect(firstCall[0]).toBe(`backups/2027-03-28/${FIRST_TABLE}.jsonl`);

    // Body is a Buffer to dodge V8's ~512 MiB String.maxLength on large
    // tables (RangeError d758f914 fix). Decode for byte-exact comparison.
    const expectedJsonl =
      JSON.stringify(rows[0]) + '\n' + JSON.stringify(rows[1]);
    expect(Buffer.isBuffer(firstCall[1])).toBe(true);
    expect((firstCall[1] as Buffer).toString('utf-8')).toBe(expectedJsonl);
    // The signal is what lets the run abort a put that outlives the Blob
    // deadline; it is a live signal, not yet aborted, on a healthy run.
    expect(firstCall[2]).toEqual({
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/x-ndjson',
      abortSignal: expect.any(AbortSignal),
    });
    expect(
      mockPut.mock.calls.every(
        ([, , opts]) => (opts as { abortSignal: AbortSignal }).abortSignal,
      ),
    ).toBe(true);
    expect(
      mockPut.mock.calls.some(
        ([, , opts]) =>
          (opts as { abortSignal: AbortSignal }).abortSignal.aborted,
      ),
    ).toBe(false);

    // 16 put calls total
    expect(mockPut).toHaveBeenCalledTimes(16);
  });

  it('computes totalBytes correctly from JSONL content', async () => {
    const row = { id: 1 };
    mockSql.mockResolvedValue([row]);

    const res = await runBackup();

    const json = res._json as Record<string, unknown>;
    // .byteLength (not .length) matches the Buffer body produced by
    // exportTable. ASCII JSON: byteLength === string length; the
    // assertion stays stable across UTF-8 row payloads regardless.
    const expectedPerTable = Buffer.byteLength(JSON.stringify(row));
    // 16 tables, each with one row
    expect(json.totalBytes).toBe(expectedPerTable * 16);
  });

  // SENTRY-EMERALD-DESERT-6T: Vercel Blob's put() rejects empty bodies
  // with "body is required". Empty tables are now skipped — recorded in
  // the results map with rows:0/bytes:0 but never sent to Blob — so the
  // weekly cron stops alerting on tables that simply happen to have no
  // rows this week.
  it('skips put() for empty tables but still records them in results', async () => {
    mockSql.mockResolvedValue([]);

    const res = await runBackup();

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.totalRows).toBe(0);
    expect(json.totalBytes).toBe(0);
    expect(json.errors).toBeUndefined();

    // put() is NOT called when every table is empty.
    expect(mockPut).not.toHaveBeenCalled();

    // Every table still appears in results so a downstream consumer can
    // tell "table absent because empty" vs "table missing because failed".
    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    expect(Object.keys(tables)).toHaveLength(16);
    expect(tables.market_snapshots).toEqual({ rows: 0, bytes: 0 });

    // Happy path with no errors → status 'ok'
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'ok', errors: 0 }),
    );
  });

  // SENTRY-EMERALD-DESERT-6V: Neon's serverless HTTP driver caps the
  // response at 64 MiB. exportTable now pages via LIMIT/OFFSET so a
  // single oversized table can't abort the whole backup row.
  it('pages large tables via LIMIT/OFFSET chunks', async () => {
    // Mock 50001 rows for the first table — should require 2 chunks:
    // [50000 rows] + [1 row]. All other tables stay small (1 row each) →
    // 1 chunk.
    const bigTable: Record<string, unknown>[] = Array.from(
      { length: 50_000 },
      (_, i) => ({ id: i }),
    );
    const tail: Record<string, unknown>[] = [{ id: 50_000 }];
    const small: Record<string, unknown>[] = [{ id: 1 }];

    mockSql
      .mockResolvedValueOnce(bigTable) // first table chunk 1
      .mockResolvedValueOnce(tail) // first table chunk 2
      .mockResolvedValue(small); // every other table chunk 1

    const res = await runBackup();

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    // The first table collected both pages: 50000 + 1 = 50001 rows.
    expect(tables[FIRST_TABLE]!.rows).toBe(50_001);
    // Total = 50001 (first table) + 15 × 1 (every other table)
    expect(json.totalRows).toBe(50_016);
    // 17 sql calls total: 2 for the first table + 1 for each of the
    // remaining 15 tables.
    expect(mockSql).toHaveBeenCalledTimes(17);
  });

  // ── Time budget ───────────────────────────────────────────
  // Vercel kills the function at maxDuration (300 s) before the closing
  // check-in, so Sentry shows only a "timeout" and opens no issue. The loop
  // stops starting tables at 210 s and the run ends loudly instead.

  it('stops starting tables once the time budget is spent and names the rest', async () => {
    // Every query takes 70 s: three tables start (t = 0, 70, 140) and their
    // puts run at t = 70, 140 and 210, before the Blob deadline; at t = 210
    // the budget (210 s) is gone.
    mockSql.mockImplementation(async () => {
      advanceClock(70_000);
      return [{ id: 1 }];
    });

    const res = await runBackup();

    const expectedSkipped = TABLE_ORDER.slice(3);
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockPut).toHaveBeenCalledTimes(3);

    // Never a 2xx: withCronCheckin sends its `error` check-in off the
    // response status, not off the Axiom status.
    expect(res._status).toBe(500);
    const json = res._json as {
      status: string;
      tables: Record<string, unknown>;
      skipped: string[];
      unfinished?: string[];
      errors: string[];
    };
    expect(json.status).toBe('partial');
    expect(Object.keys(json.tables)).toEqual(TABLE_ORDER.slice(0, 3));
    expect(json.skipped).toEqual(expectedSkipped);
    expect(json.unfinished).toBeUndefined();
    for (const table of expectedSkipped) {
      expect(json.errors.some((e) => e.startsWith(`${table}:`))).toBe(true);
    }

    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({
        status: 'partial',
        errors: expectedSkipped.length,
        skippedTables: expectedSkipped,
      }),
    );

    // An error-level Sentry event names every table that is missing.
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(context).toMatchObject({
      level: 'error',
      fingerprint: ['backup-tables', 'incomplete'],
    });
    for (const table of expectedSkipped) expect(message).toContain(table);
    // The pino line names them too: the response and the Axiom event are
    // read later, the log is what shows during the run.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: expectedSkipped, unfinished: [] }),
      'Tables not backed up',
    );
    // withCronCheckin never flushes, so the handler has to.
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
  });

  // The next two tests are one pair that pins the budget to 210_000 ms. The
  // third table starts at 2 x the step: 209_998 ms with a step of 104_999 ms
  // (must run), 210_000 ms with a step of 105_000 ms (must be skipped). Both
  // pass only for a budget of 209_999 or 210_000 ms: a shorter one fails the
  // first test, a longer one fails the second, and so does a `>` where the
  // loop has `>=`.
  it('starts a table 2 ms inside the budget', async () => {
    // Two queries of 104_999 ms: the third table starts at t = 209_998 ms,
    // inside the 210_000 ms budget, and finishes. Nothing is skipped.
    let queries = 0;
    mockSql.mockImplementation(async () => {
      queries += 1;
      if (queries <= 2) advanceClock(104_999);
      return [{ id: 1 }];
    });

    const res = await runBackup();

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(16);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not start a table that would begin exactly at the 210 s budget', async () => {
    // Two queries of 105_000 ms put the third table's start at t = 210_000 ms,
    // on the deadline, so it is skipped. A longer budget (the old 240 s one
    // among them) would start it; the pathological tail (5 s in_progress
    // check-in, one 33 s page, its put, the closing check-in) then no longer
    // fits in 300 s with the margin the 210 s budget keeps.
    let queries = 0;
    mockSql.mockImplementation(async () => {
      queries += 1;
      if (queries <= 2) advanceClock(105_000);
      return [{ id: 1 }];
    });

    const res = await runBackup();

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect((res._json as { skipped: string[] }).skipped).toEqual(
      TABLE_ORDER.slice(2),
    );
  });

  it('stops a table that crosses the time budget mid-table and uploads nothing for it', async () => {
    // The first table has plenty of full pages and each query takes 150 s:
    // page 1 starts at t = 0, page 2 at t = 150, and at t = 300 the budget is
    // gone before page 3. The queue ends after page 4 so a broken guard fails
    // an assertion instead of paging forever.
    const fullPage = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    let queries = 0;
    mockSql.mockImplementation(async () => {
      queries += 1;
      advanceClock(150_000);
      return queries <= 4 ? fullPage : [];
    });

    const res = await runBackup();

    expect(mockSql).toHaveBeenCalledTimes(2);
    // A truncated file would pass for a complete backup, so none is written.
    expect(mockPut).not.toHaveBeenCalled();

    expect(res._status).toBe(500);
    const json = res._json as {
      status: string;
      tables: Record<string, unknown>;
      skipped: string[];
      unfinished: string[];
      errors: string[];
    };
    expect(json.status).toBe('error');
    expect(json.unfinished).toEqual([FIRST_TABLE]);
    expect(json.skipped).toEqual(TABLE_ORDER.slice(1));
    expect(json.tables).toEqual({});
    expect(json.errors.some((e) => e.startsWith(`${FIRST_TABLE}:`))).toBe(true);

    // Nothing was backed up, so the run is an error, not a partial.
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({
        status: 'error',
        unfinishedTables: [FIRST_TABLE],
      }),
    );
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(context).toMatchObject({ level: 'error' });
    expect(message).toContain(FIRST_TABLE);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        skipped: TABLE_ORDER.slice(1),
        unfinished: [FIRST_TABLE],
      }),
      'Tables not backed up',
    );
  });

  // ── Size cap ──────────────────────────────────────────────
  // The whole table sits in memory (the rows, then a second copy in
  // Buffer.concat) inside a 4096 MB function. The 2026-11-01 run died at
  // 4096/4096 MB. A table past the cap ends loudly instead.

  it('stops a table that outgrows the size cap, uploads nothing for it, and goes on', async () => {
    // 49,999 rows of ~11 KB is ~548 MB of JSONL, past the 512 MiB cap. One
    // page, so the time budget is never involved.
    const pad = 'x'.repeat(10_950);
    const hugePage = Array.from({ length: 49_999 }, (_, i) => ({ id: i, pad }));
    mockSql.mockResolvedValueOnce(hugePage).mockResolvedValue([{ id: 1 }]);

    const res = await runBackup();

    expect(res._status).toBe(500);
    const json = res._json as {
      tables: Record<string, unknown>;
      skipped?: string[];
      unfinished: string[];
      errors: string[];
    };
    expect(json.unfinished).toEqual([FIRST_TABLE]);
    expect(json.skipped).toBeUndefined();
    // The size cap does not end the run: the other 15 tables are backed up.
    expect(Object.keys(json.tables)).toEqual(TABLE_ORDER.slice(1));
    expect(mockPut).toHaveBeenCalledTimes(15);
    expect(
      mockPut.mock.calls.some(([path]) => String(path).includes(FIRST_TABLE)),
    ).toBe(false);

    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'partial' }),
    );
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(context).toMatchObject({ level: 'error' });
    expect(message).toContain(FIRST_TABLE);
  }, 60_000);

  // ── Individual table failure ──────────────────────────────

  it('continues when a single table export fails', async () => {
    mockSql.mockImplementation(async () => {
      if (currentTable === 'outcomes') {
        throw new Error('relation "outcomes" does not exist');
      }
      return [{ id: 1 }];
    });
    mockList.mockResolvedValue(STALE_BACKUP);

    const res = await runBackup();

    // A table that did not back up is an error check-in, not an ok one.
    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    expect(json.status).toBe('partial');

    // 15 successful, 1 failed
    const tables = json.tables as Record<string, unknown>;
    expect(Object.keys(tables)).toHaveLength(15);
    expect(tables.outcomes).toBeUndefined();

    // errors array should contain the failed table
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('outcomes');
    expect(errors[0]).toContain('relation "outcomes" does not exist');
    // A DB reject is neither skipped nor unfinished.
    expect(json.skipped).toBeUndefined();
    expect(json.unfinished).toBeUndefined();

    // Sentry should capture the exception itself, not just a count, and
    // flush it: withCronCheckin never does.
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'relation "outcomes" does not exist',
      }),
    );
    expect(Sentry.flush).toHaveBeenCalledTimes(1);

    // put() should only be called 15 times (not for the failed table)
    expect(mockPut).toHaveBeenCalledTimes(15);

    // A backup that is missing a table must not delete the older ones: a
    // table that failed every week would lose its last good copy on the 5th.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect(json.pruned).toBe(0);
    expect(json.pruneSkipped).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { errors: 1 },
      'Pruning skipped, backup incomplete',
    );

    // Partial-failure → status 'partial' so the dashboard reflects reality
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'partial', errors: 1 }),
    );
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
  });

  it('continues when put() fails for a table', async () => {
    mockSql.mockResolvedValue([{ id: 1 }]);
    let putCallCount = 0;
    mockPut.mockImplementation(async () => {
      putCallCount++;
      if (putCallCount === 2) {
        throw new Error('Blob upload failed');
      }
      return { url: 'https://blob.test/file' };
    });
    mockList.mockResolvedValue(STALE_BACKUP);

    const res = await runBackup();

    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;

    // 15 successful tables, 1 failed
    const tables = json.tables as Record<string, unknown>;
    expect(Object.keys(tables)).toHaveLength(15);

    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Blob upload failed');
    expect(errors[0]).toContain(TABLE_ORDER[1]);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Blob upload failed' }),
    );
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect(json.pruneSkipped).toBe(true);
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'partial', errors: 1 }),
    );
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
  });

  it('handles non-Error throws in table export', async () => {
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw 'string error'; // intentional: tests non-Error throw handling
      }
      return [];
    });

    const res = await runBackup();

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown error');
  });

  it('reports multiple table failures', async () => {
    let callCount = 0;
    mockSql.mockImplementation(async () => {
      callCount++;
      // Fail on 1st and 4th tables
      if (callCount === 1 || callCount === 4) {
        throw new Error(`Table ${callCount} failed`);
      }
      return [{ id: 1 }];
    });

    const res = await runBackup();

    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  // ── Blob deadline ─────────────────────────────────────────
  // @vercel/blob retries a failing call up to 10 times with a backoff that
  // does not watch an abort signal, so a degraded Blob would hold the run until
  // Vercel killed it at 300 s, before the closing check-in. Every put, list and
  // del is aborted at the Blob deadline instead, and the run reports it.

  const ABORT_REJECTIONS: [
    string,
    (opts: { abortSignal: AbortSignal }) => unknown,
  ][] = [
    [
      'stuck in its retry backoff (never settles)',
      () => new Promise(() => undefined),
    ],
    [
      'rejects the way @vercel/blob does on abort',
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () =>
            reject(new Error('Vercel Blob: The request was aborted.')),
          );
        }),
    ],
  ];

  it.each(ABORT_REJECTIONS)(
    'aborts a put still running at the Blob deadline and reports the table: %s',
    async (_label, hang) => {
      let signal: AbortSignal | undefined;
      mockPut.mockImplementation(
        (
          _path: unknown,
          _body: unknown,
          opts: { abortSignal: AbortSignal },
        ) => {
          signal = opts.abortSignal;
          return hang(opts);
        },
      );
      jumpNearBlobDeadlineAt(FIRST_TABLE, 50);

      const { res, elapsedMs } = await runBackupTimed();

      // The abort comes ~50 ms after the put starts. A later deadline in the
      // handler than the 240 s these tests assume would make this much slower.
      expect(elapsedMs).toBeLessThan(MAX_REAL_MS_AT_DEADLINE);
      // The signal reached the put and was aborted, so @vercel/blob stops
      // sending instead of retrying in the background.
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      expect(mockPut).toHaveBeenCalledTimes(1);

      expect(res._status).toBe(500);
      const json = res._json as {
        status: string;
        tables: Record<string, unknown>;
        errors: string[];
      };
      expect(json.status).toBe('error');
      expect(json.tables).toEqual({});
      expect(json.errors[0]).toMatch(
        new RegExp(`^${FIRST_TABLE}: .*(aborted|did not finish before)`),
      );

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/aborted|did not finish before/),
        }),
      );
      expect(Sentry.flush).toHaveBeenCalledTimes(1);
      // An incomplete run does not prune.
      expect(mockList).not.toHaveBeenCalled();
      expect(mockDel).not.toHaveBeenCalled();
      expect(checkInStatuses()).toEqual(['in_progress', 'error']);
    },
  );

  it('names the deadline in the error when the put never settles', async () => {
    mockPut.mockImplementation(() => new Promise(() => undefined));
    jumpNearBlobDeadlineAt(FIRST_TABLE, 50);

    const { res, elapsedMs } = await runBackupTimed();

    expect(elapsedMs).toBeLessThan(MAX_REAL_MS_AT_DEADLINE);
    const errors = (res._json as { errors: string[] }).errors;
    expect(errors[0]).toContain(`put backups/2027-03-28/${FIRST_TABLE}.jsonl`);
    expect(errors[0]).toContain('did not finish before the run deadline');
  });

  it('lets a slow put finish when it is inside the Blob deadline', async () => {
    // 500 ms before the deadline, a put that takes 20 ms: not cut off. With
    // the abort tests above (50 ms left, under 2 s real), this pins the
    // deadline to 240 s within about 2 s: an earlier one would abort this put,
    // a later one would stretch those.
    mockPut.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { url: 'https://blob.test/file' };
    });
    jumpNearBlobDeadlineAt(FIRST_TABLE, 500);

    const res = await runBackup();

    const json = res._json as {
      tables: Record<string, unknown>;
      errors: string[];
    };
    expect(Object.keys(json.tables)).toEqual([FIRST_TABLE]);
    expect(json.errors.some((e) => e.startsWith(`${FIRST_TABLE}:`))).toBe(
      false,
    );
    const opts = mockPut.mock.calls[0]![2] as { abortSignal: AbortSignal };
    expect(opts.abortSignal.aborted).toBe(false);
  });

  // A table that starts at 209.9 s with Neon paging for another 33 s reaches
  // its put after 240 s. Starting it would send a doomed upload (up to ~130 MB
  // for greek_exposure) that the race has already given up on.
  it('does not start a put once the Blob deadline has passed', async () => {
    jumpNearBlobDeadlineAt(FIRST_TABLE, -100);

    const res = await runBackup();

    expect(mockPut).not.toHaveBeenCalled();
    expect(res._status).toBe(500);
    const errors = (res._json as { errors: string[] }).errors;
    expect(errors[0]).toContain(`put backups/2027-03-28/${FIRST_TABLE}.jsonl`);
    expect(errors[0]).toContain('did not finish before the run deadline');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('did not finish before the run'),
      }),
    );
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    // An incomplete run does not prune.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
  });

  it('does not start the prune list once the Blob deadline has passed', async () => {
    // The last table is empty (no put), but its query carries the clock past
    // the deadline, so the prune's list must not start.
    mockSql.mockImplementation(async () => {
      if (currentTable === 'greek_exposure') {
        advanceClock(BLOB_DEADLINE_MS + 100);
        return [];
      }
      return [{ id: 1 }];
    });

    const res = await runBackup();

    expect(mockList).not.toHaveBeenCalled();
    expect(res._status).toBe(500);
    const errors = (res._json as { errors: string[] }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('list backups/');
    expect(errors[0]).toContain('did not finish before the run deadline');
  });

  it('does not start the prune del once the Blob deadline has passed', async () => {
    // list() finds a stale folder but takes the clock past the deadline, so
    // the del must not start.
    mockList.mockImplementation(async () => {
      advanceClock(BLOB_DEADLINE_MS + 100);
      return STALE_BACKUP;
    });

    const res = await runBackup();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockDel).not.toHaveBeenCalled();
    expect(res._status).toBe(500);
    const errors = (res._json as { errors: string[] }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('del 1 blobs');
    expect(errors[0]).toContain('did not finish before the run deadline');
  });

  // The deadline timer of a call that finishes in time must be cleared: left
  // armed for 240 s it keeps the table's body alive (~366 MiB across the run).
  it('clears the deadline timer of every Blob call that finishes in time', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      mockSql.mockResolvedValue([{ id: 1 }]);

      await runBackup();

      // The clock is frozen, so exactly the Blob deadline timers are armed for
      // BLOB_DEADLINE_MS: 16 puts and the prune's list (nothing to delete).
      const deadlineTimers = setSpy.mock.calls.flatMap(([, delay], i) =>
        delay === BLOB_DEADLINE_MS ? [setSpy.mock.results[i]!.value] : [],
      );
      expect(deadlineTimers).toHaveLength(17);
      for (const timer of deadlineTimers) {
        expect(clearSpy).toHaveBeenCalledWith(timer);
      }
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it.each(['list', 'del'] as const)(
    'aborts a %s still running at the Blob deadline and reports a pruning error',
    async (call) => {
      // All 16 tables land; the clock reaches the deadline during the last
      // query, so the prune's list (or del) gets 50 ms and then hangs. A del
      // needs something to delete, so list finds a stale folder.
      if (call === 'del') mockList.mockResolvedValue(STALE_BACKUP);
      let signal: AbortSignal | undefined;
      const hang = (...args: unknown[]) => {
        const opts = args.at(-1) as { abortSignal: AbortSignal };
        signal = opts.abortSignal;
        return new Promise(() => undefined);
      };
      if (call === 'list') mockList.mockImplementation(hang);
      else mockDel.mockImplementation(hang);
      jumpNearBlobDeadlineAt('greek_exposure', 50);

      const { res, elapsedMs } = await runBackupTimed();

      expect(elapsedMs).toBeLessThan(MAX_REAL_MS_AT_DEADLINE);
      expect(signal?.aborted).toBe(true);
      expect(res._status).toBe(500);
      const json = res._json as {
        status: string;
        tables: Record<string, unknown>;
        errors: string[];
        pruneSkipped?: boolean;
      };
      // Every table landed; only the prune failed.
      expect(Object.keys(json.tables)).toHaveLength(16);
      expect(json.status).toBe('partial');
      expect(json.pruneSkipped).toBeUndefined();
      expect(json.errors).toHaveLength(1);
      expect(json.errors[0]).toContain('pruning');
      expect(json.errors[0]).toContain(`${call} `);
      expect(json.errors[0]).toContain(
        'did not finish before the run deadline',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('did not finish before'),
        }),
      );
      expect(Sentry.flush).toHaveBeenCalledTimes(1);
      expect(checkInStatuses()).toEqual(['in_progress', 'error']);
    },
  );

  // ── Pruning logic ────────────────────────────────────────

  it('prunes blobs older than 4 weeks', async () => {
    // Current date is 2027-03-28, cutoff = 2027-02-28
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/2027-02-14/market_snapshots.jsonl',
          url: 'https://blob.test/old1',
        },
        {
          pathname: 'backups/2027-02-27/analyses.jsonl',
          url: 'https://blob.test/old2',
        },
        {
          pathname: 'backups/2027-03-21/analyses.jsonl',
          url: 'https://blob.test/recent',
        },
      ],
    });

    const res = await runBackup();

    expect(res._status).toBe(200);
    // list() and del() carry the same abort signal as put().
    expect(mockList).toHaveBeenCalledWith({
      prefix: 'backups/',
      abortSignal: expect.any(AbortSignal),
    });

    // Two old blobs should be deleted
    expect(mockDel).toHaveBeenCalledWith(
      ['https://blob.test/old1', 'https://blob.test/old2'],
      { abortSignal: expect.any(AbortSignal) },
    );

    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(2);
  });

  // The prune deletes the oldest weekly folders, so it runs only after a run
  // that backed up every table. A table that fails every week would otherwise
  // lose its last good copy on the 5th failing run: the folders still holding
  // it age out while the new ones lack it.
  it('does not prune after the table loop stopped on the time budget', async () => {
    // 70 s per query: three tables start and put before the Blob deadline,
    // then the 210 s budget stops the loop.
    mockSql.mockImplementation(async () => {
      advanceClock(70_000);
      return [{ id: 1 }];
    });
    mockList.mockResolvedValue(STALE_BACKUP);

    const res = await runBackup();

    expect(res._status).toBe(500);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
    expect(json.pruneSkipped).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { errors: TABLE_ORDER.length - 3 },
      'Pruning skipped, backup incomplete',
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({
        status: 'partial',
        pruned: 0,
        pruneSkipped: true,
      }),
    );
  });

  it('does not prune after a table was cut off mid-table', async () => {
    const fullPage = Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    let queries = 0;
    mockSql.mockImplementation(async () => {
      queries += 1;
      advanceClock(150_000);
      return queries <= 4 ? fullPage : [];
    });
    mockList.mockResolvedValue(STALE_BACKUP);

    const res = await runBackup();

    expect(mockList).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect((res._json as Record<string, unknown>).pruneSkipped).toBe(true);
  });

  it('prunes again once a run backs up every table', async () => {
    // Last week was incomplete and skipped the prune; this week's clean run
    // makes up for it, so the stale folder goes now.
    mockSql.mockResolvedValue([{ id: 1 }]);
    mockList.mockResolvedValue(STALE_BACKUP);

    const res = await runBackup();

    expect(res._status).toBe(200);
    expect(mockDel).toHaveBeenCalledWith(['https://blob.test/old1'], {
      abortSignal: expect.any(AbortSignal),
    });
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(1);
    expect(json.pruneSkipped).toBeUndefined();
  });

  it('does not delete blobs within retention window', async () => {
    // Current date is 2027-03-28, cutoff = 2027-02-28
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/2027-03-07/analyses.jsonl',
          url: 'https://blob.test/keep1',
        },
        {
          pathname: 'backups/2027-03-14/analyses.jsonl',
          url: 'https://blob.test/keep2',
        },
        {
          pathname: 'backups/2027-03-21/analyses.jsonl',
          url: 'https://blob.test/keep3',
        },
      ],
    });

    const res = await runBackup();

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  // The cutoff is the run's date minus 28 days, counted in UTC days, as it is on
  // Vercel. A local-time count is an hour off when a DST change falls inside
  // the 28 days (2027-03-14 here): on a machine west of UTC the cutoff moved
  // past the cutoff day's own folder and deleted it a day early. A UTC machine
  // passes either way; one on Central time fails it.
  it('keeps the folder dated on the cutoff day and deletes the day before, across a DST change', async () => {
    // Current date is 2027-03-28, cutoff = 2027-02-28
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: 'backups/2027-02-27/analyses.jsonl',
          url: 'https://blob.test/day-before',
        },
        {
          pathname: 'backups/2027-02-28/analyses.jsonl',
          url: 'https://blob.test/cutoff-day',
        },
      ],
    });

    const res = await runBackup();

    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledWith(['https://blob.test/day-before'], {
      abortSignal: expect.any(AbortSignal),
    });
    expect((res._json as Record<string, unknown>).pruned).toBe(1);
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

    const res = await runBackup();

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  it('handles pruning failure without crashing the backup', async () => {
    mockList.mockRejectedValue(new Error('Blob list failed'));

    const res = await runBackup();

    // Retention silently stopping is how the backups went unpruned for six
    // months, so a failed prune is an error check-in too.
    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    // Pruning error appears in errors array
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('Blob list failed');

    // Sentry should capture the pruning error, and flush it: this exception
    // is raised after the table loop, so only a flush after the prune sends it.
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Blob list failed' }),
    );
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);

    // The prune was attempted (all tables backed up), so it was not skipped.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(json.pruneSkipped).toBeUndefined();

    // Backup data should still be present
    expect(json.status).toBe('partial');
    expect(json.totalRows).toBeDefined();
    expect(json.pruned).toBe(0);
  });

  // list() worked and found a folder to delete; the delete itself failed.
  it('surfaces a failed del() of the stale folders as a pruning error', async () => {
    mockList.mockResolvedValue(STALE_BACKUP);
    mockDel.mockRejectedValue(new Error('Blob delete failed'));

    const res = await runBackup();

    expect(mockDel).toHaveBeenCalledWith(['https://blob.test/old1'], {
      abortSignal: expect.any(AbortSignal),
    });
    expect(res._status).toBe(500);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('Blob delete failed');
    // Nothing is reported as deleted, and the prune was attempted, not skipped.
    expect(json.pruned).toBe(0);
    expect(json.pruneSkipped).toBeUndefined();
    // All 16 tables landed and only the prune failed: still 'partial'.
    expect(json.status).toBe('partial');
    expect(Object.keys(json.tables as object)).toHaveLength(16);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Blob delete failed' }),
    );
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
    expect(checkInStatuses()).toEqual(['in_progress', 'error']);
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'partial', errors: 1, pruned: 0 }),
    );
  });

  it('handles non-Error throws in pruning', async () => {
    mockList.mockRejectedValue('blob service down');

    const res = await runBackup();

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('pruning');
    expect(errors[0]).toContain('Unknown');
  });

  // ── Protection floor ─────────────────────────────────────

  // Owner decision 2026-11-12: a folder dated on or before 2026-11-15 is never
  // pruned, whatever its age. Those folders are the only copies of the tables
  // before the October-November repairs. The 4-week rule applies only to
  // folders dated after the floor. Dates here are the ET dates in the folder
  // names; the 4-week cutoff of a run is its date minus 28 days, and no folder
  // in these tests sits on that day (the cutoff day has its own test above).
  // Production folders hold about 9 files, so a folder here holds two or more:
  // a count of files instead of folders then shows.

  function backupFile(date: string, table = 'analyses') {
    return {
      pathname: `backups/${date}/${table}.jsonl`,
      url: `https://blob.test/${date}/${table}`,
    };
  }

  // Two files per weekly folder from `from` through `through`, both inclusive.
  function weeklyFolders(from: string, through: string) {
    const files = [];
    for (
      let day = Date.parse(from);
      day <= Date.parse(through);
      day += 7 * 86_400_000
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      files.push(backupFile(date), backupFile(date, 'outcomes'));
    }
    return files;
  }

  it('deletes nothing on the first complete run, 2026-11-15, even with the folders back to 2026-04-19', async () => {
    // Cutoff 2026-10-18: without the floor the 26 folders 04-19 to 10-11 (52
    // files) go in one del(). The weekly folders stop at 10-11 and skip 10-18
    // and 10-25, so none sits on the cutoff day; 11-01 and 11-08 are inside
    // the 4 weeks.
    vi.setSystemTime(new Date('2026-11-15T05:00:00.000Z'));
    mockSql.mockResolvedValue([{ id: 1 }]);
    mockList.mockResolvedValue({
      blobs: [
        ...weeklyFolders('2026-04-19', '2026-10-11'),
        backupFile('2026-11-01'),
        backupFile('2026-11-01', 'outcomes'),
        backupFile('2026-11-08'),
        backupFile('2026-11-08', 'outcomes'),
        // The folder this run has just written.
        backupFile('2026-11-15', FIRST_TABLE),
      ],
    });

    const res = await runBackup();

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2026-11-15');
    // The prune ran (it was not skipped) and the floor kept every folder.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(json.pruneSkipped).toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
    expect(json.pruned).toBe(0);
    // The 26 folders (not their 52 files) the 4-week rule alone would have
    // deleted.
    expect(logger.info).toHaveBeenCalledWith(
      { foldersKept: 26, protectedThrough: '2026-11-15' },
      'Backup folders kept by the protection floor',
    );
  });

  it('prunes the folders after the floor that the 4-week cutoff has passed, and keeps the floor and older', async () => {
    // 2027-01-10: cutoff 2026-12-13.
    vi.setSystemTime(new Date('2027-01-10T05:00:00.000Z'));
    mockSql.mockResolvedValue([{ id: 1 }]);
    mockList.mockResolvedValue({
      blobs: [
        backupFile('2026-04-19'),
        backupFile('2026-04-19', 'outcomes'),
        backupFile('2026-11-08'),
        backupFile('2026-11-15'),
        backupFile('2026-11-15', 'outcomes'),
        backupFile('2026-11-22'),
        backupFile('2026-11-29'),
        backupFile('2026-12-06'),
        // Inside the 4 weeks: kept by the 4-week rule.
        backupFile('2026-12-20'),
        backupFile('2027-01-03'),
      ],
    });

    const res = await runBackup();

    expect(res._status).toBe(200);
    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledWith(
      [
        'https://blob.test/2026-11-22/analyses',
        'https://blob.test/2026-11-29/analyses',
        'https://blob.test/2026-12-06/analyses',
      ],
      { abortSignal: expect.any(AbortSignal) },
    );
    expect((res._json as Record<string, unknown>).pruned).toBe(3);
    // 04-19, 11-08 and 11-15: three folders (five files) older than the
    // cutoff, kept by the floor.
    expect(logger.info).toHaveBeenCalledWith(
      { foldersKept: 3, protectedThrough: '2026-11-15' },
      'Backup folders kept by the protection floor',
    );
  });

  it('keeps 2026-11-15 and deletes the first day after it', async () => {
    // Every file of a folder is judged by the folder's date. 11-16 is not a
    // weekly folder; it is here to pin the boundary to the day.
    vi.setSystemTime(new Date('2027-01-10T05:00:00.000Z'));
    mockSql.mockResolvedValue([{ id: 1 }]);
    mockList.mockResolvedValue({
      blobs: [
        backupFile('2026-11-14', 'analyses'),
        backupFile('2026-11-15', 'analyses'),
        backupFile('2026-11-15', 'outcomes'),
        backupFile('2026-11-16', 'analyses'),
        backupFile('2026-11-16', 'outcomes'),
        backupFile('2026-11-22', 'analyses'),
      ],
    });

    await runBackup();

    expect(mockDel).toHaveBeenCalledWith(
      [
        'https://blob.test/2026-11-16/analyses',
        'https://blob.test/2026-11-16/outcomes',
        'https://blob.test/2026-11-22/analyses',
      ],
      { abortSignal: expect.any(AbortSignal) },
    );
  });

  it('does not log the floor when it kept nothing', async () => {
    mockList.mockResolvedValue(STALE_BACKUP);

    await runBackup();

    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Backup folders kept by the protection floor',
    );
  });

  // ── Date in backup path ───────────────────────────────────

  it('uses the current date in the backup path', async () => {
    vi.setSystemTime(new Date('2026-12-25T05:00:00.000Z'));
    mockSql.mockResolvedValue([{ id: 1 }]);

    const res = await runBackup();

    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2026-12-25');

    // Verify the path includes the correct date
    const firstPutPath = mockPut.mock.calls[0]![0];
    expect(firstPutPath).toMatch(/^backups\/2026-12-25\//);
  });

  // ── Response structure completeness ───────────────────────

  it('returns all required fields in the response', async () => {
    mockSql.mockResolvedValue([{ id: 1 }]);

    const res = await runBackup();

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
    mockSql.mockResolvedValue([]);
    const res1 = await runBackup();
    expect((res1._json as Record<string, unknown>).errors).toBeUndefined();

    // Error case: errors field present, and with no table backed up the run
    // is an error rather than a partial.
    vi.resetAllMocks();
    fetchMock.mockImplementation(async () => new Response('', { status: 202 }));
    mockSql.mockRejectedValue(new Error('DB down'));
    mockList.mockResolvedValue({ blobs: [] });
    const res2 = await runBackup();
    expect((res2._json as Record<string, unknown>).errors).toBeDefined();
    expect((res2._json as Record<string, unknown>).status).toBe('error');
    expect(res2._status).toBe(500);
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'error', tables: 0 }),
    );
  });
});
