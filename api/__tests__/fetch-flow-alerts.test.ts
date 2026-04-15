// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import handler, {
  computeDerived,
  type UwFlowAlert,
} from '../cron/fetch-flow-alerts.js';

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
  total_ask_side_prem: '151875',
  total_bid_side_prem: '405',
  total_premium: '152280',
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

describe('fetch-flow-alerts handler', () => {
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
    // SELECT MAX(created_at) → empty; then 3 INSERT RETURNING, all stored.
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
      job: 'fetch-flow-alerts',
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
      job: 'fetch-flow-alerts',
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

  it('omits newer_than on first run (empty table)', async () => {
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
    // Sanity: base filters should be present.
    expect(calledPath).toContain('ticker_symbol=SPXW');
    expect(calledPath).toContain('min_dte=0');
    expect(calledPath).toContain('max_dte=1');
    expect(calledPath).toContain('limit=200');
  });

  // ── Pagination ─────────────────────────────────────────────

  it('paginates with older_than when first page returns exactly 200 rows', async () => {
    // Build 200 synthetic alerts with descending created_at (newest first).
    const firstPage = Array.from({ length: 200 }, (_, i) => {
      const minuteOffset = i; // 0..199
      // Newest at i=0 (19:45:00), oldest at i=199 (19:45:00 - 199 min).
      const secondsFromBase = 60 * minuteOffset;
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
    // 201 inserts total, all RETURNING an id.
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
    expect(secondCallPath).toContain(encodeURIComponent(oldestCreatedAt));
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 201, inserted: 201 });
  });

  // ── Derived field spot-check via INSERT values ─────────────

  it('computes derived fields correctly and passes them to INSERT', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([SAMPLE_ALERT]);
    mockSql.mockResolvedValueOnce([{ id: 1 }]); // INSERT RETURNING id

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);

    const values = callValuesFor('INSERT INTO flow_alerts');
    expect(values).not.toBeNull();
    const vals = values!;

    // ask_side_ratio ≈ 151875/152280
    const expectedAskRatio = 151875 / 152280;
    const expectedBidRatio = 405 / 152280;
    const expectedNetPrem = 151875 - 405;

    const approxEqual = (v: unknown, expected: number, eps = 1e-9) =>
      typeof v === 'number' && Math.abs(v - expected) < eps;

    expect(vals.some((v) => approxEqual(v, expectedAskRatio))).toBe(true);
    expect(vals.some((v) => approxEqual(v, expectedBidRatio))).toBe(true);
    expect(vals).toContain(expectedNetPrem);

    // dte_at_alert = 1 day (2026-04-15 - 2026-04-14)
    expect(vals).toContain(1);
    // distance_from_spot = 6900 - 6850 = 50
    expect(vals).toContain(50);
    // distance_pct = 50/6850
    expect(vals.some((v) => approxEqual(v, 50 / 6850))).toBe(true);
    // moneyness = 6850/6900
    expect(vals.some((v) => approxEqual(v, 6850 / 6900))).toBe(true);
    // is_itm = false (call, strike 6900 > spot 6850)
    expect(vals).toContain(false);
    // minute_of_day = 885 (14:45 CT)
    expect(vals).toContain(885);
    // session_elapsed_min = 885 - 510 = 375
    expect(vals).toContain(375);
    // day_of_week = 1 (Tuesday, 2026-04-14)
    expect(vals).toContain(1);
  });

  // ── Direct spot-check of computeDerived ────────────────────

  it('computeDerived matches expected fixture values', () => {
    const d = computeDerived(SAMPLE_ALERT);
    expect(d.ask_side_ratio).toBeCloseTo(0.99734, 4);
    expect(d.bid_side_ratio).toBeCloseTo(0.00266, 4);
    expect(d.net_premium).toBe(151470);
    expect(d.dte_at_alert).toBe(1);
    expect(d.distance_from_spot).toBe(50);
    expect(d.distance_pct).toBeCloseTo(50 / 6850, 9);
    expect(d.moneyness).toBeCloseTo(6850 / 6900, 9);
    expect(d.is_itm).toBe(false);
    expect(d.minute_of_day).toBe(885);
    expect(d.session_elapsed_min).toBe(375);
    expect(d.day_of_week).toBe(1);
  });

  // ── Dedupe: ON CONFLICT DO NOTHING returns empty rows ──────

  it('does not increment inserted when ON CONFLICT returns no row', async () => {
    mockSql.mockResolvedValueOnce([{ max_created_at: null }]);
    mockUwFetch.mockResolvedValueOnce([
      makeAlert({ option_chain: 'SPXW260415C06900000' }),
      makeAlert({ option_chain: 'SPXW260415C06910000' }),
    ]);
    // First INSERT: dupe (empty returning); second: stored.
    mockSql
      .mockResolvedValueOnce([]) // dupe
      .mockResolvedValueOnce([{ id: 2 }]); // new

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, inserted: 1 });
  });
});
