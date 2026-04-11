// @vitest-environment node

/**
 * Tests for the GexTarget feature helper (Phase 4, subagent 4A).
 *
 * Covers:
 *  - loadSnapshotHistory grouping, ordering, camelCase conversion, and
 *    defensive behavior on malformed rows or query errors
 *  - writeFeatureRows happy path, empty-input short-circuits, row
 *    flattening, per-mode breakdown, nearest-wall computation, and the
 *    non-blocking error path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  query: typeof mockQuery;
};
mockSql.query = mockQuery;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  loadSnapshotHistory,
  writeFeatureRows,
} from '../_lib/gex-target-features.js';
import logger from '../_lib/logger.js';
import type { GexSnapshot } from '../../src/utils/gex-target.js';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeRawRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-03-24T14:30:00.000Z',
    strike: '5800',
    price: '5800',
    call_gamma_oi: '100',
    put_gamma_oi: '-50',
    call_gamma_vol: '10',
    put_gamma_vol: '-5',
    call_gamma_ask: '5',
    call_gamma_bid: '4',
    put_gamma_ask: '-3',
    put_gamma_bid: '-2',
    call_charm_oi: '1000',
    put_charm_oi: '-500',
    call_charm_vol: '100',
    put_charm_vol: '-50',
    call_delta_oi: '200',
    put_delta_oi: '-100',
    call_vanna_oi: '50',
    put_vanna_oi: '-25',
    call_vanna_vol: '5',
    put_vanna_vol: '-2',
    ...overrides,
  };
}

/**
 * Build a plausible snapshot history for a synthetic session. The
 * returned sequence has enough history that `computeGexTarget` will
 * produce non-empty leaderboards.
 */
function buildSnapshotHistory(snapshotCount: number): GexSnapshot[] {
  const snapshots: GexSnapshot[] = [];
  const spot = 5800;
  for (let i = 0; i < snapshotCount; i++) {
    const ts = new Date(
      Date.parse('2026-03-24T18:00:00.000Z') + i * 60_000,
    ).toISOString();

    const strikes = [];
    for (let k = -4; k <= 4; k++) {
      const strike = spot + k * 5;
      const callBase = k >= 0 ? 100 + k * 20 + i * 2 : 20;
      const putBase = k <= 0 ? 80 + Math.abs(k) * 15 + i * 2 : 15;
      strikes.push({
        strike,
        price: spot,
        callGammaOi: callBase,
        putGammaOi: -putBase,
        callGammaVol: callBase / 10,
        putGammaVol: -putBase / 10,
        callGammaAsk: callBase / 4,
        callGammaBid: callBase / 5,
        putGammaAsk: -putBase / 4,
        putGammaBid: -putBase / 5,
        callCharmOi: callBase * 10,
        putCharmOi: -putBase * 10,
        callCharmVol: callBase,
        putCharmVol: -putBase,
        callDeltaOi: callBase * 2,
        putDeltaOi: -putBase * 2,
        callVannaOi: callBase / 2,
        putVannaOi: -putBase / 2,
        callVannaVol: callBase / 20,
        putVannaVol: -putBase / 20,
      });
    }

    snapshots.push({ timestamp: ts, price: spot, strikes });
  }
  return snapshots;
}

// ── loadSnapshotHistory ─────────────────────────────────────────────────

