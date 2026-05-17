import { describe, expect, it } from 'vitest';

import type { ForcedFlowMacroContext } from '../_lib/forced-flow.js';
import {
  INFERRED_STRUCTURE_LABELS,
  type LotteryAlertRow,
  SESSION_PHASES,
  type SequentialContext,
  type SilentBoomAlertRow,
  ctMinuteAndDow,
  deriveAggressivePremiumFlag,
  deriveBurstStormBadge,
  deriveBurstStormDistinctCount,
  deriveCofireDiffChainFlag,
  deriveCofireFlag,
  deriveDealerGammaSign,
  deriveIsItmAtFire,
  deriveNSameDirFiresLast30Min,
  deriveOtmDistancePct,
  deriveSessionPhase,
  expandOneHotCategoricals,
  featuresForLottery,
  featuresForSilentBoom,
  sessionPhaseCatFromMinuteCt,
  sessionPhaseFromMinuteCt,
  tickerDirKey,
} from '../_lib/takeit-features.js';
import type { TakeitBundle } from '../_lib/takeit-score.js';

const EMPTY_CTX: SequentialContext = {
  recentSameTypeFires: [],
  recentOtherTypeByChain: new Map(),
  recentOtherTypeByTickerDir: new Map(),
  priorSessionWinRateByTicker: new Map(),
};

function makeBundle(
  alertType: 'lottery' | 'silentboom',
  featureCols: string[],
  topTickers: string[] = ['SPY', 'QQQ'],
  categoricalCols: string[] = alertType === 'lottery'
    ? ['option_type', 'mode', 'flow_quad', 'tod', 'inferred_structure']
    : ['option_type', 'score_tier', 'inferred_structure'],
): TakeitBundle {
  return {
    version: 'v-test',
    alert_type: alertType,
    trained_on_date: '2026-05-16',
    win_label_threshold_pct: 20,
    xgb_json_schema: '2.1',
    feature_cols: featureCols,
    top_tickers: topTickers,
    categorical_cols: categoricalCols,
    feature_derivation_constants: {},
    xgb_model: {
      learner: {
        learner_model_param: { base_score: '[5.0E-1]' },
        gradient_booster: { model: { trees: [] } },
      },
    },
    isotonic: { x_thresholds: [0, 1], y_thresholds: [0, 1] },
  };
}

/* ───────────────────────── Time helpers ────────────────────────────── */

describe('ctMinuteAndDow', () => {
  it('converts UTC 14:30 to CT 09:30 minute=570 on a weekday', () => {
    const utc = new Date('2026-04-01T14:30:00Z'); // Wed
    const r = ctMinuteAndDow(utc);
    expect(r.minute_of_day_ct).toBe(9 * 60 + 30);
    expect(r.day_of_week).toBe(2); // Wed = 2 (Python: Mon=0..Sun=6)
  });

  it('Friday UTC translates to dow=4 in Python convention', () => {
    const utc = new Date('2026-04-03T19:00:00Z'); // Fri
    const r = ctMinuteAndDow(utc);
    expect(r.day_of_week).toBe(4);
  });
});

describe('sessionPhaseFromMinuteCt', () => {
  it('partitions the trading day into 5 phases', () => {
    expect(sessionPhaseFromMinuteCt(8 * 60 + 35)).toBe(1); // 8:35
    expect(sessionPhaseFromMinuteCt(9 * 60 + 30)).toBe(2); // 9:30
    expect(sessionPhaseFromMinuteCt(11 * 60)).toBe(3); // 11:00
    expect(sessionPhaseFromMinuteCt(13 * 60)).toBe(4); // 13:00
    expect(sessionPhaseFromMinuteCt(14 * 60 + 30)).toBe(5); // 14:30
    expect(sessionPhaseFromMinuteCt(7 * 60)).toBe(0); // outside session
  });
});

/* ───────────────────────── Per-row derivations ─────────────────────── */

describe('deriveIsItmAtFire', () => {
  it('handles ITM call, OTM call, ITM put, OTM put', () => {
    expect(deriveIsItmAtFire('C', 510, 500)).toBe(1); // ITM call
    expect(deriveIsItmAtFire('C', 500, 510)).toBe(0); // OTM call
    expect(deriveIsItmAtFire('P', 510, 500)).toBe(0); // OTM put
    expect(deriveIsItmAtFire('P', 500, 510)).toBe(1); // ITM put
  });

  it('returns null when spot or strike is missing', () => {
    expect(deriveIsItmAtFire('C', null, 500)).toBeNull();
    expect(deriveIsItmAtFire('C', 500, null)).toBeNull();
  });
});

