// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

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

const { mockCheckBot } = vi.hoisted(() => ({
  mockCheckBot: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: mockCheckBot,
}));

import handler from '../options-flow/top-strikes.js';

// ── Fixtures ────────────────────────────────────────────────

// NUMERIC columns come back as strings from @neondatabase/serverless.
// Tests must exercise that path.
const BASE_ROW = {
  alert_rule: 'RepeatedHits' as const,
  ticker: 'SPXW',
  strike: '6900',
  expiry: '2026-04-15',
  type: 'call' as const,
  option_chain: 'SPXW260415C06900000',
  created_at: '2026-04-14T19:45:00.000Z',
  price: '4.05',
  underlying_price: '6850',
  total_premium: '152280',
  total_ask_side_prem: '151875',
  total_bid_side_prem: '405',
  total_size: 461,
  volume: 2442,
  open_interest: 1000,
  volume_oi_ratio: '0.308',
  has_sweep: true,
  has_floor: false,
  has_multileg: false,
  has_singleleg: true,
  all_opening_trades: false,
  ask_side_ratio: '0.9973',
  net_premium: '151470',
  distance_from_spot: '50',
  distance_pct: '0.0073',
  is_itm: false,
  minute_of_day: 885,
};

type Row = typeof BASE_ROW;

function makeRow(overrides: Partial<Row> = {}): Row {
  return { ...BASE_ROW, ...overrides };
}

