// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCheckBot, mockSql } = vi.hoisted(() => ({
  mockCheckBot: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
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

import handler from '../options-flow/otm-heavy.js';

// ── Fixtures ────────────────────────────────────────────────

type Row = {
  id: number;
  option_chain: string;
  strike: string;
  type: string;
  created_at: string;
  price: string | null;
  underlying_price: string | null;
  total_premium: string;
  total_size: number | null;
  volume: number | null;
  open_interest: number | null;
  volume_oi_ratio: string | null;
  ask_side_ratio: string | null;
  bid_side_ratio: string | null;
  distance_pct: string | null;
  moneyness: string | null;
  dte_at_alert: number | null;
  has_sweep: boolean | null;
  has_multileg: boolean | null;
  alert_rule: string;
};

const BASE_ROW: Row = {
  id: 1001,
  option_chain: 'SPXW260422C07100000',
  strike: '7100',
  type: 'call',
  created_at: '2026-04-22T14:45:00.000Z',
  price: '2.50',
  underlying_price: '7000.00',
  total_premium: '125000',
  total_size: 500,
  volume: 5000,
  open_interest: 1200,
  volume_oi_ratio: '4.17',
  ask_side_ratio: '0.82',
  bid_side_ratio: '0.10',
  distance_pct: '0.01429',
  moneyness: '0.9859',
  dte_at_alert: 0,
  has_sweep: true,
  has_multileg: false,
  alert_rule: 'RepeatedHits',
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return { ...BASE_ROW, ...overrides };
}

