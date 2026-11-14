/**
 * FROZEN. This is lottery score version `seed-2026-06-17`: never edit it.
 *
 * These are the weights `scoreLotteryV2` used live from 2026-06-17 until the
 * weights store (phase 4, decision D5) replaced the generated constants file.
 * They are that file's values verbatim: model `rescore-v1-2026-05-22`, trained
 * on the 90 days through 2026-06-16.
 *
 * The store's first migration inserts this object as the `seed-2026-06-17` row
 * of `lottery_score_versions` and points both the `active` and `takeit`
 * pointers at it. A fire scored before the store existed has a NULL
 * `score_version` and was scored with these weights. Editing the values here
 * would change what that version id means for every stored score, so a new set
 * of weights is a new version in the store, never an edit of this file.
 * `api/__tests__/fixtures/lottery-score-parity.json` pins the seed: it holds
 * a copy of these weights and the score each of 70 synthetic fires gets from
 * them. The Python scorer is meant to replay the same file (phase 4, Task 12).
 *
 * Spec: docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md (D5)
 * Origin: docs/superpowers/specs/lottery-rescore-2026-05-22.md
 */

import type { LotteryWeights } from './lottery-weights-schema.js';

export const SEED_LOTTERY_WEIGHTS_VERSION = 'seed-2026-06-17';

