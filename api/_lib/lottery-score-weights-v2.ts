/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate via: ml/.venv/bin/python scripts/sync_lottery_score_weights_v2.py
 *
 * Phase 2 output of the lottery rescore project.
 * Spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md
 * Source JSON: ml/output/lottery_score_weights.json
 *
 * Model version : rescore-v1-2026-05-22
 * Trained at    : 2026-05-29T01:13:56.995971+00:00
 *
 * Phase 3 will wire computeLotteryScoreV2() into detect-lottery-fires.ts.
 * Until then the old lottery-score-weights.ts continues to drive production.
 */

// ---------------------------------------------------------------------------
// Ticker weights
// ---------------------------------------------------------------------------

export const LOTTERY_TICKER_WEIGHTS_V2: Readonly<Record<string, number>> = {
  AAOI: 2,
  AAPL: 0,
  AMD: 0,
  AMZN: 0,
  APLD: 0,
  APP: -1,
  ARM: 0,
  ASTS: 0,
  AVGO: 0,
  BA: 2,
  BABA: 0,
  BE: -1,
  CAR: 0,
  COIN: 0,
  CRCL: 0,
  CRWD: 0,
  CRWV: 0,
  CSCO: 0,
  CVNA: 0,
  DELL: 0,
  GME: 0,
  GOOG: 1,
  GOOGL: 0,
  HIMS: 0,
  HOOD: 0,
  IBIT: 0,
  IBM: 0,
  INTC: 0,
  IONQ: 0,
  IREN: 0,
  IWM: 0,
  LITE: 0,
  LLY: 0,
  META: 0,
  MRVL: 0,
  MSFT: 0,
  MSTR: 0,
  MU: 0,
  NBIS: 1,
  NFLX: 0,
  NOW: 0,
  NVDA: 0,
  NVTS: 0,
  OKLO: 0,
  ORCL: 0,
  PLTR: 0,
  POET: 0,
  QCOM: 1,
  QQQ: 0,
  RBLX: -1,
  RDDT: 1,
  RGTI: -1,
  RIOT: 0,
  RIVN: 0,
  RKLB: 3,
  RUTW: 0,
  SHOP: 0,
  SLV: -1,
  SMCI: 1,
  SMH: 0,
  SNDK: 1,
  SNOW: 0,
  SOFI: -1,
  SOUN: 5,
  SOXL: 0,
  SOXS: -1,
  SPXW: 0,
  SPY: 0,
  SQQQ: 0,
  STX: 1,
  TEAM: 0,
  TLT: 0,
  TNA: -1,
  TQQQ: 0,
  TSLA: 0,
  TSLL: 1,
  TSM: 1,
  UBER: 0,
  UNH: 1,
  USAR: -1,
  USO: -1,
  WDC: -1,
  WMT: 0,
  WULF: -1,
  XOM: 0,
};

// ---------------------------------------------------------------------------
// Time-of-day weights
// ---------------------------------------------------------------------------

export const TOD_WEIGHTS_V2: Readonly<
  Record<'AM_open' | 'MID' | 'LUNCH' | 'PM', number>
> = {
  AM_open: 4,
  MID: 0,
  LUNCH: -4,
  PM: -4,
};

// ---------------------------------------------------------------------------
// TOD DOW overrides  (per-day-of-week override tables; only Monday for now)
//
// 90-day lineage finding (2026-05-22): Monday TOD outcome pattern is fully
// inverted vs Tue-Fri — LUNCH is the only positive Monday slot, AM_open is
// the worst. The global weights (AM_open=+4, LUNCH=-4) work backwards on
// Mondays. This map corrects that without touching the global table.
//
// Schema: { [dayName: string]: Record<TimeOfDay, number> }
// dayName matches `new Date(...).toLocaleDateString('en-US', {weekday:'long'})`
// ---------------------------------------------------------------------------

type TimeOfDay = 'AM_open' | 'MID' | 'LUNCH' | 'PM';

export const TOD_WEIGHTS_DOW_OVERRIDES_V2: Readonly<
  Record<string, Readonly<Record<TimeOfDay, number>>>
