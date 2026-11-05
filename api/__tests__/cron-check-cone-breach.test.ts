// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────

const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
  transaction: vi.fn(),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
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
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const isMarketHours =
      utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour <= 21;
    if (!isMarketHours) {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    }
    return {
      apiKey: '',
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

import handler from '../cron/check-cone-breach.js';
import { Sentry } from '../_lib/sentry.js';

// ── Fixtures ──────────────────────────────────────────────────

const MARKET_TIME = new Date('2026-05-08T15:00:00.000Z');
const TODAY = '2026-05-08';

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/**
 * Queue a cone-row SELECT followed by a spot-row SELECT. The handler
 * always issues these two SELECTs in this order before any INSERT.
 *
 * Numeric fields accept `number | string` because Neon returns
 * NUMERIC columns as strings; tests below exercise both shapes.
 */
function queueConeAndSpot(
  cone: { cone_upper: number | string; cone_lower: number | string } | null,
  spot: { close: number | string; timestamp: string } | null,
): void {
  mockSql.mockResolvedValueOnce(cone == null ? [] : [cone]);
  mockSql.mockResolvedValueOnce(spot == null ? [] : [spot]);
}

describe('check-cone-breach handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth + method guards ──────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 without CRON_SECRET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Skip paths ────────────────────────────────────────────

  it('skips when no cone_levels row exists for today (pre-9:31)', async () => {
    queueConeAndSpot(null, null);

    const res = mockResponse();
    await handler(authedReq(), res);

    // Only the cone SELECT runs; we exit before the spot lookup.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('skips when SPX bar is not yet populated', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      null, // empty spot rows
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(2); // cone SELECT + spot SELECT
  });

  // ── Inside-cone (no breach) ───────────────────────────────

  it('does not INSERT when spot is inside the cone', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 5800, timestamp: '2026-05-08T15:00:00.000Z' },
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    // 2 SELECTs only — no INSERT
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Upper breach ──────────────────────────────────────────

  it('INSERTs an upper breach event when spot exceeds cone_upper', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 5815.5, timestamp: '2026-05-08T15:00:00.000Z' },
    );
    // 3rd call = INSERT, returns the new row id
    mockSql.mockResolvedValueOnce([{ id: 42 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(3);
    const insertArgs = mockSql.mock.calls[2]!.slice(1) as unknown[];
    // INSERT VALUES order: date, direction, breach_time, spot, bound, pts_past
    expect(insertArgs[0]).toBe(TODAY);
    expect(insertArgs[1]).toBe('upper');
    expect(insertArgs[3]).toBe(5815.5); // spot_at_breach
    expect(insertArgs[4]).toBe(5810); // cone_bound_at_breach
    expect(insertArgs[5]).toBe(5.5); // pts_past_bound
  });

  it('surfaces a failed breach INSERT as a 500 with a captured exception', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 5815.5, timestamp: '2026-05-08T15:00:00.000Z' },
    );
    const insertError = new Error('insert failed');
    mockSql.mockRejectedValueOnce(insertError);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({
      job: 'check-cone-breach',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(insertError);
  });

  // ── Lower breach ──────────────────────────────────────────

  it('INSERTs a lower breach event when spot is below cone_lower', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 5783.25, timestamp: '2026-05-08T15:00:00.000Z' },
    );
    mockSql.mockResolvedValueOnce([{ id: 43 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(3);
    const insertArgs = mockSql.mock.calls[2]!.slice(1) as unknown[];
    expect(insertArgs[0]).toBe(TODAY);
    expect(insertArgs[1]).toBe('lower');
    expect(insertArgs[3]).toBe(5783.25);
    expect(insertArgs[4]).toBe(5790);
    expect(insertArgs[5]).toBe(6.75);
  });

  // ── Idempotency ───────────────────────────────────────────

  it('does not double-record when the same direction has already breached', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 5815, timestamp: '2026-05-08T15:00:00.000Z' },
    );
    // ON CONFLICT DO NOTHING + RETURNING id → empty rows on duplicate
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    // Still 3 SQL calls — INSERT was attempted but no row returned, so the
    // logger.info call is gated; no second alert/notification fires.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── String-typed Neon numerics ────────────────────────────

  it('parses Neon numeric strings for cone bounds + spot', async () => {
    queueConeAndSpot(
      // Neon returns NUMERIC as strings
      { cone_upper: '5810.00', cone_lower: '5790.00' },
      { close: '5815.50', timestamp: '2026-05-08T15:00:00.000Z' },
    );
    mockSql.mockResolvedValueOnce([{ id: 44 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const insertArgs = mockSql.mock.calls[2]!.slice(1) as unknown[];
    expect(insertArgs[1]).toBe('upper');
    expect(insertArgs[5]).toBe(5.5); // pts_past, computed from parsed strings
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Error paths: returned `error` must still reach Sentry ──
  //
  // withCronInstrumentation captures only thrown errors; a returned
  // `status: 'error'` gets a red check-in and nothing else (R4).

  it('returns error and warns Sentry when a cone bound is unparseable', async () => {
    queueConeAndSpot({ cone_upper: 'not-a-number', cone_lower: 5790 }, null);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'check-cone-breach',
      status: 'error',
      reason: 'cone_bounds_unparseable',
    });
    // Exits before the spot lookup; nothing is written.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'check-cone-breach: cone bounds unparseable',
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['check-cone-breach', 'cone-bounds-unparseable'],
        extra: expect.objectContaining({
          coneUpper: 'not-a-number',
          coneLower: 5790,
        }),
      }),
    );
  });

  it('returns error and warns Sentry when the SPX close is unparseable', async () => {
    queueConeAndSpot(
      { cone_upper: 5810, cone_lower: 5790 },
      { close: 'garbage', timestamp: '2026-05-08T15:00:00.000Z' },
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({
      status: 'error',
      reason: 'spx_close_unparseable',
    });
    // Cone + spot SELECTs only; no INSERT.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'check-cone-breach: SPX close unparseable',
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['check-cone-breach', 'spx-close-unparseable'],
        extra: expect.objectContaining({ close: 'garbage' }),
      }),
    );
  });
});