describe('deriveOtmDistancePct', () => {
  it('is positive for OTM, negative for ITM', () => {
    // OTM call: strike > spot
    expect(deriveOtmDistancePct('C', 500, 510)).toBeCloseTo(0.02);
    // ITM call: strike < spot
    expect(deriveOtmDistancePct('C', 510, 500)).toBeCloseTo(-10 / 510);
    // OTM put: spot > strike
    expect(deriveOtmDistancePct('P', 510, 500)).toBeCloseTo(10 / 510);
    // ITM put: spot < strike
    expect(deriveOtmDistancePct('P', 500, 510)).toBeCloseTo(-0.02);
  });

  it('returns null for missing or zero spot', () => {
    expect(deriveOtmDistancePct('C', null, 500)).toBeNull();
    expect(deriveOtmDistancePct('C', 0, 500)).toBeNull();
  });
});

describe('deriveDealerGammaSign', () => {
  it('returns 1, -1, null, null for positive, negative, zero, null', () => {
    expect(deriveDealerGammaSign(5)).toBe(1);
    expect(deriveDealerGammaSign(-3)).toBe(-1);
    expect(deriveDealerGammaSign(0)).toBeNull();
    expect(deriveDealerGammaSign(null)).toBeNull();
  });
});

describe('deriveAggressivePremiumFlag', () => {
  it('is 1 only when ask_pct >= 0.85 (threshold inclusive)', () => {
    expect(deriveAggressivePremiumFlag(0.84)).toBe(0);
    expect(deriveAggressivePremiumFlag(0.85)).toBe(1);
    expect(deriveAggressivePremiumFlag(1.0)).toBe(1);
    expect(deriveAggressivePremiumFlag(null)).toBeNull();
  });
});

/* ───────────────────────── Sequential derivations ──────────────────── */

describe('deriveBurstStormDistinctCount', () => {
  it('counts only DISTINCT underlyings strictly prior within the 30min window', () => {
    const t = new Date('2026-04-01T14:30:00Z');
    const ctx = [
      // Same underlying twice → distinct count counts once.
      {
        fire_time: new Date(t.getTime() - 10 * 60_000),
        underlying_symbol: 'AAA',
        option_type: 'C' as const,
      },
      {
        fire_time: new Date(t.getTime() - 5 * 60_000),
        underlying_symbol: 'AAA',
        option_type: 'P' as const,
      },
      // Different underlyings.
      {
        fire_time: new Date(t.getTime() - 8 * 60_000),
        underlying_symbol: 'BBB',
        option_type: 'C' as const,
      },
      {
        fire_time: new Date(t.getTime() - 3 * 60_000),
        underlying_symbol: 'CCC',
        option_type: 'C' as const,
      },
      // Outside window (45min before).
      {
        fire_time: new Date(t.getTime() - 45 * 60_000),
        underlying_symbol: 'DDD',
        option_type: 'C' as const,
      },
    ];
    expect(deriveBurstStormDistinctCount(t, ctx)).toBe(3); // AAA, BBB, CCC
  });

  it('excludes fires at exactly fire_time (strictly prior)', () => {
    const t = new Date('2026-04-01T14:30:00Z');
    const ctx = [
      { fire_time: t, underlying_symbol: 'AAA', option_type: 'C' as const }, // strictly NOT prior
    ];
    expect(deriveBurstStormDistinctCount(t, ctx)).toBe(0);
  });
});

describe('deriveBurstStormBadge', () => {
  it('fires when distinct count meets the 5-cofire threshold', () => {
    expect(deriveBurstStormBadge(4)).toBe(0);
    expect(deriveBurstStormBadge(5)).toBe(1);
    expect(deriveBurstStormBadge(20)).toBe(1);
  });
});

describe('deriveCofireFlag', () => {
  const chain = 'SPY_500_C';
  const t = new Date('2026-04-01T14:30:00Z');

  it('flags a counterpart within window strictly prior', () => {
    const ctx = new Map([
      [chain, [{ fire_time: new Date(t.getTime() - 3 * 60_000) }]],
    ]);
    expect(deriveCofireFlag(t, chain, ctx)).toBe(1);
  });

  it('does NOT flag a future counterpart (PIT-correct)', () => {
    const ctx = new Map([
      [chain, [{ fire_time: new Date(t.getTime() + 3 * 60_000) }]],
    ]);
    expect(deriveCofireFlag(t, chain, ctx)).toBe(0);
  });

  it('does NOT flag a counterpart outside the 5-min window', () => {
    const ctx = new Map([
      [chain, [{ fire_time: new Date(t.getTime() - 6 * 60_000) }]],
    ]);
    expect(deriveCofireFlag(t, chain, ctx)).toBe(0);
  });

  it('does NOT flag a counterpart on a different chain', () => {
    const ctx = new Map([
      ['OTHER_CHAIN', [{ fire_time: new Date(t.getTime() - 2 * 60_000) }]],
    ]);
    expect(deriveCofireFlag(t, chain, ctx)).toBe(0);
  });
});

