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

import type { TakeitBundle } from './takeit-score.js';

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
  recentOtherTypeByChain: ReadonlyMap<string, ReadonlyArray<{ fire_time: Date }>>;
  /**
   * Per-ticker expanding mean of daily win rates using only fires from
   * strictly EARLIER dates (PIT-correct). NaN entries mean no prior history.
   */
  priorSessionWinRateByTicker: ReadonlyMap<string, number | null>;
}

/* ────────────────────────── Constants (must mirror Phase 1) ─────────────────────── */

const AGGRESSIVE_ASK_PCT_THRESHOLD = 0.85;
const BURST_STORM_WINDOW_MIN = 30;
const BURST_STORM_MIN_COFIRES = 5;
const COFIRE_WINDOW_MIN = 5;
const SAME_DIR_WINDOW_MIN = 30;

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
export function deriveDealerGammaSign(spxSpotGammaOi: number | null): number | null {
  if (spxSpotGammaOi === null) return null;
  if (spxSpotGammaOi > 0) return 1;
  if (spxSpotGammaOi < 0) return -1;
  return null;
}

/** aggressive_premium_flag: 1 iff ask-side share >= threshold. NaN-safe. */
export function deriveAggressivePremiumFlag(askPct: number | null): number | null {
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
    if (ft >= cutoff && ft < t && r.underlying_symbol === underlying && r.option_type === optionType) {
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

function nullableBooleanToFeature(v: boolean | null | undefined): number | null {
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
): Record<string, number | null> {
  const { minute_of_day_ct, day_of_week } = ctMinuteAndDow(row.fire_time);
  const sessionPhase = sessionPhaseFromMinuteCt(minute_of_day_ct);
  const isItm = deriveIsItmAtFire(row.option_type, row.spot_at_first, row.strike);
  const otm = deriveOtmDistancePct(row.option_type, row.spot_at_first, row.strike);
  const gammaSign = deriveDealerGammaSign(row.spx_spot_gamma_oi);
  const aggressive = deriveAggressivePremiumFlag(row.trigger_ask_pct);
  const burstCount = deriveBurstStormDistinctCount(row.fire_time, ctx.recentSameTypeFires);
  const burstBadge = deriveBurstStormBadge(burstCount);
  const sbCofire = deriveCofireFlag(row.fire_time, row.option_chain_id, ctx.recentOtherTypeByChain);
  const nSameDir = deriveNSameDirFiresLast30Min(
    row.fire_time,
    row.underlying_symbol,
    row.option_type,
    ctx.recentSameTypeFires,
  );
  const priorWin = ctx.priorSessionWinRateByTicker.get(row.underlying_symbol);

  const base: Record<string, number | null> = {
    // raw numerics carried straight through
    dte: row.dte,
    trigger_vol_to_oi_window: nullableNumberToFeature(row.trigger_vol_to_oi_window),
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
    minutes_since_prev_fire: nullableNumberToFeature(row.minutes_since_prev_fire),
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
    gex_strike_call_minus_put: nullableNumberToFeature(row.gex_strike_call_minus_put),
    gex_strike_call_ask_minus_bid: nullableNumberToFeature(row.gex_strike_call_ask_minus_bid),
    gex_strike_put_ask_minus_bid: nullableNumberToFeature(row.gex_strike_put_ask_minus_bid),
    score: nullableNumberToFeature(row.score),
    direction_gated: nullableBooleanToFeature(row.direction_gated),
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
    n_same_dir_fires_last_30min: nSameDir,
    prior_session_win_rate_same_ticker: priorWin === undefined ? null : priorWin,
  };

  // One-hot categoricals.
  Object.assign(
    base,
    expandOneHotCategoricals(
      bundle,
      {
        option_type: row.option_type,
        mode: row.mode,
        flow_quad: row.flow_quad,
        tod: row.tod,
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
): Record<string, number | null> {
  const { minute_of_day_ct, day_of_week } = ctMinuteAndDow(row.fire_time);
  const sessionPhase = sessionPhaseFromMinuteCt(minute_of_day_ct);
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
  const burstCount = deriveBurstStormDistinctCount(row.fire_time, ctx.recentSameTypeFires);
  const burstBadge = deriveBurstStormBadge(burstCount);
  const lotteryCofire = deriveCofireFlag(
    row.fire_time,
    row.option_chain_id,
    ctx.recentOtherTypeByChain,
  );
  const nSameDir = deriveNSameDirFiresLast30Min(
    row.fire_time,
    row.underlying_symbol,
    row.option_type,
    ctx.recentSameTypeFires,
  );
  const priorWin = ctx.priorSessionWinRateByTicker.get(row.underlying_symbol);

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
    underlying_price_at_spike: nullableNumberToFeature(row.underlying_price_at_spike),
    score: nullableNumberToFeature(row.score),
    direction_gated: nullableBooleanToFeature(row.direction_gated),
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
    n_same_dir_fires_last_30min: nSameDir,
    prior_session_win_rate_same_ticker: priorWin === undefined ? null : priorWin,
  };

  // One-hot categoricals.
  Object.assign(
    base,
    expandOneHotCategoricals(
      bundle,
      { option_type: row.option_type, score_tier: row.score_tier },
      row.underlying_symbol,
    ),
  );

  return base;
}
