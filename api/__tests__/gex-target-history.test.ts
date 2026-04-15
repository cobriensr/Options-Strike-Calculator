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

type GexMode = 'oi' | 'vol' | 'dir';

interface FeatureRowOverrides {
  mode?: GexMode;
  // `rank` only controls the test-local strike/gex magnitude so the
  // fallback ordering (by |gex_dollars| desc) in the endpoint gives
  // rank-1 rows larger gex than higher-ranked ones. Derived columns were
  // dropped in migration #58 so rank is no longer stored on the row.
  rank?: number;
  strike?: number;
  spotPrice?: number;
  // Phase 1.5 nullable horizon fields — surfaced so the round-trip
  // test can lock in their reconstruction.
  deltaPct1m?: number | null;
  deltaPct5m?: number | null;
  deltaPct20m?: number | null;
  deltaPct60m?: number | null;
  prevGexDollars1m?: number | null;
  prevGexDollars5m?: number | null;
  prevGexDollars10m?: number | null;
  prevGexDollars15m?: number | null;
  prevGexDollars20m?: number | null;
  prevGexDollars60m?: number | null;
  // Other commonly-overridden columns
  callRatio?: number;
  charmNet?: number;
  deltaNet?: number;
  vannaNet?: number;
  gexDollars?: number;
}

/**
 * Build one `gex_target_features` row with sensible defaults. Override
 * via `overrides` for the parts each test cares about.
 */
function makeFeatureRow(overrides: FeatureRowOverrides = {}) {
  const {
    mode = 'oi',
    rank = 1,
    strike = 5800,
    spotPrice = 5790,
    deltaPct1m = 0.12,
    deltaPct5m = 0.08,
    deltaPct20m = 0.04,
    deltaPct60m = 0.02,
    prevGexDollars1m = 1_000_000_000,
    prevGexDollars5m = 950_000_000,
    prevGexDollars10m = 930_000_000,
    prevGexDollars15m = 920_000_000,
    prevGexDollars20m = 900_000_000,
    prevGexDollars60m = 800_000_000,
    callRatio = 0.6,
    charmNet = 5_000_000,
    deltaNet = 2_000_000_000,
    vannaNet = 1_500_000,
    // Fallback ordering in the endpoint is by |gex_dollars| desc.
    // Derive a rank-sensitive magnitude so rank-1 has the largest
    // |gex| and thus sorts first.
    gexDollars = 1_200_000_000 - (rank - 1) * 100_000_000,
  } = overrides;

  return {
    date: '2026-04-08',
    timestamp: '2026-04-08T19:00:00Z',
    mode,
    math_version: 'v1',
    strike: String(strike),

    gex_dollars: String(gexDollars),

    delta_gex_1m: '120000000',
    delta_gex_5m: '76000000',
    delta_gex_20m: '36000000',
    delta_gex_60m: '16000000',

    prev_gex_dollars_1m:
      prevGexDollars1m === null ? null : String(prevGexDollars1m),
    prev_gex_dollars_5m:
      prevGexDollars5m === null ? null : String(prevGexDollars5m),
    prev_gex_dollars_10m:
      prevGexDollars10m === null ? null : String(prevGexDollars10m),
    prev_gex_dollars_15m:
      prevGexDollars15m === null ? null : String(prevGexDollars15m),
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
  };
}

/**
 * Build a full 30-row snapshot — 10 strikes per mode × 3 modes — with
 * monotonically decreasing scores so the rank-1 strike is the target
 * and the leaderboard ordering is unambiguous.
 */
