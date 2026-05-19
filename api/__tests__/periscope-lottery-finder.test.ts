// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  detectCallLottery,
  detectPutLottery,
  fetchEntryPx,
  fetchGexTarget,
  fetchLatestVix,
  fetchQqqNetPremBalance30m,
} from '../_lib/periscope-lottery-finder.js';
import { PERISCOPE_LOTTERY_THRESHOLDS } from '../_lib/periscope-lottery-types.js';

beforeEach(() => {
  mockSql.mockReset();
});

/**
 * Helper: enqueue mock SQL responses in the order that detectCallLottery /
 * detectPutLottery will call them.
 *
 * Sequence per fire:
 *   1) fetchCandidates() — returns SliceRow[] (called once per detect)
 *   2) For each candidate that passes hard filters:
 *      - fetchGexTarget(): GexTargetRow[]
 *      - For CALL only: fetchQqqNetPremBalance30m(): FlowRow[]
 *      - fetchEntryPx(): { price }[]
 *      - fetchLatestVix(): { vix }[]
 */

describe('PERISCOPE_LOTTERY_THRESHOLDS — constants are locked', () => {
  it('CALL filter thresholds match v3 strict spec', () => {
    const t = PERISCOPE_LOTTERY_THRESHOLDS.CALL;
    expect(t.DAY_TOP_PCT).toBe(0.01);
    expect(t.RANK_FLOOR).toBe(0.9);
    expect(t.SIGN_NEGATIVE).toBe(true);
    expect(t.STRIKE_DIST_MIN_PTS).toBe(15);
    expect(t.GEX_DOLLARS_MAX).toBe(1_000_000_000);
    expect(t.TRADE_OFFSET_PTS).toBe(50);
    expect(t.HOLD_MINUTES).toBe(120);
    expect(t.QQQ_BALANCE_BADGE_MIN_ABS).toBe(0.5);
  });

  it('PUT filter thresholds match v3 strict spec', () => {
    const t = PERISCOPE_LOTTERY_THRESHOLDS.PUT;
    expect(t.DAY_TOP_PCT).toBe(0.05);
    expect(t.STRIKE_DIST_MIN_PTS).toBe(10);
    expect(t.CALL_RATIO_MAX).toBe(1.5);
    expect(t.TRADE_OFFSET_PTS).toBe(50);
    expect(t.HOLD_MINUTES).toBe(180);
    expect(t.ENTRY_PX_BADGE_MAX).toBe(1.0);
  });
});

describe('fetchGexTarget', () => {
  it('returns parsed gex_dollars + call_ratio', async () => {
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '-863000000', call_ratio: '1.02' },
    ]);
    const result = await fetchGexTarget(7380, new Date('2026-05-18T18:43:12Z'));
    expect(result).toEqual({ gex_dollars: '-863000000', call_ratio: '1.02' });
  });

  it('returns null when no row exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await fetchGexTarget(9999, new Date());
    expect(result).toBeNull();
  });
});

describe('fetchQqqNetPremBalance30m', () => {
  it('reads sum_call / sum_put aliases (regression for v4 badge bug)', async () => {
    // Spec: +1.0 means decisively call-heavy
    mockSql.mockResolvedValueOnce([
      { sum_call: '1500000', sum_put: '500000' },
    ]);
    const result = await fetchQqqNetPremBalance30m(new Date());
    // (1.5M - 0.5M) / (1.5M + 0.5M) = +0.5
    expect(result).toBeCloseTo(0.5, 4);
  });

  it('returns -1.0 for put-heavy tape', async () => {
    mockSql.mockResolvedValueOnce([
      { sum_call: '100000', sum_put: '900000' },
    ]);
    const result = await fetchQqqNetPremBalance30m(new Date());
    // (0.1M - 0.9M) / (0.1M + 0.9M) = -0.8
    expect(result).toBeCloseTo(-0.8, 4);
  });

  it('returns null when no flow', async () => {
    mockSql.mockResolvedValueOnce([{ sum_call: null, sum_put: null }]);
    const result = await fetchQqqNetPremBalance30m(new Date());
    expect(result).toBeNull();
  });

  it('returns null when totals sum to zero', async () => {
    mockSql.mockResolvedValueOnce([{ sum_call: '0', sum_put: '0' }]);
    const result = await fetchQqqNetPremBalance30m(new Date());
    expect(result).toBeNull();
  });
});

