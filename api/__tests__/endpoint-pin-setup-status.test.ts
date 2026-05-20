// @vitest-environment node

/**
 * HTTP-level tests for GET /api/pin-setup-status.
 *
 * Covers: method guard, owner-or-guest gate, schema rejection of bad
 * date format, happy paths for ARMED / WATCH / NOT_TRIGGERED, empty-
 * data path, historical mode with outcome, and error propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from '../_lib/api-helpers.js';
import handler from '../pin-setup-status.js';
import { Sentry } from '../_lib/sentry.js';

const SNAP_TS = '2026-05-14T15:30:00.000Z';

/**
 * Build a per-strike row matching the SQL projection in db-pin-setup.ts.
 */
function strikeRow(
  strike: number,
  netGammaRaw: number,
  netCharmRaw = -5e9,
  spot = 7505,
) {
  return {
    strike,
    spot,
    net_gamma_raw: netGammaRaw,
    net_charm_raw: netCharmRaw,
    snapshot_ts: SNAP_TS,
  };
}

/** Mock the four sql calls db-pin-setup makes in live mode (3 with no
 *  trajectory, no settle): snapshot-ts → strikes → trajectory. */
function mockLive(strikes: ReturnType<typeof strikeRow>[]) {
  mockSql.mockResolvedValueOnce([{ ts: SNAP_TS }]); // snapshot ts
  mockSql.mockResolvedValueOnce(strikes); // strike rows
  mockSql.mockResolvedValueOnce([]); // trajectory rows (empty for test)
}

/** Mock the four sql calls for historical mode (adds settle). */
function mockHistorical(
  strikes: ReturnType<typeof strikeRow>[],
  settle: number | null,
) {
  mockSql.mockResolvedValueOnce([{ ts: SNAP_TS }]); // snapshot ts
  mockSql.mockResolvedValueOnce(strikes); // strike rows
  mockSql.mockResolvedValueOnce([]); // trajectory rows
  mockSql.mockResolvedValueOnce(settle == null ? [] : [{ close: settle }]);
}

beforeEach(() => {
  vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  vi.mocked(isMarketOpen).mockReturnValue(false);
  vi.mocked(setCacheHeaders).mockClear();
  mockSql.mockReset();
});

