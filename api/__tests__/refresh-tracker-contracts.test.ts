// @vitest-environment node

/**
 * Tests for api/cron/refresh-tracker-contracts.ts — the cron that refreshes
 * tracked option contracts every 5 min during market hours, inserts a new
 * tick row, and fires threshold alerts.
 *
 * Spec: docs/superpowers/specs/contract-tracker-2026-05-17.md
 *
 * Mocking strategy:
 *   - `db.js`           — shared `mockSql` queue; tests push DB results in
 *                         the order the handler consumes them.
 *   - `api-helpers.js`  — re-implemented `cronGuard` + programmable
 *                         `uwFetch`/`withRetry`. Matches the pattern in
 *                         cron-fetch-strike-iv.test.ts.
 *   - `sentry.js`       — capture mock so we can assert tag payloads.
 *   - `axiom.js`        — `reportCronRun` no-op; production already
 *                         tolerates failures internally.
 *
 * Coverage:
 *   1. 401 when CRON_SECRET wrong/missing
 *   2. Skip with `Outside time window` when isMarketHours()=false
 *   3. Happy path — 2 contracts → ticks inserted, no alerts
 *   4. Up_pct threshold fires at +52%
 *   5. Alert dedup — running again yields zero new inserts
 *   6. spot_level fires when underlying breaches >= operator
 *   7. dte_7 fires at exactly 7 days to expiry
 *   8. Partial UW failure → other contracts still get ticks + Sentry tag
 *   9. Auto-expiry — past-due row UPDATEs to status='expired'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────────
//
// vi.hoisted() lifts these refs above the vi.mock() factory hoist so they
// are initialized before the factories run. Required because vi.mock is
// hoisted to the very top of the file at transform time.
const { mockSql, mockUwFetch, mockSentryCapture, mockSentryBreadcrumb } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockUwFetch: vi.fn(),
    mockSentryCapture: vi.fn(),
    mockSentryBreadcrumb: vi.fn(),
  }));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: vi.fn(),
    addBreadcrumb: mockSentryBreadcrumb,
  },
  metrics: { uwRateLimit: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

// Programmable api-helpers — match the contract used by the handler and
// the wrapper. uwFetch is exposed as mockUwFetch; withRetry is identity
// (single-attempt for predictable test ordering); cronGuard mirrors prod.
vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: (...args: unknown[]) => mockUwFetch(...args),
  withRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  cronGuard: vi.fn((req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'GET only' });
      return null;
    }
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization ?? '';
    if (!secret || authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    // Faithful in-market-hours check matching the prod cronGuard
    // contract: weekday + 13–21 UTC. Inside-window tests use
    // MARKET_TIME; outside-window tests use OFF_HOURS_TIME.
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const inWindow =
      utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour <= 21;
    if (!inWindow) {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    }
    return {
      apiKey: 'test-api-key',
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

import handler from '../cron/refresh-tracker-contracts.js';

// ── Fixtures ──────────────────────────────────────────────────────

// 2026-05-19 = Tuesday; 14:00 UTC = 10:00 ET → inside market hours.
const MARKET_TIME = new Date('2026-05-19T14:00:00.000Z');
const OFF_HOURS_TIME = new Date('2026-05-19T11:00:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/**
 * Build an active-contracts row in the shape returned by the SELECT.
 */
interface RowOpts {
  id: number;
  occ_symbol: string;
  ticker: string;
  expiry: string;
  entry_price: number;
  up_thresholds?: number[] | null;
  down_thresholds?: number[] | null;
  spot_alerts?: Array<{ op: string; level: number }> | null;
}
function row(opts: RowOpts): Record<string, unknown> {
  return {
    id: opts.id,
    occ_symbol: opts.occ_symbol,
    ticker: opts.ticker,
    // Postgres DATE → string from the driver in test fixtures; the handler
    // tolerates both Date and string.
    expiry: opts.expiry,
    entry_price: opts.entry_price,
    up_thresholds: opts.up_thresholds ?? null,
    down_thresholds: opts.down_thresholds ?? null,
    spot_alerts: opts.spot_alerts ?? null,
  };
}