describe('fetchEntryPx', () => {
  it('uses canceled=FALSE and price>0 filters', async () => {
    mockSql.mockResolvedValueOnce([{ price: '0.04' }]);
    const result = await fetchEntryPx(
      '2026-04-23',
      7155,
      'C',
      new Date('2026-04-23T19:50:00Z'),
    );
    expect(result).toBe(0.04);
    // Verify the SQL template was called with the expected filter shape
    const callArgs = mockSql.mock.calls[0]?.[0] as string[] | undefined;
    const sqlText = callArgs?.join('?') ?? '';
    expect(sqlText).toContain('canceled = FALSE');
    expect(sqlText).toContain('price > 0');
  });

  it('returns null when no trades in window', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await fetchEntryPx('2026-05-18', 7430, 'C', new Date());
    expect(result).toBeNull();
  });
});

describe('fetchLatestVix', () => {
  it('parses NUMERIC vix to number', async () => {
    mockSql.mockResolvedValueOnce([{ vix: '18.31' }]);
    const result = await fetchLatestVix(new Date());
    expect(result).toBeCloseTo(18.31, 2);
  });

  it('returns null when no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await fetchLatestVix(new Date());
    expect(result).toBeNull();
  });
});

describe('detectCallLottery — v3 strict filter cascade', () => {
  // The 5/18 7380 Wonce trigger reproduces here
  const WONCE_CANDIDATE = {
    captured_at: '2026-05-18T18:43:12Z',
    strike: 7380,
    greek_post: -7403.4,
    greek_prior: -2890.1,
    greek_delta: -4513.3,
    spot_at_event: 7362.14,
    lvl_rank: 0.95,
    chg_rank: 0.999,
  };

  it('fires on 5/18 7380 (Wonce trigger reproduction)', async () => {
    // 1. fetchCandidates returns the Wonce slice
    mockSql.mockResolvedValueOnce([WONCE_CANDIDATE]);
    // 2. fetchGexTarget — gex_dollars below 1e9 threshold
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '-974008661', call_ratio: '-3.58' },
    ]);
    // 3. fetchQqqNetPremBalance30m
    mockSql.mockResolvedValueOnce([
      { sum_call: '800000', sum_put: '200000' },
    ]);
    // 4. fetchEntryPx
    mockSql.mockResolvedValueOnce([{ price: '0.10' }]);
    // 5. fetchLatestVix
    mockSql.mockResolvedValueOnce([{ vix: '18.31' }]);

    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(1);
    const fire = fires[0]!;
    expect(fire.fireType).toBe('call_lottery');
    expect(fire.eventStrike).toBe(7380);
    expect(fire.tradeStrike).toBe(7430); // 7380 + 50
    expect(fire.greekPost).toBeCloseTo(-7403.4, 1);
    expect(fire.gexDollars).toBeCloseTo(-974008661, 0);
    expect(fire.entryPx).toBe(0.1);
    expect(fire.v3StrictPass).toBe(true);
    expect(fire.v4Badge).toBe(true); // |0.6| >= 0.5
  });

  it('rejects when strike <= spot (below-spot or ATM)', async () => {
    mockSql.mockResolvedValueOnce([
      { ...WONCE_CANDIDATE, strike: 7300, spot_at_event: 7362.14 },
    ]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });

  it('rejects when greek_post >= 0 (not deep_neg)', async () => {
    mockSql.mockResolvedValueOnce([{ ...WONCE_CANDIDATE, greek_post: 100 }]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });

  it('rejects when lvl_rank < 0.90 OR chg_rank < 0.90', async () => {
    mockSql.mockResolvedValueOnce([
      { ...WONCE_CANDIDATE, lvl_rank: 0.85 },
    ]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });

  it('rejects when strike_dist < 15 pts (near-ATM)', async () => {
    mockSql.mockResolvedValueOnce([
      { ...WONCE_CANDIDATE, strike: 7370, spot_at_event: 7362.14 },
    ]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });

  it('rejects when gex_dollars >= 1e9 (mature wall)', async () => {
    mockSql.mockResolvedValueOnce([WONCE_CANDIDATE]);
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '2500000000', call_ratio: '1.0' },
    ]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });

  it('skips empty candidate set', async () => {
    mockSql.mockResolvedValueOnce([]);
    const fires = await detectCallLottery('2026-05-18');
    expect(fires).toHaveLength(0);
  });
});

