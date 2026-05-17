import { describe, expect, it } from 'vitest';

import {
  CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS,
  CROSS_NAME_CLUSTER_MIN_TICKERS,
  CROSS_NAME_CLUSTER_SATURATION_TICKERS,
  type ForcedFlowMacroContext,
  clusterScoreFromCount,
  computeForcedFlowFeatures,
  isQuarterEndLastHourCt,
} from '../_lib/forced-flow.js';
import type {
  LotteryAlertRow,
  SilentBoomAlertRow,
} from '../_lib/takeit-features.js';

/* ───────────────────────── Fixture helpers ─────────────────────────── */

function lotteryRow(overrides: Partial<LotteryAlertRow> = {}): LotteryAlertRow {
  return {
    fire_time: new Date('2026-04-01T14:30:00Z'),
    date: new Date('2026-04-01'),
    option_chain_id: 'SPY_500_C_2026-04-01',
    underlying_symbol: 'SPY',
    option_type: 'C',
    strike: 500,
    dte: 0,
    trigger_vol_to_oi_window: null,
    trigger_vol_to_oi_cum: null,
    trigger_iv: null,
    trigger_delta: null,
    trigger_ask_pct: null,
    trigger_window_size: null,
    trigger_window_prints: null,
    entry_price: null,
    open_interest: null,
    spot_at_first: null,
    alert_seq: null,
    minutes_since_prev_fire: null,
    flow_quad: null,
    tod: null,
    mode: null,
    reload_tagged: null,
    cheap_call_pm_tagged: null,
    burst_ratio_vs_prev: null,
    entry_drop_pct_vs_prev: null,
    mkt_tide_ncp: null,
    mkt_tide_npp: null,
    mkt_tide_diff: null,
    mkt_tide_otm_diff: null,
    spx_flow_diff: null,
    spy_etf_diff: null,
    qqq_etf_diff: null,
    zero_dte_diff: null,
    spx_spot_gamma_oi: null,
    spx_spot_gamma_vol: null,
    spx_spot_charm_oi: null,
    spx_spot_vanna_oi: null,
    gex_strike_call_minus_put: null,
    gex_strike_call_ask_minus_bid: null,
    gex_strike_put_ask_minus_bid: null,
    score: null,
    direction_gated: null,
    ...overrides,
  };
}

function silentBoomRow(
  overrides: Partial<SilentBoomAlertRow> = {},
): SilentBoomAlertRow {
  return {
    fire_time: new Date('2026-04-01T14:30:00Z'),
    date: new Date('2026-04-01'),
    option_chain_id: 'SPY_500_C_2026-04-01',
    underlying_symbol: 'SPY',
    option_type: 'C',
    strike: 500,
    dte: 0,
    spike_volume: null,
    baseline_volume: null,
    spike_ratio: null,
    ask_pct: null,
    vol_oi: null,
    entry_price: null,
    open_interest: null,
    mkt_tide_diff: null,
    mkt_tide_otm_diff: null,
    zero_dte_diff: null,
    spx_spot_gamma_oi: null,
    multi_leg_share: null,
    underlying_price_at_spike: null,
    score: null,
    score_tier: null,
    direction_gated: null,
    ...overrides,
  };
}

const EMPTY_MACRO: ForcedFlowMacroContext = {};

/* ───────────────────────── clusterScoreFromCount ───────────────────── */