describe('loadSnapshotHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty array when the DB returns no rows', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T20:00:00.000Z',
      10,
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when historySize is non-positive', async () => {
    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T20:00:00.000Z',
      0,
    );
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('groups flat rows by timestamp and returns ascending order', async () => {
    mockQuery.mockResolvedValueOnce([
      makeRawRow({
        timestamp: '2026-03-24T14:31:00.000Z',
        strike: '5800',
      }),
      makeRawRow({
        timestamp: '2026-03-24T14:31:00.000Z',
        strike: '5805',
      }),
      makeRawRow({
        timestamp: '2026-03-24T14:30:00.000Z',
        strike: '5800',
      }),
      makeRawRow({
        timestamp: '2026-03-24T14:30:00.000Z',
        strike: '5805',
      }),
    ]);

    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T14:31:00.000Z',
      2,
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.timestamp).toBe('2026-03-24T14:30:00.000Z');
    expect(result[1]!.timestamp).toBe('2026-03-24T14:31:00.000Z');
    expect(result[0]!.strikes).toHaveLength(2);
    expect(result[1]!.strikes).toHaveLength(2);
  });

  it('converts snake_case DB columns to camelCase and parses numbers', async () => {
    mockQuery.mockResolvedValueOnce([
      makeRawRow({
        call_gamma_oi: '123.45',
        put_gamma_oi: '-67.89',
        call_charm_oi: '1000',
      }),
    ]);

    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T14:30:00.000Z',
      1,
    );

    expect(result).toHaveLength(1);
    const strike = result[0]!.strikes[0]!;
    expect(strike.strike).toBe(5800);
    expect(strike.price).toBe(5800);
    expect(strike.callGammaOi).toBeCloseTo(123.45);
    expect(strike.putGammaOi).toBeCloseTo(-67.89);
    expect(strike.callCharmOi).toBe(1000);
  });

  it('honors the historySize limit via the LIMIT parameter', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await loadSnapshotHistory('2026-03-24', '2026-03-24T14:30:00.000Z', 61);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0]!;
    expect((params as unknown[])[2]).toBe(61);
  });

  it('drops rows with non-finite price or strike defensively', async () => {
    mockQuery.mockResolvedValueOnce([
      makeRawRow({ price: 'not-a-number', strike: '5800' }),
      makeRawRow({
        timestamp: '2026-03-24T14:31:00.000Z',
        strike: 'garbage',
      }),
      makeRawRow({
        timestamp: '2026-03-24T14:32:00.000Z',
        strike: '5800',
        price: '5800',
      }),
    ]);

    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T14:32:00.000Z',
      5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.timestamp).toBe('2026-03-24T14:32:00.000Z');
  });

  it('coerces null Greek columns to 0 without throwing', async () => {
    mockQuery.mockResolvedValueOnce([
      makeRawRow({
        call_charm_oi: null,
        put_charm_oi: null,
        call_delta_oi: null,
      }),
    ]);

    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T14:30:00.000Z',
      1,
    );

    const strike = result[0]!.strikes[0]!;
    expect(strike.callCharmOi).toBe(0);
    expect(strike.putCharmOi).toBe(0);
    expect(strike.callDeltaOi).toBe(0);
  });

  it('returns empty and logs on DB query error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const result = await loadSnapshotHistory(
      '2026-03-24',
      '2026-03-24T14:30:00.000Z',
      10,
    );
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'loadSnapshotHistory: gex_strike_0dte query failed',
    );
  });
});

// ── writeFeatureRows ────────────────────────────────────────────────────

