/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate via: ml/.venv/bin/python scripts/sync_lottery_score_weights_v2.py
 *
 * Phase 2 output of the lottery rescore project.
 * Spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md
 * Source JSON: ml/output/lottery_score_weights.json
 *
 * Model version : rescore-v1-2026-05-22
 * Trained at    : 2026-05-22T19:31:54.430243+00:00
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
  BE: 0,
  CAR: 0,
  COIN: 0,
  CRCL: 0,
  CRWD: 0,
  CRWV: 0,
  CSCO: 0,
  CVNA: -1,
  DELL: 1,
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
  IWM: -1,
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
  RGTI: 0,
  RIOT: -1,
  RIVN: 0,
  RKLB: 3,
  RUTW: -1,
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
  UBER: -1,
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
  0.05964214711729622, 0.09565217391304348, 0.1543981570905453,
  0.3783801646987372,
];

// ---------------------------------------------------------------------------
// Gamma-at-trigger quintile weights + boundaries
// ---------------------------------------------------------------------------

export const GAMMA_QUINTILE_WEIGHTS: ReadonlyArray<number> = [3, -2, -2, -2, 0];
export const GAMMA_QUINTILE_BOUNDARIES: ReadonlyArray<number> = [
  0.012324876801251189, 0.025442619069240443, 0.042202206604267926,
  0.06821011318181819,
];

// ---------------------------------------------------------------------------
// Ask-pct quintile weights + boundaries
// ---------------------------------------------------------------------------

export const ASK_PCT_QUINTILE_WEIGHTS: ReadonlyArray<number> = [
  -1, 1, 1, 2, -4,
];
export const ASK_PCT_QUINTILE_BOUNDARIES: ReadonlyArray<number> = [
  0.5333333333333333, 0.5714285714285714, 0.625, 0.746268656716418,
];

// ---------------------------------------------------------------------------
// Option type weights
// ---------------------------------------------------------------------------

export const OPT_TYPE_WEIGHTS_V2: Readonly<Record<'C' | 'P', number>> = {
  C: 2,
  P: -2,
};

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
 *   ask_pct_quintile + option_type
 *
 * Null-safe features (volOiWindow, gammaAtTrigger, triggerAskPct) contribute
 * 0 when the value is unavailable rather than invalidating the whole score.
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
}): number | null {
  if (!args.isAligned) return null;

  const dteKey = String(args.dte);
  if (!(dteKey in DTE_WEIGHTS_V2)) return null;

  let score = 0;

  score += LOTTERY_TICKER_WEIGHTS_V2[args.ticker] ?? 0;
  score += TOD_WEIGHTS_V2[args.tod];
  score += DTE_WEIGHTS_V2[dteKey] ?? 0;

  if (args.volOiWindow !== null) {
    const q = assignQuintile(args.volOiWindow, VOL_OI_QUINTILE_BOUNDARIES);
    score += VOL_OI_QUINTILE_WEIGHTS[q] ?? 0;
  }

  if (args.gammaAtTrigger !== null) {
    const q = assignQuintile(args.gammaAtTrigger, GAMMA_QUINTILE_BOUNDARIES);
    score += GAMMA_QUINTILE_WEIGHTS[q] ?? 0;
  }

  if (args.triggerAskPct !== null) {
    const q = assignQuintile(args.triggerAskPct, ASK_PCT_QUINTILE_BOUNDARIES);
    score += ASK_PCT_QUINTILE_WEIGHTS[q] ?? 0;
  }

  score += OPT_TYPE_WEIGHTS_V2[args.optionType];

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