> = {
  Monday: {
    AM_open: -1,
    MID: -3,
    LUNCH: 5,
    PM: 2,
  },
};

// ---------------------------------------------------------------------------
// DTE weights  (keys are string-encoded integers to survive JSON round-trips)
// ---------------------------------------------------------------------------

export const DTE_WEIGHTS_V2: Readonly<Record<string, number>> = {
  '0': -2,
  '1': 4,
  '2': 0,
  '3': 1,
};

// ---------------------------------------------------------------------------
// Vol/OI quintile weights + boundaries
// ---------------------------------------------------------------------------

/** Per-quintile score uplift for vol_to_oi_window (length 5, index = quintile 0-4). */
export const VOL_OI_QUINTILE_WEIGHTS: ReadonlyArray<number> = [1, 0, 2, 0, -3];

/**
 * Boundaries that define the vol/OI quintiles (length 4).
 * Quintile 0 : value < boundaries[0]
 * Quintile k : boundaries[k-1] <= value < boundaries[k]
 * Quintile 4 : value >= boundaries[3]
 */
export const VOL_OI_QUINTILE_BOUNDARIES: ReadonlyArray<number> = [
  0.05996843766438716, 0.09682150774205377, 0.1565040650406504,
  0.38517179023508136,
];

// ---------------------------------------------------------------------------
// Gamma-at-trigger quintile weights + boundaries
// ---------------------------------------------------------------------------

export const GAMMA_QUINTILE_WEIGHTS: ReadonlyArray<number> = [
  3, -2, -2, -2, -1,
];
export const GAMMA_QUINTILE_BOUNDARIES: ReadonlyArray<number> = [
  0.012314985530921642, 0.02554117154869061, 0.042568723904775466,
  0.06920657150330813,
];

// ---------------------------------------------------------------------------
// Ask-pct quintile weights + boundaries
// ---------------------------------------------------------------------------

export const ASK_PCT_QUINTILE_WEIGHTS: ReadonlyArray<number> = [
  -1, 1, 1, 2, -4,
];
export const ASK_PCT_QUINTILE_BOUNDARIES: ReadonlyArray<number> = [
  0.5333333333333333, 0.5714285714285714, 0.625, 0.75,
];

// ---------------------------------------------------------------------------
// Option type weights
// ---------------------------------------------------------------------------

export const OPT_TYPE_WEIGHTS_V2: Readonly<Record<'C' | 'P', number>> = {
  C: 2,
  P: -2,
};

// ---------------------------------------------------------------------------
// Composite bonuses / penalties  (Phase B — 2026-05-22 mining report)
//
// Each entry fires when ALL keys in `match` agree with a fire's feature
// values. Missing keys are wildcards. Quintile fields use string keys
// ("0".."4"). Multiple entries can match the same fire; their bonuses sum.
//
// Positive bonus  → winning composite (add to score).
// Negative bonus  → losing composite / penalty (subtract from score).
//
// Schema mirrors ml/output/lottery_score_weights.json composite_bonuses[].
// ---------------------------------------------------------------------------

export interface CompositeBonus {
  match: Readonly<
    Partial<{
      ticker: string;
      tod: TimeOfDay;
      gamma_q: string;
      vol_oi_q: string;
      ask_pct_q: string;
    }>
  >;
  bonus: number;
  support: number;
  winRate: number;
  note: string;
}