describe('detectPutLottery — v3 strict filter cascade', () => {
  // The 4/23 7105 charm trigger (57x outcome)
  const APRIL23_CANDIDATE = {
    captured_at: '2026-04-23T15:00:00Z',
    strike: 7105,
    greek_post: -621000000,
    greek_prior: -623170000,
    greek_delta: 2170000,
    spot_at_event: 7142.45,
    lvl_rank: 0.98,
    chg_rank: 0.99,
  };

  it('fires on 4/23 7105 charm (57x reproduction)', async () => {
    mockSql.mockResolvedValueOnce([APRIL23_CANDIDATE]);
    // gex_target for 7105 — call_ratio < 1.5 required
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '500000000', call_ratio: '0.8' },
    ]);
    // Entry price (cheap)
    mockSql.mockResolvedValueOnce([{ price: '0.42' }]);
    // VIX
    mockSql.mockResolvedValueOnce([{ vix: '20.5' }]);

    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(1);
    const fire = fires[0]!;
    expect(fire.fireType).toBe('put_lottery');
    expect(fire.eventStrike).toBe(7105);
    expect(fire.tradeStrike).toBe(7055); // 7105 - 50
    expect(fire.callRatio).toBeCloseTo(0.8, 2);
    expect(fire.entryPx).toBe(0.42);
    expect(fire.qqqNetPremBalance30m).toBeNull(); // not used for L
    expect(fire.v3StrictPass).toBe(true);
    expect(fire.v4Badge).toBe(true); // entry 0.42 <= 1.0
  });

  it('accepts post_neg OR post_pos charm (no sign filter)', async () => {
    // post_pos variant
    mockSql.mockResolvedValueOnce([
      { ...APRIL23_CANDIDATE, greek_post: 423000 },
    ]);
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '100000000', call_ratio: '0.5' },
    ]);
    mockSql.mockResolvedValueOnce([{ price: '0.50' }]);
    mockSql.mockResolvedValueOnce([{ vix: '20.5' }]);

    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(1);
  });

  it('rejects when call_ratio >= 1.5 (call-dominated wing)', async () => {
    mockSql.mockResolvedValueOnce([APRIL23_CANDIDATE]);
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '500000000', call_ratio: '2.0' },
    ]);
    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(0);
  });

  it('rejects when strike >= spot (above-spot for puts)', async () => {
    mockSql.mockResolvedValueOnce([
      { ...APRIL23_CANDIDATE, strike: 7200, spot_at_event: 7142.45 },
    ]);
    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(0);
  });

  it('rejects when strike_dist < 10 pts', async () => {
    mockSql.mockResolvedValueOnce([
      { ...APRIL23_CANDIDATE, strike: 7138, spot_at_event: 7142.45 },
    ]);
    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(0);
  });

  it('does not set v4Badge when entry_px > 1.0', async () => {
    mockSql.mockResolvedValueOnce([APRIL23_CANDIDATE]);
    mockSql.mockResolvedValueOnce([
      { gex_dollars: '500000000', call_ratio: '0.8' },
    ]);
    mockSql.mockResolvedValueOnce([{ price: '2.50' }]); // > $1
    mockSql.mockResolvedValueOnce([{ vix: '20.5' }]);

    const fires = await detectPutLottery('2026-04-23');
    expect(fires).toHaveLength(1);
    expect(fires[0]!.v4Badge).toBe(false);
  });
});