describe('GET /api/options-flow/otm-heavy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckBot.mockResolvedValue({ isBot: false });
    vi.useFakeTimers();
    // Freeze to 2026-04-22 15:00 UTC = 10:00 CT (mid-session)
    vi.setSystemTime(new Date('2026-04-22T15:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Method / bot gates ────────────────────────────────────

  it('returns 405 for non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 403 when checkBot flags request as bot', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Query validation ─────────────────────────────────────

  it('returns 400 for min_ask_ratio below 0.5 floor', async () => {
    const req = mockRequest({ method: 'GET', query: { min_ask_ratio: '0.3' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for min_distance_pct above 0.02 ceiling', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { min_distance_pct: '0.05' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for window_minutes not in {5,15,30,60}', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { window_minutes: '10' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid sides enum value', async () => {
    const req = mockRequest({ method: 'GET', query: { sides: 'middle' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for as_of without date (cross-field refine)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { as_of: '2026-04-22T14:00:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed date', async () => {
    const req = mockRequest({ method: 'GET', query: { date: '2026/04/22' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Live mode happy path ──────────────────────────────────

  it('returns live-mode response with transformed rows, newest first', async () => {
    const rows = [
      makeRow({
        id: 3,
        option_chain: 'SPXW260422C07200000',
        strike: '7200',
        created_at: '2026-04-22T14:58:00.000Z',
        ask_side_ratio: '0.75',
        bid_side_ratio: '0.15',
        distance_pct: '0.02857',
      }),
      makeRow({
        id: 2,
        option_chain: 'SPXW260422P06900000',
        strike: '6900',
        type: 'put',
        created_at: '2026-04-22T14:55:00.000Z',
        ask_side_ratio: '0.90',
        bid_side_ratio: '0.05',
        distance_pct: '-0.01429',
      }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: Array<{
        id: number;
        strike: number;
        type: string;
        dominant_side: string;
        distance_pct: number;
        ask_side_ratio: number;
      }>;
      alert_count: number;
      last_updated: string;
      spot: number;
      mode: string;
      window_minutes: number;
    };
    expect(body.alerts).toHaveLength(2);
    expect(body.alerts[0]!.id).toBe(3);
    expect(body.alerts[0]!.dominant_side).toBe('ask');
    expect(body.alerts[1]!.type).toBe('put');
    expect(body.alert_count).toBe(2);
    expect(body.last_updated).toBe('2026-04-22T14:58:00.000Z');
    expect(body.spot).toBe(7000);
    expect(body.mode).toBe('live');
    expect(body.window_minutes).toBe(30);
  });

  it('sets live Cache-Control: max-age=30, swr=30', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe(
      'max-age=30, stale-while-revalidate=30',
    );
  });

  it('returns empty-shape response when DB has no matching rows', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      alerts: unknown[];
      alert_count: number;
      last_updated: string | null;
      spot: number | null;
      mode: string;
      thresholds: { ask: number; bid: number };
    };
    expect(body.alerts).toEqual([]);
    expect(body.alert_count).toBe(0);
    expect(body.last_updated).toBeNull();
    expect(body.spot).toBeNull();
    expect(body.mode).toBe('live');
    expect(body.thresholds.ask).toBe(0.6);
    expect(body.thresholds.bid).toBe(0.6);
  });

  // ── Row transforms / filtering ───────────────────────────

  it('rejects rows with unknown type', async () => {
    const rows = [makeRow({ type: 'spread' }), makeRow()];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { alerts: unknown[] };
    expect(body.alerts).toHaveLength(1);
  });

  it('rejects rows with zero/null underlying_price', async () => {
    const rows = [
      makeRow({ underlying_price: null }),
      makeRow({ underlying_price: '0' }),
      makeRow({ underlying_price: 'garbage' }),
      makeRow(),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { alerts: unknown[] };
    expect(body.alerts).toHaveLength(1);
  });

  it('computes dominant_side = "bid" when bid_side_ratio > ask_side_ratio', async () => {
    const row = makeRow({
      ask_side_ratio: '0.10',
      bid_side_ratio: '0.85',
    });
    mockSql.mockResolvedValueOnce([row]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: Array<{ dominant_side: string }> };
    expect(body.alerts[0]!.dominant_side).toBe('bid');
  });

  it('falls back to computed distance_pct when DB column is null', async () => {
    const row = makeRow({ distance_pct: null });
    mockSql.mockResolvedValueOnce([row]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { alerts: Array<{ distance_pct: number }> };
    // strike 7100, spot 7000 → (7100 - 7000) / 7000 = 0.01429
    expect(body.alerts[0]!.distance_pct).toBeCloseTo(0.01429, 4);
  });

  // ── Historical mode ───────────────────────────────────────

  it('returns historical-mode response with long-lived Cache-Control', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-21', as_of: '2026-04-21T19:00:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { mode: string };
    expect(body.mode).toBe('historical');
    expect(res._headers['Cache-Control']).toBe(
      'max-age=3600, stale-while-revalidate=86400',
    );
  });

  it('historical mode with date-only anchors window to 15:00 CT on that date', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-21', window_minutes: '30' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { mode: string };
    expect(body.mode).toBe('historical');

    // Verify the window actually lands on 15:00 CT. 2026-04-21 falls during
    // CDT (UTC-5), so 15:00 CT = 20:00 UTC. With a 30-min window that means
    // windowStart = 19:30 UTC, windowEnd = 20:00 UTC. Regression guard for
    // marketCloseUtcForDate()'s DST handling.
    const [, ...args] = mockSql.mock.calls[0] as [unknown, ...unknown[]];
    expect(args[0]).toBe('2026-04-21T19:30:00.000Z'); // windowStart
    expect(args[1]).toBe('2026-04-21T20:00:00.000Z'); // windowEnd
  });

  // ── Parameter binding (SQL-injection guard) ──────────────

  it('passes sides and type as bound parameters, not string-interpolated', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { sides: 'ask', type: 'call' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Neon tagged template: calls[0] = [stringsArray, ...bindValues]
    // The SQL in otm-heavy.ts interpolates in this order:
    //   windowStart, windowEnd, min_distance_pct, min_premium,
    //   sides, min_ask_ratio, sides, min_bid_ratio,
    //   type, type, limit
    const [, ...args] = mockSql.mock.calls[0] as [unknown, ...unknown[]];
    expect(args[4]).toBe('ask'); // first sides
    expect(args[6]).toBe('ask'); // second sides
    expect(args[8]).toBe('call'); // first type
    expect(args[9]).toBe('call'); // second type
    // And the static SQL fragments must not contain the raw user values
    // (belt-and-braces — ensures nobody ever "simplified" this into
    // string-concat SQL).
    const strings = mockSql.mock.calls[0]![0] as string[];
    const joined = strings.join('');
    expect(joined).not.toContain("sides = 'ask'");
    expect(joined).not.toContain("type = 'call'");
  });

  // ── Error handling ────────────────────────────────────────

  it('returns 500 with generic message when the SQL query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'OTM flow query failed' });
    // Should NOT leak the raw error message
    expect(JSON.stringify(res._json)).not.toContain('connection reset');
  });

  // ── Threshold echo ────────────────────────────────────────

  it('echoes user-supplied thresholds in the response', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: {
        min_ask_ratio: '0.75',
        min_bid_ratio: '0.65',
        min_distance_pct: '0.01',
        min_premium: '100000',
        sides: 'ask',
        type: 'call',
        window_minutes: '15',
        limit: '50',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      thresholds: {
        ask: number;
        bid: number;
        distance_pct: number;
        premium: number;
      };
      window_minutes: number;
    };
    expect(body.thresholds).toEqual({
      ask: 0.75,
      bid: 0.65,
      distance_pct: 0.01,
      premium: 100000,
    });
    expect(body.window_minutes).toBe(15);
  });
});