/**
 * Queue a programmed sequence of `uwFetch` responses. The handler issues:
 *   - one call per unique ticker  (stock-state)
 *   - one call per unique ticker  (/stock/{ticker}/option-contracts —
 *     batched across all OCC symbols held for that ticker)
 * in that order, both via Promise.allSettled. Each entry of `seq` is
 * either an array (resolved value) or a thrown Error (rejected).
 *
 * Option-contract responses use the live UW shape:
 *   [{ option_symbol, last_price, nbbo_bid, nbbo_ask, volume,
 *      open_interest }, …]
 *
 * uwFetch is mocked to always return an array (since the extract
 * callback shape is exercised by the production extract function — we
 * return the post-extract list directly).
 */
type FetchEntry = unknown[] | Error;
function programUwFetch(seq: FetchEntry[]): void {
  mockUwFetch.mockReset();
  for (const entry of seq) {
    if (entry instanceof Error) {
      mockUwFetch.mockRejectedValueOnce(entry);
    } else {
      mockUwFetch.mockResolvedValueOnce(entry);
    }
  }
}

/**
 * Build an option-contract response row in the live UW shape. Helper
 * keeps the test fixtures readable when only a few fields matter.
 *
 * `occSymbol` is normalized (space-stripped, uppercase) to match the
 * `option_symbol` field UW returns and the lookup key the handler
 * uses internally.
 */
