// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockUwFetch, mockCheckBot, mockSql } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCheckBot: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  checkBot: mockCheckBot,
}));

vi.mock('../_lib/guest-auth.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(() => false),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: vi.fn(
      async (
        cb: (scope: { setTransactionName: (n: string) => void }) => unknown,
      ) => cb({ setTransactionName: vi.fn() }),
    ),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../options-flow/whale-positioning.js';

// ── Fixtures ────────────────────────────────────────────────

type UwAlert = {
  ticker: string;
  strike: string;
  expiry: string;
  type: 'call' | 'put';
  option_chain: string;
  created_at: string;
  total_premium: string;
  total_ask_side_prem: string;
  total_bid_side_prem: string;
  total_size: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: string;
  has_sweep: boolean;
  has_floor: boolean;
  has_multileg: boolean;
  has_singleleg?: boolean;
  all_opening_trades?: boolean;
  alert_rule: string;
  underlying_price: string;
  issue_type: string;
  price?: string;
  expiry_count?: number;
  trade_count?: number;
};

const SAMPLE_ALERT: UwAlert = {
  ticker: 'SPXW',
  strike: '6500',
  expiry: '2026-04-20',
  type: 'put',
  option_chain: 'SPXW260420P06500000',
  created_at: '2026-04-15T14:30:00.000Z',
  total_premium: '206475000',
  total_ask_side_prem: '190000000',
  total_bid_side_prem: '16475000',
  total_size: 50000,
  volume: 100000,
  open_interest: 20000,
  volume_oi_ratio: '5.0',
  has_sweep: true,
  has_floor: false,
  has_multileg: false,
  has_singleleg: true,
  all_opening_trades: false,
  alert_rule: 'RepeatedHits',
  underlying_price: '7001.00',
  issue_type: 'Index',
  price: '4100.00',
  expiry_count: 1,
  trade_count: 5,
};

function makeAlert(overrides: Partial<UwAlert> = {}): UwAlert {
  return { ...SAMPLE_ALERT, ...overrides };
}

function makeAlertWithPremium(
  premium: number,
  overrides: Partial<UwAlert> = {},
): UwAlert {
  return makeAlert({
    total_premium: String(premium),
    total_ask_side_prem: String(Math.floor(premium * 0.9)),
    total_bid_side_prem: String(Math.floor(premium * 0.1)),
    ...overrides,
  });
}

