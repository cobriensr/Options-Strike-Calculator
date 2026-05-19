// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockUwFetch, mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: mockWithRetry,
  // Use the real mapWithConcurrency — it preserves input-index call
  // order (required by mockUwFetch's mockResolvedValueOnce sequence
  // in setupMocks) and is small/pure enough not to need its own mock.
  mapWithConcurrency: async <T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, idx: number) => Promise<R>,
  ): Promise<R[]> => {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runner = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        const item = items[idx];
        if (item === undefined) continue;
        results[idx] = await worker(item, idx);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, runner),
    );
    return results;
  },
}));

import handler from '../cron/fetch-greek-flow-etf.js';

// ── Fixtures ──────────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-27' };

function makeGreekFlowTick(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-04-27T14:32:00Z',
    ticker: 'SPY',
    total_delta_flow: '5000000',
    dir_delta_flow: '-3000000',
    total_vega_flow: '200000',
    dir_vega_flow: '-100000',
    otm_total_delta_flow: '3000000',
    otm_dir_delta_flow: '-1500000',
    otm_total_vega_flow: '150000',
    otm_dir_vega_flow: '-75000',
    transactions: 4500,
    volume: 120000,
    ...overrides,
  };
}

// expiry-breakdown response shape: { expires, chains, open_interest, volume }.
// (Live API field is `expires`; OpenAPI spec misleadingly says `expiry`.)
// Default: today is NOT in the list (non-expiry day), so per-expiry calls
// are skipped. Tests that exercise the expiry path override this.
const NON_EXPIRY_BREAKDOWN = [
  { expires: '2026-04-29', chains: 100, open_interest: 1000, volume: 5000 },
  { expires: '2026-05-01', chains: 100, open_interest: 1000, volume: 5000 },
];
const EXPIRY_TODAY_BREAKDOWN = [
  { expires: '2026-04-27', chains: 200, open_interest: 5000, volume: 80000 },
  { expires: '2026-04-29', chains: 100, open_interest: 1000, volume: 5000 },
];

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/**
 * Configure mockUwFetch to return responses for the 4 always-fired calls
 * (2 all-DTE greek-flow + 2 expiry-breakdown), in the order Promise.all
 * issues them: SPY all-DTE, QQQ all-DTE, SPY expiry-breakdown,
 * QQQ expiry-breakdown.
 *
 * On expiry days, the handler then issues 2 more calls (SPY then QQQ
 * per-expiry); pass `spyExpiry` / `qqqExpiry` to register those.
 */
function setupMocks(opts: {
  spyAll?: ReturnType<typeof makeGreekFlowTick>[];
  qqqAll?: ReturnType<typeof makeGreekFlowTick>[];
  spyBreakdown?: typeof NON_EXPIRY_BREAKDOWN;
  qqqBreakdown?: typeof NON_EXPIRY_BREAKDOWN;
  spyExpiry?: ReturnType<typeof makeGreekFlowTick>[];
  qqqExpiry?: ReturnType<typeof makeGreekFlowTick>[];
}) {
  mockUwFetch
    .mockResolvedValueOnce(
      opts.spyAll ?? [makeGreekFlowTick({ ticker: 'SPY' })],
    )
    .mockResolvedValueOnce(
      opts.qqqAll ?? [makeGreekFlowTick({ ticker: 'QQQ' })],
    )
    .mockResolvedValueOnce(opts.spyBreakdown ?? NON_EXPIRY_BREAKDOWN)
    .mockResolvedValueOnce(opts.qqqBreakdown ?? NON_EXPIRY_BREAKDOWN);
  if (opts.spyExpiry) mockUwFetch.mockResolvedValueOnce(opts.spyExpiry);
  if (opts.qqqExpiry) mockUwFetch.mockResolvedValueOnce(opts.qqqExpiry);
}