export const COMPOSITE_BONUSES_V2: ReadonlyArray<CompositeBonus> = [
  {
    match: { ticker: 'SNDK', tod: 'AM_open', gamma_q: '0' },
    bonus: 3,
    support: 278,
    winRate: 0.953,
    note: '265/278 winners (2026-05-22 mining report); strongest-support winning composite',
  },
  {
    match: { ticker: 'RKLB', tod: 'AM_open', gamma_q: '1' },
    bonus: 3,
    support: 21,
    winRate: 0.952,
    note: '20/21 winners (2026-05-22 mining report)',
  },
  {
    match: { ticker: 'TQQQ', tod: 'AM_open', gamma_q: '4' },
    bonus: 3,
    support: 43,
    winRate: 0.953,
    note: '41/43 winners (2026-05-22 mining report)',
  },
  {
    match: { ticker: 'WDC', ask_pct_q: '0' },
    bonus: -5,
    support: 12,
    winRate: 0.0,
    note: '12/12 losers (2026-05-22 mining report); -5 penalty',
  },
  {
    match: { ticker: 'SHOP', gamma_q: '4' },
    bonus: -4,
    support: 17,
    winRate: 0.0,
    note: '16/17 losers (2026-05-22 mining report); -4 penalty',
  },
  {
    match: { ticker: 'RGTI', tod: 'LUNCH', vol_oi_q: '4' },
    bonus: -3,
    support: 31,
    winRate: 0.0,
    note: '27/31 losers (2026-05-22 mining report); -3 penalty; largest-n losing composite',
  },
  {
    match: { ticker: 'POET', vol_oi_q: '4' },
    bonus: -3,
    support: 13,
    winRate: 0.0,
    note: '12/13 losers (2026-05-22 mining report); -3 penalty',
  },
];

// ---------------------------------------------------------------------------
// Tier cutoffs
// ---------------------------------------------------------------------------

export const LOTTERY_TIER_THRESHOLDS_V2 = {
  t1: 9,
  t2: 7,
} as const;

// ---------------------------------------------------------------------------
// Helper: assign a value to quintile 0-4 using a 4-element boundary array
// ---------------------------------------------------------------------------

/**
 * Map a continuous `value` to a quintile index (0–4) using `boundaries`.
 *
 * Assignment rules (mirrors the Python training logic):
 *   - value < boundaries[0]  → quintile 0
 *   - value < boundaries[1]  → quintile 1
 *   - value < boundaries[2]  → quintile 2
 *   - value < boundaries[3]  → quintile 3
 *   - value >= boundaries[3] → quintile 4
 *
 * @param value      The raw feature value (e.g. vol_to_oi_window).
 * @param boundaries Four-element sorted array of bucket thresholds.
 * @returns          Integer in [0, 4].
 */
export function assignQuintile(
  value: number,
  boundaries: ReadonlyArray<number>,
): number {
  for (let i = 0; i < boundaries.length; i++) {
    const bound = boundaries[i];
    if (bound !== undefined && value < bound) return i;
  }
  return 4;
}

// ---------------------------------------------------------------------------
// Main score function
// ---------------------------------------------------------------------------

/**
 * Compute the v2 lottery score for a single fire alert.
 *
 * Returns `null` when:
 *   - `args.isAligned` is false (hard gate per spec decision 6)
 *   - `args.dte` is not in {0, 1, 2, 3} (out of scoring universe)
 *
 * Otherwise returns an integer sum of per-feature weights:
 *   ticker + tod + dte + vol_oi_quintile + gamma_quintile +
 *   ask_pct_quintile + option_type + composite
 *
 * Null-safe features (volOiWindow, gammaAtTrigger, triggerAskPct) contribute
 * 0 when the value is unavailable rather than invalidating the whole score.
 *
 * `dayOfWeek` (optional): full day name matching
 * `toLocaleDateString('en-US', {weekday:'long'})` (e.g. "Monday"). When
 * provided and a matching entry exists in TOD_WEIGHTS_DOW_OVERRIDES_V2, the
 * override table is used for the tod component; otherwise falls back to the
 * global TOD_WEIGHTS_V2. Currently only "Monday" has an override.
 *
 * Composite bonuses from COMPOSITE_BONUSES_V2 are applied last: every entry
 * whose `match` keys all agree with the fire's features contributes its
 * `bonus` (positive = winning pattern, negative = losing pattern). Multiple
 * matches sum.
 */
