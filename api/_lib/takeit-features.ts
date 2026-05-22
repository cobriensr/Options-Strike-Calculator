/**
 * Take-It feature builder — produce the feature vector the TS scorer expects
 * from a fresh alert row + a pre-fetched sequential context.
 *
 * Mirrors `ml/src/takeit/build_training_set.py` (Phase 1) so the live-detect
 * features land in the same shape the model was trained on. Phase 3c spec
 * resolved decision #3: full model fidelity — every Phase 1 feature is
 * derived at detect time. Sequential features (burst-storm, cofire,
 * same-direction, prior-session win-rate) require recent-fire context that
 * the detect cron pre-fetches ONCE per run and passes in.
 *
 * Categorical encoding: the bundle pins the exact list of one-hot columns
 * that existed at training time (`bundle.feature_cols`). We only set
 * `{col}_{value}` features that the bundle declares — unknown categorical
 * values produce an all-zero one-hot block, which the model handles
 * gracefully via NaN-default routing.
 *
 * Float-precision contract: tree comparisons in TS apply Math.fround
 * (see takeit-score.ts), so feature values can stay as float64 here and the
 * scorer will quantize at comparison time.
 */

import { getCTDayOfWeek, getCTTime } from '../../src/utils/timezone.js';

import {
  type ForcedFlowMacroContext,
  computeForcedFlowFeatures,
} from './forced-flow.js';
import type { TakeitBundle } from './takeit-score.js';

export type { ForcedFlowMacroContext } from './forced-flow.js';

export type AlertType = 'lottery' | 'silentboom';

/**
 * Normalised lottery alert row using the exact snake_case column names the
 * Phase 1 parquet exposes. The detect cron must build one of these before
 * calling featuresForLottery().
 */
export interface LotteryAlertRow {
  fire_time: Date; // = trigger_time_ct, UTC
  date: Date; // session date (used by sequential features)
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: number;
  dte: number;
  trigger_vol_to_oi_window: number | null;
  trigger_vol_to_oi_cum: number | null;
  trigger_iv: number | null;
  trigger_delta: number | null;
  trigger_ask_pct: number | null;
  trigger_window_size: number | null;
  trigger_window_prints: number | null;
  entry_price: number | null;
  open_interest: number | null;
  spot_at_first: number | null;
  spot_at_trigger: number | null;
  alert_seq: number | null;
  minutes_since_prev_fire: number | null;
  flow_quad: string | null;
  tod: string | null;
  mode: string | null;
  reload_tagged: boolean | null;
  cheap_call_pm_tagged: boolean | null;
  burst_ratio_vs_prev: number | null;
  entry_drop_pct_vs_prev: number | null;
  mkt_tide_ncp: number | null;
  mkt_tide_npp: number | null;
  mkt_tide_diff: number | null;
  mkt_tide_otm_diff: number | null;
  spx_flow_diff: number | null;
  spy_etf_diff: number | null;
  qqq_etf_diff: number | null;
  zero_dte_diff: number | null;
  spx_spot_gamma_oi: number | null;
  spx_spot_gamma_vol: number | null;
  spx_spot_charm_oi: number | null;
  spx_spot_vanna_oi: number | null;
  gex_strike_call_minus_put: number | null;
  gex_strike_call_ask_minus_bid: number | null;
  gex_strike_put_ask_minus_bid: number | null;
  score: number | null;
  direction_gated: boolean | null;
  // Multileg classification (migration #160, populated by Phase 2 Round 3
  // detect-cron wire). Optional so that pre-Round-3 callers (and any
  // historical fixtures) still type-check; pre-migration rows + matcher
  // failures stay NULL. See encoding notes near INFERRED_STRUCTURE_LABELS
  // below.
  inferred_structure?: string | null;
  is_isolated_leg?: boolean | null;
  match_confidence?: number | null;
  pattern_group_id?: string | null;
}

/**
 * Normalised silent-boom alert row. Field names mirror the silent_boom_alerts
 * Postgres table + the Phase 1 silentboom_training.parquet column set.
 */
