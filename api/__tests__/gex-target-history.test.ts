// @vitest-environment node

/**
 * Tests for `GET /api/gex-target-history` (Phase 5 of the GexTarget rebuild).
 *
 * The endpoint reads `gex_target_features` for one snapshot, reconstructs
 * three `TargetScore` objects (oi/vol/dir), and returns them alongside
 * the per-day SPX 1-minute candles. The tests cover the live, explicit
 * date, and scrubbed input modes plus the empty-database / DB-failure
 * fallback paths described in the Phase 5 spec.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../_lib/spx-candles.js', () => ({
  fetchSPXCandles: vi.fn(),
}));

import handler from '../gex-target-history.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { fetchSPXCandles } from '../_lib/spx-candles.js';

// ── Fixtures ──────────────────────────────────────────────

interface FeatureRowOverrides {
  mode?: 'oi' | 'vol' | 'dir';
  rank?: number;
  isTarget?: boolean;
  tier?: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  wallSide?: 'CALL' | 'PUT' | 'NEUTRAL';
  strike?: number;
  spotPrice?: number;
  finalScore?: number;
  // Phase 1.5 nullable horizon fields — surfaced so the round-trip
  // test can lock in their reconstruction.
  deltaPct1m?: number | null;
  deltaPct5m?: number | null;
  deltaPct20m?: number | null;
  deltaPct60m?: number | null;
  prevGexDollars1m?: number | null;
  prevGexDollars5m?: number | null;
  prevGexDollars20m?: number | null;
  prevGexDollars60m?: number | null;
  // Other commonly-overridden columns
  callRatio?: number;
  charmNet?: number;
  deltaNet?: number;
  vannaNet?: number;
}

/**
 * Build one `gex_target_features` row with sensible defaults. Override
 * via `overrides` for the parts each test cares about.
 */
function makeFeatureRow(overrides: FeatureRowOverrides = {}) {
  const {
    mode = 'oi',
    rank = 1,
    isTarget = rank === 1,
    tier = 'HIGH',
    wallSide = 'CALL',
    strike = 5800,
    spotPrice = 5790,
    finalScore = 0.65,
    deltaPct1m = 0.12,
    deltaPct5m = 0.08,
    deltaPct20m = 0.04,
    deltaPct60m = 0.02,
    prevGexDollars1m = 1_000_000_000,
    prevGexDollars5m = 950_000_000,
    prevGexDollars20m = 900_000_000,
    prevGexDollars60m = 800_000_000,
    callRatio = 0.6,
    charmNet = 5_000_000,
    deltaNet = 2_000_000_000,
    vannaNet = 1_500_000,
  } = overrides;

  return {
    date: '2026-04-08',
    timestamp: '2026-04-08T19:00:00Z',
    mode,
    math_version: 'v1',
    strike: String(strike),

    rank_in_mode: rank,
    rank_by_size: rank,
    is_target: isTarget,

    gex_dollars: '1200000000',

    delta_gex_1m: '120000000',
    delta_gex_5m: '76000000',
    delta_gex_20m: '36000000',
    delta_gex_60m: '16000000',

    prev_gex_dollars_1m:
      prevGexDollars1m === null ? null : String(prevGexDollars1m),
    prev_gex_dollars_5m:
      prevGexDollars5m === null ? null : String(prevGexDollars5m),
    prev_gex_dollars_20m:
      prevGexDollars20m === null ? null : String(prevGexDollars20m),
    prev_gex_dollars_60m:
      prevGexDollars60m === null ? null : String(prevGexDollars60m),

    delta_pct_1m: deltaPct1m === null ? null : String(deltaPct1m),
    delta_pct_5m: deltaPct5m === null ? null : String(deltaPct5m),
    delta_pct_20m: deltaPct20m === null ? null : String(deltaPct20m),
    delta_pct_60m: deltaPct60m === null ? null : String(deltaPct60m),

    call_ratio: String(callRatio),
    charm_net: String(charmNet),
    delta_net: String(deltaNet),
    vanna_net: String(vannaNet),
    dist_from_spot: String(strike - spotPrice),
    spot_price: String(spotPrice),
    minutes_after_noon_ct: '60',

    flow_confluence: '0.55',
    price_confirm: '0.40',
    charm_score: '0.30',
    dominance: '0.80',
    clarity: '0.20',
    proximity: '0.85',

    final_score: String(finalScore),
    tier,
    wall_side: wallSide,
  };
}

