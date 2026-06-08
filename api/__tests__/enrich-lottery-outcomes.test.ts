// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { KEPT_RETENTION_DAYS } from '../_lib/constants.js';

const {
  mockSql,
  mockCronGuard,
  mockFetchIntraday,
  mockSimulateInversion,
  mockMetricsIncrement,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCronGuard: vi.fn(),
  mockFetchIntraday: vi.fn(),
  mockSimulateInversion: vi.fn(),
  mockMetricsIncrement: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  // Real best-effort semantics: run the op, swallow any throw (so a prune
  // failure can never fail the cron). Mirrors the real safeDbVoid in db.ts.
  safeDbVoid: async (op: () => Promise<void>): Promise<void> => {
    try {
      await op();
    } catch {
      /* swallowed — db.error metric in the real impl */
    }
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: mockMetricsIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

vi.mock('../_lib/option-intraday.js', () => ({
  fetchAndCacheOptionIntraday: mockFetchIntraday,
}));

vi.mock('../_lib/flow-inversion.js', () => ({
  simulateFlowInversion: mockSimulateInversion,
}));

import handler from '../cron/enrich-lottery-outcomes.js';

const GUARD = { apiKey: 'test-key', today: '2026-05-02' };

/**
 * The tagged-template mock receives the SQL string fragments as its first
 * arg (a TemplateStringsArray). Join them to match against the query text.
 */
function queryText(call: unknown[]): string {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join('') : '';
}

/**
 * Find the retention-prune DELETE among all mockSql calls.
 *
 * NOTE: the neon tagged-template mock receives the SQL string fragments as
 * `call[0]` (a TemplateStringsArray) and each interpolated value as the
 * following positional args. The prune binds `KEPT_RETENTION_DAYS` as a
 * param, so the joined string text holds the structure (DELETE, the strict
 * `<` cutoff, the NY-date anchor, the `::int` cast on the param) while the
 * retention-days value lives in `call[1]`. We assert both sides here.
 *
 * This is the realistic binding under the mock harness — there is no real
 * Postgres, so we verify the generated SQL *shape* + the bound constant
 * rather than executing the DELETE. A future tightening of the cutoff
 * (strict `<` → `<=`, or KEPT_RETENTION_DAYS → 0) changes the asserted
 * shape/value and fails `asserts the strict-< retention cutoff` below.
 */
function findPruneCall(calls: unknown[][]): unknown[] | undefined {
  return calls.find((c) => {
    const text = queryText(c);
    return (
      text.includes('DELETE FROM lottery_kept_tickers') &&
      text.includes('trade_date') &&
      // Strict `<` cutoff is load-bearing: today's rows must survive so the
      // lottery-finder diff-skip can never drop a same-day kept ticker.
      text.includes('<') &&
      !text.includes('<=') &&
      text.includes("AT TIME ZONE 'America/New_York'") &&
      // date − integer (cast param) stays a date; no INTERVAL double-cast.
      text.includes('::int')
    );
  });
}

const baseFire = {
  id: 1,
  optionChainId: 'SPY260502C00500000',
  underlyingSymbol: 'SPY',
  optionType: 'C' as const,
  date: new Date('2026-05-02T00:00:00Z'),
  triggerTimeCt: new Date('2026-05-02T14:29:00Z'),
  entryTimeCt: new Date('2026-05-02T14:30:00Z'),
  entryPrice: 1.5,
  expiry: new Date('2026-05-02'),
};

describe('enrich-lottery-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockReturnValue(GUARD);
    mockFetchIntraday.mockResolvedValue([]);
    mockSimulateInversion.mockReturnValue({
      exitPct: null,
      exitTs: null,
      status: 'no_post_trigger_prices',
    });
  });

  it('enriches fires with post-entry ticks and writes flow_inversion when computable', async () => {
    mockSql.mockResolvedValueOnce([baseFire]); // SELECT fires
    mockSql.mockResolvedValueOnce([
      { executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.6 },
      { executedAt: new Date('2026-05-02T14:32:00Z'), price: 1.8 },
      { executedAt: new Date('2026-05-02T14:33:00Z'), price: 1.7 },
      { executedAt: new Date('2026-05-02T14:40:00Z'), price: 1.9 },
    ]); // SELECT ticks
    mockSql.mockResolvedValueOnce([
      {
        ts: new Date('2026-05-02T14:35:00Z'),
        netCallPrem: '100',
        netPutPrem: '0',
      },
      {
        ts: new Date('2026-05-02T14:36:00Z'),
        netCallPrem: '-50',
        netPutPrem: '0',
      },
    ]); // loadMatchedFlow SELECT
    mockSql.mockResolvedValueOnce([]); // UPDATE
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    mockFetchIntraday.mockResolvedValueOnce([
      { ts: new Date('2026-05-02T14:31:00Z'), mid: 1.55 },
    ]);
    mockSimulateInversion.mockReturnValueOnce({
      exitPct: 12.5,
      exitTs: new Date('2026-05-02T14:45:00Z'),
      status: 'inversion',
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('flow_inversion populated 1'),
    });
    expect(mockFetchIntraday).toHaveBeenCalledWith(
      'test-key',
      'SPY260502C00500000',
      '2026-05-02',
    );
    expect(mockSimulateInversion).toHaveBeenCalled();
    // 4 enrichment queries + 1 retention-prune DELETE.
    expect(mockSql).toHaveBeenCalledTimes(5);

    // The retention prune ran, and ran AFTER the main work (it is the last
    // mockSql call — the UPDATE that lands enrichment is call index 3).
    const calls = mockSql.mock.calls;
    const pruneCall = findPruneCall(calls);
    expect(pruneCall).toBeDefined();
    expect(calls.indexOf(pruneCall!)).toBe(calls.length - 1);
  });

  it('skips fires with no post-entry ticks', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseFire,
        id: 2,
        optionChainId: 'SPY260502P00495000',
        optionType: 'P',
        entryTimeCt: new Date('2026-05-02T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // ticks empty
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('skipped 1'),
    });
    // SELECT fires + SELECT ticks + retention-prune DELETE.
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
    expect(mockFetchIntraday).not.toHaveBeenCalled();
  });

  it('returns early when no unenriched fires exist, but still prunes', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty)
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: 'No unenriched fires',
    });

    // Even on the no-work early return, the retention prune still runs.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  it('still succeeds when the retention prune throws (best-effort)', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → early return path
    // The prune DELETE rejects; safeDbVoid must swallow it so the handler
    // still returns success.
    mockSql.mockRejectedValueOnce(new Error('neon: connection reset'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: 'No unenriched fires',
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(findPruneCall(mockSql.mock.calls)).toBeDefined();
  });

  // ── Never-vanish ↔ retention coupling (round-4 #1/#3/#5/#6) ──────────────
  // These bind the cross-file invariant that makes the lottery-finder
  // diff-skip safe: the retention floor is >= 1 trading day AND the prune
  // uses a strict `<` cutoff referencing KEPT_RETENTION_DAYS, so today's
  // rows always survive. A tightening to `<=`, to today, or to 0 fails here.

  it('keeps KEPT_RETENTION_DAYS >= 1 (never-vanish current-day floor)', () => {
    expect(KEPT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  it('prunes with a strict-< cutoff that binds KEPT_RETENTION_DAYS as the day count', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockResolvedValueOnce([]); // prune DELETE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    const pruneCall = findPruneCall(mockSql.mock.calls);
    expect(pruneCall).toBeDefined();

    // findPruneCall already asserts `<` present and `<=` absent in the SQL
    // string. The retention-days value is bound as the first interpolated
    // param (call[1]) — assert it equals the constant, so a future change to
    // the constant flows through here and a `<=`/today tightening fails above.
    expect(pruneCall![1]).toBe(KEPT_RETENTION_DAYS);
  });

  it('emits the lottery.kept_prune heartbeat metric on a successful prune', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockResolvedValueOnce([]); // prune DELETE succeeds

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(mockMetricsIncrement).toHaveBeenCalledWith('lottery.kept_prune');
  });

  it('does NOT emit the heartbeat when the prune DELETE throws', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT fires (empty) → prune path
    mockSql.mockRejectedValueOnce(new Error('neon: connection reset'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    // safeDbVoid swallows the throw before the metric line runs, so the
    // heartbeat correctly stays flat — exactly the missing-prune signal.
    expect(res._status).toBe(200);
    expect(mockMetricsIncrement).not.toHaveBeenCalledWith('lottery.kept_prune');
  });
});