describe('deriveCofireDiffChainFlag', () => {
  const chain = 'SPY_500_C';
  const sibling = 'SPY_505_C';
  const t = new Date('2026-04-01T14:30:00Z');

  it('flags a sibling-chain prior fire on same ticker+direction', () => {
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'C'),
        [
          {
            fire_time: new Date(t.getTime() - 2 * 60_000),
            option_chain_id: sibling,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(1);
  });

  it('does NOT flag when only the same chain has a prior fire (excluded)', () => {
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'C'),
        [
          {
            fire_time: new Date(t.getTime() - 2 * 60_000),
            option_chain_id: chain,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(0);
  });

  it('does NOT flag opposite option_type (C vs P) on same ticker', () => {
    // Bucket keyed on SPY|P; this fire is SPY|C — different bucket, no match.
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'P'),
        [
          {
            fire_time: new Date(t.getTime() - 2 * 60_000),
            option_chain_id: sibling,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(0);
  });

  it('does NOT flag a sibling fire outside the 5-min window', () => {
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'C'),
        [
          {
            fire_time: new Date(t.getTime() - 6 * 60_000),
            option_chain_id: sibling,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(0);
  });

  it('does NOT flag a future sibling fire (PIT-correct)', () => {
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'C'),
        [
          {
            fire_time: new Date(t.getTime() + 2 * 60_000),
            option_chain_id: sibling,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(0);
  });

  it('co-fires INDEPENDENTLY of same-chain when both prior fires exist', () => {
    // Two prior fires in bucket SPY|C: one on same chain, one on sibling.
    // diff-chain flag flips because the sibling exists; same-chain helper
    // would also flip (tested separately). Confirms NOT mutually exclusive.
    const ctx = new Map([
      [
        tickerDirKey('SPY', 'C'),
        [
          {
            fire_time: new Date(t.getTime() - 2 * 60_000),
            option_chain_id: chain,
          },
          {
            fire_time: new Date(t.getTime() - 3 * 60_000),
            option_chain_id: sibling,
          },
        ],
      ],
    ]);
    expect(deriveCofireDiffChainFlag(t, chain, 'SPY', 'C', ctx)).toBe(1);
  });
});

describe('deriveNSameDirFiresLast30Min', () => {
  it('counts strictly prior same-ticker + same-option_type within 30 min', () => {
    const t = new Date('2026-04-01T14:30:00Z');
    const ctx = [
      {
        fire_time: new Date(t.getTime() - 10 * 60_000),
        underlying_symbol: 'SPY',
        option_type: 'C' as const,
      }, // ✓
      {
        fire_time: new Date(t.getTime() - 5 * 60_000),
        underlying_symbol: 'SPY',
        option_type: 'P' as const,
      }, // wrong type
      {
        fire_time: new Date(t.getTime() - 2 * 60_000),
        underlying_symbol: 'QQQ',
        option_type: 'C' as const,
      }, // wrong ticker
      {
        fire_time: new Date(t.getTime() - 35 * 60_000),
        underlying_symbol: 'SPY',
        option_type: 'C' as const,
      }, // outside window
      {
        fire_time: new Date(t.getTime() - 1 * 60_000),
        underlying_symbol: 'SPY',
        option_type: 'C' as const,
      }, // ✓
    ];
    expect(deriveNSameDirFiresLast30Min(t, 'SPY', 'C', ctx)).toBe(2);
  });
});

/* ───────────────────────── Categorical one-hot ─────────────────────── */

describe('expandOneHotCategoricals', () => {
  it('emits only one-hot columns that exist in bundle.feature_cols', () => {
    const bundle = makeBundle('lottery', [
      'option_type_C',
      'option_type_P',
      'mode_A_intraday_0DTE',
      'mode_B_multi_day_DTE1_3',
      'tod_AM_open',
      'ticker_bucket_SPY',
      'ticker_bucket_QQQ',
      'ticker_bucket_OTHER',
    ]);
    const out = expandOneHotCategoricals(
      bundle,
      { option_type: 'C', mode: 'A_intraday_0DTE', tod: 'AM_open' },
      'SPY',
    );
    expect(out).toEqual({
      option_type_C: 1,
      mode_A_intraday_0DTE: 1,
      tod_AM_open: 1,
      ticker_bucket_SPY: 1,
    });
  });

  it('puts unknown ticker into OTHER bucket', () => {
    const bundle = makeBundle('lottery', [
      'ticker_bucket_SPY',
      'ticker_bucket_OTHER',
    ]);
    const out = expandOneHotCategoricals(bundle, {}, 'OBSCURE');
    expect(out).toEqual({ ticker_bucket_OTHER: 1 });
  });

  it('skips unknown categorical values (no key emitted)', () => {
    const bundle = makeBundle('lottery', [
      'mode_A_intraday_0DTE',
      'ticker_bucket_OTHER',
    ]);
    const out = expandOneHotCategoricals(
      bundle,
      { mode: 'UNKNOWN_MODE' },
      'OBSCURE',
    );
    // No mode_* key set; only ticker_bucket_OTHER.
    expect(out).toEqual({ ticker_bucket_OTHER: 1 });
  });
});

/* ───────────────────────── featuresForLottery smoke ────────────────── */

function lotteryRow(overrides: Partial<LotteryAlertRow> = {}): LotteryAlertRow {
  return {
    fire_time: new Date('2026-04-01T14:30:00Z'),
    date: new Date('2026-04-01'),
    option_chain_id: 'SPY_500_C_2026-04-01',
    underlying_symbol: 'SPY',
    option_type: 'C',
    strike: 500,
    dte: 0,
    trigger_vol_to_oi_window: 0.5,
    trigger_vol_to_oi_cum: 1.2,
    trigger_iv: 0.25,
    trigger_delta: 0.3,
    trigger_ask_pct: 0.6,
    trigger_window_size: 5,
    trigger_window_prints: 4,
    entry_price: 1.0,
    open_interest: 100,
    spot_at_first: 505,
    alert_seq: 1,
    minutes_since_prev_fire: 60,
    flow_quad: 'Q1',
    tod: 'AM_open',
    mode: 'A_intraday_0DTE',
    reload_tagged: false,
    cheap_call_pm_tagged: false,
    burst_ratio_vs_prev: 1.5,
    entry_drop_pct_vs_prev: 0,
    mkt_tide_ncp: 1.0,
    mkt_tide_npp: -1.0,
    mkt_tide_diff: 2.0,
    mkt_tide_otm_diff: 1.5,
    spx_flow_diff: 0,
    spy_etf_diff: 0,
    qqq_etf_diff: 0,
    zero_dte_diff: 0,
    spx_spot_gamma_oi: 5,
    spx_spot_gamma_vol: 1,
    spx_spot_charm_oi: 0,
    spx_spot_vanna_oi: 0,
    gex_strike_call_minus_put: 0,
    gex_strike_call_ask_minus_bid: 0,
    gex_strike_put_ask_minus_bid: 0,
    score: 12,
    direction_gated: false,
    inferred_structure: null,
    is_isolated_leg: null,
    match_confidence: null,
    pattern_group_id: null,
    ...overrides,
  };
}

describe('featuresForLottery', () => {
  it('populates derived + base + one-hot features end-to-end', () => {
    const bundle = makeBundle('lottery', [
      'dte',
      'score',
      'session_phase',
      'is_itm_at_fire',
      'otm_distance_pct',
      'dealer_gamma_sign',
      'aggressive_premium_flag',
      'burst_storm_badge',
      'burst_storm_distinct_count',
      'silent_boom_cofire_within_5min',
      'n_same_dir_fires_last_30min',
      'prior_session_win_rate_same_ticker',
      'minute_of_day_ct',
      'day_of_week',
      'option_type_C',
      'mode_A_intraday_0DTE',
      'tod_AM_open',
      'ticker_bucket_SPY',
    ]);
    const row = lotteryRow();
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    expect(out.dte).toBe(0);
    expect(out.score).toBe(12);
    expect(out.session_phase).toBe(2); // 9:30 CT
    expect(out.is_itm_at_fire).toBe(1); // spot 505 >= strike 500 for call
    expect(out.dealer_gamma_sign).toBe(1);
    expect(out.aggressive_premium_flag).toBe(0); // 0.6 < 0.85
    expect(out.burst_storm_badge).toBe(0);
    expect(out.silent_boom_cofire_within_5min).toBe(0);
    expect(out.n_same_dir_fires_last_30min).toBe(0);
    expect(out.prior_session_win_rate_same_ticker).toBeNull(); // no history
    expect(out.option_type_C).toBe(1);
    expect(out.mode_A_intraday_0DTE).toBe(1);
    expect(out.tod_AM_open).toBe(1);
    expect(out.ticker_bucket_SPY).toBe(1);
  });

  it('uses sequential context for burst-storm + cofire + prior-session', () => {
    const t = new Date('2026-04-01T14:30:00Z');
    const ctx: SequentialContext = {
      recentSameTypeFires: [
        {
          fire_time: new Date(t.getTime() - 5 * 60_000),
          underlying_symbol: 'AAA',
          option_type: 'C',
        },
        {
          fire_time: new Date(t.getTime() - 4 * 60_000),
          underlying_symbol: 'BBB',
          option_type: 'C',
        },
        {
          fire_time: new Date(t.getTime() - 3 * 60_000),
          underlying_symbol: 'CCC',
          option_type: 'C',
        },
        {
          fire_time: new Date(t.getTime() - 2 * 60_000),
          underlying_symbol: 'DDD',
          option_type: 'C',
        },
        {
          fire_time: new Date(t.getTime() - 1 * 60_000),
          underlying_symbol: 'EEE',
          option_type: 'C',
        },
        // SPY same-dir prior
        {
          fire_time: new Date(t.getTime() - 6 * 60_000),
          underlying_symbol: 'SPY',
          option_type: 'C',
        },
      ],
      recentOtherTypeByChain: new Map([
        [
          'SPY_500_C_2026-04-01',
          [{ fire_time: new Date(t.getTime() - 2 * 60_000) }],
        ],
      ]),
      recentOtherTypeByTickerDir: new Map([
        [
          tickerDirKey('SPY', 'C'),
          [
            {
              // Same chain — should NOT trip diff-chain flag.
              fire_time: new Date(t.getTime() - 2 * 60_000),
              option_chain_id: 'SPY_500_C_2026-04-01',
            },
            {
              // Sibling chain — should trip diff-chain flag.
              fire_time: new Date(t.getTime() - 3 * 60_000),
              option_chain_id: 'SPY_505_C_2026-04-01',
            },
          ],
        ],
      ]),
      priorSessionWinRateByTicker: new Map([['SPY', 0.65]]),
    };
    const bundle = makeBundle('lottery', [
      'burst_storm_distinct_count',
      'burst_storm_badge',
      'silent_boom_cofire_within_5min',
      'silent_boom_cofire_diff_chain_within_5min',
      'n_same_dir_fires_last_30min',
      'prior_session_win_rate_same_ticker',
    ]);
    const row = lotteryRow({ fire_time: t });
    const out = featuresForLottery(bundle, row, ctx);
    expect(out.burst_storm_distinct_count).toBe(6); // 5 distinct + SPY
    expect(out.burst_storm_badge).toBe(1);
    expect(out.silent_boom_cofire_within_5min).toBe(1);
    expect(out.silent_boom_cofire_diff_chain_within_5min).toBe(1);
    expect(out.n_same_dir_fires_last_30min).toBe(1); // only SPY/C prior
    expect(out.prior_session_win_rate_same_ticker).toBe(0.65);
  });
});

/* ───────────────────────── featuresForSilentBoom smoke ─────────────── */

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
    spike_volume: 1000,
    baseline_volume: 100,
    spike_ratio: 10,
    ask_pct: 0.9,
    vol_oi: 1,
    entry_price: 1,
    open_interest: 100,
    mkt_tide_diff: 1,
    mkt_tide_otm_diff: 1,
    zero_dte_diff: 0,
    spx_spot_gamma_oi: -3,
    multi_leg_share: 0.1,
    underlying_price_at_spike: 505,
    score: 6,
    score_tier: 'tier1',
    direction_gated: false,
    inferred_structure: null,
    is_isolated_leg: null,
    match_confidence: null,
    pattern_group_id: null,
    ...overrides,
  };
}

describe('featuresForSilentBoom', () => {
  it('uses ask_pct (not trigger_ask_pct) and underlying_price_at_spike', () => {
    const bundle = makeBundle('silentboom', [
      'dte',
      'ask_pct',
      'spike_ratio',
      'session_phase',
      'is_itm_at_fire',
      'aggressive_premium_flag',
      'dealer_gamma_sign',
      'lottery_cofire_within_5min',
      'option_type_C',
      'score_tier_tier1',
      'ticker_bucket_SPY',
    ]);
    const out = featuresForSilentBoom(bundle, silentBoomRow(), EMPTY_CTX);
    expect(out.dte).toBe(0);
    expect(out.ask_pct).toBe(0.9);
    expect(out.spike_ratio).toBe(10);
    expect(out.session_phase).toBe(2);
    expect(out.is_itm_at_fire).toBe(1); // spot 505 >= strike 500
    expect(out.aggressive_premium_flag).toBe(1); // 0.9 >= 0.85
    expect(out.dealer_gamma_sign).toBe(-1);
    expect(out.lottery_cofire_within_5min).toBe(0);
    expect(out.option_type_C).toBe(1);
    expect(out.score_tier_tier1).toBe(1);
    expect(out.ticker_bucket_SPY).toBe(1);
  });
});

/* ───────────────────────── Multileg features (migration #160) ──────── */

describe('multileg classification features (lottery)', () => {
  const MULTILEG_FEATURE_COLS = [
    'is_isolated_leg',
    'match_confidence',
    'inferred_structure_isolated_leg',
    'inferred_structure_vertical',
    'inferred_structure_strangle',
    'inferred_structure_risk_reversal',
    'inferred_structure_butterfly',
  ];

  it('populates is_isolated_leg=1, match_confidence, and the matching one-hot column when classified', () => {
    const bundle = makeBundle('lottery', MULTILEG_FEATURE_COLS);
    const row = lotteryRow({
      is_isolated_leg: true,
      match_confidence: 0.87,
      inferred_structure: 'vertical',
    });
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    expect(out.is_isolated_leg).toBe(1);
    expect(out.match_confidence).toBeCloseTo(0.87);
    expect(out.inferred_structure_vertical).toBe(1);
    // Sibling one-hot columns stay unset (treated as 0 at inference time).
    expect(out.inferred_structure_isolated_leg).toBeUndefined();
    expect(out.inferred_structure_strangle).toBeUndefined();
    expect(out.inferred_structure_risk_reversal).toBeUndefined();
    expect(out.inferred_structure_butterfly).toBeUndefined();
  });

  it('encodes is_isolated_leg=false as 0 (not null)', () => {
    const bundle = makeBundle('lottery', MULTILEG_FEATURE_COLS);
    const row = lotteryRow({
      is_isolated_leg: false,
      match_confidence: 0.6,
      inferred_structure: 'strangle',
    });
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    expect(out.is_isolated_leg).toBe(0);
    expect(out.match_confidence).toBeCloseTo(0.6);
    expect(out.inferred_structure_strangle).toBe(1);
  });

  it('keeps is_isolated_leg / match_confidence as null and emits no inferred_structure_* one-hot when unclassified', () => {
    const bundle = makeBundle('lottery', MULTILEG_FEATURE_COLS);
    const row = lotteryRow({
      is_isolated_leg: null,
      match_confidence: null,
      inferred_structure: null,
    });
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    // NULL → null feature (XGBoost treats as missing — do NOT default to 0/false).
    expect(out.is_isolated_leg).toBeNull();
    expect(out.match_confidence).toBeNull();
    // No inferred_structure_* one-hot fires (all-zero block).
    for (const label of INFERRED_STRUCTURE_LABELS) {
      expect(out[`inferred_structure_${label}`]).toBeUndefined();
    }
  });

  it('emits no inferred_structure_* one-hot for unknown labels (forward-compat)', () => {
    const bundle = makeBundle('lottery', MULTILEG_FEATURE_COLS);
    const row = lotteryRow({
      // v2 matcher could emit e.g. 'condor'; bundle doesn't pin it → no key.
      inferred_structure: 'condor',
    });
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    for (const label of INFERRED_STRUCTURE_LABELS) {
      expect(out[`inferred_structure_${label}`]).toBeUndefined();
    }
  });
});

describe('multileg classification features (silentboom)', () => {
  const MULTILEG_FEATURE_COLS = [
    'is_isolated_leg',
    'match_confidence',
    'inferred_structure_isolated_leg',
    'inferred_structure_vertical',
    'inferred_structure_strangle',
    'inferred_structure_risk_reversal',
    'inferred_structure_butterfly',
  ];

  it('populates the same fields end-to-end on silent-boom rows', () => {
    const bundle = makeBundle('silentboom', MULTILEG_FEATURE_COLS);
    const row = silentBoomRow({
      is_isolated_leg: true,
      match_confidence: 0.91,
      inferred_structure: 'butterfly',
    });
    const out = featuresForSilentBoom(bundle, row, EMPTY_CTX);
    expect(out.is_isolated_leg).toBe(1);
    expect(out.match_confidence).toBeCloseTo(0.91);
    expect(out.inferred_structure_butterfly).toBe(1);
  });

  it('handles null multileg fields on silent-boom (matches unclassified rows)', () => {
    const bundle = makeBundle('silentboom', MULTILEG_FEATURE_COLS);
    const out = featuresForSilentBoom(bundle, silentBoomRow(), EMPTY_CTX);
    expect(out.is_isolated_leg).toBeNull();
    expect(out.match_confidence).toBeNull();
    for (const label of INFERRED_STRUCTURE_LABELS) {
      expect(out[`inferred_structure_${label}`]).toBeUndefined();
    }
  });
});

describe('INFERRED_STRUCTURE_LABELS stability', () => {
  it('exposes the v1 label set in a frozen order (regression guard)', () => {
    // The trainer reads this exact list to pin `feature_cols` for each
    // retrain. Changing the order or adding/removing a label here is a
    // model-breaking change — bump the bundle version + audit the
    // upstream classifier + manually verify pinned columns.
    expect([...INFERRED_STRUCTURE_LABELS]).toEqual([
      'isolated_leg',
      'vertical',
      'strangle',
      'risk_reversal',
      'butterfly',
    ]);
  });
});

/* ───────────────────────── Session-phase categorical (meta-detectors Phase 3) ── */

describe('sessionPhaseCatFromMinuteCt', () => {
  it('partitions the trading day into 7 LEFT-inclusive phases', () => {
    expect(sessionPhaseCatFromMinuteCt(7 * 60)).toBe('pre_open'); // 07:00
    expect(sessionPhaseCatFromMinuteCt(8 * 60 + 29)).toBe('pre_open'); // 08:29
    expect(sessionPhaseCatFromMinuteCt(8 * 60 + 30)).toBe('open'); // 08:30 boundary
    expect(sessionPhaseCatFromMinuteCt(8 * 60 + 59)).toBe('open'); // 08:59
    expect(sessionPhaseCatFromMinuteCt(9 * 60)).toBe('opening_30'); // 09:00 boundary
    expect(sessionPhaseCatFromMinuteCt(9 * 60 + 29)).toBe('opening_30'); // 09:29
    expect(sessionPhaseCatFromMinuteCt(9 * 60 + 30)).toBe('morning'); // 09:30 boundary
    expect(sessionPhaseCatFromMinuteCt(10 * 60 + 59)).toBe('morning'); // 10:59
    expect(sessionPhaseCatFromMinuteCt(11 * 60)).toBe('lunch'); // 11:00 boundary
    expect(sessionPhaseCatFromMinuteCt(12 * 60 + 59)).toBe('lunch'); // 12:59
    expect(sessionPhaseCatFromMinuteCt(13 * 60)).toBe('afternoon'); // 13:00 boundary
    expect(sessionPhaseCatFromMinuteCt(13 * 60 + 59)).toBe('afternoon'); // 13:59
    expect(sessionPhaseCatFromMinuteCt(14 * 60)).toBe('closing'); // 14:00 boundary
    expect(sessionPhaseCatFromMinuteCt(15 * 60)).toBe('closing'); // 15:00 still closing
  });
});

describe('deriveSessionPhase', () => {
  it('maps 08:35 CT to "open" (cash-open overlap)', () => {
    // 08:35 CT = 13:35 UTC during CDT (summer); use a date safely inside CDT.
    const utc = new Date('2026-05-15T13:35:00Z');
    expect(deriveSessionPhase(utc)).toBe('open');
  });

  it('maps 09:32 CT to "morning" (just past opening_30 boundary)', () => {
    const utc = new Date('2026-05-15T14:32:00Z');
    expect(deriveSessionPhase(utc)).toBe('morning');
  });

  it('maps 14:55 CT to "closing"', () => {
    const utc = new Date('2026-05-15T19:55:00Z');
    expect(deriveSessionPhase(utc)).toBe('closing');
  });

  it('treats 08:30:00 CT exactly as "open" (LEFT-inclusive)', () => {
    const utc = new Date('2026-05-15T13:30:00Z');
    expect(deriveSessionPhase(utc)).toBe('open');
  });

  it('treats 09:00:00 CT exactly as "opening_30" (LEFT-inclusive)', () => {
    const utc = new Date('2026-05-15T14:00:00Z');
    expect(deriveSessionPhase(utc)).toBe('opening_30');
  });

  it('returns "morning" as fallback for invalid Date', () => {
    expect(deriveSessionPhase(new Date(Number.NaN))).toBe('morning');
  });
});

describe('SESSION_PHASES stability', () => {
  it('pins the 7-phase label set in a frozen order (regression guard)', () => {
    // The trainer pins one-hot columns by exact name
    // (`session_phase_cat_<phase>`). Reorder / add / remove = model-break.
    expect([...SESSION_PHASES]).toEqual([
      'pre_open',
      'open',
      'opening_30',
      'morning',
      'lunch',
      'afternoon',
      'closing',
    ]);
  });

  it('has length 7', () => {
    expect(SESSION_PHASES).toHaveLength(7);
  });
});

describe('session_phase_cat one-hot (lottery + silentboom)', () => {
  // 08:35 CT = 13:35 UTC during CDT → phase `open`.
  const OPEN_UTC = new Date('2026-05-15T13:35:00Z');
  // 14:55 CT = 19:55 UTC during CDT → phase `closing`.
  const CLOSING_UTC = new Date('2026-05-15T19:55:00Z');

  const SESSION_PHASE_COLS = [
    'session_phase_cat_pre_open',
    'session_phase_cat_open',
    'session_phase_cat_opening_30',
    'session_phase_cat_morning',
    'session_phase_cat_lunch',
    'session_phase_cat_afternoon',
    'session_phase_cat_closing',
  ];

  it('emits session_phase_cat_open=1 at 08:35 CT for lottery (others unset)', () => {
    const bundle = makeBundle(
      'lottery',
      SESSION_PHASE_COLS,
      ['SPY'],
      ['session_phase_cat'],
    );
    const out = featuresForLottery(
      bundle,
      lotteryRow({ fire_time: OPEN_UTC }),
      EMPTY_CTX,
    );
    expect(out.session_phase_cat_open).toBe(1);
    // Sibling buckets stay unset (treated as 0 at inference time).
    expect(out.session_phase_cat_pre_open).toBeUndefined();
    expect(out.session_phase_cat_opening_30).toBeUndefined();
    expect(out.session_phase_cat_morning).toBeUndefined();
    expect(out.session_phase_cat_lunch).toBeUndefined();
    expect(out.session_phase_cat_afternoon).toBeUndefined();
    expect(out.session_phase_cat_closing).toBeUndefined();
  });

  it('emits session_phase_cat_closing=1 at 14:55 CT for silent-boom', () => {
    const bundle = makeBundle(
      'silentboom',
      SESSION_PHASE_COLS,
      ['SPY'],
      ['session_phase_cat'],
    );
    const out = featuresForSilentBoom(
      bundle,
      silentBoomRow({ fire_time: CLOSING_UTC }),
      EMPTY_CTX,
    );
    expect(out.session_phase_cat_closing).toBe(1);
    expect(out.session_phase_cat_open).toBeUndefined();
    expect(out.session_phase_cat_morning).toBeUndefined();
  });

  it('emits no session_phase_cat one-hot when bundle does not pin them (forward-compat)', () => {
    // A bundle trained BEFORE Phase 3 has no `session_phase_cat_*` columns.
    // The feature should compute silently with no output keys.
    const bundle = makeBundle('lottery', ['dte'], ['SPY'], []);
    const out = featuresForLottery(
      bundle,
      lotteryRow({ fire_time: OPEN_UTC }),
      EMPTY_CTX,
    );
    for (const col of SESSION_PHASE_COLS) {
      expect(out[col]).toBeUndefined();
    }
  });
});

/* ───────────────────────── Forced-flow integration (meta-detectors Phase 5) ── */

describe('forced-flow features (lottery integration)', () => {
  const FORCED_FLOW_COLS = [
    'bilateral_flow_score',
    'cross_name_cluster_score',
    'calendar_adjacency_flag',
    'cross_asset_stress_flag',
  ];

  it('lottery output always carries the 4 forced-flow keys as numbers (default macro)', () => {
    const bundle = makeBundle('lottery', FORCED_FLOW_COLS);
    const out = featuresForLottery(bundle, lotteryRow(), EMPTY_CTX);
    for (const col of FORCED_FLOW_COLS) {
      expect(typeof out[col]).toBe('number');
    }
    // Defaults: stubs return 0, no calendar/VIX trigger by default.
    expect(out.bilateral_flow_score).toBe(0);
    expect(out.cross_name_cluster_score).toBe(0);
    expect(out.calendar_adjacency_flag).toBe(0);
    expect(out.cross_asset_stress_flag).toBe(0);
  });

  it('lottery cross_asset_stress_flag flips when VIX intraday change > +3', () => {
    const bundle = makeBundle('lottery', FORCED_FLOW_COLS);
    const macro: ForcedFlowMacroContext = { vixIntradayChange: 4.5 };
    const out = featuresForLottery(bundle, lotteryRow(), EMPTY_CTX, macro);
    expect(out.cross_asset_stress_flag).toBe(1);
    // Other features still 0 (stubs / no calendar trigger).
    expect(out.calendar_adjacency_flag).toBe(0);
    expect(out.bilateral_flow_score).toBe(0);
    expect(out.cross_name_cluster_score).toBe(0);
  });

  it('lottery calendar_adjacency_flag fires on quarter-end last hour CT', () => {
    const bundle = makeBundle('lottery', FORCED_FLOW_COLS);
    // 2026-03-31 14:30 CT (CDT) = 19:30 UTC. Last weekday of Q1, in window.
    const row = lotteryRow({ fire_time: new Date('2026-03-31T19:30:00Z') });
    const out = featuresForLottery(bundle, row, EMPTY_CTX);
    expect(out.calendar_adjacency_flag).toBe(1);
  });
});

describe('forced-flow features (silentboom integration)', () => {
  const FORCED_FLOW_COLS = [
    'bilateral_flow_score',
    'cross_name_cluster_score',
    'calendar_adjacency_flag',
    'cross_asset_stress_flag',
  ];

  it('silent-boom output always carries the 4 forced-flow keys', () => {
    const bundle = makeBundle('silentboom', FORCED_FLOW_COLS);
    const out = featuresForSilentBoom(bundle, silentBoomRow(), EMPTY_CTX);
    expect(out.bilateral_flow_score).toBe(0);
    expect(out.cross_name_cluster_score).toBe(0);
    expect(out.calendar_adjacency_flag).toBe(0);
    expect(out.cross_asset_stress_flag).toBe(0);
  });

  it('silent-boom respects macro arg for cross_asset_stress_flag', () => {
    const bundle = makeBundle('silentboom', FORCED_FLOW_COLS);
    const out = featuresForSilentBoom(bundle, silentBoomRow(), EMPTY_CTX, {
      vixIntradayChange: 10,
    });
    expect(out.cross_asset_stress_flag).toBe(1);
  });

  it('silent-boom fires calendar_adjacency_flag on quarter-end last hour CT', () => {
    const bundle = makeBundle('silentboom', FORCED_FLOW_COLS);
    const row = silentBoomRow({
      // 2026-09-30 14:30 CT (CDT) = 19:30 UTC. Last weekday of Q3.
      fire_time: new Date('2026-09-30T19:30:00Z'),
    });
    const out = featuresForSilentBoom(bundle, row, EMPTY_CTX);
    expect(out.calendar_adjacency_flag).toBe(1);
  });
});
