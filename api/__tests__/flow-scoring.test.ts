// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  aggregateAlertsByStrike,
  computeDirectionalRollup,
  proximityPenalty,
  rankStrikes,
  scoreStrike,
  SCORING_WEIGHTS,
  type Aggregated,
  type FlowAlertRow,
  type RankedStrike,
} from '../_lib/flow-scoring.js';

// --- Fixture ---------------------------------------------------------------

function makeAlert(overrides: Partial<FlowAlertRow> = {}): FlowAlertRow {
  return {
    alert_rule: 'RepeatedHits',
    ticker: 'SPXW',
    strike: 6900,
    expiry: '2026-04-14',
    type: 'call',
    option_chain: 'SPXW260414C06900000',
    created_at: '2026-04-14T14:30:00.000Z',
    price: 3.5,
    underlying_price: 6850,
    total_premium: 100_000,
    total_ask_side_prem: 70_000,
    total_bid_side_prem: 30_000,
    total_size: 100,
    volume: 500,
    open_interest: 1000,
    volume_oi_ratio: 0.5,
    has_sweep: false,
    has_floor: false,
    has_multileg: false,
    has_singleleg: true,
    all_opening_trades: false,
    ask_side_ratio: 0.7,
    net_premium: 40_000,
    distance_from_spot: 50,
    distance_pct: 0.0073,
    is_itm: false,
    minute_of_day: 570,
    ...overrides,
  };
}

function baseAggregated(overrides: Partial<Aggregated> = {}): Aggregated {
  return {
    strike: 6900,
    type: 'call',
    total_premium: 100_000,
    ask_side_ratio: 0.7,
    volume_oi_ratio: 0.5,
    hit_count: 1,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    distance_from_spot: 50,
    distance_pct: 0.0073,
    is_itm: false,
    first_seen_at: '2026-04-14T14:30:00.000Z',
    last_seen_at: '2026-04-14T14:30:00.000Z',
    ...overrides,
  };
}

// --- aggregateAlertsByStrike -----------------------------------------------

describe('aggregateAlertsByStrike', () => {
  it('groups alerts by type:strike with correct hit counts', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ strike: 6900, type: 'call' }),
      makeAlert({ strike: 6900, type: 'call' }),
      makeAlert({ strike: 6900, type: 'call' }),
      makeAlert({ strike: 6800, type: 'put' }),
      makeAlert({ strike: 6800, type: 'put' }),
    ];

    const result = aggregateAlertsByStrike(alerts);
    expect(result.size).toBe(2);

    const call6900 = result.get('call:6900');
    expect(call6900).toBeDefined();
    expect(call6900?.hit_count).toBe(3);

    const put6800 = result.get('put:6800');
    expect(put6800).toBeDefined();
    expect(put6800?.hit_count).toBe(2);
  });

  it('computes premium-weighted ask_side_ratio', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({
        strike: 6900,
        type: 'call',
        total_premium: 100,
        ask_side_ratio: 1.0,
      }),
      makeAlert({
        strike: 6900,
        type: 'call',
        total_premium: 400,
        ask_side_ratio: 0.5,
      }),
    ];

    const result = aggregateAlertsByStrike(alerts);
    const agg = result.get('call:6900');
    // (100*1.0 + 400*0.5) / 500 = 300/500 = 0.6
    expect(agg?.ask_side_ratio).toBeCloseTo(0.6, 10);
  });

  it('takes max volume_oi_ratio across the window', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({
        created_at: '2026-04-14T14:30:00.000Z',
        volume_oi_ratio: 0.5,
      }),
      makeAlert({
        created_at: '2026-04-14T14:31:00.000Z',
        volume_oi_ratio: 2.1,
      }),
      makeAlert({
        created_at: '2026-04-14T14:32:00.000Z',
        volume_oi_ratio: 0.8,
      }),
    ];

    const result = aggregateAlertsByStrike(alerts);
    const agg = result.get('call:6900');
    expect(agg?.volume_oi_ratio).toBe(2.1);
  });

  it('detects has_ascending_fill when any row is RepeatedHitsAscendingFill', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ alert_rule: 'RepeatedHits' }),
      makeAlert({ alert_rule: 'RepeatedHitsAscendingFill' }),
      makeAlert({ alert_rule: 'RepeatedHits' }),
    ];

    const agg = aggregateAlertsByStrike(alerts).get('call:6900');
    expect(agg?.has_ascending_fill).toBe(true);
    expect(agg?.has_descending_fill).toBe(false);
  });

  it('detects has_multileg when any row has has_multileg=true', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ has_multileg: false }),
      makeAlert({ has_multileg: true }),
    ];

    const agg = aggregateAlertsByStrike(alerts).get('call:6900');
    expect(agg?.has_multileg).toBe(true);
  });

  it('returns null ask_side_ratio when every row is null', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ ask_side_ratio: null }),
      makeAlert({ ask_side_ratio: null }),
    ];

    const agg = aggregateAlertsByStrike(alerts).get('call:6900');
    expect(agg?.ask_side_ratio).toBeNull();
  });

  it('returns null volume_oi_ratio when every row is null', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ volume_oi_ratio: null }),
      makeAlert({ volume_oi_ratio: null }),
    ];

    const agg = aggregateAlertsByStrike(alerts).get('call:6900');
    expect(agg?.volume_oi_ratio).toBeNull();
  });

  it('tracks first_seen_at and last_seen_at across rows', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({ created_at: '2026-04-14T14:31:00.000Z' }),
      makeAlert({ created_at: '2026-04-14T14:29:00.000Z' }),
      makeAlert({ created_at: '2026-04-14T14:33:00.000Z' }),
    ];

    const agg = aggregateAlertsByStrike(alerts).get('call:6900');
    expect(agg?.first_seen_at).toBe('2026-04-14T14:29:00.000Z');
    expect(agg?.last_seen_at).toBe('2026-04-14T14:33:00.000Z');
  });
});

