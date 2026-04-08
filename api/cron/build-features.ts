/**
 * GET /api/cron/build-features
 *
 * Feature engineering cron that transforms raw intraday data into
 * daily ML feature vectors (training_features) and extracts structured
 * labels from review-mode analyses (day_labels).
 *
 * Runs ~15 min after fetch-outcomes to ensure settlement data is available.
 * On first run, backfills all historical dates. After that, only processes today.
 *
 * Feature engineering is split into focused modules:
 *   build-features-flow.ts   — flow checkpoint NCP/NPP + agreement
 *   build-features-gex.ts    — GEX, Greek exposure, per-strike features
 *   build-features-phase2.ts — prev day, realized vol, events, max pain, dark pool, options
 *   build-features-monitor.ts — IV monitor + flow ratio monitor dynamics
 *   build-features-types.ts  — shared types, constants, and helpers
 *
 * Environment: DATABASE_URL, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';
import type {
  FeatureRow,
  SnapshotRow,
  FlowRow,
} from '../_lib/build-features-types.js';
import {
  AGREEMENT_SOURCES,
  num,
  findNearestCandle,
} from '../_lib/build-features-types.js';
import { engineerFlowFeatures } from '../_lib/build-features-flow.js';
import { engineerGexFeatures } from '../_lib/build-features-gex.js';
import { engineerPhase2Features } from '../_lib/build-features-phase2.js';
import { engineerMonitorFeatures } from '../_lib/build-features-monitor.js';

export const config = { maxDuration: 300 };

// ── Time window check ──────────────────────────────────────

function isPostClose(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  // 4:30 PM = 990 min, 6:00 PM = 1080 min
  return totalMin >= 990 && totalMin <= 1080;
}

// ── Nullable feature keys ──────────────────────────────────

// Columns that are legitimately null on most days (non-event days, no
// significant gamma wall, etc.).  Excluding them prevents completeness
// from being artificially penalised.
const NULLABLE_FEATURE_KEYS = new Set([
  'event_type',
  'is_opex',
  'gamma_wall_above_dist',
  'gamma_wall_above_mag',
  'gamma_wall_below_dist',
  'gamma_wall_below_mag',
  'neg_gamma_nearest_dist',
  'neg_gamma_nearest_mag',
  'gamma_asymmetry',
  'charm_max_pos_dist',
  'charm_max_neg_dist',
  'dp_total_premium',
  'dp_cluster_count',
  'dp_top_cluster_dist',
  'dp_support_premium',
  'dp_resistance_premium',
  'dp_support_resistance_ratio',
  'dp_concentration',
  'max_pain_0dte',
  'max_pain_dist',
  'opt_call_volume',
  'opt_put_volume',
  'opt_call_oi',
  'opt_put_oi',
  'opt_call_premium',
  'opt_put_premium',
  'opt_bullish_premium',
  'opt_bearish_premium',
  'opt_call_vol_ask',
  'opt_put_vol_bid',
  'opt_vol_pcr',
  'opt_oi_pcr',
  'opt_premium_ratio',
  'opt_call_vol_vs_avg30',
  'opt_put_vol_vs_avg30',
  'iv_open',
  'iv_max',
  'iv_range',
  'iv_crush_rate',
  'iv_spike_count',
  'iv_at_t2',
  'pcr_open',
  'pcr_max',
  'pcr_min',
  'pcr_range',
  'pcr_trend_t1_t2',
  'pcr_spike_count',
  'oic_net_oi_change',
  'oic_call_oi_change',
  'oic_put_oi_change',
  'oic_oi_change_pcr',
  'oic_net_premium',
  'oic_call_premium',
  'oic_put_premium',
  'oic_ask_ratio',
  'oic_multi_leg_pct',
  'oic_top_strike_dist',
  'oic_concentration',
  'iv_ts_slope_0d_30d',
  'iv_ts_contango',
  'iv_ts_spread',
  'uw_rv_30d',
  'uw_iv_rv_spread',
  'uw_iv_overpricing_pct',
  'iv_rank',
  // Futures features — nullable until sidecar is live
  'es_momentum_t1',
  'es_momentum_t2',
  'es_spx_basis_t1',
  'es_volume_ratio_t1',
  'es_overnight_range',
  'es_overnight_gap',
  'es_gap_fill_pct_t1',
  'es_vwap_deviation_t1',
  'nq_momentum_t1',
  'nq_es_ratio_t1',
  'nq_es_ratio_change',
  'nq_qqq_divergence_t1',
  'vx_front_price',
  'vx_term_spread',
  'vx_term_slope_pct',
  'vx_contango_signal',
  'vx_basis',
  'zn_momentum_t1',
  'zn_daily_change',
  'spx_zn_correlation_5d',
  'rty_momentum_t1',
  'rty_es_divergence_t1',
  'cl_overnight_change_pct',
  'cl_intraday_momentum_t1',
  'cl_es_correlation_5d',
  'es_put_oi_concentration',
  'es_call_oi_concentration',
  'es_options_max_pain_dist',
  'es_spx_gamma_agreement',
  'es_put_buy_aggressor_pct',
  'es_call_buy_aggressor_pct',
  'es_options_net_delta',
  'es_atm_iv',
]);

/** Compute feature completeness as fraction of non-null values. */
function computeCompleteness(features: FeatureRow): number {
  const keys = Object.keys(features).filter(
    (k) =>
      k !== 'date' &&
      k !== 'feature_completeness' &&
      k !== 'created_at' &&
      !NULLABLE_FEATURE_KEYS.has(k),
  );
  if (keys.length === 0) return 0;
  const nonNull = keys.filter((k) => features[k] != null).length;
  return Math.round((nonNull / keys.length) * 100) / 100;
}

/** Normalize a Neon DATE value to YYYY-MM-DD string. */
function toDateStr(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().split('T')[0]!;
  }
  const s = String(val);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (match) return match[1]!;
  return s;
}

// ── Build features for a single date ───────────────────────

