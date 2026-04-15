// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockUwFetch, mockCheckBot } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCheckBot: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  checkBot: mockCheckBot,
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
});