export interface SilentBoomAlertRow {
  fire_time: Date; // = bucket_ct, UTC
  date: Date;
  option_chain_id: string;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: number;
  dte: number;
  spike_volume: number | null;
  baseline_volume: number | null;
  spike_ratio: number | null;
  ask_pct: number | null;
  vol_oi: number | null;
  entry_price: number | null;
  open_interest: number | null;
  mkt_tide_diff: number | null;
  mkt_tide_otm_diff: number | null;
  zero_dte_diff: number | null;
  spx_spot_gamma_oi: number | null;
  multi_leg_share: number | null;
  underlying_price_at_spike: number | null;
  score: number | null;
  score_tier: string | null;
  direction_gated: boolean | null;
  // Multileg classification (migration #160, populated by Phase 2 Round 3
  // detect-cron wire). Optional so that pre-Round-3 callers (and any
  // historical fixtures) still type-check; pre-migration rows + matcher
  // failures stay NULL. See encoding notes near INFERRED_STRUCTURE_LABELS
  // below.
  inferred_structure?: string | null;
  is_isolated_leg?: boolean | null;
  match_confidence?: number | null;
  pattern_group_id?: string | null;
}

/**
 * Sequential feature context — populated by the detect cron with one query
 * each per run, then passed to every per-fire derivation call.
 */
export interface SequentialContext {
  /**
   * Recent fires of the SAME alert type within the look-back window.
   * Sorted by fire_time ascending. Used to compute burst-storm distinct
   * count and n_same_dir_fires_last_30min.
   */
  recentSameTypeFires: ReadonlyArray<{
    fire_time: Date;
    underlying_symbol: string;
    option_type: 'C' | 'P';
  }>;
  /**
   * Recent fires of the OTHER alert type with the SAME option_chain_id,
   * within the cofire window. Used for silent_boom_cofire_within_5min
   * (when building lottery features) or lottery_cofire_within_5min
   * (when building silent-boom features).
   */
  recentOtherTypeByChain: ReadonlyMap<
    string,
    ReadonlyArray<{ fire_time: Date }>
  >;
  /**
   * Recent fires of the OTHER alert type indexed by `${underlying}|${option_type}`.
   * Carries the source chain id so the diff-chain derivation can exclude
   * same-chain hits. Used for the sibling-chain cofire features
   * (silent_boom_cofire_diff_chain_within_5min / lottery_cofire_diff_chain_within_5min).
   */
  recentOtherTypeByTickerDir: ReadonlyMap<
    string,
    ReadonlyArray<{ fire_time: Date; option_chain_id: string }>
  >;
  /**
   * Per-ticker expanding mean of daily win rates using only fires from
   * strictly EARLIER dates (PIT-correct). NaN entries mean no prior history.
   */
  priorSessionWinRateByTicker: ReadonlyMap<string, number | null>;
}

/**
 * Build the composite key for `recentOtherTypeByTickerDir`. Keeps the
 * `${underlying}|${option_type}` convention in one place so call sites can
 * derive it from a row without typoing the separator.
 */
export function tickerDirKey(
  underlying: string,
  optionType: 'C' | 'P',
): string {
  return `${underlying}|${optionType}`;
}

/* ────────────────────────── Constants (must mirror Phase 1) ─────────────────────── */

const AGGRESSIVE_ASK_PCT_THRESHOLD = 0.85;
const BURST_STORM_WINDOW_MIN = 30;
const BURST_STORM_MIN_COFIRES = 5;
const COFIRE_WINDOW_MIN = 5;
const SAME_DIR_WINDOW_MIN = 30;

/**
 * Stable label set for the multileg `inferred_structure` categorical.
 *
 * Why a frozen module-level constant: the column is encoded as a one-hot block
 * by `expandOneHotCategoricals` (same mechanism as `mode`, `flow_quad`, `tod`,
 * `score_tier`). Stability across retrains is enforced two ways:
 *
 *   1. The bundle's `feature_cols` array pins the exact set of one-hot
 *      columns the trained model knows about (e.g. `inferred_structure_vertical`).
 *      Unknown / NULL values produce an all-zero block, which XGBoost handles
 *      via NaN-default routing — same NULL-handling story as every other
 *      categorical in this file.
 *   2. This constant documents the value set Phase 2 Round 3 will emit, so
 *      reviewers (and the trainer pre-flight) can sanity-check that a retrain
 *      with new data won't silently drop a value the bundle doesn't pin.
 *
 * Forward-compat: the v1 multileg matcher emits the 5-value spec set
 * (`vertical | strangle | risk_reversal | butterfly | isolated_leg`); the
 * Postgres column comment lists a richer set (`single_leg | calendar |
 * diagonal | condor | complex`) for v2 matchers. Both are safe — adding a new
 * value just means the next bundle's `feature_cols` includes the new
 * `inferred_structure_<value>` column. Existing bundles ignore it.
 *
 * NULL semantics: `is_isolated_leg = null` and `inferred_structure = null`
 * mean "not yet classified" (the matcher failed or pre-migration row), which
 * is genuinely missing — we surface as nullable feature values, NOT as
 * `false` / a default category.
 */