async function buildFeaturesForDate(
  dateStr: string,
): Promise<FeatureRow | null> {
  const sql = getDb();
  const features: FeatureRow = { date: dateStr };

  // 1. Static features from market_snapshots
  // Prefer the earliest entry that has spx_open populated (many early/
  // pre-market snapshots store NaN before cash open). Fall back to the
  // absolute earliest if no snapshot has spx_open.
  const snapshots = await sql`
    SELECT vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
           regime_zone, cluster_mult, dow_mult_hl, dow_label,
           spx_open, sigma, hours_remaining,
           ic_ceiling, put_spread_ceiling, call_spread_ceiling,
           opening_range_signal, opening_range_pct_consumed, is_event_day
    FROM market_snapshots
    WHERE date = ${dateStr}
    ORDER BY (spx_open IS NULL OR spx_open = 'NaN') ASC,
             entry_time ASC
    LIMIT 1
  `;

  if (snapshots.length > 0) {
    const s = snapshots[0] as SnapshotRow;
    features.vix = num(s.vix);
    features.vix1d = num(s.vix1d);
    features.vix9d = num(s.vix9d);
    features.vvix = num(s.vvix);
    features.vix1d_vix_ratio = num(s.vix1d_vix_ratio);
    features.vix_vix9d_ratio = num(s.vix_vix9d_ratio);
    features.regime_zone = s.regime_zone;
    features.cluster_mult = num(s.cluster_mult);
    features.dow_mult = num(s.dow_mult_hl);
    features.dow_label = s.dow_label;
    features.spx_open = num(s.spx_open);
    features.sigma = num(s.sigma);
    features.hours_remaining = num(s.hours_remaining);
    features.ic_ceiling = num(s.ic_ceiling);
    features.put_spread_ceiling = num(s.put_spread_ceiling);
    features.call_spread_ceiling = num(s.call_spread_ceiling);
    features.opening_range_signal = s.opening_range_signal;
    features.opening_range_pct_consumed = num(s.opening_range_pct_consumed);
    features.is_event_day = s.is_event_day;
  }

  // Fall back to outcomes.day_open if snapshots didn't provide spx_open
  if (features.spx_open == null) {
    const fallback = await sql`
      SELECT day_open FROM outcomes WHERE date = ${dateStr} LIMIT 1
    `;
    if (fallback.length > 0 && fallback[0]!.day_open != null) {
      features.spx_open = num(fallback[0]!.day_open);
    }
  }

  // Day of week from date string
  const d = new Date(`${dateStr}T12:00:00-05:00`);
  const dow = Number.isNaN(d.getTime()) ? null : d.getDay();
  features.day_of_week = dow;
  features.is_friday = dow === 5;

  // 2. Flow checkpoint features
  await engineerFlowFeatures(sql, dateStr, features);

  // 3-5. GEX, Greek exposure, per-strike features
  await engineerGexFeatures(sql, dateStr, features);

  // 6-9. Phase 2: prev day, realized vol, events, max pain, dark pool, options
  await engineerPhase2Features(sql, dateStr, features);

  // 10. Monitor features: IV dynamics + flow ratio dynamics
  await engineerMonitorFeatures(sql, dateStr, features);

  // 11. Futures features (~32 features from futures_bars,
  //     futures_snapshots, futures_options_daily)
  // [Phase 2] Implement once futures_bars and futures_options_daily
  //       tables are populated by the Databento sidecar.
  //       Each feature group below queries the appropriate table
  //       and writes to the features object.
  //
  // ES features (8):
  //   - es_momentum_t1/t2: 1H return from futures_bars at T1/T2
  //   - es_spx_basis_t1: ES price - SPX open at T1
  //   - es_volume_ratio_t1: ES volume / 20-day avg at T1
  //   - es_overnight_range/gap: from Globex session bars
  //   - es_gap_fill_pct_t1: gap fill by T1
  //   - es_vwap_deviation_t1: ES price - overnight VWAP at T1
  //
  // NQ features (4):
  //   - nq_momentum_t1: NQ 1H return at T1
  //   - nq_es_ratio_t1: NQ/ES price ratio at T1
  //   - nq_es_ratio_change: ratio change from prior close
  //   - nq_qqq_divergence_t1: sign agreement with QQQ NCP
  //
  // VX features (5):
  //   - vx_front_price: VX front month last
  //   - vx_term_spread: front - back month
  //   - vx_term_slope_pct: (front - back) / back
  //   - vx_contango_signal: 1 contango, -1 backwardation
  //   - vx_basis: VX front - spot VIX
  //
  // ZN features (3):
  //   - zn_momentum_t1: ZN 1H return at T1
  //   - zn_daily_change: prior day change
  //   - spx_zn_correlation_5d: 5-day rolling correlation
  //
  // RTY features (2):
  //   - rty_momentum_t1: RTY 1H return at T1
  //   - rty_es_divergence_t1: sign agreement with ES
  //
  // CL features (3):
  //   - cl_overnight_change_pct: prior settlement to Globex close
  //   - cl_intraday_momentum_t1: open to T1 change
  //   - cl_es_correlation_5d: 5-day rolling correlation
  //
  // ES Options features (8):
  //   - es_put/call_oi_concentration: from futures_options_daily
  //   - es_options_max_pain_dist: distance to max pain
  //   - es_spx_gamma_agreement: gamma wall agreement score
  //   - es_put/call_buy_aggressor_pct: from futures_options_trades
  //   - es_options_net_delta: sum of exchange delta * OI
  //   - es_atm_iv: exchange-computed IV at ATM
  //
  // await engineerFuturesFeatures(sql, dateStr, features);

  features.feature_completeness = computeCompleteness(features);

  return features;
}

// ── Label extraction from review analyses ──────────────────

