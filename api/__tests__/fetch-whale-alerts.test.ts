// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
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
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler, { type UwFlowAlert } from '../cron/fetch-whale-alerts.js';

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ALERT: UwFlowAlert = {
  alert_rule: 'RepeatedHitsAscendingFill',
  all_opening_trades: false,
  created_at: '2026-04-14T19:45:00.000000Z', // 14:45 CT (CDT, UTC-5)
  expiry: '2026-04-15',
  expiry_count: 1,
  has_floor: false,
  has_multileg: false,
  has_singleleg: true,
  has_sweep: true,
  issue_type: 'Index',
  open_interest: 1000,
  option_chain: 'SPXW260415C06900000',
  price: '4.05',
  strike: '6900',
  ticker: 'SPXW',
  total_ask_side_prem: '1518750',
  total_bid_side_prem: '4050',
  total_premium: '1522800',
  total_size: 461,
  trade_count: 32,
  type: 'call',
  underlying_price: '6850',
  volume: 2442,
  volume_oi_ratio: '0.308',
};

const makeAlert = (overrides: Partial<UwFlowAlert> = {}): UwFlowAlert => ({
  ...SAMPLE_ALERT,
  ...overrides,
});

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-14' };

/**
 * Grab the most recent mockSql call whose SQL text contains `needle`.
 * Returns the interpolated values array, or null if none matched.
 */
function callValuesFor(needle: string): unknown[] | null {
  for (let i = mockSql.mock.calls.length - 1; i >= 0; i--) {
    const call = mockSql.mock.calls[i]!;
    const strings = call[0] as unknown;
    if (
      Array.isArray(strings) &&
      strings.some((s) => String(s).includes(needle))
    ) {
      return call.slice(1);
    }
  }
  return null;
}

