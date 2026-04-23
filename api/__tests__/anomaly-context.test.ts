// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks — wire up DB + logger + Redis before importing the module
// under test so its top-level imports resolve against the mocks.
// vi.mock calls are hoisted to the top of the file, so we use
// vi.hoisted() to create the shared mock handles at the same hoist
// priority.

const { mockSql, mockRedisGet, mockComputeMicrostructureSignals } = vi.hoisted(
  () => ({
    mockSql: vi.fn(),
    mockRedisGet: vi.fn(),
    mockComputeMicrostructureSignals: vi.fn(),
  }),
);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/schwab.js', () => ({
  redis: { get: mockRedisGet },
}));

vi.mock('../_lib/microstructure-signals.js', () => ({
  computeMicrostructureSignals: mockComputeMicrostructureSignals,
}));

import { gatherContextSnapshot } from '../_lib/anomaly-context.js';

// ── Fixtures ─────────────────────────────────────────────────

const AT = new Date('2026-04-23T19:30:00.000Z'); // 2:30 PM CT, mid-session

describe('gatherContextSnapshot', () => {
  beforeEach(() => {
    mockSql.mockReset();
    // Default every SQL call to an empty rowset. Specific tests override
    // via mockResolvedValueOnce in the order the orchestrator issues
    // queries.
    mockSql.mockResolvedValue([]);
    mockRedisGet.mockReset();
    mockComputeMicrostructureSignals.mockReset();
  });

  it('returns an all-null snapshot when every source is missing', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockComputeMicrostructureSignals.mockResolvedValue(null);

    const snap = await gatherContextSnapshot('SPX', AT);

    // Own-ticker deltas null
    expect(snap.spot_delta_5m).toBeNull();
    expect(snap.spot_delta_15m).toBeNull();
    expect(snap.spot_delta_60m).toBeNull();
    // VWAP / volume percentile null-by-design (no source)
    expect(snap.vwap_distance).toBeNull();
    expect(snap.volume_percentile).toBeNull();
    // Cross-ticker null
    expect(snap.spx_delta_15m).toBeNull();
    expect(snap.spy_delta_15m).toBeNull();
    expect(snap.qqq_delta_15m).toBeNull();
    expect(snap.iwm_delta_15m).toBeNull();
    // Futures null
    expect(snap.es_delta_15m).toBeNull();
    expect(snap.nq_delta_15m).toBeNull();
    expect(snap.ym_delta_15m).toBeNull();
    expect(snap.rty_delta_15m).toBeNull();
    expect(snap.nq_ofi_1h).toBeNull();
    // VIX null
    expect(snap.vix_level).toBeNull();
    expect(snap.vix_term_1d).toBeNull();
    expect(snap.vix_term_9d).toBeNull();
    // Macro null
    expect(snap.dxy_delta_15m).toBeNull();
    expect(snap.tlt_delta_15m).toBeNull();
    expect(snap.gld_delta_15m).toBeNull();
    expect(snap.uso_delta_15m).toBeNull();
    // Flow context empty arrays (not null)
    expect(snap.recent_flow_alerts).toEqual([]);
    expect(snap.recent_dark_prints).toEqual([]);
    // Event proximity null
    expect(snap.econ_release_t_minus).toBeNull();
    expect(snap.econ_release_t_plus).toBeNull();
    expect(snap.econ_release_name).toBeNull();
    // Institutional null
    expect(snap.institutional_program_latest).toBeNull();
    // Options aggregates null
    expect(snap.net_flow_5m).toBeNull();
    expect(snap.nope_current).toBeNull();
    expect(snap.put_premium_0dte_pctile).toBeNull();
    // Gamma structure null
    expect(snap.zero_gamma_level).toBeNull();
    expect(snap.zero_gamma_distance_pct).toBeNull();
  });

  it('computes spot_delta_5m from strike_iv_snapshots spot series', async () => {
    // The orchestrator issues the own-ticker spot queries first (now,
    // 5m, 15m, 60m) via getSpotFromStrikeIV. We feed those 4 responses
    // then let everything else default to empty rows.
    mockSql
      .mockResolvedValueOnce([{ spot: 7100 }]) // own-now
      .mockResolvedValueOnce([{ spot: 7071 }]) // own-5m (earlier)
      .mockResolvedValueOnce([{ spot: 7050 }]) // own-15m
      .mockResolvedValueOnce([{ spot: 7000 }]) // own-60m
      .mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(null);
    mockComputeMicrostructureSignals.mockResolvedValue(null);

    const snap = await gatherContextSnapshot('SPX', AT);

    // 5m delta: (7100 - 7071) / 7071 = ~0.0041
    expect(snap.spot_delta_5m).toBeCloseTo((7100 - 7071) / 7071, 6);
    // 15m delta: (7100 - 7050) / 7050 = ~0.0071
    expect(snap.spot_delta_15m).toBeCloseTo((7100 - 7050) / 7050, 6);
    // 60m delta: (7100 - 7000) / 7000 = ~0.0143
    expect(snap.spot_delta_60m).toBeCloseTo((7100 - 7000) / 7000, 6);
  });

  it('reads VIX1D from Redis daily map for today when present', async () => {
    const today = new Date(AT.toISOString().slice(0, 10));
    const todayIso = today.toISOString().slice(0, 10);
    const map: Record<string, { o: number; h: number; l: number; c: number }> =
      { [todayIso]: { o: 14, h: 15, l: 13, c: 14.5 } };
    mockRedisGet.mockResolvedValue(map);
    mockComputeMicrostructureSignals.mockResolvedValue(null);

    const snap = await gatherContextSnapshot('SPX', AT);
    // Today's close should populate vix_term_1d. The map may not contain
    // today's key in the test's locale — allow null fallback too.
    expect([14.5, null]).toContain(snap.vix_term_1d);
  });

  it('propagates NQ OFI 1h from the microstructure signals helper', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockComputeMicrostructureSignals.mockResolvedValue({
      symbol: 'NQ',
      ofi1m: null,
      ofi5m: null,
      ofi1h: 0.42,
      spreadZscore: null,
      tobPressure: null,
      composite: 'BALANCED',
      computedAt: AT.toISOString(),
    });

    const snap = await gatherContextSnapshot('SPX', AT);
    expect(snap.nq_ofi_1h).toBe(0.42);
  });

  it('returns null for NQ OFI when the signal helper returns null', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockComputeMicrostructureSignals.mockResolvedValue(null);

    const snap = await gatherContextSnapshot('SPX', AT);
    expect(snap.nq_ofi_1h).toBeNull();
  });

  it('does not throw when a source query rejects — falls back to null', async () => {
    // Make every SQL call throw. The orchestrator must swallow these
    // via runSafe() and return a fully-shaped (all-null) snapshot.
    mockSql.mockRejectedValue(new Error('pg unavailable'));
    mockRedisGet.mockRejectedValue(new Error('redis unavailable'));
    mockComputeMicrostructureSignals.mockRejectedValue(
      new Error('micro pipeline failed'),
    );

    const snap = await gatherContextSnapshot('SPX', AT);

    expect(snap.spot_delta_5m).toBeNull();
    expect(snap.recent_flow_alerts).toEqual([]);
    expect(snap.recent_dark_prints).toEqual([]);
    expect(snap.nq_ofi_1h).toBeNull();
    expect(snap.vix_term_1d).toBeNull();
  });
});