// --- proximityPenalty -------------------------------------------------------

describe('proximityPenalty', () => {
  it('returns 0 for distance_pct=0 (ATM)', () => {
    expect(proximityPenalty(0)).toBe(0);
  });

  it('returns half of max for distance_pct=0.015 (1.5%)', () => {
    expect(proximityPenalty(0.015)).toBeCloseTo(10, 10);
  });

  it('returns full penalty for distance_pct=0.05 (capped)', () => {
    expect(proximityPenalty(0.05)).toBe(SCORING_WEIGHTS.PROXIMITY_PENALTY_MAX);
  });

  it('uses absolute value for negative distance_pct', () => {
    expect(proximityPenalty(-0.015)).toBeCloseTo(10, 10);
  });

  it('returns 0 for null input', () => {
    expect(proximityPenalty(null)).toBe(0);
  });
});

// --- scoreStrike ------------------------------------------------------------

describe('scoreStrike', () => {
  it('is monotonic in total_premium (doubling increases score)', () => {
    const lo = baseAggregated({ total_premium: 100_000 });
    const hi = baseAggregated({ total_premium: 200_000 });
    expect(scoreStrike(hi)).toBeGreaterThan(scoreStrike(lo));
  });

  it('adding ascending_fill adds exactly ASCENDING_FILL_BONUS', () => {
    const without = baseAggregated({ has_ascending_fill: false });
    const withAsc = baseAggregated({ has_ascending_fill: true });
    expect(scoreStrike(withAsc) - scoreStrike(without)).toBeCloseTo(
      SCORING_WEIGHTS.ASCENDING_FILL_BONUS,
      10,
    );
  });

  it('caps volume_oi_ratio contribution at VOL_OI_RATIO_CAP', () => {
    const capped = baseAggregated({ volume_oi_ratio: 2.0 });
    const over = baseAggregated({ volume_oi_ratio: 10.0 });
    expect(scoreStrike(over)).toBeCloseTo(scoreStrike(capped), 10);
  });

  it('treats null ask_side_ratio as 0', () => {
    const nullAsk = baseAggregated({ ask_side_ratio: null });
    const zeroAsk = baseAggregated({ ask_side_ratio: 0 });
    expect(scoreStrike(nullAsk)).toBeCloseTo(scoreStrike(zeroAsk), 10);
  });
});

// --- rankStrikes ------------------------------------------------------------

describe('rankStrikes', () => {
  it('sorts by score desc and respects the limit', () => {
    // Construct 5 strikes with differentiating total_premium so scores vary
    // predictably (premium-log term dominates).
    const premiums = [10_000, 1_000_000, 100_000, 100_000_000, 50_000];
    const alerts: FlowAlertRow[] = premiums.map((p, i) =>
      makeAlert({
        strike: 6900 + i * 10,
        type: 'call',
        total_premium: p,
        ask_side_ratio: 0.5,
        volume_oi_ratio: 0.5,
        distance_pct: 0, // neutralize proximity penalty
      }),
    );

    const top3 = rankStrikes(alerts, 3);
    expect(top3).toHaveLength(3);

    // Descending scores
    for (let i = 0; i < top3.length - 1; i += 1) {
      const cur = top3[i];
      const next = top3[i + 1];
      if (!cur || !next) throw new Error('unexpected missing ranked entry');
      expect(cur.score).toBeGreaterThanOrEqual(next.score);
    }

    // Highest premium (100M) must win
    const first = top3[0];
    if (!first) throw new Error('expected at least one ranked strike');
    expect(first.strike).toBe(6930);
    expect(first.total_premium).toBe(100_000_000);
  });

  it('returns empty array when limit is 0', () => {
    const alerts = [makeAlert()];
    expect(rankStrikes(alerts, 0)).toEqual([]);
  });

  it('produces RankedStrike shapes with defaulted nulls', () => {
    const alerts: FlowAlertRow[] = [
      makeAlert({
        strike: 6900,
        ask_side_ratio: null,
        volume_oi_ratio: null,
        is_itm: null,
        distance_from_spot: null,
        distance_pct: null,
      }),
    ];
    const ranked = rankStrikes(alerts, 10);
    const r = ranked[0];
    if (!r) throw new Error('expected one ranked strike');
    expect(r.ask_side_ratio).toBe(0);
    expect(r.volume_oi_ratio).toBe(0);
    expect(r.is_itm).toBe(false);
    expect(r.distance_from_spot).toBe(0);
    expect(r.distance_pct).toBe(0);
  });
});