function contractRow(
  occSymbol: string,
  fields: {
    last: number;
    bid: number;
    ask: number;
    volume: number;
    openInterest: number;
  },
): Record<string, unknown> {
  return {
    option_symbol: occSymbol.replace(/\s+/g, '').toUpperCase(),
    last_price: fields.last,
    nbbo_bid: fields.bid,
    nbbo_ask: fields.ask,
    volume: fields.volume,
    open_interest: fields.openInterest,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('refresh-tracker-contracts handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ─────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer WRONG' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Market hours skip ──────────────────────────────────────────

  it('skips with "Outside time window" when isMarketHours() returns false', async () => {
    vi.setSystemTime(OFF_HOURS_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────

  it('happy path: 2 contracts × 2 tickers → ticks inserted, no alerts fired', async () => {
    const rows = [
      row({
        id: 1,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        entry_price: 4.3,
      }),
      row({
        id: 2,
        occ_symbol: 'AMD   260605C00150000',
        ticker: 'AMD',
        expiry: '2026-06-05',
        entry_price: 2.0,
      }),
    ];

    // SQL call sequence:
    //   1. SELECT active rows
    //   2. INSERT batched ticks (1 batch)
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]); // tick insert

    // UW sequence: 2 stock-state (NVDA, AMD) then 2 ticker-batched
    // option-contracts calls. Last prices held near entry → no alerts.
    programUwFetch([
      [{ close: 142.5 }], // NVDA stock-state
      [{ close: 158.4 }], // AMD stock-state
      [
        contractRow('NVDA  260522P00225000', {
          last: 4.4,
          bid: 4.3,
          ask: 4.5,
          volume: 100,
          openInterest: 800,
        }),
      ],
      [
        contractRow('AMD   260605C00150000', {
          last: 2.1,
          bid: 2.0,
          ask: 2.2,
          volume: 50,
          openInterest: 400,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      status: string;
      processed: number;
      expired: number;
      ticks_inserted: number;
      alerts_fired: number;
    };
    expect(body).toMatchObject({
      status: 'success',
      processed: 2,
      expired: 0,
      ticks_inserted: 2,
      alerts_fired: 0,
    });
    // SELECT + 1 INSERT (batched).
    expect(mockSql).toHaveBeenCalledTimes(2);
    // 4 UW calls: 2 stock-state + 2 option-contract.
    expect(mockUwFetch).toHaveBeenCalledTimes(4);
  });

  // ── Up-pct alert fires ─────────────────────────────────────────

  it('fires up_pct/50 alert when contract is up +52% vs entry', async () => {
    const rows = [
      row({
        id: 1,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        entry_price: 4.3,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows); // SELECT active
    mockSql.mockResolvedValueOnce([]); // tick insert
    // ON CONFLICT … RETURNING id → one new row for the up_pct/50 alert.
    mockSql.mockResolvedValueOnce([{ id: 11 }]); // up_pct/50 insert (fires)

    // 4.3 × 1.52 = 6.536 → +52% (>= default 50 threshold; < 100 so no 100 fire)
    programUwFetch([
      [{ close: 145.0 }], // NVDA spot
      [
        contractRow('NVDA  260522P00225000', {
          last: 6.54,
          bid: 6.4,
          ask: 6.7,
          volume: 200,
          openInterest: 900,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as { alerts_fired: number };
    expect(body.alerts_fired).toBe(1);
    // Sanity: only one alert INSERT issued (the +50 threshold).
    // The 4th SQL call is the alert insert; earlier ones are SELECT + tick.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Alert dedup ────────────────────────────────────────────────

  it('does not refire up_pct/50 on next run — ON CONFLICT DO NOTHING returns empty', async () => {
    const rows = [
      row({
        id: 1,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        entry_price: 4.3,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows); // SELECT
    mockSql.mockResolvedValueOnce([]); // tick insert
    // The alert would normally fire, but the DB returns [] from RETURNING
    // (ON CONFLICT triggered).
    mockSql.mockResolvedValueOnce([]); // up_pct/50 already exists

    programUwFetch([
      [{ close: 145.0 }],
      [
        contractRow('NVDA  260522P00225000', {
          last: 6.54,
          bid: 6.4,
          ask: 6.7,
          volume: 200,
          openInterest: 900,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as { alerts_fired: number };
    expect(body.alerts_fired).toBe(0);
  });

  // ── Spot-level alert ───────────────────────────────────────────

  it('fires spot_level/595 when underlying >= 595', async () => {
    const rows = [
      row({
        id: 5,
        occ_symbol: 'SPY   260522C00600000',
        ticker: 'SPY',
        expiry: '2026-05-22',
        entry_price: 1.5,
        spot_alerts: [{ op: '>=', level: 595 }],
      }),
    ];

    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]); // tick insert
    mockSql.mockResolvedValueOnce([{ id: 21 }]); // spot_level/595 fires

    programUwFetch([
      [{ close: 596.2 }], // SPY breaches 595
      [
        contractRow('SPY   260522C00600000', {
          last: 1.6,
          bid: 1.5,
          ask: 1.7,
          volume: 1,
          openInterest: 50,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as { alerts_fired: number };
    expect(body.alerts_fired).toBe(1);
  });

  // ── DTE = 7 alert ──────────────────────────────────────────────

  it('fires dte_7 when expiry is exactly 7 days out', async () => {
    // MARKET_TIME = 2026-05-19. 7 DTE = 2026-05-26.
    const rows = [
      row({
        id: 7,
        occ_symbol: 'AAPL  260526C00200000',
        ticker: 'AAPL',
        expiry: '2026-05-26',
        entry_price: 2.0,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]); // tick insert
    mockSql.mockResolvedValueOnce([{ id: 31 }]); // dte_7 fires

    programUwFetch([
      [{ close: 198.0 }],
      [
        contractRow('AAPL  260526C00200000', {
          last: 1.9,
          bid: 1.85,
          ask: 1.95,
          volume: 5,
          openInterest: 200,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as { alerts_fired: number };
    expect(body.alerts_fired).toBe(1);
    // dte_7 alert insert was issued (SELECT + tick + dte_7 = 3 SQL calls).
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Partial UW failure → others still get ticks ────────────────

  it('captures Sentry exception when one contract fetch fails; survivors get ticks', async () => {
    const rows = [
      row({
        id: 1,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        entry_price: 4.3,
      }),
      row({
        id: 2,
        occ_symbol: 'AMD   260605C00150000',
        ticker: 'AMD',
        expiry: '2026-06-05',
        entry_price: 2.0,
      }),
      row({
        id: 3,
        occ_symbol: 'TSLA  260605C00280000',
        ticker: 'TSLA',
        expiry: '2026-06-05',
        entry_price: 3.0,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]); // tick insert for 2 survivors

    // 3 stock-state calls then 3 ticker-batched option-contracts calls
    // (one per unique ticker). Each contract here is on its own ticker,
    // so the AMD batch rejecting matches the contract-level failure
    // assertion below.
    programUwFetch([
      [{ close: 142.5 }],
      [{ close: 158.4 }],
      [{ close: 275.0 }],
      [
        contractRow('NVDA  260522P00225000', {
          last: 4.4,
          bid: 4.3,
          ask: 4.5,
          volume: 100,
          openInterest: 800,
        }),
      ],
      new Error('UW API 503: upstream down'),
      [
        contractRow('TSLA  260605C00280000', {
          last: 3.1,
          bid: 3.0,
          ask: 3.2,
          volume: 60,
          openInterest: 300,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      processed: number;
      ticks_inserted: number;
    };
    expect(body.processed).toBe(3);
    expect(body.ticks_inserted).toBe(2);

    expect(mockSentryCapture).toHaveBeenCalledTimes(1);
    // The captureException call must carry contract-scoped tags so the
    // Sentry alert is actionable.
    const captureArgs = mockSentryCapture.mock.calls[0]!;
    const opts = captureArgs[1] as
      | { tags?: Record<string, string> }
      | undefined;
    expect(opts?.tags).toMatchObject({
      cron: 'refresh-tracker-contracts',
      occ_symbol: 'AMD   260605C00150000',
      ticker: 'AMD',
    });
  });

  // ── Auto-expiry ────────────────────────────────────────────────

  it('auto-expires contracts whose expiry is in the past', async () => {
    // First contract is expired (2026-05-18 < 2026-05-19), second is live.
    const rows = [
      row({
        id: 11,
        occ_symbol: 'NVDA  260518P00150000',
        ticker: 'NVDA',
        expiry: '2026-05-18',
        entry_price: 4.0,
      }),
      row({
        id: 12,
        occ_symbol: 'AMD   260605C00150000',
        ticker: 'AMD',
        expiry: '2026-06-05',
        entry_price: 2.0,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows); // SELECT active
    mockSql.mockResolvedValueOnce([]); // UPDATE expired row → 1 update
    mockSql.mockResolvedValueOnce([]); // tick insert for surviving contract

    // Only 1 stock-state + 1 option-contracts batch are issued (the
    // expired contract is skipped before any UW call).
    programUwFetch([
      [{ close: 158.4 }], // AMD spot
      [
        contractRow('AMD   260605C00150000', {
          last: 2.1,
          bid: 2.0,
          ask: 2.2,
          volume: 30,
          openInterest: 200,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as { expired: number; processed: number };
    expect(body.expired).toBe(1);
    expect(body.processed).toBe(1);
    // UW called only for the live contract: 1 stock-state + 1 contract.
    expect(mockUwFetch).toHaveBeenCalledTimes(2);
  });

  // ── Multiple contracts per ticker → one batched UW call ──────

  it('batches multiple contracts on the same ticker into one UW option-contracts call', async () => {
    // Two NVDA contracts share a ticker — the handler must issue only
    // one `/stock/NVDA/option-contracts?option_symbol[]=…&option_symbol[]=…`
    // call and look up each row in the returned Map by OCC.
    const rows = [
      row({
        id: 41,
        occ_symbol: 'NVDA  260522P00225000',
        ticker: 'NVDA',
        expiry: '2026-05-22',
        entry_price: 4.3,
      }),
      row({
        id: 42,
        occ_symbol: 'NVDA  260605C00150000',
        ticker: 'NVDA',
        expiry: '2026-06-05',
        entry_price: 2.5,
      }),
    ];

    mockSql.mockResolvedValueOnce(rows); // SELECT active
    mockSql.mockResolvedValueOnce([]); // tick insert (1 batched INSERT)

    // 1 stock-state (NVDA) + 1 option-contracts (NVDA, two OCCs in
    // the response) = 2 UW calls total — proves the batching.
    programUwFetch([
      [{ close: 142.5 }],
      [
        contractRow('NVDA  260522P00225000', {
          last: 4.4,
          bid: 4.3,
          ask: 4.5,
          volume: 100,
          openInterest: 800,
        }),
        contractRow('NVDA  260605C00150000', {
          last: 2.6,
          bid: 2.5,
          ask: 2.7,
          volume: 50,
          openInterest: 600,
        }),
      ],
    ]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      processed: number;
      ticks_inserted: number;
      alerts_fired: number;
    };
    expect(body).toMatchObject({
      processed: 2,
      ticks_inserted: 2,
      alerts_fired: 0,
    });
    // Only 2 UW calls — the batching is what fixed the per-contract
    // 429 risk that originally motivated the endpoint swap.
    expect(mockUwFetch).toHaveBeenCalledTimes(2);
  });

  // ── No active contracts → fast return ─────────────────────────

  it('returns "no active contracts" early when SELECT is empty', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      status: string;
      processed: number;
      ticks_inserted: number;
      alerts_fired: number;
      message?: string;
    };
    expect(body.status).toBe('success');
    expect(body.processed).toBe(0);
    expect(body.ticks_inserted).toBe(0);
    expect(body.alerts_fired).toBe(0);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });
});