describe('fetch-whale-alerts handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockUwFetch.mockResolvedValue([]);
    // Default: MAX(created_at) SELECT returns empty (first run).
    mockSql.mockResolvedValue([{ max_created_at: null }]);
  });

  // ── Happy path ─────────────────────────────────────────────

  it('inserts 3 alerts and returns 200 with inserted:3', async () => {
    const alerts = [
      makeAlert({
        option_chain: 'SPXW260415C06900000',
        created_at: '2026-04-14T19:45:00.000000Z',
      }),
      makeAlert({
        option_chain: 'SPXW260415C06910000',
        created_at: '2026-04-14T19:46:00.000000Z',
      }),
      makeAlert({
        option_chain: 'SPXW260415P06800000',
        type: 'put',
        strike: '6800',
        created_at: '2026-04-14T19:47:00.000000Z',
      }),
    ];
    mockUwFetch.mockResolvedValueOnce(alerts);
    mockSql
      .mockResolvedValueOnce([{ max_created_at: null }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-whale-alerts',
      fetched: 3,
      inserted: 3,
    });
  });

  // ── Empty UW response ──────────────────────────────────────

  it('returns 200 with inserted:0 when UW returns no alerts', async () => {
    mockUwFetch.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-whale-alerts',
      fetched: 0,
      inserted: 0,
    });
    // No INSERT should have run.
    expect(mockSql).toHaveBeenCalledTimes(1); // only the MAX(created_at) SELECT
  });

  // ── Steady-state: newer_than passed to UW ──────────────────

  it('passes newer_than to UW when DB has prior rows', async () => {
    const lastSeen = '2026-04-14T19:40:00.000Z';
    mockSql.mockResolvedValueOnce([{ max_created_at: lastSeen }]);
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const calledPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(calledPath).toContain('newer_than=');
    expect(calledPath).toContain(encodeURIComponent(lastSeen));
    expect(calledPath).not.toContain('older_than=');
  });

  // ── First-run: newer_than omitted ──────────────────────────

  it('omits newer_than on first run (empty table) and sets whale filter params', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const calledPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(calledPath).not.toContain('newer_than=');
    expect(calledPath).not.toContain('older_than=');
    // Whale-specific filters:
    expect(calledPath).toContain('ticker_symbol=SPXW');
    expect(calledPath).toContain('min_dte=0');
    expect(calledPath).toContain('max_dte=7');
    expect(calledPath).toContain('min_premium=500000');
    expect(calledPath).toContain('limit=200');
    // Whale cron intentionally captures ALL rule types.
    expect(calledPath).not.toContain('rule_name');
  });

  // ── Pagination ─────────────────────────────────────────────

  it('paginates with older_than when first page returns exactly 200 rows', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => {
      const secondsFromBase = 60 * i;
      const baseMs = Date.parse('2026-04-14T19:45:00.000Z');
      const iso = new Date(baseMs - secondsFromBase * 1000).toISOString();
      return makeAlert({
        option_chain: `SPXW260415C0690${String(i).padStart(4, '0')}`,
        created_at: iso,
      });
    });
    const oldestCreatedAt = firstPage.at(-1)!.created_at;

    const secondPage = [
      makeAlert({
        option_chain: 'SPXW260415C06999999',
        created_at: '2026-04-14T16:00:00.000Z',
      }),
    ];

    mockSql.mockResolvedValueOnce([{ max_created_at: null }]); // SELECT MAX
    mockUwFetch
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    for (let i = 0; i < 201; i++) {
      mockSql.mockResolvedValueOnce([{ id: i + 1 }]);
    }

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    const secondCallPath = mockUwFetch.mock.calls[1]![1] as string;
    expect(secondCallPath).toContain('older_than=');
    const expectedOlderThan = new Date(
      new Date(oldestCreatedAt).getTime() - 1,
    ).toISOString();
    expect(secondCallPath).toContain(encodeURIComponent(expectedOlderThan));
    expect(secondCallPath).not.toContain(encodeURIComponent(oldestCreatedAt));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 201, inserted: 201 });
  });

  // ── Derived field spot-check via INSERT values ─────────────

  it('computes derived fields correctly and passes them to INSERT', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([SAMPLE_ALERT]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    const values = callValuesFor('INSERT INTO whale_alerts');
    expect(values).not.toBeNull();
    const vals = values!;

    const totalPrem = 1522800;
    const expectedAskRatio = 1518750 / totalPrem;
    const expectedBidRatio = 4050 / totalPrem;
    const expectedNetPrem = 1518750 - 4050;

    const approxEqual = (v: unknown, expected: number, eps = 1e-9) =>
      typeof v === 'number' && Math.abs(v - expected) < eps;

    expect(vals.some((v) => approxEqual(v, expectedAskRatio))).toBe(true);
    expect(vals.some((v) => approxEqual(v, expectedBidRatio))).toBe(true);
    expect(vals).toContain(expectedNetPrem);

    // dte_at_alert = 1, distance_from_spot = 50
    expect(vals).toContain(1);
    expect(vals).toContain(50);
    expect(vals.some((v) => approxEqual(v, 50 / 6850))).toBe(true);
    expect(vals.some((v) => approxEqual(v, 6850 / 6900))).toBe(true);
    expect(vals).toContain(false); // is_itm (call, strike 6900 > spot 6850)
    expect(vals).toContain(885); // minute_of_day (14:45 CT)
    expect(vals).toContain(375); // session_elapsed_min
  });

  // ── age_minutes_at_ingest ─────────────────────────────────

  describe('age_minutes_at_ingest', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('computes age_minutes_at_ingest as floor((now - created_at) / 60_000)', async () => {
      // Pin wall clock to 7 minutes 30 seconds after the SAMPLE_ALERT.created_at.
      const alertCreatedMs = Date.parse('2026-04-14T19:45:00.000Z');
      const fakeNowMs = alertCreatedMs + 7 * 60_000 + 30_000;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(fakeNowMs));

      mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
      mockUwFetch.mockResolvedValueOnce([SAMPLE_ALERT]);
      mockSql.mockResolvedValueOnce([{ id: 1 }]);

      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      const values = callValuesFor('INSERT INTO whale_alerts');
      expect(values).not.toBeNull();
      // 7.5 minutes → floor → 7
      expect(values!).toContain(7);
    });
  });

  // ── Dedupe: ON CONFLICT DO NOTHING returns empty rows ──────

  it('does not increment inserted when ON CONFLICT returns no row', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([
      makeAlert({ option_chain: 'SPXW260415C06900000' }),
      makeAlert({ option_chain: 'SPXW260415C06910000' }),
    ]);
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 2 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, inserted: 1 });
  });

  // ── cronGuard rejection ────────────────────────────────────

  it('bails without calling uwFetch or getDb when cronGuard returns null', async () => {
    // When cronGuard rejects (bad CRON_SECRET, non-GET, etc.) it writes
    // the response itself and returns null. The handler must treat that
    // as the terminal state and do no further work.
    mockCronGuard.mockReturnValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockCronGuard).toHaveBeenCalledOnce();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── URL assertions ─────────────────────────────────────────

  it('never includes rule_name in the UW path and always sets min_premium + max_dte', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const calledPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(calledPath).not.toContain('rule_name');
    expect(calledPath).toContain('min_premium=500000');
    expect(calledPath).toContain('max_dte=7');
  });
});