function makeFullSnapshotRows() {
  const rows: ReturnType<typeof makeFeatureRow>[] = [];
  const modes: GexMode[] = ['oi', 'vol', 'dir'];
  for (const mode of modes) {
    for (let rank = 1; rank <= 10; rank++) {
      rows.push(
        makeFeatureRow({
          mode,
          rank,
          strike: 5800 + rank * 5,
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

  it('groups rows by mode and sorts each leaderboard by |gex_dollars| desc', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    // Intentionally pass rows out of order so the sort step is exercised.
    // `rank` in makeFeatureRow drives the default gex_dollars magnitude,
    // so rank-1 rows sort first in the fallback ordering.
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({ mode: 'vol', rank: 2, strike: 5810 }),
      makeFeatureRow({ mode: 'oi', rank: 3, strike: 5815 }),
      makeFeatureRow({ mode: 'dir', rank: 1, strike: 5805 }),
      makeFeatureRow({ mode: 'oi', rank: 1, strike: 5800 }),
      makeFeatureRow({ mode: 'vol', rank: 1, strike: 5805 }),
      makeFeatureRow({ mode: 'oi', rank: 2, strike: 5810 }),
      makeFeatureRow({ mode: 'dir', rank: 2, strike: 5810 }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;

    // Leaderboards are ordered by |gex_dollars| desc — rank-1 rows first.
    expect(body.oi?.leaderboard.map((s) => s.strike)).toEqual([
      5800, 5810, 5815,
    ]);
    expect(body.vol?.leaderboard.map((s) => s.strike)).toEqual([5805, 5810]);
    expect(body.dir?.leaderboard.map((s) => s.strike)).toEqual([5805, 5810]);

    // target is always null — the browser computes it from raw features.
    expect(body.oi?.target).toBeNull();
    expect(body.vol?.target).toBeNull();
    expect(body.dir?.target).toBeNull();
  });

  it('target is always null regardless of leaderboard contents', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({ mode: 'oi', rank: 1, strike: 5800 }),
      makeFeatureRow({ mode: 'oi', rank: 2, strike: 5810 }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as ResponseShape;
    // Derived scoring columns were dropped in migration #58 — the
    // server can't know what the target is anymore, so it always
    // returns null. Browser computes the target from raw features.
    expect(body.oi?.target).toBeNull();
    expect(body.oi?.leaderboard).toHaveLength(2);
    // tier defaults to 'NONE' since the DB no longer stores it.
    expect(body.oi?.leaderboard[0]?.tier).toBe('NONE');
  });

  it('reconstructs every raw feature field including Phase 1.5 nullable horizons', async () => {
    mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
    mockSql.mockResolvedValueOnce([{ timestamp: '2026-04-08T19:00:00Z' }]);
    // One row with a known mix of populated and null horizons.
    mockSql.mockResolvedValueOnce([
      makeFeatureRow({
        mode: 'oi',
        rank: 1,
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
    // Derived scoring columns were dropped in migration #58, so target
    // is always null — pull the first leaderboard row instead and
    // verify raw feature round-tripping off of that.
    const entry = body.oi?.leaderboard[0];
    expect(entry).toBeDefined();
    expect(entry?.strike).toBe(5800);
    // Derived defaults — filled client-side before display.
    expect(entry?.isTarget).toBe(false);
    expect(entry?.finalScore).toBe(0);
    expect(entry?.tier).toBe('NONE');
    expect(entry?.wallSide).toBe('NEUTRAL');
    expect(entry?.rankByScore).toBe(0);
    expect(entry?.rankBySize).toBe(0);

    const features = entry?.features as {
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

    // Components default to zero since the DB no longer stores them.
    const components = entry?.components as {
      flowConfluence: number;
      priceConfirm: number;
      charmScore: number;
      dominance: number;
      clarity: number;
      proximity: number;
    };
    expect(components.flowConfluence).toBe(0);
    expect(components.priceConfirm).toBe(0);
    expect(components.charmScore).toBe(0);
    expect(components.dominance).toBe(0);
    expect(components.clarity).toBe(0);
    expect(components.proximity).toBe(0);
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

  // ── ?all=true bulk mode ───────────────────────────────────────
  describe('?all=true bulk mode', () => {
    /**
     * Build a minimal set of feature rows for a given timestamp
     * with one row per mode (oi/vol/dir) × 2 ranks = 6 rows per ts.
     */
    function makeTimestampRows(
      ts: string,
      spotPrice = 5790,
    ): ReturnType<typeof makeFeatureRow>[] {
      const modes: GexMode[] = ['oi', 'vol', 'dir'];
      const rows: ReturnType<typeof makeFeatureRow>[] = [];
      for (const mode of modes) {
        for (let rank = 1; rank <= 2; rank++) {
          rows.push(
            makeFeatureRow({
              mode,
              rank,
              strike: 5800 + rank * 5,
              spotPrice,
            }),
          );
          // Patch the timestamp in-place so rows belong to `ts`.
          rows.at(-1)!.timestamp = ts;
        }
      }
      return rows;
    }

    it('returns all snapshots for the date', async () => {
      const ts1 = '2026-04-02T15:00:00Z';
      const ts2 = '2026-04-02T15:05:00Z';

      // availableDates
      mockSql.mockResolvedValueOnce([{ date: '2026-04-02' }]);
      // timestamps
      mockSql.mockResolvedValueOnce([{ timestamp: ts1 }, { timestamp: ts2 }]);
      // all-rows (bulk) query
      mockSql.mockResolvedValueOnce([
        ...makeTimestampRows(ts1),
        ...makeTimestampRows(ts2),
      ]);

      vi.mocked(fetchSPXCandles).mockResolvedValue({
        candles: [
          {
            open: 5790,
            high: 5800,
            low: 5785,
            close: 5795,
            volume: 1000,
            datetime: 1743606000000,
          },
        ],
        previousClose: null,
      });

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-04-02', all: 'true' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        snapshots: Array<{
          timestamp: string;
          spot: number | null;
          oi: unknown;
          vol: unknown;
          dir: unknown;
        }>;
        candles: unknown[];
        previousClose: number | null;
        availableDates: string[];
        timestamps: string[];
        date: string;
      };
      expect(body.snapshots).toHaveLength(2);
      expect(body.snapshots[0]!.timestamp).toBe('2026-04-02T15:00:00.000Z');
      expect(body.snapshots[1]!.timestamp).toBe('2026-04-02T15:05:00.000Z');
    });

    it('each snapshot has oi/vol/dir from its own rows', async () => {
      const ts1 = '2026-04-02T15:00:00Z';
      const ts2 = '2026-04-02T15:05:00Z';

      mockSql.mockResolvedValueOnce([{ date: '2026-04-02' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: ts1 }, { timestamp: ts2 }]);
      mockSql.mockResolvedValueOnce([
        ...makeTimestampRows(ts1),
        ...makeTimestampRows(ts2),
      ]);

      vi.mocked(fetchSPXCandles).mockResolvedValue({
        candles: [],
        previousClose: null,
      });

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-04-02', all: 'true' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        snapshots: Array<{
          timestamp: string;
          spot: number | null;
          oi: { target: unknown; leaderboard: unknown[] } | null;
          vol: { target: unknown; leaderboard: unknown[] } | null;
          dir: { target: unknown; leaderboard: unknown[] } | null;
        }>;
      };
      expect(body.snapshots[0]!.oi).not.toBeNull();
      expect(body.snapshots[0]!.vol).not.toBeNull();
      expect(body.snapshots[0]!.dir).not.toBeNull();
    });

    it('returns candles and previousClose at top level', async () => {
      const ts1 = '2026-04-02T15:00:00Z';

      mockSql.mockResolvedValueOnce([{ date: '2026-04-02' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: ts1 }]);
      mockSql.mockResolvedValueOnce(makeTimestampRows(ts1));

      vi.mocked(fetchSPXCandles).mockResolvedValue({
        candles: [
          {
            open: 5790,
            high: 5800,
            low: 5785,
            close: 5795,
            volume: 1000,
            datetime: 1743606000000,
          },
        ],
        previousClose: 5780,
      });

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-04-02', all: 'true' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as {
        candles: unknown[];
        previousClose: number | null;
        snapshots: unknown[];
      };
      expect(body.candles).toHaveLength(1);
      expect(body.previousClose).toBe(5780);
    });

    it('returns empty snapshots when no rows exist for the timestamps', async () => {
      const ts1 = '2026-04-02T15:00:00Z';
      const ts2 = '2026-04-02T15:05:00Z';

      mockSql.mockResolvedValueOnce([{ date: '2026-04-02' }]);
      mockSql.mockResolvedValueOnce([{ timestamp: ts1 }, { timestamp: ts2 }]);
      // All-rows query returns empty — no feature rows for any timestamp.
      mockSql.mockResolvedValueOnce([]);

      vi.mocked(fetchSPXCandles).mockResolvedValue({
        candles: [],
        previousClose: null,
      });

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-04-02', all: 'true' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      const body = res._json as { snapshots: unknown[] };
      expect(body.snapshots).toEqual([]);
    });

    it('falls back to single-snapshot path when all param is absent', async () => {
      mockSql.mockResolvedValueOnce([{ date: '2026-04-08' }]);
      mockSql.mockResolvedValueOnce([
        { timestamp: '2026-04-08T18:00:00Z' },
        { timestamp: '2026-04-08T19:00:00Z' },
      ]);
      mockSql.mockResolvedValueOnce(makeFullSnapshotRows());

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(res._status).toBe(200);
      const body = res._json as Record<string, unknown>;
      // Single-snapshot path has top-level oi/vol/dir and a singular timestamp.
      expect(body).toHaveProperty('oi');
      expect(body).toHaveProperty('vol');
      expect(body).toHaveProperty('dir');
      expect(body).toHaveProperty('timestamp');
      // Bulk-only field must not be present on the single-snapshot path.
      expect(body).not.toHaveProperty('snapshots');
    });
  });
});