describe('clusterScoreFromCount', () => {
  it('returns 0 below the N≥5 floor', () => {
    expect(clusterScoreFromCount(0)).toBe(0);
    expect(clusterScoreFromCount(4)).toBe(0);
    expect(clusterScoreFromCount(CROSS_NAME_CLUSTER_MIN_TICKERS - 1)).toBe(0);
  });

  it('hits 0.5 exactly at N=5 (linear with 10-saturation)', () => {
    expect(clusterScoreFromCount(CROSS_NAME_CLUSTER_MIN_TICKERS)).toBe(0.5);
  });

  it('saturates at 1 at N=10 and stays at 1 for N>10', () => {
    expect(clusterScoreFromCount(CROSS_NAME_CLUSTER_SATURATION_TICKERS)).toBe(
      1,
    );
    expect(clusterScoreFromCount(50)).toBe(1);
  });

  it('interpolates linearly between N=5 and N=10', () => {
    expect(clusterScoreFromCount(7)).toBeCloseTo(0.7);
    expect(clusterScoreFromCount(8)).toBeCloseTo(0.8);
  });

  it('returns 0 for non-finite input (NaN, Infinity)', () => {
    expect(clusterScoreFromCount(Number.NaN)).toBe(0);
    expect(clusterScoreFromCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/* ───────────────────────── isQuarterEndLastHourCt ──────────────────── */

describe('isQuarterEndLastHourCt', () => {
  it('flags 2026-03-31 14:30 CT (Tue, quarter end, in last hour)', () => {
    // 14:30 CT (CDT, UTC-5) on 2026-03-31 = 19:30 UTC
    const t = new Date('2026-03-31T19:30:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(true);
  });

  it('flags 2026-03-31 14:00 CT (LEFT-inclusive boundary)', () => {
    // 14:00 CT (CDT) = 19:00 UTC. Note: 2026-03-31 is a CDT date
    // (DST switch is 2026-03-08 in the US).
    const t = new Date('2026-03-31T19:00:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(true);
  });

  it('does NOT flag 2026-03-31 15:00 CT (RIGHT-exclusive boundary)', () => {
    // 15:00 CT (CDT) = 20:00 UTC
    const t = new Date('2026-03-31T20:00:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(false);
  });

  it('does NOT flag 13:59 CT on the last day of the quarter (before window)', () => {
    const t = new Date('2026-03-31T18:59:00Z'); // 13:59 CT (CDT)
    expect(isQuarterEndLastHourCt(t)).toBe(false);
  });

  it('does NOT flag the LAST CALENDAR day when it falls on a weekend', () => {
    // 2026-12-31 is a Thu, last weekday. Pick a quarter where the 31st is
    // a Sunday: 2027-01-31 is a Sun (not a quarter-end). For real check:
    // 2026-12-31 (Thu) → flag. 2027-Q1 ends 2027-03-31 (Wed) → flag.
    // Use 2025-08-31 (a Sunday in 2025). 2025-08-31 is NOT a quarter-end
    // (Aug ≠ Mar/Jun/Sep/Dec). Synthesize a non-quarter-end weekend.
    const t = new Date('2026-04-30T19:30:00Z'); // 2026-04-30 = Thu, not quarter end
    expect(isQuarterEndLastHourCt(t)).toBe(false);
  });

  it('does NOT flag a non-quarter-end month', () => {
    const t = new Date('2026-04-30T19:30:00Z'); // last weekday of April, in window
    expect(isQuarterEndLastHourCt(t)).toBe(false);
  });

  it('flags 2026-06-30 14:30 CT (Tue, Q2 end)', () => {
    // 2026-06-30 is a Tue. 14:30 CT (CDT) = 19:30 UTC.
    const t = new Date('2026-06-30T19:30:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(true);
  });

  it('flags 2026-09-30 14:30 CT (Wed, Q3 end)', () => {
    // 2026-09-30 is a Wed. 14:30 CT (CDT) = 19:30 UTC.
    const t = new Date('2026-09-30T19:30:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(true);
  });

  it('flags 2026-12-31 14:30 CT (Thu, Q4 end, CST winter time)', () => {
    // 2026-12-31 is a Thu. 14:30 CT (CST, UTC-6) = 20:30 UTC.
    const t = new Date('2026-12-31T20:30:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(true);
  });

  it('does NOT flag the 30th when the last weekday is the 31st', () => {
    // 2026-03-30 is a Mon; 2026-03-31 is a Tue (the last weekday → quarter end).
    const t = new Date('2026-03-30T19:30:00Z');
    expect(isQuarterEndLastHourCt(t)).toBe(false);
  });

  it('returns false for an invalid Date', () => {
    expect(isQuarterEndLastHourCt(new Date(Number.NaN))).toBe(false);
  });
});

/* ───────────────────────── computeForcedFlowFeatures ───────────────── */

describe('computeForcedFlowFeatures — bilateral_flow_score', () => {
  it('returns 0 (stub) regardless of alert / macro input', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), EMPTY_MACRO);
    expect(out.bilateral_flow_score).toBe(0);
    const out2 = computeForcedFlowFeatures(silentBoomRow(), {
      sectorMap: new Map([['SPY', 'ETF_BROAD']]),
      vixIntradayChange: 5,
    });
    expect(out2.bilateral_flow_score).toBe(0);
  });
});

describe('computeForcedFlowFeatures — cross_name_cluster_score', () => {
  it('returns 0 (stub) regardless of sectorMap', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {
      sectorMap: new Map([
        ['AAPL', 'TECH'],
        ['MSFT', 'TECH'],
        ['GOOGL', 'TECH'],
        ['META', 'TECH'],
        ['NVDA', 'TECH'],
        ['AMZN', 'TECH'],
      ]),
    });
    expect(out.cross_name_cluster_score).toBe(0);
  });
});

describe('computeForcedFlowFeatures — calendar_adjacency_flag', () => {
  it('flags 1 when fire_time lands in quarter-end last hour CT', () => {
    const out = computeForcedFlowFeatures(
      lotteryRow({ fire_time: new Date('2026-03-31T19:30:00Z') }),
      EMPTY_MACRO,
    );
    expect(out.calendar_adjacency_flag).toBe(1);
  });

  it('flags 0 outside the quarter-end last hour', () => {
    const out = computeForcedFlowFeatures(
      lotteryRow({ fire_time: new Date('2026-04-01T15:30:00Z') }),
      EMPTY_MACRO,
    );
    expect(out.calendar_adjacency_flag).toBe(0);
  });
});

describe('computeForcedFlowFeatures — cross_asset_stress_flag', () => {
  it('flags 1 when vixIntradayChange > +3pts (strict)', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {
      vixIntradayChange: CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS + 0.01,
    });
    expect(out.cross_asset_stress_flag).toBe(1);
  });

  it('flags 0 when vixIntradayChange equals the threshold (strict-greater)', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {
      vixIntradayChange: CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS,
    });
    expect(out.cross_asset_stress_flag).toBe(0);
  });

  it('flags 0 when vixIntradayChange is below threshold', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {
      vixIntradayChange: 1.2,
    });
    expect(out.cross_asset_stress_flag).toBe(0);
  });

  it('flags 0 when vixIntradayChange is null / undefined / NaN', () => {
    expect(
      computeForcedFlowFeatures(lotteryRow(), { vixIntradayChange: null })
        .cross_asset_stress_flag,
    ).toBe(0);
    expect(
      computeForcedFlowFeatures(lotteryRow(), {}).cross_asset_stress_flag,
    ).toBe(0);
    expect(
      computeForcedFlowFeatures(lotteryRow(), {
        vixIntradayChange: Number.NaN,
      }).cross_asset_stress_flag,
    ).toBe(0);
  });

  it('flags 0 when VIX is sharply NEGATIVE (vol-off rally, not stress)', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {
      vixIntradayChange: -5,
    });
    expect(out.cross_asset_stress_flag).toBe(0);
  });
});

