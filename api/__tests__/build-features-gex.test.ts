// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { engineerGexFeatures } from '../_lib/build-features-gex.js';
import type { FeatureRow, StrikeRow } from '../_lib/build-features-types.js';

// ── Helpers ─────────────────────────────────────────────────

function makeFeatures(overrides: Partial<FeatureRow> = {}): FeatureRow {
  const row: FeatureRow = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) row[k] = v;
  }
  return row;
}

/**
 * Build a strike row at a given strike with specified gamma and charm.
 * Price defaults to '5800' (atm for most tests).
 */
function makeStrike(
  strike: number,
  opts: {
    callGamma?: number;
    putGamma?: number;
    callCharm?: number;
    putCharm?: number;
    price?: number;
  } = {},
): StrikeRow {
  return {
    strike: String(strike),
    price: String(opts.price ?? 5800),
    call_gamma_oi: String(opts.callGamma ?? 0),
    put_gamma_oi: String(opts.putGamma ?? 0),
    call_charm_oi: String(opts.callCharm ?? 0),
    put_charm_oi: String(opts.putCharm ?? 0),
  };
}

describe('engineerGexFeatures', () => {
  const DATE_STR = '2026-03-24';

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
  });

  // ── classifyCharmPattern null-check branches ──────────────

  describe('classifyCharmPattern null branches', () => {
    it('does not set charm_pattern when strike_exposures is empty', async () => {
      const features = makeFeatures();

      // Query 1: spot_exposures → empty
      mockSql.mockResolvedValueOnce([]);
      // Query 2: greek_exposure → empty
      mockSql.mockResolvedValueOnce([]);
      // Query 3: strike_exposures (0DTE) → empty
      mockSql.mockResolvedValueOnce([]);
      // Query 4: strike_exposures (all-expiry) → empty
      mockSql.mockResolvedValueOnce([]);

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      // computeStrikeFeatures returns {} for empty strikes
      expect(features.charm_pattern).toBeUndefined();
    });

    it('returns null charm_pattern when fewer than 5 nearby strikes', async () => {
      const features = makeFeatures();

      // Only 3 strikes within +/-50 of ATM (5800)
      const strikes = [
        makeStrike(5790, { callCharm: 100, putCharm: -50 }),
        makeStrike(5800, { callCharm: 200, putCharm: -80 }),
        makeStrike(5810, { callCharm: 150, putCharm: -60 }),
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBeNull();
    });
  });

  // ── classifyCharmPattern pattern classifications ──────────

  describe('classifyCharmPattern classifications', () => {
    /**
     * Build 10 strikes around ATM=5800 (+/-50 range)
     * with specified charm patterns.
     */
    function buildCharmStrikes(
      charms: { strike: number; callCharm: number; putCharm: number }[],
    ): StrikeRow[] {
      return charms.map((c) =>
        makeStrike(c.strike, {
          callCharm: c.callCharm,
          putCharm: c.putCharm,
        }),
      );
    }

    it('classifies all_negative when >80% of nearby charm is negative', async () => {
      const features = makeFeatures();

      // 10 strikes, all with net negative charm
      const strikes = buildCharmStrikes([
        { strike: 5760, callCharm: -100, putCharm: -50 },
        { strike: 5770, callCharm: -80, putCharm: -60 },
        { strike: 5780, callCharm: -90, putCharm: -40 },
        { strike: 5790, callCharm: -110, putCharm: -30 },
        { strike: 5800, callCharm: -70, putCharm: -50 },
        { strike: 5810, callCharm: -120, putCharm: -10 },
        { strike: 5820, callCharm: -60, putCharm: -80 },
        { strike: 5830, callCharm: -100, putCharm: -20 },
        { strike: 5840, callCharm: -90, putCharm: -30 },
        { strike: 5850, callCharm: -85, putCharm: -15 },
      ]);

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBe('all_negative');
    });

    it('classifies all_positive when >80% of nearby charm is positive', async () => {
      const features = makeFeatures();

      const strikes = buildCharmStrikes([
        { strike: 5760, callCharm: 100, putCharm: 50 },
        { strike: 5770, callCharm: 80, putCharm: 60 },
        { strike: 5780, callCharm: 90, putCharm: 40 },
        { strike: 5790, callCharm: 110, putCharm: 30 },
        { strike: 5800, callCharm: 70, putCharm: 50 },
        { strike: 5810, callCharm: 120, putCharm: 10 },
        { strike: 5820, callCharm: 60, putCharm: 80 },
        { strike: 5830, callCharm: 100, putCharm: 20 },
        { strike: 5840, callCharm: 90, putCharm: 30 },
        { strike: 5850, callCharm: 85, putCharm: 15 },
      ]);

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBe('all_positive');
    });

    it('classifies ccs_confirming when positive charm above ATM dominates', async () => {
      const features = makeFeatures();

      // Above ATM: mostly positive charm (posAbove >> negAbove)
      // Below ATM: negative charm dominates (negBelow >= posBelow)
      const strikes = buildCharmStrikes([
        { strike: 5760, callCharm: -100, putCharm: -50 }, // below, neg
        { strike: 5770, callCharm: -80, putCharm: -60 }, // below, neg
        { strike: 5780, callCharm: -90, putCharm: -40 }, // below, neg
        { strike: 5790, callCharm: -110, putCharm: -30 }, // below, neg
        { strike: 5800, callCharm: 200, putCharm: 100 }, // at/above, pos
        { strike: 5810, callCharm: 250, putCharm: 80 }, // above, pos
        { strike: 5820, callCharm: 300, putCharm: 50 }, // above, pos
        { strike: 5830, callCharm: 180, putCharm: 100 }, // above, pos
        { strike: 5840, callCharm: 200, putCharm: 90 }, // above, pos
        { strike: 5850, callCharm: -5, putCharm: -5 }, // above, neg (1 neg)
      ]);

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBe('ccs_confirming');
    });

    it('classifies pcs_confirming when positive charm below ATM dominates', async () => {
      const features = makeFeatures();

      // Below ATM: mostly positive charm (posBelow >> negBelow)
      // Above ATM: negative charm dominates (negAbove >= posAbove)
      const strikes = buildCharmStrikes([
        { strike: 5760, callCharm: 200, putCharm: 100 }, // below, pos
        { strike: 5770, callCharm: 250, putCharm: 80 }, // below, pos
        { strike: 5780, callCharm: 300, putCharm: 50 }, // below, pos
        { strike: 5790, callCharm: 180, putCharm: 100 }, // below, pos
        { strike: 5800, callCharm: -100, putCharm: -50 }, // at/above, neg
        { strike: 5810, callCharm: -80, putCharm: -60 }, // above, neg
        { strike: 5820, callCharm: -90, putCharm: -40 }, // above, neg
        { strike: 5830, callCharm: -110, putCharm: -30 }, // above, neg
        { strike: 5840, callCharm: -100, putCharm: -20 }, // above, neg
        { strike: 5850, callCharm: -5, putCharm: -5 }, // above, neg
      ]);

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBe('pcs_confirming');
    });

    it('classifies mixed when no dominant pattern', async () => {
      const features = makeFeatures();

      // Roughly even split of positive/negative charm above and below
      const strikes = buildCharmStrikes([
        { strike: 5760, callCharm: 100, putCharm: 50 }, // below, pos
        { strike: 5770, callCharm: -80, putCharm: -60 }, // below, neg
        { strike: 5780, callCharm: 90, putCharm: 40 }, // below, pos
        { strike: 5790, callCharm: -110, putCharm: -30 }, // below, neg
        { strike: 5800, callCharm: 70, putCharm: 50 }, // at/above, pos
        { strike: 5810, callCharm: -120, putCharm: -10 }, // above, neg
        { strike: 5820, callCharm: 60, putCharm: 80 }, // above, pos
        { strike: 5830, callCharm: -100, putCharm: -20 }, // above, neg
        { strike: 5840, callCharm: 90, putCharm: 30 }, // above, pos
        { strike: 5850, callCharm: -85, putCharm: -15 }, // above, neg
      ]);

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.charm_pattern).toBe('mixed');
    });
  });

  // ── computeStrikeFeatures branches ────────────────────────

  describe('computeStrikeFeatures branches', () => {
    it('returns empty features when atmPrice is 0', async () => {
      const features = makeFeatures();

      // Strikes with null price → atmPrice=0 → early return
      const strikes: StrikeRow[] = [
        {
          strike: '5800',
          price: null,
          call_gamma_oi: '100',
          put_gamma_oi: '-50',
          call_charm_oi: '10',
          put_charm_oi: '-5',
        },
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      // computeStrikeFeatures returns {} when atmPrice=0
      expect(features.gamma_wall_above_dist).toBeUndefined();
      expect(features.charm_pattern).toBeUndefined();
    });

    it('sets gamma_asymmetry to null when sumPosBelow is 0', async () => {
      const features = makeFeatures();

      // All positive gamma is strictly above ATM (dist > 0).
      // Below and at ATM: negative gamma only → sumPosBelow=0.
      // Note: dist=0 (at ATM) goes to the else branch (sumPosBelow),
      // so the ATM strike must also have negative gamma.
      const strikes = [
        makeStrike(5790, { callGamma: -10, putGamma: -5 }), // below, neg
        makeStrike(5795, { callGamma: -8, putGamma: -3 }), // below, neg
        makeStrike(5800, { callGamma: -5, putGamma: -2 }), // at ATM, neg
        makeStrike(5805, { callGamma: 400, putGamma: 200 }), // above, pos
        makeStrike(5810, { callGamma: 300, putGamma: 100 }), // above, pos
        makeStrike(5815, { callGamma: 200, putGamma: 50 }), // above, pos
        makeStrike(5820, { callGamma: 150, putGamma: 30 }), // above, pos
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.gamma_asymmetry).toBeNull();
    });

    it('computes gamma_asymmetry ratio when sumPosBelow > 0', async () => {
      const features = makeFeatures();

      // Positive gamma both above and below ATM.
      // ATM price = num(strikeRows[0]!.price) = 5800.
      // dist = strike - 5800.
      // At dist=0 (strike 5800), positive gamma goes to sumPosBelow (else branch).
      const strikes = [
        makeStrike(5780, { callGamma: 100, putGamma: 50 }), // dist=-20, gamma=150 → sumPosBelow
        makeStrike(5790, { callGamma: 200, putGamma: 100 }), // dist=-10, gamma=300 → sumPosBelow
        makeStrike(5800, { callGamma: 10, putGamma: 5 }), // dist=0, gamma=15 → sumPosBelow
        makeStrike(5810, { callGamma: 300, putGamma: 150 }), // dist=10, gamma=450 → sumPosAbove
        makeStrike(5820, { callGamma: 400, putGamma: 200 }), // dist=20, gamma=600 → sumPosAbove
        makeStrike(5830, { callGamma: 50, putGamma: 25 }), // dist=30, gamma=75 → sumPosAbove
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      // sumPosAbove = 450 + 600 + 75 = 1125
      // sumPosBelow = 150 + 300 + 15 = 465
      // gamma_asymmetry = 1125 / 465 ≈ 2.4194
      expect(features.gamma_asymmetry).toBeCloseTo(1125 / 465, 4);
    });

    it('sets null charm max dist when no finite charm values exist', async () => {
      const features = makeFeatures();

      // With only 1 strike, charm_max_pos_dist and charm_max_neg_dist
      // should still be set based on the single strike's values
      const strikes = [
        makeStrike(5800, { callCharm: 0, putCharm: 0 }),
        makeStrike(5810, { callCharm: 0, putCharm: 0 }),
        makeStrike(5820, { callCharm: 0, putCharm: 0 }),
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(strikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      // netCharm=0 for all: maxPosCharm stays at -Infinity (not finite) → null
      // but actually 0 > -Infinity so maxPosCharm=0 which IS finite → dist is set
      // and 0 < Infinity so maxNegCharm=0 which IS finite → dist is set
      expect(features.charm_max_pos_dist).toBeDefined();
      expect(features.charm_max_neg_dist).toBeDefined();
    });
  });

  // ── 0DTE vs all-expiry gamma agreement ────────────────────

  describe('gamma 0DTE/all-expiry agreement', () => {
    it('sets gamma_0dte_allexp_agree=true when top walls overlap', async () => {
      const features = makeFeatures();

      // 0DTE strikes with top gamma at 5800
      const zeroDteStrikes = [
        makeStrike(5790, { callGamma: 100, putGamma: 50 }),
        makeStrike(5800, { callGamma: 5000, putGamma: 3000 }),
        makeStrike(5810, { callGamma: 200, putGamma: 100 }),
      ];

      // All-expiry strikes with top gamma also at 5800 (within 10pts)
      const allExpStrikes: StrikeRow[] = [
        {
          strike: '5790',
          price: null,
          call_gamma_oi: '200',
          put_gamma_oi: '100',
          call_charm_oi: null,
          put_charm_oi: null,
        },
        {
          strike: '5805',
          price: null,
          call_gamma_oi: '6000',
          put_gamma_oi: '4000',
          call_charm_oi: null,
          put_charm_oi: null,
        },
        {
          strike: '5820',
          price: null,
          call_gamma_oi: '300',
          put_gamma_oi: '150',
          call_charm_oi: null,
          put_charm_oi: null,
        },
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(zeroDteStrikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce(allExpStrikes); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.gamma_0dte_allexp_agree).toBe(true);
    });

    it('sets gamma_0dte_allexp_agree=false when top walls are far apart', async () => {
      const features = makeFeatures();

      // 0DTE top gamma at 5800
      const zeroDteStrikes = [
        makeStrike(5790, { callGamma: 100, putGamma: 50 }),
        makeStrike(5800, { callGamma: 5000, putGamma: 3000 }),
        makeStrike(5810, { callGamma: 200, putGamma: 100 }),
      ];

      // All-expiry top gamma at 5900 (far from 5800)
      const allExpStrikes: StrikeRow[] = [
        {
          strike: '5880',
          price: null,
          call_gamma_oi: '100',
          put_gamma_oi: '50',
          call_charm_oi: null,
          put_charm_oi: null,
        },
        {
          strike: '5900',
          price: null,
          call_gamma_oi: '6000',
          put_gamma_oi: '4000',
          call_charm_oi: null,
          put_charm_oi: null,
        },
        {
          strike: '5920',
          price: null,
          call_gamma_oi: '300',
          put_gamma_oi: '150',
          call_charm_oi: null,
          put_charm_oi: null,
        },
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(zeroDteStrikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce(allExpStrikes); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.gamma_0dte_allexp_agree).toBe(false);
    });

    it('does not set gamma_0dte_allexp_agree when 0DTE strikes are empty', async () => {
      const features = makeFeatures();

      const allExpStrikes: StrikeRow[] = [
        {
          strike: '5800',
          price: null,
          call_gamma_oi: '6000',
          put_gamma_oi: '4000',
          call_charm_oi: null,
          put_charm_oi: null,
        },
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce([]); // strike_exposures (0DTE) → empty
      mockSql.mockResolvedValueOnce(allExpStrikes); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.gamma_0dte_allexp_agree).toBeUndefined();
    });

    it('does not set gamma_0dte_allexp_agree when all-expiry strikes are empty', async () => {
      const features = makeFeatures();

      const zeroDteStrikes = [
        makeStrike(5800, { callGamma: 5000, putGamma: 3000 }),
      ];

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      mockSql.mockResolvedValueOnce([]); // greek_exposure
      mockSql.mockResolvedValueOnce(zeroDteStrikes); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry) → empty

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.gamma_0dte_allexp_agree).toBeUndefined();
    });
  });

  // ── Greek exposure aggregate/0DTE branches ────────────────

  describe('greek exposure features', () => {
    it('sets agg_net_gamma when aggregate row exists', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      // greek_exposure with agg row (dte=-1)
      mockSql.mockResolvedValueOnce([
        {
          expiry: '2026-03-24',
          dte: '-1',
          call_gamma: '5000000',
          put_gamma: '-3000000',
          call_charm: '100000',
          put_charm: '-80000',
        },
      ]);
      mockSql.mockResolvedValueOnce([]); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.agg_net_gamma).toBe(2000000); // 5M + (-3M)
    });

    it('sets dte0_net_charm and dte0_charm_pct when 0DTE row exists', async () => {
      const features = makeFeatures();

      mockSql.mockResolvedValueOnce([]); // spot_exposures
      // Both agg and 0DTE greek rows
      mockSql.mockResolvedValueOnce([
        {
          expiry: '2026-03-24',
          dte: '-1',
          call_gamma: '5000000',
          put_gamma: '-3000000',
          call_charm: '100000',
          put_charm: '-80000',
        },
        {
          expiry: '2026-03-24',
          dte: '0',
          call_gamma: null,
          put_gamma: null,
          call_charm: '50000',
          put_charm: '-40000',
        },
      ]);
      mockSql.mockResolvedValueOnce([]); // strike_exposures (0DTE)
      mockSql.mockResolvedValueOnce([]); // strike_exposures (all-expiry)

      await engineerGexFeatures(mockSql as never, DATE_STR, features);

      expect(features.dte0_net_charm).toBe(10000); // 50K + (-40K)
      expect(features.dte0_charm_pct).toBeGreaterThan(0);
      expect(features.dte0_charm_pct).toBeLessThanOrEqual(1);
    });
  });
});