export function computeLotteryScoreV2(args: {
  ticker: string;
  tod: 'AM_open' | 'MID' | 'LUNCH' | 'PM';
  /** Days-to-expiry; only 0, 1, 2, 3 are in the scoring universe. */
  dte: number;
  /** vol_to_oi_window at trigger time; null when not populated. */
  volOiWindow: number | null;
  /** gamma_at_trigger; null when not populated. */
  gammaAtTrigger: number | null;
  /** trigger_ask_pct; null when not populated. */
  triggerAskPct: number | null;
  optionType: 'C' | 'P';
  /**
   * True when the alert direction aligns with net flow:
   * call + cum_ncp > cum_npp, OR put + cum_npp > cum_ncp.
   */
  isAligned: boolean;
  /**
   * Full day name (e.g. "Monday"). When provided and an override exists in
   * TOD_WEIGHTS_DOW_OVERRIDES_V2, that table replaces the global TOD weights
   * for this fire's tod component.
   */
  dayOfWeek?: string;
}): number | null {
  if (!args.isAligned) return null;

  const dteKey = String(args.dte);
  if (!(dteKey in DTE_WEIGHTS_V2)) return null;

  // Resolve TOD weights: use DOW override when present, else global.
  const todWeights: Readonly<Record<TimeOfDay, number>> =
    args.dayOfWeek !== undefined &&
    args.dayOfWeek in TOD_WEIGHTS_DOW_OVERRIDES_V2
      ? TOD_WEIGHTS_DOW_OVERRIDES_V2[args.dayOfWeek]!
      : TOD_WEIGHTS_V2;

  let score = 0;

  score += LOTTERY_TICKER_WEIGHTS_V2[args.ticker] ?? 0;
  score += todWeights[args.tod];
  score += DTE_WEIGHTS_V2[dteKey] ?? 0;

  let volOiQ: number | null = null;
  if (args.volOiWindow !== null) {
    volOiQ = assignQuintile(args.volOiWindow, VOL_OI_QUINTILE_BOUNDARIES);
    score += VOL_OI_QUINTILE_WEIGHTS[volOiQ] ?? 0;
  }

  let gammaQ: number | null = null;
  if (args.gammaAtTrigger !== null) {
    gammaQ = assignQuintile(args.gammaAtTrigger, GAMMA_QUINTILE_BOUNDARIES);
    score += GAMMA_QUINTILE_WEIGHTS[gammaQ] ?? 0;
  }

  let askPctQ: number | null = null;
  if (args.triggerAskPct !== null) {
    askPctQ = assignQuintile(args.triggerAskPct, ASK_PCT_QUINTILE_BOUNDARIES);
    score += ASK_PCT_QUINTILE_WEIGHTS[askPctQ] ?? 0;
  }

  score += OPT_TYPE_WEIGHTS_V2[args.optionType];

  // Composite bonuses/penalties — iterate every entry and sum matching ones.
  // Guard on length so SonarJS doesn't flag an always-empty-collection loop
  // when the model has no composite entries (as is the case pre-Phase-B).
  if (COMPOSITE_BONUSES_V2.length > 0) {
    for (const entry of COMPOSITE_BONUSES_V2) {
      const m = entry.match;
      if (m.ticker !== undefined && m.ticker !== args.ticker) continue;
      if (m.tod !== undefined && m.tod !== args.tod) continue;
      if (m.gamma_q !== undefined) {
        const label = gammaQ === null ? 'null' : String(gammaQ);
        if (m.gamma_q !== label) continue;
      }
      if (m.vol_oi_q !== undefined) {
        const label = volOiQ === null ? 'null' : String(volOiQ);
        if (m.vol_oi_q !== label) continue;
      }
      if (m.ask_pct_q !== undefined) {
        const label = askPctQ === null ? 'null' : String(askPctQ);
        if (m.ask_pct_q !== label) continue;
      }
      score += entry.bonus;
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Tier label
// ---------------------------------------------------------------------------

/** Map a v2 score to its display tier. null score → 'tier3'. */
export function lotteryScoreTierV2(
  score: number | null,
): 'tier1' | 'tier2' | 'tier3' {
  if (score === null) return 'tier3';
  if (score >= LOTTERY_TIER_THRESHOLDS_V2.t1) return 'tier1';
  if (score >= LOTTERY_TIER_THRESHOLDS_V2.t2) return 'tier2';
  return 'tier3';
}