describe('fetch-greek-flow-etf handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    // Default: UPSERT returns one row with was_insert=true (new row)
    mockSql.mockResolvedValue([{ was_insert: true }]);
  });

  // ── Guard delegation ───────────────────────────────────────

  it('exits early without fetching when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('passes auth when CRON_SECRET matches', async () => {
    setupMocks({});
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours gate ─────────────────────────────────────

  it('skips when outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(500).json({ error: 'UW_API_KEY not configured' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Non-expiry day happy path ─────────────────────────────

  it('non-expiry day: fetches all-DTE + expiry-breakdown, skips per-expiry', async () => {
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
      // breakdowns default to NON_EXPIRY_BREAKDOWN (today not in list)
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // 4 UW calls: 2 all-DTE + 2 expiry-breakdown. No per-expiry calls.
    expect(mockUwFetch).toHaveBeenCalledTimes(4);
    // 2 UPSERT calls: 1 per ticker (all-DTE only; per-expiry tick lists are empty).
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({
      job: 'fetch-greek-flow-etf',
      tickers: {
        SPY: {
          all: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
          expiry: null,
        },
        QQQ: {
          all: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
          expiry: null,
        },
      },
    });
  });

  // ── Expiry day happy path ─────────────────────────────────

  it('expiry day: fetches all-DTE + expiry-breakdown + per-expiry for both tickers', async () => {
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
      spyBreakdown: EXPIRY_TODAY_BREAKDOWN,
      qqqBreakdown: EXPIRY_TODAY_BREAKDOWN,
      spyExpiry: [makeGreekFlowTick({ ticker: 'SPY', expiry: '2026-04-27' })],
      qqqExpiry: [makeGreekFlowTick({ ticker: 'QQQ', expiry: '2026-04-27' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // 6 UW calls: 2 all-DTE + 2 expiry-breakdown + 2 per-expiry.
    expect(mockUwFetch).toHaveBeenCalledTimes(6);
    // 4 UPSERT calls: 1 all-DTE + 1 per-expiry per ticker.
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: {
          all: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
          expiry: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
        },
        QQQ: {
          all: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
          expiry: { ticks: 1, inserted: 1, updated: 0, failed: 0 },
        },
      },
    });
  });

  it('expiry day for SPY only: fires per-expiry call for SPY but not QQQ', async () => {
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
      spyBreakdown: EXPIRY_TODAY_BREAKDOWN,
      qqqBreakdown: NON_EXPIRY_BREAKDOWN,
      spyExpiry: [makeGreekFlowTick({ ticker: 'SPY' })],
      // qqqExpiry intentionally omitted — handler should not call it
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // 5 UW calls: 4 always + 1 per-expiry (SPY only).
    expect(mockUwFetch).toHaveBeenCalledTimes(5);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { expiry: { ticks: 1 } },
        QQQ: { expiry: null },
      },
    });
  });

  // ── URL coverage ──────────────────────────────────────────

  it('calls all four required URLs (greek-flow + expiry-breakdown for both tickers)', async () => {
    setupMocks({});
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(
      urls.some((u) => u.includes('/stock/SPY/greek-flow?date=2026-04-27')),
    ).toBe(true);
    expect(
      urls.some((u) => u.includes('/stock/QQQ/greek-flow?date=2026-04-27')),
    ).toBe(true);
    expect(
      urls.some((u) =>
        u.includes('/stock/SPY/expiry-breakdown?date=2026-04-27'),
      ),
    ).toBe(true);
    expect(
      urls.some((u) =>
        u.includes('/stock/QQQ/expiry-breakdown?date=2026-04-27'),
      ),
    ).toBe(true);
  });

  it('per-expiry URL uses /stock/{ticker}/greek-flow/{today}?date={today} format', async () => {
    setupMocks({
      spyBreakdown: EXPIRY_TODAY_BREAKDOWN,
      qqqBreakdown: EXPIRY_TODAY_BREAKDOWN,
      spyExpiry: [makeGreekFlowTick()],
      qqqExpiry: [makeGreekFlowTick()],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(
      urls.some(
        (u) => u === '/stock/SPY/greek-flow/2026-04-27?date=2026-04-27',
      ),
    ).toBe(true);
    expect(
      urls.some(
        (u) => u === '/stock/QQQ/greek-flow/2026-04-27?date=2026-04-27',
      ),
    ).toBe(true);
  });

  // ── Empty data ────────────────────────────────────────────

  it('handles empty data for both tickers (returns all zeros)', async () => {
    setupMocks({ spyAll: [], qqqAll: [] });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: {
          all: { ticks: 0, inserted: 0, updated: 0, failed: 0 },
          expiry: null,
        },
        QQQ: {
          all: { ticks: 0, inserted: 0, updated: 0, failed: 0 },
          expiry: null,
        },
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── UPSERT (existing-row) path ────────────────────────────

  it('counts existing rows as updated when ON CONFLICT fires', async () => {
    mockSql.mockResolvedValue([{ was_insert: false }]);
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { all: { inserted: 0, updated: 1, failed: 0 } },
        QQQ: { all: { inserted: 0, updated: 1, failed: 0 } },
      },
    });
  });

  // ── Upsert error handling ─────────────────────────────────

  it('counts upsert error as failed; whole handler still returns 200', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB insert failed'));
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { all: { inserted: 0, updated: 0, failed: 1 } },
        QQQ: { all: { inserted: 0, updated: 0, failed: 0 } },
      },
    });
  });

  // ── UW API errors ─────────────────────────────────────────

  it('returns 500 when UW API returns non-ok response', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('UW API 500: Server error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when UW fetch throws a network error', async () => {
    mockWithRetry.mockRejectedValueOnce(new Error('Network error'));
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when expiry-breakdown call fails', async () => {
    // First two withRetry calls (all-DTE SPY/QQQ) succeed; third (SPY
    // expiry-breakdown) rejects. The rejection must propagate up.
    mockWithRetry
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockRejectedValueOnce(new Error('UW expiry-breakdown 500'));
    mockUwFetch.mockResolvedValue([]);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  it('returns 500 when per-expiry call fails on an expiry day', async () => {
    // The first 4 withRetry calls (all-DTE x2 + expiry-breakdown x2) succeed.
    // The 5th (SPY per-expiry) rejects. Phase B failure must propagate too.
    mockWithRetry
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockImplementationOnce((fn: () => unknown) => fn())
      .mockRejectedValueOnce(new Error('UW per-expiry 503'));
    mockUwFetch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(EXPIRY_TODAY_BREAKDOWN)
      .mockResolvedValueOnce(EXPIRY_TODAY_BREAKDOWN);

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
  });

  // ── 8-field INSERT column regression test ────────────────

  it('persists all 8 vega+delta columns plus expiry in the INSERT (field coverage regression)', async () => {
    const tick = makeGreekFlowTick({
      ticker: 'SPY',
      dir_vega_flow: '-100000',
      otm_dir_vega_flow: '-75000',
      total_vega_flow: '200000',
      otm_total_vega_flow: '150000',
      dir_delta_flow: '-3000000',
      otm_dir_delta_flow: '-1500000',
      total_delta_flow: '5000000',
      otm_total_delta_flow: '3000000',
    });
    setupMocks({ spyAll: [tick], qqqAll: [] });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);

    const [strings, ...values] = mockSql.mock.calls[0]!;
    const sqlText = (strings as readonly string[]).join('?');

    // All 8 column names must appear in the SQL, plus the new expiry column.
    expect(sqlText).toContain('dir_vega_flow');
    expect(sqlText).toContain('otm_dir_vega_flow');
    expect(sqlText).toContain('total_vega_flow');
    expect(sqlText).toContain('otm_total_vega_flow');
    expect(sqlText).toContain('dir_delta_flow');
    expect(sqlText).toContain('otm_dir_delta_flow');
    expect(sqlText).toContain('total_delta_flow');
    expect(sqlText).toContain('otm_total_delta_flow');
    expect(sqlText).toContain('expiry');
    // ON CONFLICT clause must reference the new (ticker, timestamp, expiry) key.
    expect(sqlText).toContain('ON CONFLICT (ticker, timestamp, expiry)');

    // Batched UPSERT passes per-column arrays via UNNEST. Flatten the
    // mix of scalars + arrays so we can assert on individual values
    // regardless of which slot they're in.
    const flatValues = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
    expect(flatValues).toContain('-100000'); // dir_vega_flow
    expect(flatValues).toContain('-75000'); // otm_dir_vega_flow
    expect(flatValues).toContain('200000'); // total_vega_flow
    expect(flatValues).toContain('150000'); // otm_total_vega_flow
    expect(flatValues).toContain('-3000000'); // dir_delta_flow
    expect(flatValues).toContain('-1500000'); // otm_dir_delta_flow
    expect(flatValues).toContain('5000000'); // total_delta_flow
    expect(flatValues).toContain('3000000'); // otm_total_delta_flow
    // All-DTE rows pass expiry=null as the scalar parameter (not in any array).
    expect(values).toContain(null);
  });

  // ── Per-expiry insert: expiry value is the date, not null ─

  it('per-expiry INSERT carries expiry=today, not null', async () => {
    setupMocks({
      spyAll: [],
      qqqAll: [],
      spyBreakdown: EXPIRY_TODAY_BREAKDOWN,
      qqqBreakdown: NON_EXPIRY_BREAKDOWN,
      spyExpiry: [makeGreekFlowTick({ ticker: 'SPY' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    const [, ...values] = mockSql.mock.calls[0]!;
    expect(values).toContain('2026-04-27');
    expect(values).not.toContain(null);
  });

  // ── Per-minute granularity preserved through batching ─────

  it('preserves per-minute granularity in a single batched INSERT (no 5-min downsampling)', async () => {
    const tick1 = makeGreekFlowTick({ timestamp: '2026-04-27T14:31:00Z' });
    const tick2 = makeGreekFlowTick({ timestamp: '2026-04-27T14:33:00Z' });
    // Batched UPSERT returns one RETURNING row per input tick.
    mockSql.mockResolvedValueOnce([{ was_insert: true }, { was_insert: true }]);
    setupMocks({ spyAll: [tick1, tick2], qqqAll: [] });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { all: { ticks: 2, inserted: 2, updated: 0, failed: 0 } },
      },
    });
    // One batched UPSERT for SPY (both ticks), zero for QQQ (empty list).
    expect(mockSql).toHaveBeenCalledTimes(1);
    // The single call must carry both timestamps in its payload arrays.
    const [, ...values] = mockSql.mock.calls[0]!;
    const arrayParams = values.filter((v): v is unknown[] => Array.isArray(v));
    const tsArray = arrayParams.find(
      (a) => a.length === 2 && typeof a[0] === 'string' && a[0].includes('T'),
    );
    expect(tsArray).toEqual(['2026-04-27T14:31:00Z', '2026-04-27T14:33:00Z']);
  });
});