async function extractLabelsForDate(
  dateStr: string,
): Promise<FeatureRow | null> {
  const sql = getDb();

  const reviews = await sql`
    SELECT id, full_response
    FROM analyses
    WHERE date = ${dateStr} AND mode = 'review'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (reviews.length === 0) return null;

  const row = reviews[0]!;
  const analysisId = row.id as number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any;
  try {
    resp =
      typeof row.full_response === 'string'
        ? JSON.parse(row.full_response)
        : row.full_response;
  } catch {
    logger.warn({ date: dateStr }, 'Failed to parse review full_response');
    return null;
  }

  const review = resp?.review ?? {};
  const chartConf = resp?.chartConfidence ?? {};

  const labels: FeatureRow = {
    date: dateStr,
    analysis_id: analysisId,
    structure_correct: review.wasCorrect ?? null,
    recommended_structure: resp?.structure ?? null,
    confidence: resp?.confidence ?? null,
    suggested_delta: resp?.suggestedDelta ?? null,
    charm_diverged: chartConf?.periscopeCharm?.signal === 'CONTRADICTS' || null,
    naive_charm_signal: chartConf?.netCharm?.signal ?? null,
    spx_flow_signal: chartConf?.spxNetFlow?.signal ?? null,
    market_tide_signal: chartConf?.marketTide?.signal ?? null,
    spy_flow_signal: chartConf?.spyNetFlow?.signal ?? null,
    gex_signal: chartConf?.aggregateGex?.signal ?? null,
  };

  // Derived labels from outcomes
  const outcomes = await sql`
    SELECT settlement, day_open, day_high, day_low, day_range_pts
    FROM outcomes
    WHERE date = ${dateStr}
    LIMIT 1
  `;

  if (outcomes.length > 0) {
    const o = outcomes[0]!;
    const settlement = Number(o.settlement);
    const dayOpen = Number(o.day_open);
    const rangePts = Number(o.day_range_pts);

    labels.settlement_direction =
      settlement > dayOpen ? 'UP' : settlement < dayOpen ? 'DOWN' : 'FLAT';

    labels.range_category =
      rangePts < 30
        ? 'NARROW'
        : rangePts < 60
          ? 'NORMAL'
          : rangePts < 100
            ? 'WIDE'
            : 'EXTREME';

    // Flow was directional? Compare majority flow at T2 vs settlement direction
    const flowRows = await sql`
      SELECT timestamp, source, ncp
      FROM flow_data
      WHERE date = ${dateStr}
      ORDER BY timestamp ASC
    `;

    const allFlowT2 = flowRows as FlowRow[];
    let bullishCount = 0;
    let bearishCount = 0;

    for (const source of AGREEMENT_SOURCES) {
      const sourceRows = allFlowT2.filter((r) => r.source === source);
      const candle = findNearestCandle(sourceRows, 630, dateStr);
      if (!candle) continue;
      const ncp = num(candle.ncp);
      if (ncp == null) continue;
      if (ncp > 0) bullishCount++;
      else if (ncp < 0) bearishCount++;
    }

    const flowDirection =
      bullishCount > bearishCount
        ? 'UP'
        : bearishCount > bullishCount
          ? 'DOWN'
          : null;
    labels.flow_was_directional =
      flowDirection != null
        ? flowDirection === labels.settlement_direction
        : null;
  }

  // Compute label completeness
  const labelKeys = [
    'structure_correct',
    'charm_diverged',
    'naive_charm_signal',
    'spx_flow_signal',
    'market_tide_signal',
    'gex_signal',
    'settlement_direction',
    'range_category',
    'flow_was_directional',
  ];
  const nonNull = labelKeys.filter((k) => labels[k] != null).length;
  labels.label_completeness =
    Math.round((nonNull / labelKeys.length) * 100) / 100;

  return labels;
}

// ── Upsert helpers ─────────────────────────────────────────

async function upsertFeatures(f: FeatureRow): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO training_features (
      date, vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
      regime_zone, cluster_mult, dow_mult, dow_label,
      spx_open, sigma, hours_remaining,
      ic_ceiling, put_spread_ceiling, call_spread_ceiling,
      opening_range_signal, opening_range_pct_consumed,
      day_of_week, is_friday, is_event_day,
      mt_ncp_t1, mt_npp_t1, mt_ncp_t2, mt_npp_t2,
      mt_ncp_t3, mt_npp_t3, mt_ncp_t4, mt_npp_t4,
      spx_ncp_t1, spx_npp_t1, spx_ncp_t2, spx_npp_t2,
      spx_ncp_t3, spx_npp_t3, spx_ncp_t4, spx_npp_t4,
      spy_ncp_t1, spy_npp_t1, spy_ncp_t2, spy_npp_t2,
      qqq_ncp_t1, qqq_npp_t1, qqq_ncp_t2, qqq_npp_t2,
      spy_etf_ncp_t1, spy_etf_npp_t1, spy_etf_ncp_t2, spy_etf_npp_t2,
      qqq_etf_ncp_t1, qqq_etf_npp_t1, qqq_etf_ncp_t2, qqq_etf_npp_t2,
      zero_dte_ncp_t1, zero_dte_npp_t1, zero_dte_ncp_t2, zero_dte_npp_t2,
      delta_flow_total_t1, delta_flow_dir_t1, delta_flow_total_t2, delta_flow_dir_t2,
      flow_agreement_t1, flow_agreement_t2,
      etf_tide_divergence_t1, etf_tide_divergence_t2,
      ncp_npp_gap_spx_t1, ncp_npp_gap_spx_t2,
      gex_oi_t1, gex_oi_t2, gex_oi_t3, gex_oi_t4,
      gex_vol_t1, gex_vol_t2, gex_dir_t1, gex_dir_t2,
      gex_oi_slope, charm_oi_t1, charm_oi_t2,
      agg_net_gamma, dte0_net_charm, dte0_charm_pct,
      gamma_wall_above_dist, gamma_wall_above_mag,
      gamma_wall_below_dist, gamma_wall_below_mag,
      neg_gamma_nearest_dist, neg_gamma_nearest_mag,
      gamma_asymmetry, charm_slope,
      charm_max_pos_dist, charm_max_neg_dist,
      gamma_0dte_allexp_agree, charm_pattern,
      feature_completeness,
      prev_day_range_pts, prev_day_direction, prev_day_vix_change, prev_day_range_cat,
      realized_vol_5d, realized_vol_10d, rv_iv_ratio,
      vix_term_slope, vvix_percentile,
      event_type, is_fomc, is_opex, days_to_next_event, event_count,
      dp_total_premium, dp_cluster_count, dp_top_cluster_dist,
      dp_support_premium, dp_resistance_premium,
      dp_support_resistance_ratio, dp_concentration,
      max_pain_0dte, max_pain_dist,
      opt_call_volume, opt_put_volume, opt_call_oi, opt_put_oi,
      opt_call_premium, opt_put_premium,
      opt_bullish_premium, opt_bearish_premium,
      opt_call_vol_ask, opt_put_vol_bid,
      opt_vol_pcr, opt_oi_pcr, opt_premium_ratio,
      opt_call_vol_vs_avg30, opt_put_vol_vs_avg30,
      iv_open, iv_max, iv_range, iv_crush_rate, iv_spike_count, iv_at_t2,
      pcr_open, pcr_max, pcr_min, pcr_range, pcr_trend_t1_t2, pcr_spike_count,
      oic_net_oi_change, oic_call_oi_change, oic_put_oi_change,
      oic_oi_change_pcr, oic_net_premium, oic_call_premium, oic_put_premium,
      oic_ask_ratio, oic_multi_leg_pct, oic_top_strike_dist, oic_concentration,
      iv_ts_slope_0d_30d, iv_ts_contango, iv_ts_spread,
      uw_rv_30d, uw_iv_rv_spread, uw_iv_overpricing_pct, iv_rank
    ) VALUES (
      ${f.date}, ${f.vix}, ${f.vix1d}, ${f.vix9d}, ${f.vvix},
      ${f.vix1d_vix_ratio}, ${f.vix_vix9d_ratio},
      ${f.regime_zone}, ${f.cluster_mult}, ${f.dow_mult}, ${f.dow_label},
      ${f.spx_open}, ${f.sigma}, ${f.hours_remaining},
      ${f.ic_ceiling}, ${f.put_spread_ceiling}, ${f.call_spread_ceiling},
      ${f.opening_range_signal}, ${f.opening_range_pct_consumed},
      ${f.day_of_week}, ${f.is_friday}, ${f.is_event_day},
      ${f.mt_ncp_t1}, ${f.mt_npp_t1}, ${f.mt_ncp_t2}, ${f.mt_npp_t2},
      ${f.mt_ncp_t3}, ${f.mt_npp_t3}, ${f.mt_ncp_t4}, ${f.mt_npp_t4},
      ${f.spx_ncp_t1}, ${f.spx_npp_t1}, ${f.spx_ncp_t2}, ${f.spx_npp_t2},
      ${f.spx_ncp_t3}, ${f.spx_npp_t3}, ${f.spx_ncp_t4}, ${f.spx_npp_t4},
      ${f.spy_ncp_t1}, ${f.spy_npp_t1}, ${f.spy_ncp_t2}, ${f.spy_npp_t2},
      ${f.qqq_ncp_t1}, ${f.qqq_npp_t1}, ${f.qqq_ncp_t2}, ${f.qqq_npp_t2},
      ${f.spy_etf_ncp_t1}, ${f.spy_etf_npp_t1}, ${f.spy_etf_ncp_t2}, ${f.spy_etf_npp_t2},
      ${f.qqq_etf_ncp_t1}, ${f.qqq_etf_npp_t1}, ${f.qqq_etf_ncp_t2}, ${f.qqq_etf_npp_t2},
      ${f.zero_dte_ncp_t1}, ${f.zero_dte_npp_t1}, ${f.zero_dte_ncp_t2}, ${f.zero_dte_npp_t2},
      ${f.delta_flow_total_t1}, ${f.delta_flow_dir_t1},
      ${f.delta_flow_total_t2}, ${f.delta_flow_dir_t2},
      ${f.flow_agreement_t1}, ${f.flow_agreement_t2},
      ${f.etf_tide_divergence_t1}, ${f.etf_tide_divergence_t2},
      ${f.ncp_npp_gap_spx_t1}, ${f.ncp_npp_gap_spx_t2},
      ${f.gex_oi_t1}, ${f.gex_oi_t2}, ${f.gex_oi_t3}, ${f.gex_oi_t4},
      ${f.gex_vol_t1}, ${f.gex_vol_t2}, ${f.gex_dir_t1}, ${f.gex_dir_t2},
      ${f.gex_oi_slope}, ${f.charm_oi_t1}, ${f.charm_oi_t2},
      ${f.agg_net_gamma}, ${f.dte0_net_charm}, ${f.dte0_charm_pct},
      ${f.gamma_wall_above_dist}, ${f.gamma_wall_above_mag},
      ${f.gamma_wall_below_dist}, ${f.gamma_wall_below_mag},
      ${f.neg_gamma_nearest_dist}, ${f.neg_gamma_nearest_mag},
      ${f.gamma_asymmetry}, ${f.charm_slope},
      ${f.charm_max_pos_dist}, ${f.charm_max_neg_dist},
      ${f.gamma_0dte_allexp_agree}, ${f.charm_pattern},
      ${f.feature_completeness},
      ${f.prev_day_range_pts}, ${f.prev_day_direction}, ${f.prev_day_vix_change}, ${f.prev_day_range_cat},
      ${f.realized_vol_5d}, ${f.realized_vol_10d}, ${f.rv_iv_ratio},
      ${f.vix_term_slope}, ${f.vvix_percentile},
      ${f.event_type}, ${f.is_fomc}, ${f.is_opex}, ${f.days_to_next_event}, ${f.event_count},
      ${f.dp_total_premium}, ${f.dp_cluster_count}, ${f.dp_top_cluster_dist},
      ${f.dp_support_premium}, ${f.dp_resistance_premium},
      ${f.dp_support_resistance_ratio}, ${f.dp_concentration},
      ${f.max_pain_0dte}, ${f.max_pain_dist},
      ${f.opt_call_volume}, ${f.opt_put_volume},
      ${f.opt_call_oi}, ${f.opt_put_oi},
      ${f.opt_call_premium}, ${f.opt_put_premium},
      ${f.opt_bullish_premium}, ${f.opt_bearish_premium},
      ${f.opt_call_vol_ask}, ${f.opt_put_vol_bid},
      ${f.opt_vol_pcr}, ${f.opt_oi_pcr}, ${f.opt_premium_ratio},
      ${f.opt_call_vol_vs_avg30}, ${f.opt_put_vol_vs_avg30},
      ${f.iv_open}, ${f.iv_max}, ${f.iv_range},
      ${f.iv_crush_rate}, ${f.iv_spike_count}, ${f.iv_at_t2},
      ${f.pcr_open}, ${f.pcr_max}, ${f.pcr_min},
      ${f.pcr_range}, ${f.pcr_trend_t1_t2}, ${f.pcr_spike_count},
      ${f.oic_net_oi_change}, ${f.oic_call_oi_change}, ${f.oic_put_oi_change},
      ${f.oic_oi_change_pcr}, ${f.oic_net_premium}, ${f.oic_call_premium},
      ${f.oic_put_premium}, ${f.oic_ask_ratio}, ${f.oic_multi_leg_pct},
      ${f.oic_top_strike_dist}, ${f.oic_concentration},
      ${f.iv_ts_slope_0d_30d}, ${f.iv_ts_contango}, ${f.iv_ts_spread},
      ${f.uw_rv_30d}, ${f.uw_iv_rv_spread}, ${f.uw_iv_overpricing_pct}, ${f.iv_rank}
    )
    -- COALESCE on every column: only overwrite when the new value is non-null.
    -- The fail-soft helpers in build-features-phase2.ts return undefined for
    -- any field whose API call failed (e.g. UW returning 403 for dates outside
    -- the 30-day rolling window), and undefined → NULL when interpolated. A
    -- naked EXCLUDED.col assignment would clobber a previously-fetched value
    -- with NULL on every backfill. COALESCE preserves the existing fact when
    -- the re-fetch couldn't produce a fresh one.
    ON CONFLICT (date) DO UPDATE SET
      vix = COALESCE(EXCLUDED.vix, training_features.vix),
      vix1d = COALESCE(EXCLUDED.vix1d, training_features.vix1d),
      vix9d = COALESCE(EXCLUDED.vix9d, training_features.vix9d),
      vvix = COALESCE(EXCLUDED.vvix, training_features.vvix),
      vix1d_vix_ratio = COALESCE(EXCLUDED.vix1d_vix_ratio, training_features.vix1d_vix_ratio),
      vix_vix9d_ratio = COALESCE(EXCLUDED.vix_vix9d_ratio, training_features.vix_vix9d_ratio),
      regime_zone = COALESCE(EXCLUDED.regime_zone, training_features.regime_zone),
      cluster_mult = COALESCE(EXCLUDED.cluster_mult, training_features.cluster_mult),
      dow_mult = COALESCE(EXCLUDED.dow_mult, training_features.dow_mult),
      dow_label = COALESCE(EXCLUDED.dow_label, training_features.dow_label),
      spx_open = COALESCE(EXCLUDED.spx_open, training_features.spx_open),
      sigma = COALESCE(EXCLUDED.sigma, training_features.sigma),
      hours_remaining = COALESCE(EXCLUDED.hours_remaining, training_features.hours_remaining),
      ic_ceiling = COALESCE(EXCLUDED.ic_ceiling, training_features.ic_ceiling),
      put_spread_ceiling = COALESCE(EXCLUDED.put_spread_ceiling, training_features.put_spread_ceiling),
      call_spread_ceiling = COALESCE(EXCLUDED.call_spread_ceiling, training_features.call_spread_ceiling),
      opening_range_signal = COALESCE(EXCLUDED.opening_range_signal, training_features.opening_range_signal),
      opening_range_pct_consumed = COALESCE(EXCLUDED.opening_range_pct_consumed, training_features.opening_range_pct_consumed),
      day_of_week = COALESCE(EXCLUDED.day_of_week, training_features.day_of_week),
      is_friday = COALESCE(EXCLUDED.is_friday, training_features.is_friday),
      is_event_day = COALESCE(EXCLUDED.is_event_day, training_features.is_event_day),
      mt_ncp_t1 = COALESCE(EXCLUDED.mt_ncp_t1, training_features.mt_ncp_t1),
      mt_npp_t1 = COALESCE(EXCLUDED.mt_npp_t1, training_features.mt_npp_t1),
      mt_ncp_t2 = COALESCE(EXCLUDED.mt_ncp_t2, training_features.mt_ncp_t2),
      mt_npp_t2 = COALESCE(EXCLUDED.mt_npp_t2, training_features.mt_npp_t2),
      mt_ncp_t3 = COALESCE(EXCLUDED.mt_ncp_t3, training_features.mt_ncp_t3),
      mt_npp_t3 = COALESCE(EXCLUDED.mt_npp_t3, training_features.mt_npp_t3),
      mt_ncp_t4 = COALESCE(EXCLUDED.mt_ncp_t4, training_features.mt_ncp_t4),
      mt_npp_t4 = COALESCE(EXCLUDED.mt_npp_t4, training_features.mt_npp_t4),
      spx_ncp_t1 = COALESCE(EXCLUDED.spx_ncp_t1, training_features.spx_ncp_t1),
      spx_npp_t1 = COALESCE(EXCLUDED.spx_npp_t1, training_features.spx_npp_t1),
      spx_ncp_t2 = COALESCE(EXCLUDED.spx_ncp_t2, training_features.spx_ncp_t2),
      spx_npp_t2 = COALESCE(EXCLUDED.spx_npp_t2, training_features.spx_npp_t2),
      spx_ncp_t3 = COALESCE(EXCLUDED.spx_ncp_t3, training_features.spx_ncp_t3),
      spx_npp_t3 = COALESCE(EXCLUDED.spx_npp_t3, training_features.spx_npp_t3),
      spx_ncp_t4 = COALESCE(EXCLUDED.spx_ncp_t4, training_features.spx_ncp_t4),
      spx_npp_t4 = COALESCE(EXCLUDED.spx_npp_t4, training_features.spx_npp_t4),
      spy_ncp_t1 = COALESCE(EXCLUDED.spy_ncp_t1, training_features.spy_ncp_t1),
      spy_npp_t1 = COALESCE(EXCLUDED.spy_npp_t1, training_features.spy_npp_t1),
      spy_ncp_t2 = COALESCE(EXCLUDED.spy_ncp_t2, training_features.spy_ncp_t2),
      spy_npp_t2 = COALESCE(EXCLUDED.spy_npp_t2, training_features.spy_npp_t2),
      qqq_ncp_t1 = COALESCE(EXCLUDED.qqq_ncp_t1, training_features.qqq_ncp_t1),
      qqq_npp_t1 = COALESCE(EXCLUDED.qqq_npp_t1, training_features.qqq_npp_t1),
      qqq_ncp_t2 = COALESCE(EXCLUDED.qqq_ncp_t2, training_features.qqq_ncp_t2),
      qqq_npp_t2 = COALESCE(EXCLUDED.qqq_npp_t2, training_features.qqq_npp_t2),
      spy_etf_ncp_t1 = COALESCE(EXCLUDED.spy_etf_ncp_t1, training_features.spy_etf_ncp_t1),
      spy_etf_npp_t1 = COALESCE(EXCLUDED.spy_etf_npp_t1, training_features.spy_etf_npp_t1),
      spy_etf_ncp_t2 = COALESCE(EXCLUDED.spy_etf_ncp_t2, training_features.spy_etf_ncp_t2),
      spy_etf_npp_t2 = COALESCE(EXCLUDED.spy_etf_npp_t2, training_features.spy_etf_npp_t2),
      qqq_etf_ncp_t1 = COALESCE(EXCLUDED.qqq_etf_ncp_t1, training_features.qqq_etf_ncp_t1),
      qqq_etf_npp_t1 = COALESCE(EXCLUDED.qqq_etf_npp_t1, training_features.qqq_etf_npp_t1),
      qqq_etf_ncp_t2 = COALESCE(EXCLUDED.qqq_etf_ncp_t2, training_features.qqq_etf_ncp_t2),
      qqq_etf_npp_t2 = COALESCE(EXCLUDED.qqq_etf_npp_t2, training_features.qqq_etf_npp_t2),
      zero_dte_ncp_t1 = COALESCE(EXCLUDED.zero_dte_ncp_t1, training_features.zero_dte_ncp_t1),
      zero_dte_npp_t1 = COALESCE(EXCLUDED.zero_dte_npp_t1, training_features.zero_dte_npp_t1),
      zero_dte_ncp_t2 = COALESCE(EXCLUDED.zero_dte_ncp_t2, training_features.zero_dte_ncp_t2),
      zero_dte_npp_t2 = COALESCE(EXCLUDED.zero_dte_npp_t2, training_features.zero_dte_npp_t2),
      delta_flow_total_t1 = COALESCE(EXCLUDED.delta_flow_total_t1, training_features.delta_flow_total_t1),
      delta_flow_dir_t1 = COALESCE(EXCLUDED.delta_flow_dir_t1, training_features.delta_flow_dir_t1),
      delta_flow_total_t2 = COALESCE(EXCLUDED.delta_flow_total_t2, training_features.delta_flow_total_t2),
      delta_flow_dir_t2 = COALESCE(EXCLUDED.delta_flow_dir_t2, training_features.delta_flow_dir_t2),
      flow_agreement_t1 = COALESCE(EXCLUDED.flow_agreement_t1, training_features.flow_agreement_t1),
      flow_agreement_t2 = COALESCE(EXCLUDED.flow_agreement_t2, training_features.flow_agreement_t2),
      etf_tide_divergence_t1 = COALESCE(EXCLUDED.etf_tide_divergence_t1, training_features.etf_tide_divergence_t1),
      etf_tide_divergence_t2 = COALESCE(EXCLUDED.etf_tide_divergence_t2, training_features.etf_tide_divergence_t2),
      ncp_npp_gap_spx_t1 = COALESCE(EXCLUDED.ncp_npp_gap_spx_t1, training_features.ncp_npp_gap_spx_t1),
      ncp_npp_gap_spx_t2 = COALESCE(EXCLUDED.ncp_npp_gap_spx_t2, training_features.ncp_npp_gap_spx_t2),
      gex_oi_t1 = COALESCE(EXCLUDED.gex_oi_t1, training_features.gex_oi_t1),
      gex_oi_t2 = COALESCE(EXCLUDED.gex_oi_t2, training_features.gex_oi_t2),
      gex_oi_t3 = COALESCE(EXCLUDED.gex_oi_t3, training_features.gex_oi_t3),
      gex_oi_t4 = COALESCE(EXCLUDED.gex_oi_t4, training_features.gex_oi_t4),
      gex_vol_t1 = COALESCE(EXCLUDED.gex_vol_t1, training_features.gex_vol_t1),
      gex_vol_t2 = COALESCE(EXCLUDED.gex_vol_t2, training_features.gex_vol_t2),
      gex_dir_t1 = COALESCE(EXCLUDED.gex_dir_t1, training_features.gex_dir_t1),
      gex_dir_t2 = COALESCE(EXCLUDED.gex_dir_t2, training_features.gex_dir_t2),
      gex_oi_slope = COALESCE(EXCLUDED.gex_oi_slope, training_features.gex_oi_slope),
      charm_oi_t1 = COALESCE(EXCLUDED.charm_oi_t1, training_features.charm_oi_t1),
      charm_oi_t2 = COALESCE(EXCLUDED.charm_oi_t2, training_features.charm_oi_t2),
      agg_net_gamma = COALESCE(EXCLUDED.agg_net_gamma, training_features.agg_net_gamma),
      dte0_net_charm = COALESCE(EXCLUDED.dte0_net_charm, training_features.dte0_net_charm),
      dte0_charm_pct = COALESCE(EXCLUDED.dte0_charm_pct, training_features.dte0_charm_pct),
      gamma_wall_above_dist = COALESCE(EXCLUDED.gamma_wall_above_dist, training_features.gamma_wall_above_dist),
      gamma_wall_above_mag = COALESCE(EXCLUDED.gamma_wall_above_mag, training_features.gamma_wall_above_mag),
      gamma_wall_below_dist = COALESCE(EXCLUDED.gamma_wall_below_dist, training_features.gamma_wall_below_dist),
      gamma_wall_below_mag = COALESCE(EXCLUDED.gamma_wall_below_mag, training_features.gamma_wall_below_mag),
      neg_gamma_nearest_dist = COALESCE(EXCLUDED.neg_gamma_nearest_dist, training_features.neg_gamma_nearest_dist),
      neg_gamma_nearest_mag = COALESCE(EXCLUDED.neg_gamma_nearest_mag, training_features.neg_gamma_nearest_mag),
      gamma_asymmetry = COALESCE(EXCLUDED.gamma_asymmetry, training_features.gamma_asymmetry),
      charm_slope = COALESCE(EXCLUDED.charm_slope, training_features.charm_slope),
      charm_max_pos_dist = COALESCE(EXCLUDED.charm_max_pos_dist, training_features.charm_max_pos_dist),
      charm_max_neg_dist = COALESCE(EXCLUDED.charm_max_neg_dist, training_features.charm_max_neg_dist),
      gamma_0dte_allexp_agree = COALESCE(EXCLUDED.gamma_0dte_allexp_agree, training_features.gamma_0dte_allexp_agree),
      charm_pattern = COALESCE(EXCLUDED.charm_pattern, training_features.charm_pattern),
      feature_completeness = COALESCE(EXCLUDED.feature_completeness, training_features.feature_completeness),
      prev_day_range_pts = COALESCE(EXCLUDED.prev_day_range_pts, training_features.prev_day_range_pts),
      prev_day_direction = COALESCE(EXCLUDED.prev_day_direction, training_features.prev_day_direction),
      prev_day_vix_change = COALESCE(EXCLUDED.prev_day_vix_change, training_features.prev_day_vix_change),
      prev_day_range_cat = COALESCE(EXCLUDED.prev_day_range_cat, training_features.prev_day_range_cat),
      realized_vol_5d = COALESCE(EXCLUDED.realized_vol_5d, training_features.realized_vol_5d),
      realized_vol_10d = COALESCE(EXCLUDED.realized_vol_10d, training_features.realized_vol_10d),
      rv_iv_ratio = COALESCE(EXCLUDED.rv_iv_ratio, training_features.rv_iv_ratio),
      vix_term_slope = COALESCE(EXCLUDED.vix_term_slope, training_features.vix_term_slope),
      vvix_percentile = COALESCE(EXCLUDED.vvix_percentile, training_features.vvix_percentile),
      event_type = COALESCE(EXCLUDED.event_type, training_features.event_type),
      is_fomc = COALESCE(EXCLUDED.is_fomc, training_features.is_fomc),
      is_opex = COALESCE(EXCLUDED.is_opex, training_features.is_opex),
      days_to_next_event = COALESCE(EXCLUDED.days_to_next_event, training_features.days_to_next_event),
      event_count = COALESCE(EXCLUDED.event_count, training_features.event_count),
      dp_total_premium = COALESCE(EXCLUDED.dp_total_premium, training_features.dp_total_premium),
      dp_cluster_count = COALESCE(EXCLUDED.dp_cluster_count, training_features.dp_cluster_count),
      dp_top_cluster_dist = COALESCE(EXCLUDED.dp_top_cluster_dist, training_features.dp_top_cluster_dist),
      dp_support_premium = COALESCE(EXCLUDED.dp_support_premium, training_features.dp_support_premium),
      dp_resistance_premium = COALESCE(EXCLUDED.dp_resistance_premium, training_features.dp_resistance_premium),
      dp_support_resistance_ratio = COALESCE(EXCLUDED.dp_support_resistance_ratio, training_features.dp_support_resistance_ratio),
      dp_concentration = COALESCE(EXCLUDED.dp_concentration, training_features.dp_concentration),
      max_pain_0dte = COALESCE(EXCLUDED.max_pain_0dte, training_features.max_pain_0dte),
      max_pain_dist = COALESCE(EXCLUDED.max_pain_dist, training_features.max_pain_dist),
      opt_call_volume = COALESCE(EXCLUDED.opt_call_volume, training_features.opt_call_volume),
      opt_put_volume = COALESCE(EXCLUDED.opt_put_volume, training_features.opt_put_volume),
      opt_call_oi = COALESCE(EXCLUDED.opt_call_oi, training_features.opt_call_oi),
      opt_put_oi = COALESCE(EXCLUDED.opt_put_oi, training_features.opt_put_oi),
      opt_call_premium = COALESCE(EXCLUDED.opt_call_premium, training_features.opt_call_premium),
      opt_put_premium = COALESCE(EXCLUDED.opt_put_premium, training_features.opt_put_premium),
      opt_bullish_premium = COALESCE(EXCLUDED.opt_bullish_premium, training_features.opt_bullish_premium),
      opt_bearish_premium = COALESCE(EXCLUDED.opt_bearish_premium, training_features.opt_bearish_premium),
      opt_call_vol_ask = COALESCE(EXCLUDED.opt_call_vol_ask, training_features.opt_call_vol_ask),
      opt_put_vol_bid = COALESCE(EXCLUDED.opt_put_vol_bid, training_features.opt_put_vol_bid),
      opt_vol_pcr = COALESCE(EXCLUDED.opt_vol_pcr, training_features.opt_vol_pcr),
      opt_oi_pcr = COALESCE(EXCLUDED.opt_oi_pcr, training_features.opt_oi_pcr),
      opt_premium_ratio = COALESCE(EXCLUDED.opt_premium_ratio, training_features.opt_premium_ratio),
      opt_call_vol_vs_avg30 = COALESCE(EXCLUDED.opt_call_vol_vs_avg30, training_features.opt_call_vol_vs_avg30),
      opt_put_vol_vs_avg30 = COALESCE(EXCLUDED.opt_put_vol_vs_avg30, training_features.opt_put_vol_vs_avg30),
      iv_open = COALESCE(EXCLUDED.iv_open, training_features.iv_open),
      iv_max = COALESCE(EXCLUDED.iv_max, training_features.iv_max),
      iv_range = COALESCE(EXCLUDED.iv_range, training_features.iv_range),
      iv_crush_rate = COALESCE(EXCLUDED.iv_crush_rate, training_features.iv_crush_rate),
      iv_spike_count = COALESCE(EXCLUDED.iv_spike_count, training_features.iv_spike_count),
      iv_at_t2 = COALESCE(EXCLUDED.iv_at_t2, training_features.iv_at_t2),
      pcr_open = COALESCE(EXCLUDED.pcr_open, training_features.pcr_open),
      pcr_max = COALESCE(EXCLUDED.pcr_max, training_features.pcr_max),
      pcr_min = COALESCE(EXCLUDED.pcr_min, training_features.pcr_min),
      pcr_range = COALESCE(EXCLUDED.pcr_range, training_features.pcr_range),
      pcr_trend_t1_t2 = COALESCE(EXCLUDED.pcr_trend_t1_t2, training_features.pcr_trend_t1_t2),
      pcr_spike_count = COALESCE(EXCLUDED.pcr_spike_count, training_features.pcr_spike_count),
      oic_net_oi_change = COALESCE(EXCLUDED.oic_net_oi_change, training_features.oic_net_oi_change),
      oic_call_oi_change = COALESCE(EXCLUDED.oic_call_oi_change, training_features.oic_call_oi_change),
      oic_put_oi_change = COALESCE(EXCLUDED.oic_put_oi_change, training_features.oic_put_oi_change),
      oic_oi_change_pcr = COALESCE(EXCLUDED.oic_oi_change_pcr, training_features.oic_oi_change_pcr),
      oic_net_premium = COALESCE(EXCLUDED.oic_net_premium, training_features.oic_net_premium),
      oic_call_premium = COALESCE(EXCLUDED.oic_call_premium, training_features.oic_call_premium),
      oic_put_premium = COALESCE(EXCLUDED.oic_put_premium, training_features.oic_put_premium),
      oic_ask_ratio = COALESCE(EXCLUDED.oic_ask_ratio, training_features.oic_ask_ratio),
      oic_multi_leg_pct = COALESCE(EXCLUDED.oic_multi_leg_pct, training_features.oic_multi_leg_pct),
      oic_top_strike_dist = COALESCE(EXCLUDED.oic_top_strike_dist, training_features.oic_top_strike_dist),
      oic_concentration = COALESCE(EXCLUDED.oic_concentration, training_features.oic_concentration),
      iv_ts_slope_0d_30d = COALESCE(EXCLUDED.iv_ts_slope_0d_30d, training_features.iv_ts_slope_0d_30d),
      iv_ts_contango = COALESCE(EXCLUDED.iv_ts_contango, training_features.iv_ts_contango),
      iv_ts_spread = COALESCE(EXCLUDED.iv_ts_spread, training_features.iv_ts_spread),
      uw_rv_30d = COALESCE(EXCLUDED.uw_rv_30d, training_features.uw_rv_30d),
      uw_iv_rv_spread = COALESCE(EXCLUDED.uw_iv_rv_spread, training_features.uw_iv_rv_spread),
      uw_iv_overpricing_pct = COALESCE(EXCLUDED.uw_iv_overpricing_pct, training_features.uw_iv_overpricing_pct),
      iv_rank = COALESCE(EXCLUDED.iv_rank, training_features.iv_rank)
  `;
}