export const INFERRED_STRUCTURE_LABELS = [
  'isolated_leg',
  'vertical',
  'strangle',
  'risk_reversal',
  'butterfly',
] as const;
export type InferredStructureLabel = (typeof INFERRED_STRUCTURE_LABELS)[number];

/* ───────────────────────── CT timezone helpers ────────────────────────── */

/**
 * Convert a UTC Date to (minute_of_day_ct, day_of_week) matching Phase 1's
 * Python behaviour. Python's pandas `.dt.dayofweek` is Mon=0..Sun=6;
 * getCTDayOfWeek() in src/utils/timezone.ts is Sun=0..Sat=6. We translate
 * here so the model sees the same integer encoding it was trained on.
 */
export function ctMinuteAndDow(fireTime: Date): {
  minute_of_day_ct: number;
  day_of_week: number;
} {
  const { hour, minute } = getCTTime(fireTime);
  const jsDow = getCTDayOfWeek(fireTime); // Sun=0..Sat=6
  const pythonDow = (jsDow + 6) % 7; // → Mon=0..Sun=6
  return {
    minute_of_day_ct: hour * 60 + minute,
    day_of_week: pythonDow,
  };
}

/**
 * Map CT minute-of-day to the 5-phase intraday schedule the trader uses
 * (matches Phase 1 _session_phase_from_minute_ct).
 */
export function sessionPhaseFromMinuteCt(minuteOfDayCt: number): number {
  if (minuteOfDayCt < 8 * 60 + 30) return 0;
  if (minuteOfDayCt < 9 * 60) return 1;
  if (minuteOfDayCt < 10 * 60 + 30) return 2;
  if (minuteOfDayCt < 12 * 60) return 3;
  if (minuteOfDayCt < 14 * 60) return 4;
  if (minuteOfDayCt < 15 * 60) return 5;
  return 0;
}

/**
 * 7-phase categorical session label (meta-detectors Phase 3).
 *
 * Why this exists alongside the numeric `session_phase`:
 *   - The numeric `session_phase` (0-5) is already pinned in every trained
 *     bundle's `feature_cols` and uses 6 phases with DIFFERENT boundaries
 *     (8:30/9:00/10:30/12:00/14:00/15:00). It stays as-is — touching it
 *     would invalidate all existing bundles.
 *   - The new categorical `session_phase_cat` uses 7 phases aligned to the
 *     user's intraday trading schedule (see memory `user_trading_schedule`,
 *     5-phase intraday, trades 9:00-3:00 CT). The 7 boundaries are finer
 *     around the open (split 08:30-09:00 "cash-open overlap" from
 *     09:00-09:30 "gamma-rebalance") so the model can learn the
 *     informational asymmetry between e.g. a 9:32 print (institutional) and
 *     a 14:55 print (gamma-hedge mechanics).
 *   - Coexistence with lottery's existing `tod` feature: `tod` has 4
 *     coarse buckets (AM_open | MID | LUNCH | PM) and IS pinned in lottery
 *     bundles. We keep `tod` untouched and add `session_phase_cat` to both
 *     lottery and silent-boom (silent-boom never had a time-of-day
 *     categorical before today). The model can learn from either, both, or
 *     neither depending on what `feature_cols` pins at training time.
 *
 * BOUNDARY ORDER — DO NOT REARRANGE. The trainer pins one-hot columns by
 * exact name (`session_phase_cat_open`, `session_phase_cat_closing`, …) and
 * a reorder here would silently invalidate retrains. If SHAP shows the
 * feature concentrates importance in 1-2 phases, propose tightening the
 * cutpoints rather than reordering this array.
 *
 * BOUNDARY CONVENTION — LEFT-inclusive (08:30:00 belongs to `open`, not
 * `pre_open`). Identical to the existing `sessionPhaseFromMinuteCt`.
 *
 * FALLBACK — `morning` is the "no information" bucket if any timestamp
 * extraction fails. It's the widest informed-flow window and least likely
 * to mislead the model.
 */