export const SEED_LOTTERY_WEIGHTS: LotteryWeights = {
  schema_version: 1,
  model_version: 'rescore-v1-2026-05-22',
  trained_through: '2026-06-16',
  features: {
    // Ticker weights: per-ticker uplift from the training outcomes. A ticker
    // that is not listed scores 0.
    ticker_weights: {
      AAOI: 1,
      AAPL: -1,
      AMD: 0,
      AMZN: 1,
      APLD: 5,
      APP: -1,
      ARM: 4,
      ASTS: 2,
      AVGO: 0,
      BA: 0,
      BABA: 0,
      BE: 0,
      CAR: 0,
      COIN: -1,
      CRCL: -1,
      CRWD: -1,
      CRWV: 0,
      CSCO: 0,
      CVNA: 0,
      DELL: -1,
      GME: -1,
      GOOG: 0,
      GOOGL: 0,
      HIMS: 0,
      HOOD: 0,
      IBIT: -1,
      IBM: 0,
      INTC: 0,
      IONQ: -1,
      IREN: -1,
      IWM: -1,
      LITE: -1,
      LLY: 0,
      META: 0,
      MRVL: -1,
      MSFT: 0,
      MSTR: -1,
      MU: 0,
      NBIS: 0,
      NFLX: 0,
      NOW: 0,
      NVDA: 0,
      NVTS: 0,
      OKLO: 0,
      ORCL: -1,
      PLTR: 0,
      POET: 0,
      QCOM: 0,
      QQQ: 4,
      RBLX: -1,
      RDDT: 0,
      RGTI: -1,
      RIOT: -1,
      RIVN: 0,
      RKLB: 1,
      RUTW: -1,
      SHOP: 0,
      SLV: -1,
      SMCI: 0,
      SMH: 0,
      SNDK: 0,
      SNOW: 0,
      SOFI: -1,
      SOUN: 2,
      SOXL: -1,
      SOXS: -1,
      SPXW: -1,
      SPY: -1,
      SQQQ: -1,
      STX: 0,
      TEAM: -1,
      TLT: -1,
      TNA: -1,
      TQQQ: 0,
      TSLA: 0,
      TSLL: 0,
      TSM: 0,
      UBER: 0,
      UNH: 0,
      USAR: -1,
      USO: -1,
      WDC: -1,
      WMT: -1,
      WULF: -1,
      XOM: -1,
    },

    // Time-of-day weights.
    tod_weights: {
      AM_open: 4,
      MID: -1,
      LUNCH: -3,
      PM: -4,
    },

    // Per-weekday tod overrides. 90-day lineage finding (2026-05-22): the
    // Monday tod pattern is fully inverted against Tuesday-Friday (LUNCH is the
    // only positive Monday slot, AM_open the worst), so the global weights work
    // backwards on a Monday. A weekday with no entry uses `tod_weights`.
    tod_weights_dow_overrides: {
      Monday: {
        AM_open: 2,
        MID: -3,
        LUNCH: 5,
        PM: -1,
      },
    },

    // DTE weights. Only DTE 0-3 is in the scoring universe; any other DTE
    // scores null.
    dte_weights: {
      '0': 2,
      '1': 1,
      '2': -4,
      '3': -3,
    },

    // Vol/OI, gamma-at-trigger and ask-pct quintile weights and boundaries.
    // Boundaries are right-closed to match pandas pd.cut(..., right=True) in
    // training: quintile 0 is value <= boundaries[0], quintile k is
    // boundaries[k-1] < value <= boundaries[k], quintile 4 is value >
    // boundaries[3].
    vol_oi_quintile_weights: [-2, -2, 3, -1, 2],
    vol_oi_quintile_boundaries: [
      0.059556888503979236, 0.09506410648464654, 0.15217391304347827,
      0.3671595674244098,
    ],
    gamma_quintile_weights: [-1, 1, 4, 3, 1],
    gamma_quintile_boundaries: [
      0.01193201873015873, 0.024764634982693098, 0.04067617937929281,
      0.06795747010463163,
    ],
    ask_pct_quintile_weights: [4, -1, 0, -1, -2],
    ask_pct_quintile_boundaries: [
      0.5333333333333333, 0.5714285714285714, 0.625, 0.75,
    ],

    option_type_weights: {
      C: -2,
      P: 2,
    },

    // Composite bonuses and penalties (2026-05-22 mining report). An entry
    // fires when every key in `match` agrees with the fire; a missing key is a
    // wildcard. Quintile labels are "0".."4", or "null" for a missing feature.
    // Entries that fire sum. A positive bonus is a winning pattern, a negative
    // one a losing pattern.
    composite_bonuses: [
      {
        match: {
          ticker: 'SNDK',
          tod: 'AM_open',
          gamma_q: '0',
        },
        bonus: 3,
        support: 278,
        win_rate: 0.953,
        note: '265/278 winners (2026-05-22 mining report); strongest-support winning composite',
      },
      {
        match: {
          ticker: 'RKLB',
          tod: 'AM_open',
          gamma_q: '1',
        },
        bonus: 3,
        support: 21,
        win_rate: 0.952,
        note: '20/21 winners (2026-05-22 mining report)',
      },
      {
        match: {
          ticker: 'TQQQ',
          tod: 'AM_open',
          gamma_q: '4',
        },
        bonus: 3,
        support: 43,
        win_rate: 0.953,
        note: '41/43 winners (2026-05-22 mining report)',
      },
      {
        match: {
          ticker: 'WDC',
          ask_pct_q: '0',
        },
        bonus: -5,
        support: 12,
        win_rate: 0,
        note: '12/12 losers (2026-05-22 mining report); -5 penalty',
      },
      {
        match: {
          ticker: 'SHOP',
          gamma_q: '4',
        },
        bonus: -4,
        support: 17,
        win_rate: 0,
        note: '16/17 losers (2026-05-22 mining report); -4 penalty',
      },
      {
        match: {
          ticker: 'RGTI',
          tod: 'LUNCH',
          vol_oi_q: '4',
        },
        bonus: -3,
        support: 31,
        win_rate: 0,
        note: '27/31 losers (2026-05-22 mining report); -3 penalty; largest-n losing composite',
      },
      {
        match: {
          ticker: 'POET',
          vol_oi_q: '4',
        },
        bonus: -3,
        support: 13,
        win_rate: 0,
        note: '12/13 losers (2026-05-22 mining report); -3 penalty',
      },
    ],
  },

  // Cutoffs on the bare score: the cluster bonus counts a fire at t1 or above.
  cutoffs: {
    t1: 10,
    t2: 6,
  },

  // Cutoffs on the quality-adjusted score (bare score plus cluster bonus):
  // the feed's tier 1 and tier 2.
  feed_cutoffs: {
    tier1_min_score: 13,
    tier2_min_score: 10,
  },
};