describe('GET /api/options-flow/whale-positioning', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckBot.mockResolvedValue({ isBot: false });
    mockUwFetch.mockResolvedValue([]);
    process.env.UW_API_KEY = 'test-key';
    // Freeze to 2026-04-15 14:45:00 UTC = 09:45 CT (mid-session, post-open)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T14:45:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Method gate ────────────────────────────────────────────

  it('returns 405 for non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Bot gate ───────────────────────────────────────────────

  it('returns 403 when checkBot flags request as bot', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ error: 'Access denied' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Query validation ──────────────────────────────────────

  it('returns 400 for invalid min_premium (negative)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '-1' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for min_premium below the $500K floor', async () => {
    // The Zod floor was tightened from 0 → 500_000 so a crafted request
    // can't dump the full UW flow-alerts feed by setting min_premium=0.
    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '0' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for min_premium just below the $500K floor', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '499999' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('accepts min_premium exactly at the $500K floor', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '500000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const [, path] = mockUwFetch.mock.calls[0]! as [string, string];
    expect(path).toContain('min_premium=500000');
  });

  it('accepts min_premium at and above $1M (existing contract)', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '1000000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const [, path] = mockUwFetch.mock.calls[0]! as [string, string];
    expect(path).toContain('min_premium=1000000');
  });

  it('applies the default min_premium=1_000_000 when no query param is provided', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { min_premium: number };
    expect(body.min_premium).toBe(1_000_000);
    const [, path] = mockUwFetch.mock.calls[0]! as [string, string];
    expect(path).toContain('min_premium=1000000');
  });

  it('returns 400 for invalid max_dte (too large)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { max_dte: '99' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid limit (0)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { limit: '0' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────

  it('aggregates 3 alerts, sums total_premium, sorts desc', async () => {
    const alerts = [
      makeAlertWithPremium(5_000_000, {
        option_chain: 'A',
        created_at: '2026-04-15T14:40:00.000Z',
      }),
      makeAlertWithPremium(2_000_000, {
        option_chain: 'B',
        created_at: '2026-04-15T14:41:00.000Z',
      }),
      makeAlertWithPremium(1_000_000, {
        option_chain: 'C',
        created_at: '2026-04-15T14:42:00.000Z',
      }),
    ];
    mockUwFetch.mockResolvedValueOnce(alerts);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{ option_chain: string; total_premium: number }>;
      total_premium: number;
      alert_count: number;
      last_updated: string;
      spot: number;
    };
    expect(body.strikes).toHaveLength(3);
    expect(body.strikes.map((s) => s.option_chain)).toEqual(['A', 'B', 'C']);
    expect(body.total_premium).toBe(8_000_000);
    expect(body.alert_count).toBe(3);
    expect(body.last_updated).toBe('2026-04-15T14:42:00.000Z');
    expect(body.spot).toBe(7001);
  });

  // ── Sort order ────────────────────────────────────────────

  it('sorts out-of-order alerts by total_premium desc', async () => {
    const alerts = [
      makeAlertWithPremium(2_000_000, { option_chain: 'B' }),
      makeAlertWithPremium(4_000_000, { option_chain: 'D' }),
      makeAlertWithPremium(1_000_000, { option_chain: 'A' }),
      makeAlertWithPremium(3_000_000, { option_chain: 'C' }),
    ];
    mockUwFetch.mockResolvedValueOnce(alerts);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{ option_chain: string; total_premium: number }>;
    };
    expect(body.strikes.map((s) => s.option_chain)).toEqual([
      'D',
      'C',
      'B',
      'A',
    ]);
  });

  // ── Limit slicing ─────────────────────────────────────────

  it('slices to limit, keeping top-N by premium', async () => {
    const alerts = Array.from({ length: 30 }, (_, i) =>
      makeAlertWithPremium((i + 1) * 100_000, {
        option_chain: `CHAIN_${String(i).padStart(2, '0')}`,
      }),
    );
    mockUwFetch.mockResolvedValueOnce(alerts);

    const req = mockRequest({
      method: 'GET',
      query: { limit: '5' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{ total_premium: number }>;
      alert_count: number;
      total_premium: number;
    };
    expect(body.strikes).toHaveLength(5);
    expect(body.alert_count).toBe(5);
    // Top 5 should be premiums 3_000_000, 2_900_000, 2_800_000, 2_700_000, 2_600_000
    expect(body.strikes.map((s) => s.total_premium)).toEqual([
      3_000_000, 2_900_000, 2_800_000, 2_700_000, 2_600_000,
    ]);
    expect(body.total_premium).toBe(
      3_000_000 + 2_900_000 + 2_800_000 + 2_700_000 + 2_600_000,
    );
  });

  // ── Derived fields ────────────────────────────────────────

  it('computes derived fields correctly (dte_at_alert, distance_pct, is_itm, age_minutes, ask_side_ratio)', async () => {
    mockUwFetch.mockResolvedValueOnce([SAMPLE_ALERT]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{
        strike: number;
        type: string;
        expiry: string;
        dte_at_alert: number;
        age_minutes: number;
        ask_side_ratio: number;
        distance_from_spot: number;
        distance_pct: number;
        is_itm: boolean;
        underlying_price: number;
      }>;
    };
    expect(body.strikes).toHaveLength(1);
    const s = body.strikes[0]!;
    expect(s.strike).toBe(6500);
    expect(s.type).toBe('put');
    expect(s.expiry).toBe('2026-04-20');
    // 2026-04-20 - 2026-04-15 = 5 days
    expect(s.dte_at_alert).toBe(5);
    // now = 14:45Z, created_at = 14:30Z → 15 min
    expect(s.age_minutes).toBe(15);
    // 190M / 206.475M ≈ 0.9202
    expect(s.ask_side_ratio).toBeCloseTo(0.9202, 3);
    expect(s.distance_from_spot).toBeCloseTo(-501, 5);
    expect(s.distance_pct).toBeCloseTo(-0.0716, 3);
    // put with strike (6500) < spot (7001) → OTM
    expect(s.is_itm).toBe(false);
    expect(s.underlying_price).toBe(7001);
  });

  // ── Empty response ────────────────────────────────────────

  it('returns empty-shape response when UW returns no alerts', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      total_premium: number;
      alert_count: number;
      last_updated: string | null;
      spot: number | null;
      min_premium: number;
      max_dte: number;
    };
    expect(body.strikes).toEqual([]);
    expect(body.total_premium).toBe(0);
    expect(body.alert_count).toBe(0);
    expect(body.last_updated).toBeNull();
    expect(body.spot).toBeNull();
    expect(body.min_premium).toBe(1_000_000);
    expect(body.max_dte).toBe(7);
  });

  // ── UW error path ─────────────────────────────────────────

  it('returns 502 with generic message when uwFetch throws', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 500: boom'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(502);
    expect(res._json).toEqual({ error: 'Upstream flow data unavailable' });
    // Should NOT leak UW's raw error message
    expect(JSON.stringify(res._json)).not.toContain('UW API 500');
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 with generic message when UW_API_KEY is missing', async () => {
    delete process.env.UW_API_KEY;

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Upstream flow data unavailable' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── UW call args ──────────────────────────────────────────

  it('passes the right query params to UW', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { min_premium: '5000000', max_dte: '3', limit: '10' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const [apiKey, path] = mockUwFetch.mock.calls[0]! as [string, string];
    expect(apiKey).toBe('test-key');
    expect(path).toContain('/option-trades/flow-alerts');
    expect(path).toContain('ticker_symbol=SPXW');
    expect(path).toContain('issue_types%5B%5D=Index');
    expect(path).toContain('min_dte=0');
    expect(path).toContain('max_dte=3');
    expect(path).toContain('min_premium=5000000');
    expect(path).toContain('limit=200');
    // No rule_name filter — the whole point is broader flow
    expect(path).not.toContain('rule_name');
    // Should include newer_than (mid-session)
    expect(path).toContain('newer_than=');
  });

  // ── Cache header ──────────────────────────────────────────

  it('sets Cache-Control: max-age=30, stale-while-revalidate=30', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe(
      'max-age=30, stale-while-revalidate=30',
    );
  });

  // ── Pre-market newer_than behavior ───────────────────────

  it('omits newer_than from UW path when called before 08:30 CT', async () => {
    // Set time to 05:00 UTC = just after midnight CT — well before
    // session open (08:30 CT = 13:30 UTC during CDT).
    vi.setSystemTime(new Date('2026-04-15T05:00:00.000Z'));
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const [, path] = mockUwFetch.mock.calls[0]! as [string, string];
    expect(path).not.toContain('newer_than=');
    // window_minutes should be 0 pre-market.
    const body = res._json as { window_minutes: number };
    expect(body.window_minutes).toBe(0);
  });

  // ── Invalid type rejection (live mode) ───────────────────

  it('rejects alerts with unknown type (live mode)', async () => {
    const bad = { ...SAMPLE_ALERT, type: 'straddle' } as unknown as UwAlert;
    mockUwFetch.mockResolvedValueOnce([bad, SAMPLE_ALERT]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toHaveLength(1);
  });

  it('rejects alerts with non-finite strike (live mode)', async () => {
    const bad = makeAlertWithPremium(2_000_000, { strike: 'not-a-number' });
    mockUwFetch.mockResolvedValueOnce([bad]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// HISTORICAL / SCRUB MODE (date param triggers DB path)
// ═══════════════════════════════════════════════════════════

describe('GET /api/options-flow/whale-positioning — historical mode', () => {
  // DB row shape returned from whale_alerts.
  type DbRow = {
    option_chain: string;
    strike: string;
    type: string;
    expiry: string;
    dte_at_alert: number | null;
    created_at: string;
    total_premium: string;
    total_ask_side_prem: string | null;
    total_bid_side_prem: string | null;
    total_size: number | null;
    volume: number | null;
    open_interest: number | null;
    volume_oi_ratio: string | null;
    has_sweep: boolean | null;
    has_floor: boolean | null;
    has_multileg: boolean | null;
    alert_rule: string;
    underlying_price: string | null;
    distance_from_spot: string | null;
    distance_pct: string | null;
    is_itm: boolean | null;
  };

  const BASE_DB_ROW: DbRow = {
    option_chain: 'SPXW260420P06500000',
    strike: '6500',
    type: 'put',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-15T14:35:00.000Z',
    total_premium: '2500000',
    total_ask_side_prem: '2250000',
    total_bid_side_prem: '250000',
    total_size: 500,
    volume: 1000,
    open_interest: 200,
    volume_oi_ratio: '5.0',
    has_sweep: true,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: '7001',
    distance_from_spot: '-501',
    distance_pct: '-0.0716',
    is_itm: false,
  };

  function makeDbRow(overrides: Partial<DbRow> = {}): DbRow {
    return { ...BASE_DB_ROW, ...overrides };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckBot.mockResolvedValue({ isBot: false });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T18:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries DB (not UW) when date is provided', async () => {
    mockSql.mockResolvedValueOnce([]); // rows
    mockSql.mockResolvedValueOnce([]); // timestamps

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns empty-shape response when DB has no rows for the date', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      alert_count: number;
      total_premium: number;
      timestamps: unknown[];
    };
    expect(body.strikes).toEqual([]);
    expect(body.alert_count).toBe(0);
    expect(body.total_premium).toBe(0);
    expect(body.timestamps).toEqual([]);
  });

  it('transforms DB rows into WhaleAlert objects with computed derived fields', async () => {
    const row = makeDbRow();
    mockSql.mockResolvedValueOnce([row]);
    mockSql.mockResolvedValueOnce([{ ts: '2026-04-15T14:35:00.000Z' }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{
        strike: number;
        type: string;
        total_premium: number;
        ask_side_ratio: number;
        age_minutes: number;
        distance_from_spot: number;
        is_itm: boolean;
      }>;
      timestamps: string[];
    };
    expect(body.strikes).toHaveLength(1);
    const alert = body.strikes[0]!;
    expect(alert.strike).toBe(6500);
    expect(alert.type).toBe('put');
    expect(alert.total_premium).toBe(2_500_000);
    expect(alert.ask_side_ratio).toBeCloseTo(0.9, 3);
    // now = 18:00Z, created_at = 14:35Z → 205 min
    expect(alert.age_minutes).toBe(205);
    expect(alert.distance_from_spot).toBeCloseTo(-501, 5);
    expect(alert.is_itm).toBe(false);
    expect(body.timestamps).toEqual(['2026-04-15T14:35:00.000Z']);
  });

  it('rejects DB rows with unknown type', async () => {
    const rows = [makeDbRow({ type: 'spread' }), makeDbRow()];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toHaveLength(1);
  });

  it('rejects DB rows with zero/non-finite underlying_price', async () => {
    const rows = [
      makeDbRow({ underlying_price: '0' }),
      makeDbRow({ underlying_price: null }),
      makeDbRow({ underlying_price: 'garbage' }),
      makeDbRow(),
    ];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toHaveLength(1);
  });

  it('falls back to computed distance values when DB columns are null', async () => {
    const row = makeDbRow({
      distance_from_spot: null,
      distance_pct: null,
      is_itm: null,
    });
    mockSql.mockResolvedValueOnce([row]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{
        distance_from_spot: number;
        distance_pct: number;
        is_itm: boolean;
      }>;
    };
    const alert = body.strikes[0]!;
    // strike (6500) - spot (7001) = -501
    expect(alert.distance_from_spot).toBe(-501);
    expect(alert.distance_pct).toBeCloseTo(-501 / 7001, 6);
    // put with strike < spot → OTM
    expect(alert.is_itm).toBe(false);
  });

  it('sets long-lived Cache-Control when serving historical data', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe(
      'max-age=3600, stale-while-revalidate=86400',
    );
  });

  it('returns 500 when the historical DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Historical data query failed' });
  });

  it('slices historical results to the limit', async () => {
    // Generate 15 distinct rows.
    const rows = Array.from({ length: 15 }, (_, i) =>
      makeDbRow({
        option_chain: `CHAIN_${i}`,
        strike: String(6500 + i * 5),
        total_premium: String((15 - i) * 1_000_000),
      }),
    );
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15', limit: '5' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[]; alert_count: number };
    expect(body.strikes).toHaveLength(5);
    expect(body.alert_count).toBe(5);
  });

  it('honors as_of by restricting session window to the given timestamp', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-04-15',
        as_of: '2026-04-15T14:00:00.000Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // window_minutes is derived from (as_of - sessionOpen) / 60k.
    // sessionOpen = 12:30 UTC (EDT on 2026-04-15), as_of = 14:00 UTC.
    // → (14:00 - 12:30) / 60 = 90 minutes.
    const body = res._json as { window_minutes: number };
    expect(body.window_minutes).toBe(90);
  });

  it('rejects as_of without date (Zod refine)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { as_of: '2026-04-15T14:00:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects malformed date', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026/04/15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });
});