/**
 * Build a full 30-row snapshot — 10 strikes per mode × 3 modes — with
 * monotonically decreasing scores so the rank-1 strike is the target
 * and the leaderboard ordering is unambiguous.
 */
function makeFullSnapshotRows() {
  const rows: ReturnType<typeof makeFeatureRow>[] = [];
  const modes: Array<'oi' | 'vol' | 'dir'> = ['oi', 'vol', 'dir'];
  for (const mode of modes) {
    for (let rank = 1; rank <= 10; rank++) {
      rows.push(
        makeFeatureRow({
          mode,
          rank,
          isTarget: rank === 1,
          tier: rank === 1 ? 'HIGH' : 'MEDIUM',
          strike: 5800 + rank * 5,
          finalScore: 0.9 - rank * 0.05,
        }),
      );
    }
  }
  return rows;
}

// Response narrowing — keeps the assertions readable without `any`.
interface ScoreShape {
  strike: number;
  finalScore: number;
  rankByScore: number;
  rankBySize: number;
  isTarget: boolean;
  features: Record<string, unknown>;
  components: Record<string, unknown>;
  tier: string;
  wallSide: string;
}

interface TargetShape {
  target: ScoreShape | null;
  leaderboard: ScoreShape[];
}

interface ResponseShape {
  availableDates: string[];
  date: string | null;
  timestamps: string[];
  timestamp: string | null;
  spot: number | null;
  oi: TargetShape | null;
  vol: TargetShape | null;
  dir: TargetShape | null;
  candles: Array<Record<string, number>>;
  previousClose: number | null;
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/gex-target-history', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    vi.mocked(fetchSPXCandles).mockResolvedValue({
      candles: [],
      previousClose: null,
    });
    mockSql.mockReset();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 403 when checkBot flags the request as a bot', async () => {
    vi.mocked(checkBot).mockResolvedValue({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 for non-owner (matches gex-per-strike policy)', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns the empty payload shape when the database has no rows', async () => {
    // availableDates query → empty
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.availableDates).toEqual([]);
    expect(body.date).toBeNull();
    expect(body.timestamps).toEqual([]);
    expect(body.timestamp).toBeNull();
    expect(body.spot).toBeNull();
    expect(body.oi).toBeNull();
    expect(body.vol).toBeNull();
    expect(body.dir).toBeNull();
    expect(body.candles).toEqual([]);
    expect(body.previousClose).toBeNull();
    // Only one query should fire when the table is empty.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('live mode (no params) returns the latest available date and snapshot', async () => {
    // availableDates
    mockSql.mockResolvedValueOnce([
      { date: '2026-04-07' },
      { date: '2026-04-08' },
    ]);
    // timestamps for 2026-04-08
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-08T18:00:00Z' },
      { timestamp: '2026-04-08T19:00:00Z' },
    ]);
    // feature rows for the latest snapshot (full 30-row board)
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    vi.mocked(fetchSPXCandles).mockResolvedValue({
      candles: [
        {
          open: 5790,
          high: 5795,
          low: 5788,
          close: 5793,
          volume: 1000,
          datetime: 1,
        },
      ],
      previousClose: 5780,
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.availableDates).toEqual(['2026-04-07', '2026-04-08']);
    expect(body.date).toBe('2026-04-08');
    expect(body.timestamp).toBe('2026-04-08T19:00:00.000Z');
    expect(body.timestamps).toHaveLength(2);
    expect(body.oi?.leaderboard).toHaveLength(10);
    expect(body.vol?.leaderboard).toHaveLength(10);
    expect(body.dir?.leaderboard).toHaveLength(10);
    expect(body.candles).toHaveLength(1);
    expect(body.previousClose).toBe(5780);
    expect(body.spot).toBe(5790);
  });

  it('explicit date (no ts) returns the latest snapshot for that date', async () => {
    mockSql.mockResolvedValueOnce([
      { date: '2026-04-07' },
      { date: '2026-04-08' },
    ]);
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-07T17:30:00Z' },
      { timestamp: '2026-04-07T18:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-07' } }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.date).toBe('2026-04-07');
    expect(body.timestamp).toBe('2026-04-07T18:00:00.000Z');
  });

  it('scrubbed (date + ts) returns the exact requested snapshot', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-08T18:00:00Z' },
      { timestamp: '2026-04-08T18:30:00Z' },
      { timestamp: '2026-04-08T19:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-08', ts: '2026-04-08T18:30:00Z' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.timestamp).toBe('2026-04-08T18:30:00.000Z');
  });

  it('falls back to the latest snapshot when ts is not in the day list', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([
      { timestamp: '2026-04-08T18:00:00Z' },
      { timestamp: '2026-04-08T19:00:00Z' },
    ]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { date: '2026-04-08', ts: '2026-04-08T05:00:00Z' },
      }),
      res,
    );

    // NOT a 400 — silently falls back to latest.
    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.timestamp).toBe('2026-04-08T19:00:00.000Z');
  });

  it('returns 400 for an invalid date param', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'Invalid date' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('groups rows by mode and sorts each leaderboard by rank', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    // Intentionally pass rows out of order so the sort step is exercised.
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({ mode: 'vol', rank: 2, strike: 5810, isTarget: false }),
      makeFeatureRow({ mode: 'oi', rank: 3, strike: 5815, isTarget: false }),
      makeFeatureRow({ mode: 'dir', rank: 1, strike: 5805, isTarget: true }),
      makeFeatureRow({ mode: 'oi', rank: 1, strike: 5800, isTarget: true }),
      makeFeatureRow({ mode: 'vol', rank: 1, strike: 5805, isTarget: true }),
      makeFeatureRow({ mode: 'oi', rank: 2, strike: 5810, isTarget: false }),
      makeFeatureRow({ mode: 'dir', rank: 2, strike: 5810, isTarget: false }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;

    expect(body.oi?.leaderboard.map((s) => s.rankByScore)).toEqual([1, 2, 3]);
    expect(body.vol?.leaderboard.map((s) => s.rankByScore)).toEqual([1, 2]);
    expect(body.dir?.leaderboard.map((s) => s.rankByScore)).toEqual([1, 2]);

    expect(body.oi?.target?.strike).toBe(5800);
    expect(body.vol?.target?.strike).toBe(5805);
    expect(body.dir?.target?.strike).toBe(5805);
  });

  it('keeps target null when the top-ranked row is tier NONE', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({
        mode: 'oi',
        rank: 1,
        tier: 'NONE',
        isTarget: false,
        strike: 5800,
      }),
      makeFeatureRow({
        mode: 'oi',
        rank: 2,
        tier: 'NONE',
        isTarget: false,
        strike: 5810,
      }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.oi?.target).toBeNull();
    expect(body.oi?.leaderboard).toHaveLength(2);
    expect(body.oi?.leaderboard[0]?.tier).toBe('NONE');
  });

  it('reconstructs every StrikeScore field including Phase 1.5 nullable horizons', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    // One row with a known mix of populated and null horizons.
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({
        mode: 'oi',
        rank: 1,
        isTarget: true,
        deltaPct20m: null,
        deltaPct60m: null,
        prevGexDollars20m: null,
        prevGexDollars60m: null,
      }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    const target = body.oi?.target;
    expect(target).not.toBeNull();
    expect(target?.strike).toBe(5800);
    expect(target?.isTarget).toBe(true);

    const features = target?.features as {
      strike: number;
      spot: number;
      distFromSpot: number;
      gexDollars: number;
      deltaPct_1m: number | null;
      deltaPct_5m: number | null;
      deltaPct_20m: number | null;
      deltaPct_60m: number | null;
      prevGexDollars_1m: number | null;
      prevGexDollars_5m: number | null;
      prevGexDollars_20m: number | null;
      prevGexDollars_60m: number | null;
      callRatio: number;
      charmNet: number;
      deltaNet: number;
      vannaNet: number;
      minutesAfterNoonCT: number;
    };

    expect(features.strike).toBe(5800);
    expect(features.spot).toBe(5790);
    expect(features.distFromSpot).toBe(10);
    expect(features.gexDollars).toBe(1_200_000_000);
    expect(features.deltaPct_1m).toBeCloseTo(0.12);
    expect(features.deltaPct_5m).toBeCloseTo(0.08);
    // Null horizons must round-trip as null, NOT 0 — the scoring math
    // distinguishes "missing" from "zero".
    expect(features.deltaPct_20m).toBeNull();
    expect(features.deltaPct_60m).toBeNull();
    expect(features.prevGexDollars_1m).toBe(1_000_000_000);
    expect(features.prevGexDollars_20m).toBeNull();
    expect(features.prevGexDollars_60m).toBeNull();
    expect(features.callRatio).toBeCloseTo(0.6);
    expect(features.charmNet).toBe(5_000_000);
    expect(features.deltaNet).toBe(2_000_000_000);
    expect(features.vannaNet).toBe(1_500_000);
    expect(features.minutesAfterNoonCT).toBe(60);

    const components = target?.components as {
      flowConfluence: number;
      priceConfirm: number;
      charmScore: number;
      dominance: number;
      clarity: number;
      proximity: number;
    };
    expect(components.flowConfluence).toBeCloseTo(0.55);
    expect(components.priceConfirm).toBeCloseTo(0.4);
    expect(components.charmScore).toBeCloseTo(0.3);
    expect(components.dominance).toBeCloseTo(0.8);
    expect(components.clarity).toBeCloseTo(0.2);
    expect(components.proximity).toBeCloseTo(0.85);

    expect(target?.tier).toBe('HIGH');
    expect(target?.wallSide).toBe('CALL');
  });

  it('includes candles fetched from spx-candles.ts', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    const candles = [
      {
        open: 5790,
        high: 5795,
        low: 5788,
        close: 5793,
        volume: 1000,
        datetime: 1,
      },
      {
        open: 5793,
        high: 5800,
        low: 5792,
        close: 5798,
        volume: 1500,
        datetime: 2,
      },
    ];
    vi.mocked(fetchSPXCandles).mockResolvedValue({
      candles,
      previousClose: 5780,
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.candles).toHaveLength(2);
    expect(body.previousClose).toBe(5780);
    expect(fetchSPXCandles).toHaveBeenCalledWith(
      expect.any(String),
      '2026-04-08',
    );
  });

  it('still returns 200 with empty candles when fetchSPXCandles throws', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    vi.mocked(fetchSPXCandles).mockRejectedValue(new Error('UW down'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.candles).toEqual([]);
    expect(body.previousClose).toBeNull();
    // The leaderboards should still be populated — a candles failure
    // must not take down the whole response.
    expect(body.oi?.leaderboard).toHaveLength(10);
  });

  it('returns 500 and captures the exception when a feature query throws', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns the partial empty payload when the resolved date has no snapshots', async () => {
    // availableDates contains 2026-04-08 (so the date isn't a 404),
    // but the timestamps query for it returns nothing — this is the
    // race-condition case where the dates list was stale.
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([]);

    vi.mocked(fetchSPXCandles).mockResolvedValue({
      candles: [
        {
          open: 5790,
          high: 5795,
          low: 5788,
          close: 5793,
          volume: 1000,
          datetime: 1,
        },
      ],
      previousClose: 5780,
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.availableDates).toEqual(['2026-04-08']);
    expect(body.date).toBe('2026-04-08');
    expect(body.timestamps).toEqual([]);
    expect(body.timestamp).toBeNull();
    expect(body.oi).toBeNull();
    expect(body.vol).toBeNull();
    expect(body.dir).toBeNull();
    expect(body.spot).toBeNull();
    // Candles are still fetched on the empty path so the chart panel
    // can render even when the leaderboards are empty.
    expect(body.candles).toHaveLength(1);
    expect(body.previousClose).toBe(5780);
  });

  it('sets Cache-Control: no-store on every response path', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('normalizes Date objects from the driver to ISO 8601 strings', async () => {
    const d1 = new Date('2026-04-08T18:00:00Z');
    const d2 = new Date('2026-04-08T19:00:00Z');

    mockSql.mockResolvedValueOnce([{ date: new Date('2026-04-08T00:00:00Z') }]);
    mockSql.mockResolvedValueOnce([{ timestamp: d1 }, { timestamp: d2 }]);
    mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    expect(body.date).toBe('2026-04-08');
    expect(body.timestamps).toEqual([
      '2026-04-08T18:00:00.000Z',
      '2026-04-08T19:00:00.000Z',
    ]);
    expect(body.timestamp).toBe('2026-04-08T19:00:00.000Z');
    // The displayed timestamp must be findable in the timestamps list
    // for the frontend's scrub controls.
    expect(body.timestamps.indexOf(body.timestamp!)).toBeGreaterThanOrEqual(0);
  });
});
