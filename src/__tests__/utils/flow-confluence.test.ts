import { describe, it, expect } from 'vitest';
import {
  findConfluences,
  CONFLUENCE_CONSTANTS,
  type ConfluenceRelationship,
} from '../../utils/flow-confluence';
import type { RankedStrike, WhaleAlert } from '../../types/flow';

// ============================================================
// FIXTURES
// ============================================================

function makeRetail(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 7000,
    type: 'call',
    distance_from_spot: 0,
    distance_pct: 0,
    total_premium: 400_000,
    ask_side_ratio: 0.85,
    volume_oi_ratio: 3.0,
    hit_count: 4,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 0.8,
    first_seen_at: '2026-04-15T14:30:00Z',
    last_seen_at: '2026-04-15T15:05:00Z',
    ...overrides,
  };
}

function makeWhale(overrides: Partial<WhaleAlert> = {}): WhaleAlert {
  return {
    option_chain: 'SPXW 2026-04-20 P7000',
    strike: 7000,
    type: 'put',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-15T14:00:00Z',
    age_minutes: 30,
    total_premium: 2_000_000,
    total_ask_side_prem: 1_800_000,
    total_bid_side_prem: 200_000,
    ask_side_ratio: 0.9,
    total_size: 3000,
    volume: 3500,
    open_interest: 900,
    volume_oi_ratio: 3.9,
    has_sweep: false,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: 7001,
    distance_from_spot: -1,
    distance_pct: -0.00014,
    is_itm: false,
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('findConfluences', () => {
  it('returns no matches when retail list is empty', () => {
    const out = findConfluences([], [makeWhale()]);
    expect(out).toEqual([]);
  });

  it('returns no matches when whale list is empty', () => {
    const out = findConfluences([makeRetail()], []);
    expect(out).toEqual([]);
  });

  it('matches retail call and whale put at exact same strike → retail-call-whale-put', () => {
    const out = findConfluences(
      [makeRetail({ strike: 7000, type: 'call' })],
      [makeWhale({ strike: 7000, type: 'put' })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.relationship).toBe('retail-call-whale-put');
    expect(out[0]!.retail_strike).toBe(7000);
    expect(out[0]!.whale_strike).toBe(7000);
    expect(out[0]!.strike_delta).toBe(0);
  });

  it('matches when whale strike is within proximity window (40 pts away)', () => {
    const out = findConfluences(
      [makeRetail({ strike: 7000 })],
      [makeWhale({ strike: 7040 })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.strike_delta).toBe(40);
  });

  it('excludes pairs outside proximity window (100 pts away)', () => {
    const out = findConfluences(
      [makeRetail({ strike: 7000 })],
      [makeWhale({ strike: 7100 })],
    );
    expect(out).toEqual([]);
  });

  it('drops whales under minWhalePremium ($500K when threshold is $1M)', () => {
    const out = findConfluences(
      [makeRetail({ strike: 7000 })],
      [makeWhale({ strike: 7000, total_premium: 500_000 })],
    );
    expect(out).toEqual([]);
  });

  it('keeps only the largest-premium whale when multiple hit the same strike+side pair', () => {
    const retail = [makeRetail({ strike: 7000, type: 'call' })];
    const whales = [
      makeWhale({
        option_chain: 'W-small',
        strike: 7000,
        type: 'put',
        total_premium: 1_200_000,
      }),
      makeWhale({
        option_chain: 'W-big',
        strike: 7000,
        type: 'put',
        total_premium: 4_500_000,
      }),
      makeWhale({
        option_chain: 'W-mid',
        strike: 7000,
        type: 'put',
        total_premium: 2_000_000,
      }),
    ];
    const out = findConfluences(retail, whales);
    expect(out).toHaveLength(1);
    expect(out[0]!.whale_option_chain).toBe('W-big');
    expect(out[0]!.whale_premium).toBe(4_500_000);
  });

  it('sorts matches by retail_premium desc', () => {
    const retail = [
      makeRetail({ strike: 7000, total_premium: 200_000 }),
      makeRetail({ strike: 7100, total_premium: 800_000 }),
      makeRetail({ strike: 7200, total_premium: 500_000 }),
    ];
    const whales = [
      makeWhale({ option_chain: 'W-A', strike: 7000 }),
      makeWhale({ option_chain: 'W-B', strike: 7100 }),
      makeWhale({ option_chain: 'W-C', strike: 7200 }),
    ];
    const out = findConfluences(retail, whales);
    expect(out.map((m) => m.retail_strike)).toEqual([7100, 7200, 7000]);
    expect(out.map((m) => m.retail_premium)).toEqual([
      800_000, 500_000, 200_000,
    ]);
  });

  it('caps output at 10 matches even with 15 available', () => {
    const retail: RankedStrike[] = [];
    const whales: WhaleAlert[] = [];
    for (let i = 0; i < 15; i++) {
      const strike = 7000 + i * 10; // within proximity (10 pts apart)
      retail.push(makeRetail({ strike, total_premium: 100_000 + i * 1_000 }));
      whales.push(
        makeWhale({
          option_chain: `W-${i}`,
          strike,
          total_premium: 2_000_000,
        }),
      );
    }
    const out = findConfluences(retail, whales);
    expect(out).toHaveLength(10);
  });

  it('classifies all four relationships correctly', () => {
    const cases: Array<{
      retailType: 'call' | 'put';
      whaleType: 'call' | 'put';
      expected: ConfluenceRelationship;
    }> = [
      { retailType: 'call', whaleType: 'call', expected: 'aligned-call' },
      { retailType: 'put', whaleType: 'put', expected: 'aligned-put' },
      {
        retailType: 'call',
        whaleType: 'put',
        expected: 'retail-call-whale-put',
      },
      {
        retailType: 'put',
        whaleType: 'call',
        expected: 'retail-put-whale-call',
      },
    ];
    for (const c of cases) {
      const out = findConfluences(
        [makeRetail({ strike: 7000, type: c.retailType })],
        [
          makeWhale({
            strike: 7000,
            type: c.whaleType,
            option_chain: `W-${c.expected}`,
          }),
        ],
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.relationship).toBe(c.expected);
    }
  });

  it('breaks sort ties by strike proximity (tighter pair first)', () => {
    // Two retail strikes with the same premium; each has a whale at
    // different distances. The exact-match pair should rank first.
    const retail = [
      makeRetail({
        strike: 7000,
        type: 'call',
        total_premium: 400_000,
      }),
      makeRetail({
        strike: 7200,
        type: 'call',
        total_premium: 400_000,
      }),
    ];
    const whales = [
      makeWhale({
        option_chain: 'W-near',
        strike: 7000, // 0-pt delta
        type: 'put',
      }),
      makeWhale({
        option_chain: 'W-far',
        strike: 7240, // 40-pt delta
        type: 'put',
      }),
    ];
    const out = findConfluences(retail, whales);
    expect(out).toHaveLength(2);
    expect(Math.abs(out[0]!.strike_delta)).toBe(0);
    expect(Math.abs(out[1]!.strike_delta)).toBe(40);
  });

  it('honors opts overrides (strikeProximity, minWhalePremium, maxMatches)', () => {
    // With proximity=200, 7000 retail + 7150 whale should now match.
    const retail = [makeRetail({ strike: 7000 })];
    const whales = [
      makeWhale({ strike: 7150, total_premium: 750_000 }),
      makeWhale({ option_chain: 'W2', strike: 7200, total_premium: 600_000 }),
    ];
    const out = findConfluences(retail, whales, {
      strikeProximity: 200,
      minWhalePremium: 500_000,
      maxMatches: 1,
    });
    expect(out).toHaveLength(1);
  });

  it('exposes tunable constants with sensible defaults', () => {
    expect(CONFLUENCE_CONSTANTS.STRIKE_PROXIMITY).toBe(50);
    expect(CONFLUENCE_CONSTANTS.MIN_WHALE_PREMIUM).toBe(1_000_000);
    expect(CONFLUENCE_CONSTANTS.MAX_MATCHES).toBe(10);
  });
});