describe('GET /api/pin-setup-status', () => {
  // ── Method guard ────────────────────────────────────────────

  it('returns 405 for non-GET methods', async () => {
    const req = mockRequest({ method: 'POST', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('short-circuits when owner-or-guest guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when an unexpected query param is supplied', async () => {
    const req = mockRequest({ method: 'GET', query: { ticker: 'SPY' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when date format is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '05/14/2026' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  // ── Empty path ─────────────────────────────────────────────

  it('returns 200 NOT_TRIGGERED when no snapshot exists', async () => {
    mockSql.mockResolvedValueOnce([{ ts: null }]); // no snapshot
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      mode: 'live',
      state: 'NOT_TRIGGERED',
      spot: null,
      bias: 'no-signal',
      recommendedTradeTypes: ['directional_long_call', 'directional_long_put'],
      avoidedTradeTypes: [],
    });
  });

  it('returns NOT_TRIGGERED when every top strike is non-positive γ (anti-magnet guard)', async () => {
    // Universe with no positive net γ — e.g. pure-put-skew morning.
    mockLive([strikeRow(7500, -3_000e6, 0, 7505), strikeRow(7490, -1_000e6)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      state: string;
      conditions: { magnetStrike: number | null };
      bias: string;
    };
    expect(body.state).toBe('NOT_TRIGGERED');
    expect(body.conditions.magnetStrike).toBeNull();
    expect(body.bias).toBe('no-signal');
  });

  // ── ARMED happy path ───────────────────────────────────────

  it('returns ARMED when all 3 conditions met (round-50 + heavy γ + close to spot)', async () => {
    // Magnet at 7500 with 41,751M net γ; spot 7505 (delta -5 inside ±15)
    mockLive([
      strikeRow(7500, 41_751e6, -5_321e6, 7505),
      strikeRow(7505, 6_292e6),
    ]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      mode: string;
      state: string;
      bias: string;
      conditions: Record<string, unknown>;
      recommendedTradeTypes: string[];
      avoidedTradeTypes: string[];
      outcome: unknown;
    };
    expect(body.mode).toBe('live');
    expect(body.state).toBe('ARMED');
    expect(body.bias).toBe('fade-rips'); // spot > magnet + 3
    expect(body.conditions).toMatchObject({
      magnetStrike: 7500,
      netGammaAtMagnetM: 41751,
      isRound50: true,
      netGammaMet: true,
      distanceMet: true,
    });
    expect(body.recommendedTradeTypes).toContain('credit_call_spread');
    expect(body.avoidedTradeTypes).toContain('directional_long_call');
    expect(body.outcome).toBeNull();
  });

  it('returns full-pin bias when spot within ±3 of magnet', async () => {
    mockLive([strikeRow(7500, 41_751e6, -5_321e6, 7501)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { bias: string; recommendedTradeTypes: string[] };
    expect(body.bias).toBe('full-pin');
    expect(body.recommendedTradeTypes).toContain('iron_condor');
  });

  it('returns fade-dips bias when spot below magnet by > 3', async () => {
    mockLive([strikeRow(7500, 41_751e6, -5_321e6, 7490)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { bias: string };
    expect(body.bias).toBe('fade-dips');
  });

  // ── WATCH path ─────────────────────────────────────────────

  it('returns WATCH when magnet is off-round but other conditions hold', async () => {
    // 7415: heavy γ, in range, but NOT divisible by 50
    mockLive([strikeRow(7415, 25_000e6, -1_000e6, 7414)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      state: string;
      conditions: Record<string, unknown>;
    };
    expect(body.state).toBe('WATCH');
    expect(body.conditions).toMatchObject({
      magnetStrike: 7415,
      isRound50: false,
      netGammaMet: true,
      distanceMet: true,
    });
  });

  // ── NOT_TRIGGERED path ─────────────────────────────────────

  it('returns NOT_TRIGGERED when only one condition holds', async () => {
    // 7350: round-50 OK, but only 446M γ (under threshold) and spot far
    mockLive([strikeRow(7350, 446e6, 0, 7324)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { state: string; bias: string };
    expect(body.state).toBe('NOT_TRIGGERED');
    expect(body.bias).toBe('no-signal');
  });

  // ── Historical mode ────────────────────────────────────────

  it('returns historical mode with outcome when date is supplied and settle exists', async () => {
    mockHistorical(
      [strikeRow(7500, 41_751e6, -5_321e6, 7505)],
      7499.1, // settle
    );
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      mode: string;
      date: string | null;
      state: string;
      outcome: { settle: number; settleVsMagnet: number } | null;
    };
    expect(body.mode).toBe('historical');
    expect(body.date).toBe('2026-05-14');
    expect(body.state).toBe('ARMED');
    expect(body.outcome).toEqual({ settle: 7499.1, settleVsMagnet: -0.9 });
  });

  it('returns historical mode with null outcome when no settle row', async () => {
    mockHistorical([strikeRow(7500, 41_751e6, -5_321e6, 7505)], null);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { outcome: unknown };
    expect(body.outcome).toBeNull();
  });

  // ── Staleness ──────────────────────────────────────────────

  it('reports staleMinutes >= snapshot age', async () => {
    // Snapshot 2 hours before now
    const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockSql.mockResolvedValueOnce([{ ts: oldTs }]);
    mockSql.mockResolvedValueOnce([
      {
        strike: 7500,
        spot: 7505,
        net_gamma_raw: 41_751e6,
        net_charm_raw: -5_321e6,
        snapshot_ts: oldTs,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // trajectory

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as { staleMinutes: number | null };
    expect(body.staleMinutes).toBeGreaterThanOrEqual(119);
    expect(body.staleMinutes).toBeLessThanOrEqual(121);
  });

  // ── Cache header tiering ───────────────────────────────────

  it('uses 30s cache during live mode when market is open', async () => {
    vi.mocked(isMarketOpen).mockReturnValueOnce(true);
    mockLive([strikeRow(7500, 41_751e6, -5_321e6, 7505)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 30, 60);
  });

  it('uses 300s cache during live mode when market is closed', async () => {
    vi.mocked(isMarketOpen).mockReturnValueOnce(false);
    mockLive([strikeRow(7500, 41_751e6, -5_321e6, 7505)]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 300, 60);
  });

  it('uses 3600s cache in historical mode regardless of market state', async () => {
    vi.mocked(isMarketOpen).mockReturnValueOnce(true);
    mockHistorical([strikeRow(7500, 41_751e6, -5_321e6, 7505)], 7499.1);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(setCacheHeaders).toHaveBeenCalledWith(res, 3600, 60);
  });

  // ── Trajectory ─────────────────────────────────────────────

  it('downsamples trajectory and formats CT timestamps', async () => {
    // Build 400 minute rows; expect downsampled to <= 200.
    const traj = Array.from({ length: 400 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 4, 14, 13, 30 + i)).toISOString(),
      price: 7500 + i * 0.01,
      gamma_dir: (1000 + i) * 1e6,
    }));
    mockSql.mockResolvedValueOnce([{ ts: SNAP_TS }]);
    mockSql.mockResolvedValueOnce([strikeRow(7500, 41_751e6, -5_321e6, 7505)]);
    mockSql.mockResolvedValueOnce(traj);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      trajectory: Array<{ ts: string; gammaDirM: number }>;
    };
    expect(body.trajectory.length).toBeLessThanOrEqual(200);
    expect(body.trajectory.length).toBeGreaterThan(0);
    // HH:MM CT formatted string
    expect(body.trajectory[0]!.ts).toMatch(/^\d{2}:\d{2}$/);
  });

  it('preserves chronological order — reverses DESC SQL output before downsampling (tail-preservation)', async () => {
    // db-pin-setup.ts queries `ORDER BY timestamp DESC LIMIT 600` and then
    // `.slice().reverse()` so the handler sees the session in chronological
    // (ASC) order. This test hands the mock 600 rows in DESC order with a
    // strictly increasing gamma_dir from oldest → newest, then asserts the
    // first element of the downsampled output is the OLDEST sample and the
    // last is close to the NEWEST. If someone removes the .reverse() or
    // flips the SQL to ASC by mistake, both assertions fail — catches the
    // regression that the previous test (length + format only) would miss.
    const N = 600;
    const traj = Array.from({ length: N }, (_, descIdx) => ({
      ts: new Date(
        Date.UTC(2026, 4, 14, 13, 30 + (N - 1 - descIdx)),
      ).toISOString(),
      price: 7500,
      // Newest (descIdx=0) gets the highest value; oldest (descIdx=N-1) the lowest.
      gamma_dir: (10_000 + (N - 1 - descIdx)) * 1e6,
    }));
    mockSql.mockResolvedValueOnce([{ ts: SNAP_TS }]);
    mockSql.mockResolvedValueOnce([strikeRow(7500, 41_751e6, -5_321e6, 7505)]);
    mockSql.mockResolvedValueOnce(traj);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      trajectory: Array<{ gammaDirM: number }>;
    };
    expect(body.trajectory.length).toBeGreaterThan(0);
    // First downsampled row corresponds to ASC index 0 = oldest = 10_000.
    expect(body.trajectory[0]!.gammaDirM).toBe(10_000);
    // Last downsampled row must be strictly newer than the first —
    // i.e., the trajectory is chronological, not reversed.
    const last = body.trajectory.at(-1)!.gammaDirM;
    expect(last).toBeGreaterThan(body.trajectory[0]!.gammaDirM);
    // And the last row should be within one downsample step of the newest
    // sample (newest = 10_599). step = ceil(600/200) = 3, so last ASC
    // index kept is 597 → gamma 10_597. Allow a small tolerance for the
    // step arithmetic.
    expect(last).toBeGreaterThanOrEqual(10_590);
  });

  // ── Error path ─────────────────────────────────────────────

  it('returns 500 and reports to Sentry when SQL throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'internal_error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
