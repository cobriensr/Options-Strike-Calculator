// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
import { Sentry, metrics } from '../_lib/sentry.js';

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

  // ── Partial failure isolation (BE-CRON-H4) ───────────────
  //
  // Per-leg failures are now isolated: a single rejected UW leg no longer
  // aborts its siblings or 500s the whole run. The handler reports
  // status: 'partial' and the healthy legs' data still lands. All issued
  // legs failing reports status: 'error'. These tests prove the healthy
  // leg survives a sibling's rejection.

  it('partial: one Phase A leg fails → status partial, healthy legs still stored', async () => {
    // First withRetry (SPY all-DTE) rejects; the rest pass through.
    mockWithRetry
      .mockRejectedValueOnce(new Error('UW API 500: SPY all-DTE'))
      .mockImplementation((fn: () => unknown) => fn());
    // Remaining Phase A legs: QQQ all-DTE has a tick; both breakdowns empty.
    mockUwFetch
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'QQQ' })]) // QQQ all-DTE
      .mockResolvedValueOnce(NON_EXPIRY_BREAKDOWN) // SPY breakdown
      .mockResolvedValueOnce(NON_EXPIRY_BREAKDOWN); // QQQ breakdown

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      tickers: {
        // SPY all-DTE fetch failed → zero ticks, no upsert.
        SPY: { all: { ticks: 0 } },
        // QQQ's healthy leg survived and was upserted.
        QQQ: { all: { ticks: 1, inserted: 1 } },
      },
    });
    // Healthy QQQ leg still wrote to the DB.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('partial: per-expiry leg failure on an expiry day → status partial, all-DTE legs still stored', async () => {
    // The 4 always-fired Phase A legs succeed; the 5th (SPY per-expiry)
    // rejects. QQQ is not an expiry day, so only SPY per-expiry is issued.
    mockWithRetry
      .mockImplementationOnce((fn: () => unknown) => fn()) // SPY all-DTE
      .mockImplementationOnce((fn: () => unknown) => fn()) // QQQ all-DTE
      .mockImplementationOnce((fn: () => unknown) => fn()) // SPY breakdown
      .mockImplementationOnce((fn: () => unknown) => fn()) // QQQ breakdown
      .mockRejectedValueOnce(new Error('UW per-expiry 503')); // SPY per-expiry
    mockUwFetch
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'SPY' })]) // SPY all-DTE
      .mockResolvedValueOnce([makeGreekFlowTick({ ticker: 'QQQ' })]) // QQQ all-DTE
      .mockResolvedValueOnce(EXPIRY_TODAY_BREAKDOWN) // SPY breakdown (expiry day)
      .mockResolvedValueOnce(NON_EXPIRY_BREAKDOWN); // QQQ breakdown (non-expiry)

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      tickers: {
        SPY: {
          // all-DTE landed despite the per-expiry leg dying.
          all: { ticks: 1, inserted: 1 },
        },
        QQQ: { all: { ticks: 1, inserted: 1 } },
      },
    });
  });

  it('error: every issued Phase A leg fails → status error', async () => {
    // All 4 always-fired Phase A legs reject; no per-expiry legs issued
    // (breakdowns never resolve), so legCount === failureCount === 4.
    mockWithRetry.mockRejectedValue(new Error('UW total outage'));

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    // Handler still returns 200 (the wrapper only 500s on a thrown
    // exception); the degradation is carried by status: 'error'.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      tickers: {
        SPY: { all: { ticks: 0 } },
        QQQ: { all: { ticks: 0 } },
      },
    });
    // No leg produced ticks → no UPSERT writes.
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Persistence-based status (#2 / #6) ───────────────────
  //
  // The store (upsertGreekFlowTicks) CATCHES its own batched-INSERT error
  // and RESOLVES with { inserted: 0, failed: N } instead of throwing. The
  // cron must treat that swallowed total-write loss as a FAILED leg and
  // escalate to Sentry — a green 'success' on zero rows written is total
  // data loss masquerading as healthy.

  it("error: all upserts persist ZERO rows (store swallows) → status 'error', not 'success'", async () => {
    // Both all-DTE scopes have ticks, but every batched UPSERT throws.
    // The store catches each rejection and returns { inserted: 0, failed: N },
    // so the upsert promise FULFILLS — the old rejection-only check missed it.
    mockSql.mockRejectedValue(new Error('DB batch insert failed'));
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
      // non-expiry day → only the 2 all-DTE scopes have input
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Both persistable legs failed to write a single row → hard error.
    expect(res._json).toMatchObject({
      status: 'error',
      tickers: {
        SPY: { all: { ticks: 1, inserted: 0, failed: 1 } },
        QQQ: { all: { ticks: 1, inserted: 0, failed: 1 } },
      },
    });
    // The swallowed total-write loss must be surfaced to Sentry once per
    // failed scope (the store only logs + bumps a metric on its own).
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    const messages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map((c) => String((c[0] as Error)?.message));
    expect(messages.some((m) => m.includes('SPY/all'))).toBe(true);
    expect(messages.some((m) => m.includes('QQQ/all'))).toBe(true);
  });

  it("partial: one scope persists rows, the other writes zero → status 'partial'", async () => {
    // SPY all-DTE upsert succeeds (1 inserted), QQQ all-DTE upsert swallows
    // a total failure. Call order: SPY/all upsert, then QQQ/all upsert.
    mockSql
      .mockResolvedValueOnce([{ was_insert: true }]) // SPY/all → 1 inserted
      .mockRejectedValueOnce(new Error('QQQ DB insert failed')); // QQQ/all → swallowed
    setupMocks({
      spyAll: [makeGreekFlowTick({ ticker: 'SPY' })],
      qqqAll: [makeGreekFlowTick({ ticker: 'QQQ' })],
    });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      tickers: {
        SPY: { all: { ticks: 1, inserted: 1, failed: 0 } },
        QQQ: { all: { ticks: 1, inserted: 0, failed: 1 } },
      },
    });
    // Only the QQQ total-write loss escalates to Sentry.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("all-empty input: every fetch returns empty 200 → status 'success' + all_empty metric", async () => {
    // Both all-DTE fetches succeed but return [] (no ticks). Non-expiry day,
    // so no per-expiry scopes. No fetch failed, no scope had input → no real
    // work. Status stays 'success' but a distinct metric + warn flag the gap.
    setupMocks({ spyAll: [], qqqAll: [] });

    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success' });
    expect(metrics.increment).toHaveBeenCalledWith('greek_flow_etf.all_empty');
    // No data → no upsert, and the empty window is not escalated to Sentry.
    expect(mockSql).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
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