// --- computeDirectionalRollup ----------------------------------------------

function makeRanked(
  overrides: Partial<RankedStrike> &
    Pick<RankedStrike, 'strike' | 'type' | 'total_premium'>,
): RankedStrike {
  return {
    distance_from_spot: 0,
    distance_pct: 0,
    ask_side_ratio: 0.5,
    volume_oi_ratio: 0.5,
    hit_count: 1,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 0,
    first_seen_at: '2026-04-14T14:30:00.000Z',
    last_seen_at: '2026-04-14T14:30:00.000Z',
    ...overrides,
  };
}

describe('computeDirectionalRollup', () => {
  const spot = 6850;

  it('bullish lean when OTM call premium dominates', () => {
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6900, type: 'call', total_premium: 300_000 }),
      makeRanked({ strike: 6910, type: 'call', total_premium: 300_000 }),
      makeRanked({ strike: 6920, type: 'call', total_premium: 200_000 }),
      makeRanked({ strike: 6800, type: 'put', total_premium: 100_000 }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.lean).toBe('bullish');
    expect(r.bullish_count).toBe(3);
    expect(r.bearish_count).toBe(1);
    expect(r.bullish_premium).toBe(800_000);
    expect(r.bearish_premium).toBe(100_000);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('bearish lean when OTM put premium dominates', () => {
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6800, type: 'put', total_premium: 300_000 }),
      makeRanked({ strike: 6790, type: 'put', total_premium: 300_000 }),
      makeRanked({ strike: 6780, type: 'put', total_premium: 200_000 }),
      makeRanked({ strike: 6900, type: 'call', total_premium: 100_000 }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.lean).toBe('bearish');
    expect(r.bearish_count).toBe(3);
    expect(r.bullish_count).toBe(1);
    expect(r.bearish_premium).toBe(800_000);
    expect(r.bullish_premium).toBe(100_000);
  });

  it('neutral lean when premium ratio is below threshold', () => {
    // 500k bullish / 400k bearish = 1.25 < 1.5 threshold
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6900, type: 'call', total_premium: 500_000 }),
      makeRanked({ strike: 6800, type: 'put', total_premium: 400_000 }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.lean).toBe('neutral');
    expect(r.confidence).toBe(0);
    expect(r.bullish_premium).toBe(500_000);
    expect(r.bearish_premium).toBe(400_000);
  });

  it('excludes ITM calls and ITM puts from directional counts', () => {
    // ITM call: strike < spot. ITM put: strike > spot.
    const ranked: RankedStrike[] = [
      makeRanked({
        strike: 6800,
        type: 'call',
        total_premium: 500_000,
        is_itm: true,
      }),
      makeRanked({
        strike: 6900,
        type: 'put',
        total_premium: 500_000,
        is_itm: true,
      }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.bullish_count).toBe(0);
    expect(r.bearish_count).toBe(0);
    expect(r.bullish_premium).toBe(0);
    expect(r.bearish_premium).toBe(0);
    expect(r.lean).toBe('neutral');
    expect(r.confidence).toBe(0);
    expect(r.top_bullish_strike).toBeNull();
    expect(r.top_bearish_strike).toBeNull();
  });

  it('returns neutral/zero for null spot regardless of inputs', () => {
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6900, type: 'call', total_premium: 10_000_000 }),
      makeRanked({ strike: 6800, type: 'put', total_premium: 1 }),
    ];

    const r = computeDirectionalRollup(ranked, null);
    expect(r.lean).toBe('neutral');
    expect(r.confidence).toBe(0);
    expect(r.bullish_count).toBe(0);
    expect(r.bearish_count).toBe(0);
    expect(r.top_bullish_strike).toBeNull();
    expect(r.top_bearish_strike).toBeNull();
  });

  it('top_bullish_strike picks the max-premium bullish strike', () => {
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6900, type: 'call', total_premium: 100_000 }),
      makeRanked({ strike: 6910, type: 'call', total_premium: 750_000 }),
      makeRanked({ strike: 6920, type: 'call', total_premium: 500_000 }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.top_bullish_strike).toBe(6910);
  });

  it('top_bearish_strike picks the max-premium bearish strike', () => {
    const ranked: RankedStrike[] = [
      makeRanked({ strike: 6800, type: 'put', total_premium: 100_000 }),
      makeRanked({ strike: 6790, type: 'put', total_premium: 750_000 }),
      makeRanked({ strike: 6780, type: 'put', total_premium: 500_000 }),
    ];

    const r = computeDirectionalRollup(ranked, spot);
    expect(r.top_bearish_strike).toBe(6790);
  });
});
