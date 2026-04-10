// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockUwFetch, mockCronGuard, mockCheckDataQuality } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockCheckDataQuality: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  checkDataQuality: mockCheckDataQuality,
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-greek-exposure-strike.js';

// ── Fixture factory ──────────────────────────────────────────

const makeStrikeRow = (
  strike = '6800',
  callGex = '6105.1409',
  putGex = '-699.9181',
) => ({
  date: '2026-04-10',
  expiry: '2026-04-10',
  strike,
  dte: 0,
  call_gex: callGex,
  put_gex: putGex,
  call_delta: '394699.3301',
  put_delta: '-75428.0846',
  call_charm: '-1025514.4594',
  put_charm: '-117569.0952',
  call_vanna: '165653.1431',
  put_vanna: '18991.1969',
});

// ── Helpers ──────────────────────────────────────────────────

/** Default guard result returned by a passing cronGuard mock */
const GUARD = { apiKey: 'test-uw-key', today: '2026-04-10' };


describe('fetch-greek-exposure-strike handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: cronGuard passes
    mockCronGuard.mockReturnValue(GUARD);
    // Default: uwFetch returns empty
    mockUwFetch.mockResolvedValue([]);
    // Default: DB INSERT returns a stored row; data-quality SELECT returns QC_ROW
    mockSql.mockResolvedValue([{ strike: '6800' }]);
    mockCheckDataQuality.mockResolvedValue(undefined);
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when cronGuard returns null (not authorized)', async () => {
    // cronGuard already wrote the 401 response and returned null
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    // uwFetch must never be called when guard fails
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Empty API response ─────────────────────────────────────

  it('returns 200 when no rows are fetched (empty API response)', async () => {
    mockUwFetch.mockResolvedValue([]);
    // No INSERT rows needed; data-quality SELECT still runs
    mockSql.mockResolvedValue([{ total: '0', nonzero: '0' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 0, stored: 0, skipped: 0 });
    // Data-quality SELECT still fires even with zero rows
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCheckDataQuality).toHaveBeenCalledOnce();
  });

  // ── Happy path: store with computed values ─────────────────

  it('returns 200 and stores rows with correct computed values', async () => {
    const row = makeStrikeRow('6800', '6105.1409', '-699.9181');
    mockUwFetch.mockResolvedValue([row]);

    // INSERT RETURNING → stored; QC SELECT
    mockSql
      .mockResolvedValueOnce([{ strike: '6800' }]) // INSERT → stored
      .mockResolvedValueOnce([{ total: '1', nonzero: '1' }]); // QC SELECT

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 1, stored: 1, skipped: 0 });

    // Verify INSERT was called (mockSql is the tagged-template function)
    expect(mockSql).toHaveBeenCalledTimes(2);

    // Inspect the SQL call to verify computed columns were passed
    // mockSql is called as a tagged template: mockSql`...`(values...)
    // The values array is the second argument received by the mock
    const insertCall = mockSql.mock.calls[0]!;
    // Tagged template: first arg is the strings array, rest are interpolated values
    const values = insertCall.slice(1);

    const callGex = 6105.1409;
    const putGex = -699.9181;
    const expectedNetGex = callGex + putGex;
    const expectedAbsGex = Math.abs(callGex) + Math.abs(putGex);
    const expectedCallGexFraction = callGex / expectedAbsGex;

    // net_gex
    expect(values).toContain(expectedNetGex);
    // abs_gex
    expect(values).toContain(expectedAbsGex);
    // call_gex_fraction
    expect(
      values.some(
        (v: unknown) =>
          typeof v === 'number' &&
          Math.abs((v as number) - expectedCallGexFraction) < 1e-9,
      ),
    ).toBe(true);
  });

  // ── Zero-GEX filter ────────────────────────────────────────

  it('filters out zero-GEX strikes (call_gex and put_gex both 0.0000)', async () => {
    const zeroRow = makeStrikeRow('5000', '0.0000', '0.0000');
    const validRow = makeStrikeRow('6800', '6105.1409', '-699.9181');
    mockUwFetch.mockResolvedValue([zeroRow, validRow]);

    mockSql
      .mockResolvedValueOnce([{ strike: '6800' }]) // INSERT for validRow
      .mockResolvedValueOnce([{ total: '1', nonzero: '1' }]); // QC SELECT

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // fetched = 2 (raw from API), stored = 1 (zeroRow excluded before INSERT)
    expect(res._json).toMatchObject({ fetched: 2, stored: 1, skipped: 0 });

    // Only one INSERT should have fired (the valid row)
    // First mockSql call = INSERT, second = QC SELECT
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('keeps a strike where only call_gex is 0.0000 (put_gex is non-zero)', async () => {
    const halfZeroRow = makeStrikeRow('6500', '0.0000', '-1234.5678');
    mockUwFetch.mockResolvedValue([halfZeroRow]);

    mockSql
      .mockResolvedValueOnce([{ strike: '6500' }])
      .mockResolvedValueOnce([{ total: '1', nonzero: '1' }]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 1, stored: 1 });
  });

  // ── DB error ───────────────────────────────────────────────

  it('returns 500 on unexpected DB error and reports via Sentry', async () => {
    const { Sentry } = await import('../_lib/sentry.js');
    const { default: logger } = await import('../_lib/logger.js');

    const row = makeStrikeRow();
    mockUwFetch.mockResolvedValue([row]);

    // Make withRetry (which calls storeStrikeRows) propagate the error by
    // having the INSERT throw and also the QC SELECT throw so the outer try/catch fires.
    // We re-override withRetry for this test to propagate errors as the real impl would.
    const { withRetry } = await import('../_lib/api-helpers.js');
    vi.mocked(withRetry).mockImplementationOnce(async (fn) => {
      // first withRetry call = uwFetch — let it succeed
      return fn();
    });
    vi.mocked(withRetry).mockImplementationOnce(async () => {
      // second withRetry call = storeStrikeRows — throw
      throw new Error('DB connection lost');
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'fetch-greek-exposure-strike',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});