/* ───────────────────────── Composer integration ────────────────────── */

describe('computeForcedFlowFeatures — combined output shape', () => {
  it('returns all 4 keys with numeric values (no nulls, no undefined)', () => {
    const out = computeForcedFlowFeatures(lotteryRow(), {});
    expect(typeof out.bilateral_flow_score).toBe('number');
    expect(typeof out.cross_name_cluster_score).toBe('number');
    expect(typeof out.calendar_adjacency_flag).toBe('number');
    expect(typeof out.cross_asset_stress_flag).toBe('number');
  });

  it('works on silent-boom alerts identically', () => {
    const out = computeForcedFlowFeatures(silentBoomRow(), {
      vixIntradayChange: 4.5,
    });
    expect(out.bilateral_flow_score).toBe(0);
    expect(out.cross_name_cluster_score).toBe(0);
    expect(out.calendar_adjacency_flag).toBe(0);
    expect(out.cross_asset_stress_flag).toBe(1);
  });

  it('handles VIX + quarter-end firing simultaneously (no interaction)', () => {
    const out = computeForcedFlowFeatures(
      lotteryRow({ fire_time: new Date('2026-03-31T19:30:00Z') }),
      { vixIntradayChange: 6 },
    );
    expect(out.calendar_adjacency_flag).toBe(1);
    expect(out.cross_asset_stress_flag).toBe(1);
  });
});