export const SESSION_PHASES = [
  'pre_open',
  'open',
  'opening_30',
  'morning',
  'lunch',
  'afternoon',
  'closing',
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

/**
 * Map CT minute-of-day to the 7-phase categorical label.
 *
 * Phases (CT, all LEFT-inclusive):
 *   - pre_open    : < 08:30
 *   - open        : 08:30-09:00 (cash-open overlap)
 *   - opening_30  : 09:00-09:30 (opening 30 min, gamma rebalance)
 *   - morning     : 09:30-11:00 (informed-flow window)
 *   - lunch       : 11:00-13:00 (liquidity probes, weak signal)
 *   - afternoon   : 13:00-14:00 (trending window)
 *   - closing     : 14:00 onward (positioning into close)
 */
export function sessionPhaseCatFromMinuteCt(
  minuteOfDayCt: number,
): SessionPhase {
  if (minuteOfDayCt < 8 * 60 + 30) return 'pre_open';
  if (minuteOfDayCt < 9 * 60) return 'open';
  if (minuteOfDayCt < 9 * 60 + 30) return 'opening_30';
  if (minuteOfDayCt < 11 * 60) return 'morning';
  if (minuteOfDayCt < 13 * 60) return 'lunch';
  if (minuteOfDayCt < 14 * 60) return 'afternoon';
  return 'closing';
}

/**
 * Pure helper: map a UTC trigger time to a CT 7-phase categorical label.
 * No clock dependency — pass the timestamp in. Falls back to `morning` on
 * any extraction error (see SESSION_PHASES comment for rationale).
 */
export function deriveSessionPhase(triggerTimeCt: Date): SessionPhase {
  try {
    const { hour, minute } = getCTTime(triggerTimeCt);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'morning';
    return sessionPhaseCatFromMinuteCt(hour * 60 + minute);
  } catch {
    // Timezone parse failure → safest "no information" bucket.
    return 'morning';
  }
}

/* ───────────────────────── Per-row derivations ────────────────────────── */

/**
 * is_itm_at_fire: nullable Int8 (NaN when spot or strike missing).
 * For calls, ITM means spot >= strike; for puts, spot <= strike.
 */
export function deriveIsItmAtFire(
  optionType: 'C' | 'P',
  spot: number | null,
  strike: number | null,
): number | null {
  if (spot === null || strike === null) return null;
  const isCall = optionType === 'C';
  const itm = isCall ? spot >= strike : spot <= strike;
  return itm ? 1 : 0;
}

/**
 * otm_distance_pct: positive when OTM, negative when ITM; NaN if spot null.
 * Matches Phase 1: (strike - spot) / spot for calls, (spot - strike) / spot for puts.
 */
export function deriveOtmDistancePct(
  optionType: 'C' | 'P',
  spot: number | null,
  strike: number | null,
): number | null {
  if (spot === null || strike === null || spot === 0) return null;
  return optionType === 'C' ? (strike - spot) / spot : (spot - strike) / spot;
}

/** dealer_gamma_sign: +1 / -1 / null (0 maps to null — neutral). */
export function deriveDealerGammaSign(
  spxSpotGammaOi: number | null,
): number | null {
  if (spxSpotGammaOi === null) return null;
  if (spxSpotGammaOi > 0) return 1;
  if (spxSpotGammaOi < 0) return -1;
  return null;
}

/** aggressive_premium_flag: 1 iff ask-side share >= threshold. NaN-safe. */
export function deriveAggressivePremiumFlag(
  askPct: number | null,
): number | null {
  if (askPct === null) return null;
  return askPct >= AGGRESSIVE_ASK_PCT_THRESHOLD ? 1 : 0;
}

/* ───────────────────────── Sequential-context derivations ─────────────── */

/**
 * burst_storm_distinct_count: count of DISTINCT underlyings firing in the
 * prior BURST_STORM_WINDOW_MIN minutes (strictly before this fire). Matches
 * Phase 1's deque-based sliding window.
 */
export function deriveBurstStormDistinctCount(
  fireTime: Date,
  recentSameType: SequentialContext['recentSameTypeFires'],
): number {
  const cutoff = fireTime.getTime() - BURST_STORM_WINDOW_MIN * 60_000;
  const t = fireTime.getTime();
  const set = new Set<string>();
  for (const r of recentSameType) {
    const ft = r.fire_time.getTime();
    if (ft >= cutoff && ft < t) set.add(r.underlying_symbol);
  }
  return set.size;
}

/** burst_storm_badge: 1 iff distinct_count >= BURST_STORM_MIN_COFIRES. */
export function deriveBurstStormBadge(distinctCount: number): number {
  return distinctCount >= BURST_STORM_MIN_COFIRES ? 1 : 0;
}

/**
 * Cofire flag: 1 iff `recentOtherTypeByChain[option_chain_id]` has a row
 * with fire_time at or before `fireTime` AND within COFIRE_WINDOW_MIN.
 * Direction-aware (PIT-correct) — only prior counterparts count.
 */
export function deriveCofireFlag(
  fireTime: Date,
  optionChainId: string,
  recentOtherByChain: SequentialContext['recentOtherTypeByChain'],
): number {
  const candidates = recentOtherByChain.get(optionChainId);
  if (!candidates || candidates.length === 0) return 0;
  const window = COFIRE_WINDOW_MIN * 60_000;
  const t = fireTime.getTime();
  for (const c of candidates) {
    const delta = t - c.fire_time.getTime();
    if (delta >= 0 && delta <= window) return 1;
  }
  return 0;
}

/**
 * Sibling-chain cofire flag: 1 iff the OTHER detector fired on the SAME
 * `underlying + option_type` (Call↔Call, Put↔Put) but a DIFFERENT
 * `option_chain_id`, within COFIRE_WINDOW_MIN strictly prior to `fireTime`.
 *
 * Designed to coexist with `deriveCofireFlag` — the two are NOT mutually
 * exclusive. Same-chain fires concentrate on one contract (one trader/algo);
 * sibling-chain fires capture ticker-wide directional pressure across the
 * strike ladder. Both can be 1 simultaneously; the model learns the
 * interaction.
 */
export function deriveCofireDiffChainFlag(
  fireTime: Date,
  optionChainId: string,
  underlying: string,
  optionType: 'C' | 'P',
  recentOtherByTickerDir: SequentialContext['recentOtherTypeByTickerDir'],
): number {
  const candidates = recentOtherByTickerDir.get(
    tickerDirKey(underlying, optionType),
  );
  if (!candidates || candidates.length === 0) return 0;
  const window = COFIRE_WINDOW_MIN * 60_000;
  const t = fireTime.getTime();
  for (const c of candidates) {
    if (c.option_chain_id === optionChainId) continue;
    const delta = t - c.fire_time.getTime();
    if (delta >= 0 && delta <= window) return 1;
  }
  return 0;
}

/**
 * n_same_dir_fires_last_30min: count of strictly-prior fires with the SAME
 * underlying + option_type within a 30-min lookback.
 */
export function deriveNSameDirFiresLast30Min(
  fireTime: Date,
  underlying: string,
  optionType: 'C' | 'P',
  recentSameType: SequentialContext['recentSameTypeFires'],
): number {
  const cutoff = fireTime.getTime() - SAME_DIR_WINDOW_MIN * 60_000;
  const t = fireTime.getTime();
  let count = 0;
  for (const r of recentSameType) {
    const ft = r.fire_time.getTime();
    if (
      ft >= cutoff &&
      ft < t &&
      r.underlying_symbol === underlying &&
      r.option_type === optionType
    ) {
      count++;
    }
  }
  return count;
}

/* ───────────────────────── Categorical one-hot expansion ───────────────── */

/**
 * For each categorical column listed in bundle.categorical_cols and
 * `ticker_bucket`, set the matching one-hot feature to 1.
 *
 * Convention from pandas.get_dummies(..., drop_first=False, dummy_na=False):
 * the column name is `{col}_{value}`. We only emit entries the bundle pins
 * in feature_cols; unknown values produce an all-zero one-hot block.
 */
export function expandOneHotCategoricals(
  bundle: TakeitBundle,
  raw: Record<string, string | null | undefined>,
  ticker: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const featureSet = new Set(bundle.feature_cols);
  // Categorical columns from bundle.categorical_cols.
  for (const col of bundle.categorical_cols) {
    const v = raw[col];
    if (v === null || v === undefined) continue;
    const key = `${col}_${v}`;
    if (featureSet.has(key)) out[key] = 1;
  }
  // ticker_bucket: top_tickers + OTHER.
  const bucketValue = bundle.top_tickers.includes(ticker) ? ticker : 'OTHER';
  const bucketKey = `ticker_bucket_${bucketValue}`;
  if (featureSet.has(bucketKey)) out[bucketKey] = 1;
  return out;
}

/* ───────────────────────── Top-level builders ──────────────────────────── */

function nullableNumberToFeature(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return v;
}

function nullableBooleanToFeature(
  v: boolean | null | undefined,
): number | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

/**
 * Build the full feature record for a lottery alert. Output is a map keyed
 * by feature_cols name; the scorer can then call featuresFromRow() to turn
 * this into the ordered array.
 */
export function featuresForLottery(
  bundle: TakeitBundle,
  row: LotteryAlertRow,
  ctx: SequentialContext,
  macro: ForcedFlowMacroContext = {},
): Record<string, number | null> {
  const { minute_of_day_ct, day_of_week } = ctMinuteAndDow(row.fire_time);
  const sessionPhase = sessionPhaseFromMinuteCt(minute_of_day_ct);
  const sessionPhaseCat = deriveSessionPhase(row.fire_time);
  const isItm = deriveIsItmAtFire(
    row.option_type,
    row.spot_at_first,
    row.strike,
  );
  const otm = deriveOtmDistancePct(
    row.option_type,
    row.spot_at_first,
    row.strike,
  );
  const gammaSign = deriveDealerGammaSign(row.spx_spot_gamma_oi);
  const aggressive = deriveAggressivePremiumFlag(row.trigger_ask_pct);
  const burstCount = deriveBurstStormDistinctCount(
    row.fire_time,
    ctx.recentSameTypeFires,
  );
  const burstBadge = deriveBurstStormBadge(burstCount);
  const sbCofire = deriveCofireFlag(
    row.fire_time,
    row.option_chain_id,
    ctx.recentOtherTypeByChain,
  );
  const sbCofireDiffChain = deriveCofireDiffChainFlag(
    row.fire_time,
    row.option_chain_id,
    row.underlying_symbol,
    row.option_type,
    ctx.recentOtherTypeByTickerDir,
  );
  const nSameDir = deriveNSameDirFiresLast30Min(
    row.fire_time,
    row.underlying_symbol,
    row.option_type,
    ctx.recentSameTypeFires,
  );
  const priorWin = ctx.priorSessionWinRateByTicker.get(row.underlying_symbol);
  const forcedFlow = computeForcedFlowFeatures(row, macro);

  const base: Record<string, number | null> = {
    // raw numerics carried straight through
    dte: row.dte,
    trigger_vol_to_oi_window: nullableNumberToFeature(
      row.trigger_vol_to_oi_window,
    ),
    trigger_vol_to_oi_cum: nullableNumberToFeature(row.trigger_vol_to_oi_cum),
    trigger_iv: nullableNumberToFeature(row.trigger_iv),
    trigger_delta: nullableNumberToFeature(row.trigger_delta),
    trigger_ask_pct: nullableNumberToFeature(row.trigger_ask_pct),
    trigger_window_size: nullableNumberToFeature(row.trigger_window_size),
    trigger_window_prints: nullableNumberToFeature(row.trigger_window_prints),
    entry_price: nullableNumberToFeature(row.entry_price),
    open_interest: nullableNumberToFeature(row.open_interest),
    spot_at_first: nullableNumberToFeature(row.spot_at_first),
    alert_seq: nullableNumberToFeature(row.alert_seq),
    minutes_since_prev_fire: nullableNumberToFeature(
      row.minutes_since_prev_fire,
    ),
    reload_tagged: nullableBooleanToFeature(row.reload_tagged),
    cheap_call_pm_tagged: nullableBooleanToFeature(row.cheap_call_pm_tagged),
    burst_ratio_vs_prev: nullableNumberToFeature(row.burst_ratio_vs_prev),
    entry_drop_pct_vs_prev: nullableNumberToFeature(row.entry_drop_pct_vs_prev),
    mkt_tide_ncp: nullableNumberToFeature(row.mkt_tide_ncp),
    mkt_tide_npp: nullableNumberToFeature(row.mkt_tide_npp),
    mkt_tide_diff: nullableNumberToFeature(row.mkt_tide_diff),
    mkt_tide_otm_diff: nullableNumberToFeature(row.mkt_tide_otm_diff),
    spx_flow_diff: nullableNumberToFeature(row.spx_flow_diff),
    spy_etf_diff: nullableNumberToFeature(row.spy_etf_diff),
    qqq_etf_diff: nullableNumberToFeature(row.qqq_etf_diff),
    zero_dte_diff: nullableNumberToFeature(row.zero_dte_diff),
    spx_spot_gamma_oi: nullableNumberToFeature(row.spx_spot_gamma_oi),
    spx_spot_gamma_vol: nullableNumberToFeature(row.spx_spot_gamma_vol),
    spx_spot_charm_oi: nullableNumberToFeature(row.spx_spot_charm_oi),
    spx_spot_vanna_oi: nullableNumberToFeature(row.spx_spot_vanna_oi),
    gex_strike_call_minus_put: nullableNumberToFeature(
      row.gex_strike_call_minus_put,
    ),
    gex_strike_call_ask_minus_bid: nullableNumberToFeature(
      row.gex_strike_call_ask_minus_bid,
    ),
    gex_strike_put_ask_minus_bid: nullableNumberToFeature(
      row.gex_strike_put_ask_minus_bid,
    ),
    score: nullableNumberToFeature(row.score),
    direction_gated: nullableBooleanToFeature(row.direction_gated),
    // Multileg classification (migration #160). NULL = unclassified, surfaced
    // as null so XGBoost treats as missing rather than as a false default.
    is_isolated_leg: nullableBooleanToFeature(row.is_isolated_leg),
    match_confidence: nullableNumberToFeature(row.match_confidence),
    // derived
    minute_of_day_ct,
    day_of_week,
    session_phase: sessionPhase,
    is_itm_at_fire: isItm,
    otm_distance_pct: otm,
    dealer_gamma_sign: gammaSign,
    aggressive_premium_flag: aggressive,
    burst_storm_distinct_count: burstCount,
    burst_storm_badge: burstBadge,
    silent_boom_cofire_within_5min: sbCofire,
    silent_boom_cofire_diff_chain_within_5min: sbCofireDiffChain,
    n_same_dir_fires_last_30min: nSameDir,
    prior_session_win_rate_same_ticker:
      priorWin === undefined ? null : priorWin,
    // Forced-flow features (meta-detectors Phase 5). Numeric — emitted as
    // discrete features so the model can learn interactions (per spec
    // §"Open question 3"). See api/_lib/forced-flow.ts for stub policy
    // on bilateral_flow_score + cross_name_cluster_score.
    bilateral_flow_score: forcedFlow.bilateral_flow_score,
    cross_name_cluster_score: forcedFlow.cross_name_cluster_score,
    calendar_adjacency_flag: forcedFlow.calendar_adjacency_flag,
    cross_asset_stress_flag: forcedFlow.cross_asset_stress_flag,
  };

  // One-hot categoricals. `inferred_structure` joins the same mechanism as
  // mode / flow_quad / tod — encoding stability is enforced by
  // bundle.feature_cols (see INFERRED_STRUCTURE_LABELS). `session_phase_cat`
  // is a 7-phase time-of-day label that coexists with `tod` (4 buckets) —
  // the bundle decides which (or both) make it into feature_cols.
  Object.assign(
    base,
    expandOneHotCategoricals(
      bundle,
      {
        option_type: row.option_type,
        mode: row.mode,
        flow_quad: row.flow_quad,
        tod: row.tod,
        inferred_structure: row.inferred_structure,
        session_phase_cat: sessionPhaseCat,
      },
      row.underlying_symbol,
    ),
  );

  return base;
}

/** Build the full feature record for a silent-boom alert. */
export function featuresForSilentBoom(
  bundle: TakeitBundle,
  row: SilentBoomAlertRow,
  ctx: SequentialContext,
  macro: ForcedFlowMacroContext = {},
): Record<string, number | null> {
  const { minute_of_day_ct, day_of_week } = ctMinuteAndDow(row.fire_time);
  const sessionPhase = sessionPhaseFromMinuteCt(minute_of_day_ct);
  const sessionPhaseCat = deriveSessionPhase(row.fire_time);
  const isItm = deriveIsItmAtFire(
    row.option_type,
    row.underlying_price_at_spike,
    row.strike,
  );
  const otm = deriveOtmDistancePct(
    row.option_type,
    row.underlying_price_at_spike,
    row.strike,
  );
  const gammaSign = deriveDealerGammaSign(row.spx_spot_gamma_oi);
  const aggressive = deriveAggressivePremiumFlag(row.ask_pct);
  const burstCount = deriveBurstStormDistinctCount(
    row.fire_time,
    ctx.recentSameTypeFires,
  );
  const burstBadge = deriveBurstStormBadge(burstCount);
  const lotteryCofire = deriveCofireFlag(
    row.fire_time,
    row.option_chain_id,
    ctx.recentOtherTypeByChain,
  );
  const lotteryCofireDiffChain = deriveCofireDiffChainFlag(
    row.fire_time,
    row.option_chain_id,
    row.underlying_symbol,
    row.option_type,
    ctx.recentOtherTypeByTickerDir,
  );
  const nSameDir = deriveNSameDirFiresLast30Min(
    row.fire_time,
    row.underlying_symbol,
    row.option_type,
    ctx.recentSameTypeFires,
  );
  const priorWin = ctx.priorSessionWinRateByTicker.get(row.underlying_symbol);
  const forcedFlow = computeForcedFlowFeatures(row, macro);

  const base: Record<string, number | null> = {
    dte: row.dte,
    spike_volume: nullableNumberToFeature(row.spike_volume),
    baseline_volume: nullableNumberToFeature(row.baseline_volume),
    spike_ratio: nullableNumberToFeature(row.spike_ratio),
    ask_pct: nullableNumberToFeature(row.ask_pct),
    vol_oi: nullableNumberToFeature(row.vol_oi),
    entry_price: nullableNumberToFeature(row.entry_price),
    open_interest: nullableNumberToFeature(row.open_interest),
    mkt_tide_diff: nullableNumberToFeature(row.mkt_tide_diff),
    mkt_tide_otm_diff: nullableNumberToFeature(row.mkt_tide_otm_diff),
    zero_dte_diff: nullableNumberToFeature(row.zero_dte_diff),
    spx_spot_gamma_oi: nullableNumberToFeature(row.spx_spot_gamma_oi),
    multi_leg_share: nullableNumberToFeature(row.multi_leg_share),
    underlying_price_at_spike: nullableNumberToFeature(
      row.underlying_price_at_spike,
    ),
    score: nullableNumberToFeature(row.score),
    direction_gated: nullableBooleanToFeature(row.direction_gated),
    // Multileg classification (migration #160). NULL = unclassified, surfaced
    // as null so XGBoost treats as missing rather than as a false default.
    is_isolated_leg: nullableBooleanToFeature(row.is_isolated_leg),
    match_confidence: nullableNumberToFeature(row.match_confidence),
    // derived
    minute_of_day_ct,
    day_of_week,
    session_phase: sessionPhase,
    is_itm_at_fire: isItm,
    otm_distance_pct: otm,
    dealer_gamma_sign: gammaSign,
    aggressive_premium_flag: aggressive,
    burst_storm_distinct_count: burstCount,
    burst_storm_badge: burstBadge,
    lottery_cofire_within_5min: lotteryCofire,
    lottery_cofire_diff_chain_within_5min: lotteryCofireDiffChain,
    n_same_dir_fires_last_30min: nSameDir,
    prior_session_win_rate_same_ticker:
      priorWin === undefined ? null : priorWin,
    // Forced-flow features (meta-detectors Phase 5). See lottery branch +
    // api/_lib/forced-flow.ts for design notes. Same 4 features ship on
    // silent-boom so the model can learn forced-flow signal independently
    // per detector.
    bilateral_flow_score: forcedFlow.bilateral_flow_score,
    cross_name_cluster_score: forcedFlow.cross_name_cluster_score,
    calendar_adjacency_flag: forcedFlow.calendar_adjacency_flag,
    cross_asset_stress_flag: forcedFlow.cross_asset_stress_flag,
  };

  // One-hot categoricals. `inferred_structure` joins the same mechanism as
  // option_type / score_tier — encoding stability is enforced by
  // bundle.feature_cols (see INFERRED_STRUCTURE_LABELS).
  // `session_phase_cat` is silent-boom's FIRST time-of-day categorical
  // (lottery has `tod`; silent-boom previously had no TOD feature).
  Object.assign(
    base,
    expandOneHotCategoricals(
      bundle,
      {
        option_type: row.option_type,
        score_tier: row.score_tier,
        inferred_structure: row.inferred_structure,
        session_phase_cat: sessionPhaseCat,
      },
      row.underlying_symbol,
    ),
  );

  return base;
}