describe('writeFeatureRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: every row gets a unique id back and mode labels alternate
    // per-insert — tests override when they need a specific shape.
    mockQuery.mockImplementation(
      async (_text: string, params: unknown[] = []) => {
        const cols = 43;
        const rowCount = Math.floor(params.length / cols);
        return Array.from({ length: rowCount }, (_v, i) => {
          // Walk the params to find the mode of the i-th row (position 2
          // inside each 43-column block).
          const mode = params[i * cols + 2] as string;
          return { id: i + 1, mode };
        });
      },
    );
  });

  it('returns zeros without calling DB when snapshots is empty', async () => {
    const result = await writeFeatureRows(
      [],
      '2026-03-24',
      '2026-03-24T18:00:00.000Z',
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns zeros without calling DB when snapshots.length < 2', async () => {
    const snapshots = buildSnapshotHistory(1);
    const result = await writeFeatureRows(
      snapshots,
      '2026-03-24',
      snapshots[0]!.timestamp,
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('happy path: writes 3 modes of leaderboard rows in a single INSERT', async () => {
    const snapshots = buildSnapshotHistory(5);
    const timestamp = snapshots.at(-1)!.timestamp;
    const result = await writeFeatureRows(snapshots, '2026-03-24', timestamp);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sqlText, params] = mockQuery.mock.calls[0]!;
    expect(sqlText).toMatch(/INSERT INTO gex_target_features/);
    expect(sqlText).toMatch(
      /ON CONFLICT \(date, timestamp, mode, strike, math_version\)/,
    );
    expect(sqlText).toMatch(/DO NOTHING/);
    expect(sqlText).toMatch(/RETURNING id, mode/);

    // With 9 strikes × 3 modes we expect 27 flattened rows × 43 cols.
    const p = params as unknown[];
    expect(p.length % 43).toBe(0);
    const rowCount = p.length / 43;
    expect(rowCount).toBe(27);
    expect(result.written).toBe(27);
    expect(result.skipped).toBe(0);
    expect(result.modes.oi.written).toBe(9);
    expect(result.modes.vol.written).toBe(9);
    expect(result.modes.dir.written).toBe(9);
  });

  it('reflects ON CONFLICT skips when the DB returns fewer rows than attempted', async () => {
    const snapshots = buildSnapshotHistory(5);
    mockQuery.mockImplementationOnce(async () => {
      // Pretend only the first 3 oi rows were written — everything else
      // hit the unique constraint.
      return [
        { id: 1, mode: 'oi' },
        { id: 2, mode: 'oi' },
        { id: 3, mode: 'oi' },
      ];
    });

    const result = await writeFeatureRows(
      snapshots,
      '2026-03-24',
      snapshots.at(-1)!.timestamp,
    );

    expect(result.written).toBe(3);
    expect(result.skipped).toBe(24);
    expect(result.modes.oi.written).toBe(3);
    expect(result.modes.oi.skipped).toBe(6);
    expect(result.modes.vol.written).toBe(0);
    expect(result.modes.vol.skipped).toBe(9);
    expect(result.modes.dir.written).toBe(0);
    expect(result.modes.dir.skipped).toBe(9);
  });

  it('returns zeros and logs on DB insert error without re-throwing', async () => {
    const snapshots = buildSnapshotHistory(5);
    mockQuery.mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await writeFeatureRows(
      snapshots,
      '2026-03-24',
      snapshots.at(-1)!.timestamp,
    );

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'writeFeatureRows: gex_target_features insert failed',
    );
  });

  it('row flattening: identity, Layer 2, and Layer 3 columns land in the right slots', async () => {
    const snapshots = buildSnapshotHistory(5);
    const timestamp = snapshots.at(-1)!.timestamp;
    await writeFeatureRows(snapshots, '2026-03-24', timestamp);

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // First row identity block ($1..$5).
    expect(p[0]).toBe('2026-03-24');
    expect(p[1]).toBe(timestamp);
    expect(['oi', 'vol', 'dir']).toContain(p[2]);
    expect(p[3]).toBe('v1');
    expect(typeof p[4]).toBe('number');
    // Ranking ($6..$8)
    expect(typeof p[5]).toBe('number'); // rank_in_mode
    expect(typeof p[6]).toBe('number'); // rank_by_size
    expect(typeof p[7]).toBe('boolean'); // is_target
    // Layer 2 anchor: gex_dollars at slot $9
    expect(typeof p[8]).toBe('number');
    // Layer 3 tail: final_score, tier, wall_side at slots $41..$43
    expect(typeof p[40]).toBe('number');
    expect(['HIGH', 'MEDIUM', 'LOW', 'NONE']).toContain(p[41]);
    expect(['CALL', 'PUT', 'NEUTRAL']).toContain(p[42]);
  });

  it('nearest-wall: picks the closest call wall above spot and put wall below spot', async () => {
    // Build a minimal 2-snapshot history where the universe contains
    // clear walls on both sides. The 4-wide positive strike has the
    // largest |gex|, but the 2-wide is geometrically closer — so the
    // nearest-wall logic must pick the close one, not the biggest.
    const baseTime = Date.parse('2026-03-24T18:00:00.000Z');
    const makeStrike = (
      strike: number,
      callGammaOi: number,
      putGammaOi: number,
    ) => ({
      strike,
      price: 5800,
      callGammaOi,
      putGammaOi,
      callGammaVol: 0,
      putGammaVol: 0,
      callGammaAsk: 0,
      callGammaBid: 0,
      putGammaAsk: 0,
      putGammaBid: 0,
      callCharmOi: 0,
      putCharmOi: 0,
      callCharmVol: 0,
      putCharmVol: 0,
      callDeltaOi: 0,
      putDeltaOi: 0,
      callVannaOi: 0,
      putVannaOi: 0,
      callVannaVol: 0,
      putVannaVol: 0,
    });

    const strikes = [
      // Nearest positive wall: strike 5802, small gex
      makeStrike(5802, 50, 0),
      // Bigger positive wall further away
      makeStrike(5804, 1000, 0),
      // Nearest negative wall: strike 5798, small gex
      makeStrike(5798, 0, -60),
      // Bigger negative wall further away
      makeStrike(5796, 0, -900),
    ];

    const snapshots: GexSnapshot[] = [
      {
        timestamp: new Date(baseTime).toISOString(),
        price: 5800,
        strikes,
      },
      {
        timestamp: new Date(baseTime + 60_000).toISOString(),
        price: 5800,
        strikes,
      },
    ];

    await writeFeatureRows(snapshots, '2026-03-24', snapshots[1]!.timestamp);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // Every row in the same (snapshot × mode) gets identical wall
    // metadata. Slots 31..34 are the nearest wall block for the first
    // row: nearest_pos_wall_dist, nearest_pos_wall_gex,
    // nearest_neg_wall_dist, nearest_neg_wall_gex.
    expect(p[30]).toBe(2); // 5802 − 5800
    expect(typeof p[31]).toBe('number');
    expect((p[31] as number) > 0).toBe(true);
    expect(p[32]).toBe(2); // 5800 − 5798
    expect(typeof p[33]).toBe('number');
    expect((p[33] as number) > 0).toBe(true);
  });

  it('nearest-wall: stores null when no wall exists on a given side', async () => {
    // Universe with ONLY call walls (all above spot, all positive).
    const baseTime = Date.parse('2026-03-24T18:00:00.000Z');
    const makeStrike = (strike: number, callGammaOi: number) => ({
      strike,
      price: 5800,
      callGammaOi,
      putGammaOi: 0,
      callGammaVol: 0,
      putGammaVol: 0,
      callGammaAsk: 0,
      callGammaBid: 0,
      putGammaAsk: 0,
      putGammaBid: 0,
      callCharmOi: 0,
      putCharmOi: 0,
      callCharmVol: 0,
      putCharmVol: 0,
      callDeltaOi: 0,
      putDeltaOi: 0,
      callVannaOi: 0,
      putVannaOi: 0,
      callVannaVol: 0,
      putVannaVol: 0,
    });
    const strikes = [
      makeStrike(5805, 100),
      makeStrike(5810, 200),
      makeStrike(5815, 300),
    ];
    const snapshots: GexSnapshot[] = [
      {
        timestamp: new Date(baseTime).toISOString(),
        price: 5800,
        strikes,
      },
      {
        timestamp: new Date(baseTime + 60_000).toISOString(),
        price: 5800,
        strikes,
      },
    ];

    await writeFeatureRows(snapshots, '2026-03-24', snapshots[1]!.timestamp);

    const [, params] = mockQuery.mock.calls[0]!;
    const p = params as unknown[];
    // Positive wall present (5805 is closest)
    expect(p[30]).toBe(5);
    expect(typeof p[31]).toBe('number');
    // No negative wall on any strike — both neg slots must be null
    expect(p[32]).toBeNull();
    expect(p[33]).toBeNull();
  });
});
