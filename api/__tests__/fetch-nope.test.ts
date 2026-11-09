// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// fetch-nope now uses bulkUpsert, which calls sql.query() internally
// rather than the tagged-template form. We keep `mockSql` callable so
// tests asserting "no SQL call" still work via the function-call count.
const mockQuery = vi.fn().mockResolvedValue([]);
const mockSql = Object.assign(vi.fn(), { query: mockQuery });

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler, { type UwNopeRow } from '../cron/fetch-nope.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ROW: UwNopeRow = {
  timestamp: '2026-04-14T18:46:00Z',
  call_vol: 23421,
  put_vol: 20012,
  stock_vol: 1000000,
  call_delta: '-21257.36',
  put_delta: '-43593.96',
  call_fill_delta: '-28564.02',
  put_fill_delta: '-14947.51',
  nope: '-0.000648',
  nope_fill: '-0.000434',
};

const makeRow = (overrides: Partial<UwNopeRow> = {}): UwNopeRow => ({
  ...SAMPLE_ROW,
  ...overrides,
});

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-14' };

describe('fetch-nope handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockQuery.mockResolvedValue([]);
    mockCronGuard.mockReturnValue(GUARD);
    mockUwFetch.mockResolvedValue([]);
    // The empty-payload rule reads the clock (09:40 ET); pin it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-14T18:46:00Z')); // 14:46 ET
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Happy path ─────────────────────────────────────────────

  it('upserts 3 rows and returns 200 with upserted:3', async () => {
    const rows = [
      makeRow({ timestamp: '2026-04-14T18:45:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:47:00Z' }),
    ];
    mockUwFetch.mockResolvedValueOnce(rows);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      fetched: 3,
      upserted: 3,
    });
    // bulkUpsert collapses N rows into a single sql.query() call.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── Empty UW response ──────────────────────────────────────

  // An empty answer is not a clean run (R4): UW serves the whole session on
  // every call, so no rows during market hours means it has nothing. Skipped,
  // never success; counted always; a Sentry error from 09:40 ET only (before
  // that it is the pre-open / rollover).

  it('after 09:40 ET an empty UW answer is skipped, counted and raised to Sentry as an error, and writes nothing', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      status: 'skipped',
      fetched: 0,
      upserted: 0,
    });
    expect(metrics.increment).toHaveBeenCalledWith('fetch_nope.empty_payload');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-nope: UW returned no NOPE rows (09:40 ET or later)',
      'error',
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-nope',
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('before 09:40 ET an empty UW answer is skipped and counted, but quiet in Sentry', async () => {
    vi.setSystemTime(new Date('2026-04-14T13:35:00Z')); // 09:35 ET
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'skipped', fetched: 0 });
    expect(metrics.increment).toHaveBeenCalledWith('fetch_nope.empty_payload');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── Rule 2 guard: skip rows with zero stock_vol ────────────

  it('skips rows where stock_vol is 0 (undefined NOPE denominator)', async () => {
    const rows = [
      makeRow({ timestamp: '2026-04-14T18:45:00Z', stock_vol: 0 }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
    ];
    mockUwFetch.mockResolvedValueOnce(rows);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, upserted: 1 });
    // 1 valid row → 1 bulk upsert query.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── Fetches SPY, not SPX ───────────────────────────────────

  it('calls UW for SPY (not SPX)', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const calledPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(calledPath).toBe('/stock/SPY/nope');
  });

  // ── Guard rejected ─────────────────────────────────────────

  it('does nothing when cronGuard returns undefined', async () => {
    mockCronGuard.mockReturnValueOnce(undefined);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── Revision log (spec P0.9) ───────────────────────────────

  const authorizedReq = () =>
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });

  it('logs every inserted or changed minute to nope_ticks_revisions under the writer fetch-nope, in the one statement', async () => {
    mockUwFetch.mockResolvedValueOnce([
      makeRow({ timestamp: '2026-04-14T18:45:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
    ]);

    await handler(authorizedReq(), mockResponse());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [stmt, params] = mockQuery.mock.calls[0]!;
    const flat = (stmt as string).replaceAll(/\s+/g, ' ');
    expect(flat).toContain('INSERT INTO nope_ticks_revisions');
    expect(flat).toContain('IS DISTINCT FROM');
    expect((params as unknown[]).at(-1)).toBe('fetch-nope');
  });

  it('never writes ingested_at: the first-ingest time stays, the column default sets it on insert', async () => {
    mockUwFetch.mockResolvedValueOnce([makeRow()]);

    await handler(authorizedReq(), mockResponse());

    const [stmt, params] = mockQuery.mock.calls[0]!;
    expect(stmt).not.toContain('ingested_at');
    // 11 columns for the one row, then the writer.
    expect(params).toHaveLength(12);
  });

  it('reports what the write did: inserted, updated and unchanged, with upserted still the rows sent', async () => {
    mockUwFetch.mockResolvedValueOnce([
      makeRow({ timestamp: '2026-04-14T18:44:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:45:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
    ]);
    // The log insert returns one row per inserted or changed minute.
    mockQuery.mockResolvedValueOnce([{ inserted: true }, { inserted: false }]);

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      fetched: 3,
      upserted: 3,
      inserted: 1,
      updated: 1,
      unchanged: 1,
    });
  });

  it('returns 500 and reports to Sentry, with the error message, when the nope_ticks write fails (R4)', async () => {
    mockUwFetch.mockResolvedValueOnce([makeRow()]);
    mockQuery.mockRejectedValueOnce(
      new Error('relation "nope_ticks_revisions" does not exist'),
    );

    const res = mockResponse();
    await handler(authorizedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      error: 'relation "nope_ticks_revisions" does not exist',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'relation "nope_ticks_revisions" does not exist',
      }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'fetch-nope',
      expect.objectContaining({ status: 'success' }),
    );
  });

  // ── Error handling ─────────────────────────────────────────

  it('returns 500 and reports to Sentry on UW failure', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW 500'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      error: 'UW 500',
    });
  });
});