describe('GET /api/options-flow/top-strikes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckBot.mockResolvedValue({ isBot: false });
    mockSql.mockResolvedValue([]);
  });

  // ── Method gate ────────────────────────────────────────────

  it('returns 405 for non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Bot gate ───────────────────────────────────────────────

  it('returns 403 when checkBot flags request as bot', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Query validation ──────────────────────────────────────

  it('returns 400 for invalid limit (limit=0)', async () => {
    const req = mockRequest({ method: 'GET', query: { limit: '0' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid window_minutes (99)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { window_minutes: '99' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────

  it('aggregates 3 alerts for the same strike/type into 1 ranked entry', async () => {
    const rows = [
      makeRow({ created_at: '2026-04-14T19:45:00.000Z' }),
      makeRow({ created_at: '2026-04-14T19:44:00.000Z' }),
      makeRow({ created_at: '2026-04-14T19:43:00.000Z' }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{
        strike: number;
        type: string;
        hit_count: number;
        score: number;
        total_premium: number;
      }>;
      alert_count: number;
    };
    expect(body.strikes).toHaveLength(1);
    expect(body.strikes[0]).toMatchObject({
      strike: 6900,
      type: 'call',
      hit_count: 3,
    });
    expect(body.strikes[0]!.score).toBeGreaterThan(0);
    expect(body.strikes[0]!.total_premium).toBeCloseTo(3 * 152280, 5);
    expect(body.alert_count).toBe(3);
  });

  // ── Empty DB response ─────────────────────────────────────

  it('returns empty-shape response when DB returns no rows', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      strikes: [],
      rollup: {
        bullish_count: 0,
        bearish_count: 0,
        bullish_premium: 0,
        bearish_premium: 0,
        lean: 'neutral',
        confidence: 0,
        top_bullish_strike: null,
        top_bearish_strike: null,
      },
      spot: null,
      window_minutes: 15,
      last_updated: null,
      alert_count: 0,
      timestamps: [],
    });
  });

  // ── Spot derivation ───────────────────────────────────────

  it('derives spot from the most recent (rows[0]) underlying_price', async () => {
    // Handler's SQL orders by created_at DESC, so rows[0] is newest.
    const rows = [
      makeRow({
        created_at: '2026-04-14T19:50:00.000Z',
        underlying_price: '6875',
      }),
      makeRow({
        created_at: '2026-04-14T19:45:00.000Z',
        underlying_price: '6850',
      }),
      makeRow({
        created_at: '2026-04-14T19:40:00.000Z',
        underlying_price: '6840',
      }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { spot: number }).spot).toBe(6875);
  });

  // ── last_updated echoes newest created_at ─────────────────

  it('sets last_updated to the newest created_at (rows[0])', async () => {
    const rows = [
      makeRow({ created_at: '2026-04-14T19:50:00.000Z' }),
      makeRow({ created_at: '2026-04-14T19:45:00.000Z' }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { last_updated: string }).last_updated).toBe(
      '2026-04-14T19:50:00.000Z',
    );
  });

  // ── Default params ────────────────────────────────────────

  it('uses defaults (limit=10, window_minutes=15) when no query given', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { window_minutes: number };
    expect(body.window_minutes).toBe(15);
  });

  // ── Custom params ─────────────────────────────────────────

  it('honors custom limit and window_minutes', async () => {
    // Build 7 distinct strikes so that limit=5 actually truncates.
    const rows = Array.from({ length: 7 }, (_, i) =>
      makeRow({
        strike: String(6900 + i * 5),
        option_chain: `SPXW260415C0690${String(i).padStart(4, '0')}`,
        created_at: `2026-04-14T19:4${i}:00.000Z`,
      }),
    );
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({
      method: 'GET',
      query: { limit: '5', window_minutes: '30' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      window_minutes: number;
    };
    expect(body.strikes).toHaveLength(5);
    expect(body.window_minutes).toBe(30);
  });

  // ── Date mode ──────────────────────────────────────────────

  it('date mode uses session bounds instead of rolling window', async () => {
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
  });

  it('date + as_of (scrub mode) returns an empty shape when no rows match', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-04-15',
        as_of: '2026-04-15T14:30:00.000Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: unknown[];
      alert_count: number;
      timestamps: unknown[];
    };
    expect(body.strikes).toEqual([]);
    expect(body.alert_count).toBe(0);
    expect(body.timestamps).toEqual([]);
  });

  it('rejects as_of without date (Zod refine)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { as_of: '2026-04-15T14:30:00.000Z' },
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
      query: { date: '04/15/2026' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'Invalid query' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Timestamps query ───────────────────────────────────────

  it('returns ISO timestamps from the minute-bucket subquery', async () => {
    mockSql.mockResolvedValueOnce([]); // main rows
    mockSql.mockResolvedValueOnce([
      { ts: '2026-04-15T14:30:00.000Z' },
      { ts: '2026-04-15T14:31:00.000Z' },
      { ts: new Date('2026-04-15T14:32:00.000Z') }, // Date instance path
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-15' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { timestamps: string[] };
    expect(body.timestamps).toEqual([
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ]);
  });

  // ── Row rejection paths ────────────────────────────────────

  it('rejects rows with unknown type (neither call nor put)', async () => {
    const rows = [
      makeRow({ type: 'spread' as 'call' }),
      makeRow({ type: 'call' }),
    ];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: Array<{ hit_count: number }> };
    // Only the valid row survives scoring.
    expect(body.strikes).toHaveLength(1);
    expect(body.strikes[0]!.hit_count).toBe(1);
  });

  it('rejects rows with unknown alert_rule', async () => {
    const rows = [
      makeRow({ alert_rule: 'MysteryRule' as 'RepeatedHits' }),
      makeRow({ alert_rule: 'RepeatedHits' }),
    ];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: Array<{ hit_count: number }> };
    expect(body.strikes).toHaveLength(1);
    expect(body.strikes[0]!.hit_count).toBe(1);
  });

  it('accepts RepeatedHitsAscendingFill and RepeatedHitsDescendingFill rules', async () => {
    const rows = [
      makeRow({
        alert_rule: 'RepeatedHitsAscendingFill' as 'RepeatedHits',
        created_at: '2026-04-14T19:45:00.000Z',
      }),
      makeRow({
        alert_rule: 'RepeatedHitsDescendingFill' as 'RepeatedHits',
        created_at: '2026-04-14T19:44:00.000Z',
      }),
    ];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: unknown[] };
    expect(body.strikes).toHaveLength(1);
  });

  it('rejects rows with non-finite strike', async () => {
    const rows = [makeRow({ strike: 'NaN' }), makeRow({ strike: '6900' })];
    mockSql.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { strikes: Array<{ hit_count: number }> };
    expect(body.strikes).toHaveLength(1);
    expect(body.strikes[0]!.hit_count).toBe(1);
  });

  // ── Cache header ───────────────────────────────────────────

  it('sets Cache-Control: no-store on live responses', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  // ── DB error path ──────────────────────────────────────────

  it('returns 500 when the primary SQL query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    const body = res._json as { error: string; message: string };
    expect(body.error).toBe('DB error');
    expect(body.message).toBe('connection reset');
  });

  it('returns 500 when timestamps query throws (after rows succeed)', async () => {
    mockSql.mockResolvedValueOnce([]); // rows succeed
    mockSql.mockRejectedValueOnce(new Error('timestamps failed'));

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe('DB error');
  });

  // ── Numeric column parsing ────────────────────────────────

  it('parses NUMERIC strings into numbers before scoring', async () => {
    // All numeric columns supplied as strings (Neon serverless behavior).
    const rows = [
      makeRow({
        strike: '6900', // string → must become 6900
        total_premium: '100000', // string → must become 100000
        ask_side_ratio: '0.85', // string → must become 0.85
        volume_oi_ratio: '0.5', // string
        distance_from_spot: '25', // string
        distance_pct: '0.004', // string
        underlying_price: '6875', // string
      }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      strikes: Array<{
        strike: number;
        total_premium: number;
        ask_side_ratio: number;
        volume_oi_ratio: number;
        distance_from_spot: number;
        distance_pct: number;
      }>;
      spot: number;
    };
    expect(body.strikes).toHaveLength(1);
    const s = body.strikes[0]!;
    expect(typeof s.strike).toBe('number');
    expect(s.strike).toBe(6900);
    expect(typeof s.total_premium).toBe('number');
    expect(s.total_premium).toBe(100000);
    expect(typeof s.ask_side_ratio).toBe('number');
    expect(s.ask_side_ratio).toBeCloseTo(0.85, 6);
    expect(s.volume_oi_ratio).toBeCloseTo(0.5, 6);
    expect(s.distance_from_spot).toBe(25);
    expect(s.distance_pct).toBeCloseTo(0.004, 6);
    expect(typeof body.spot).toBe('number');
    expect(body.spot).toBe(6875);
  });
});
