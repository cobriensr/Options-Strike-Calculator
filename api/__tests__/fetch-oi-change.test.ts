// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  cronGuard: vi.fn(),
  checkDataQuality: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-oi-change.js';
import { cronGuard, uwFetch, checkDataQuality } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeOiRow(overrides: Record<string, unknown> = {}) {
  return {
    option_symbol: 'SPXW  260403C06500000',
    oi_diff_plain: '1500',
    curr_oi: '25000',
    last_oi: '23500',
    avg_price: '12.50',
    prev_ask_volume: '800',
    prev_bid_volume: '600',
    prev_multi_leg_volume: '200',
    prev_total_premium: '5000000',
    ...overrides,
  };
}

/**
 * Build a transaction mock implementation that captures the bound values
 * of each INSERT issued inside the transaction. Neon's tagged-template
 * signature is (strings, ...values); bound order for oi_changes is:
 *   0 date, 1 option_symbol, 2 strike, 3 isCall, 4 oiDiff, ...
 * Every query resolves to [{ id: 1 }] (stored).
 */
function captureTransaction(sink: Array<Record<string, unknown>>) {
  return async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
    const txnFn = (..._args: unknown[]) => {
      const values = _args.slice(1);
      sink.push({
        date: values[0],
        option_symbol: values[1],
        strike: values[2],
        isCall: values[3],
      });
      return {};
    };
    const queries = fn(txnFn);
    return queries.map(() => [{ id: 1 }]);
  };
}

// ── Lifecycle ─────────────────────────────────────────────

describe('fetch-oi-change cron handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockSql.transaction = mockTransaction;
    // Default: every INSERT in the batch returns a new row (stored).
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ id: 1 }]);
      },
    );
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-04-02',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── cronGuard ───────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Skip when data exists ──────────────────────────────

  it('skips when data already exists for today', async () => {
    // Existing count query
    mockSql.mockResolvedValueOnce([{ cnt: 42 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Data already exists for 2026-04-02 (42 rows)',
    });
    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
  });

  // ── Success path ───────────────────────────────────────

  it('fetches, stores, and returns success on happy path', async () => {
    // Existing count query: no data yet
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const rows = [
      makeOiRow(),
      makeOiRow({
        option_symbol: 'SPXW  260403P05800000',
        oi_diff_plain: '-500',
      }),
    ];
    vi.mocked(uwFetch).mockResolvedValue(rows);

    // Default transaction mock returns [{ id: 1 }] per row → both stored.

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-oi-change',
      date: '2026-04-02',
      total: 2,
      stored: 2,
      skipped: 0,
    });
    expect(res._json).toHaveProperty('durationMs');
    expect(logger.info).toHaveBeenCalled();
  });

  it('counts skipped rows when INSERT returns empty (conflict)', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([makeOiRow()]);

    // INSERT returns empty (ON CONFLICT DO NOTHING)
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => []);
      },
    );

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 1,
    });
  });

  // ── Data quality check ────────────────────────────────

  it('runs data quality check when stored > 10', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    // Create 12 rows to trigger quality check
    const rows = Array.from({ length: 12 }, (_, i) =>
      makeOiRow({ option_symbol: `SPXW  260403C0${6500 + i}000` }),
    );
    vi.mocked(uwFetch).mockResolvedValue(rows);

    // All 12 INSERTs succeed via the default transaction mock.

    // Quality check query
    mockSql.mockResolvedValueOnce([{ total: 12, nonzero: 10 }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 12 });
    expect(vi.mocked(checkDataQuality)).toHaveBeenCalledWith({
      job: 'fetch-oi-change',
      table: 'oi_changes',
      date: '2026-04-02',
      total: 12,
      nonzero: 10,
    });
  });

  it('skips data quality check when stored <= 10', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    const rows = [makeOiRow()];
    vi.mocked(uwFetch).mockResolvedValue(rows);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(vi.mocked(checkDataQuality)).not.toHaveBeenCalled();
  });

  // ── Empty data ────────────────────────────────────────

  it('handles empty API response gracefully', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    vi.mocked(uwFetch).mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      total: 0,
      stored: 0,
      skipped: 0,
    });
  });

  // ── Option symbol parsing ─────────────────────────────

  it('parses call option symbols correctly', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'SPXW  260403C06500000' }),
    ]);

    // Capture the bound values from the INSERT issued inside the transaction.
    const captured: Array<Record<string, unknown>> = [];
    mockTransaction.mockImplementationOnce(captureTransaction(captured));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(captured[0]).toBeDefined();
    expect(captured[0]!.strike).toBe(6500);
    expect(captured[0]!.isCall).toBe(true);
  });

  it('parses put option symbols correctly', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'SPXW  260403P05800000' }),
    ]);

    const captured: Array<Record<string, unknown>> = [];
    mockTransaction.mockImplementationOnce(captureTransaction(captured));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
    expect(captured[0]!.strike).toBe(5800);
    expect(captured[0]!.isCall).toBe(false);
  });

  it('handles unparseable option symbols with null strike/isCall', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({ option_symbol: 'INVALID_SYMBOL' }),
    ]);

    const captured: Array<Record<string, unknown>> = [];
    mockTransaction.mockImplementationOnce(captureTransaction(captured));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
    expect(captured[0]!.strike).toBeNull();
    expect(captured[0]!.isCall).toBeNull();
  });

  // ── Numeric parsing edge cases ────────────────────────

  it('handles non-numeric field values gracefully', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([
      makeOiRow({
        oi_diff_plain: 'not-a-number',
        curr_oi: '',
        last_oi: null,
        avg_price: '',
        prev_total_premium: 'bad',
      }),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: 1 });
  });

  // ── Error handling ────────────────────────────────────

  it('returns 500 and captures exception on API fetch error', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    const err = new Error('UW API timeout');
    vi.mocked(uwFetch).mockRejectedValue(err);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'fetch-oi-change');
    expect(logger.error).toHaveBeenCalled();
  });

  it('soft-degrades to stored:0/skipped:all when the insert transaction aborts', async () => {
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);

    vi.mocked(uwFetch).mockResolvedValue([makeOiRow(), makeOiRow()]);
    // The whole batched transaction round-trip fails (e.g. connection drop).
    mockTransaction.mockRejectedValueOnce(new Error('connection refused'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    // storeOiChanges catches the transaction error, reports it to Sentry,
    // and returns a soft-degraded result rather than crashing the cron.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: 0,
      skipped: 2,
    });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Batch oi_changes insert failed',
    );
  });

  it('returns 500 on DB read error (existing count check)', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB unavailable'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