async function upsertLabels(l: FeatureRow): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO day_labels (
      date, analysis_id,
      structure_correct, recommended_structure, confidence, suggested_delta,
      charm_diverged, naive_charm_signal, spx_flow_signal,
      market_tide_signal, spy_flow_signal, gex_signal,
      flow_was_directional, settlement_direction, range_category,
      label_completeness
    ) VALUES (
      ${l.date}, ${l.analysis_id},
      ${l.structure_correct}, ${l.recommended_structure},
      ${l.confidence}, ${l.suggested_delta},
      ${l.charm_diverged}, ${l.naive_charm_signal}, ${l.spx_flow_signal},
      ${l.market_tide_signal}, ${l.spy_flow_signal}, ${l.gex_signal},
      ${l.flow_was_directional}, ${l.settlement_direction}, ${l.range_category},
      ${l.label_completeness}
    )
    -- Same COALESCE pattern as upsertFeatures: when extractLabelsForDate
    -- can't reach a downstream source (e.g. analyses table missing a row,
    -- or outcomes still pending), it returns labels with undefined fields
    -- which would clobber existing values without this guard.
    ON CONFLICT (date) DO UPDATE SET
      analysis_id = COALESCE(EXCLUDED.analysis_id, day_labels.analysis_id),
      structure_correct = COALESCE(EXCLUDED.structure_correct, day_labels.structure_correct),
      recommended_structure = COALESCE(EXCLUDED.recommended_structure, day_labels.recommended_structure),
      confidence = COALESCE(EXCLUDED.confidence, day_labels.confidence),
      suggested_delta = COALESCE(EXCLUDED.suggested_delta, day_labels.suggested_delta),
      charm_diverged = COALESCE(EXCLUDED.charm_diverged, day_labels.charm_diverged),
      naive_charm_signal = COALESCE(EXCLUDED.naive_charm_signal, day_labels.naive_charm_signal),
      spx_flow_signal = COALESCE(EXCLUDED.spx_flow_signal, day_labels.spx_flow_signal),
      market_tide_signal = COALESCE(EXCLUDED.market_tide_signal, day_labels.market_tide_signal),
      spy_flow_signal = COALESCE(EXCLUDED.spy_flow_signal, day_labels.spy_flow_signal),
      gex_signal = COALESCE(EXCLUDED.gex_signal, day_labels.gex_signal),
      flow_was_directional = COALESCE(EXCLUDED.flow_was_directional, day_labels.flow_was_directional),
      settlement_direction = COALESCE(EXCLUDED.settlement_direction, day_labels.settlement_direction),
      range_category = COALESCE(EXCLUDED.range_category, day_labels.range_category),
      label_completeness = COALESCE(EXCLUDED.label_completeness, day_labels.label_completeness)
  `;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const backfill = req.query.backfill === 'true';

  // Optional `?date=YYYY-MM-DD` — process only the named date, skipping the
  // time-window check. Useful for refetching a single day after a cron miss
  // or to test freshness lag without running a blanket backfill that risks
  // hitting rolling-window API failures on older dates.
  const dateParamRaw = req.query.date;
  const dateParam = typeof dateParamRaw === 'string' ? dateParamRaw : undefined;
  if (dateParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res
      .status(400)
      .json({ error: 'Invalid date param, expected YYYY-MM-DD' });
  }

  // Time window is bypassed for backfill OR explicit single-date requests.
  const skipTimeCheck = backfill || dateParam != null;
  const guard = cronGuard(req, res, {
    timeCheck: skipTimeCheck ? () => true : isPostClose,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const sql = getDb();
  // Single-date and current-day runs use the tighter timeout; only blanket
  // backfill needs the long one.
  if (backfill && dateParam == null) {
    await sql`SET statement_timeout = '120000'`; // 120s per statement for backfill
  } else {
    await sql`SET statement_timeout = '30000'`; // 30s per statement
  }

  // Diagnostic: log flow_data coverage for today before doing any work
  const today = guard.today;
  const coverage = await sql`
    SELECT source, COUNT(*) as rows
    FROM flow_data
    WHERE date = ${today}
    GROUP BY source
    ORDER BY source
  `;
  logger.info({ date: today, sources: coverage }, 'flow_data coverage');

  try {
    // Determine which dates to process
    let dates: string[];

    if (dateParam != null) {
      // Explicit single-date mode — highest precedence. Used for refetching
      // one day after a cron miss or freshness investigation.
      dates = [dateParam];
      logger.info({ date: dateParam }, 'build-features: single-date mode');
    } else if (backfill) {
      // Process all historical dates with flow data
      const rows = await sql`
        SELECT DISTINCT date FROM flow_data ORDER BY date ASC
      `;
      dates = rows.map((r) => toDateStr(r.date));
    } else {
      // Check if table is empty (first run = automatic backfill)
      const countResult =
        await sql`SELECT COUNT(*) AS cnt FROM training_features`;
      const count = Number(countResult[0]!.cnt);

      if (count === 0) {
        const rows = await sql`
          SELECT DISTINCT date FROM flow_data ORDER BY date ASC
        `;
        dates = rows.map((r) => toDateStr(r.date));
        logger.info(
          { dates: dates.length },
          'build-features: empty table, backfilling all dates',
        );
      } else {
        dates = [getETDateStr(new Date())];
      }
    }

    // Filter to valid YYYY-MM-DD dates only
    dates = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

    let featuresBuilt = 0;
    let labelsExtracted = 0;
    let errors = 0;

    for (const dateStr of dates) {
      try {
        const features = await buildFeaturesForDate(dateStr);
        if (features) {
          await upsertFeatures(features);
          featuresBuilt++;
        }

        const labels = await extractLabelsForDate(dateStr);
        if (labels) {
          await upsertLabels(labels);
          labelsExtracted++;
        }
      } catch (err) {
        logger.warn(
          { err, date: dateStr },
          'build-features: error processing date',
        );
        errors++;
      }
    }

    logger.info(
      { dates: dates.length, featuresBuilt, labelsExtracted, errors },
      'build-features: completed',
    );

    return res.status(200).json({
      job: 'build-features',
      dates: dates.length,
      featuresBuilt,
      labelsExtracted,
      errors,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'build-features');
    Sentry.captureException(err);
    logger.error({ err }, 'build-features error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
