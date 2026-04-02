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
  'dp_buyer_initiated',
  'dp_seller_initiated',
  'dp_net_bias',
  'dp_cluster_count',
  'dp_top_cluster_dist',
  'dp_support_premium',
  'dp_resistance_premium',
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

  // 1. Static features from market_snapshots (use earliest entry)
  const snapshots = await sql`
    SELECT vix, vix1d, vix9d, vvix, vix1d_vix_ratio, vix_vix9d_ratio,
           regime_zone, cluster_mult, dow_mult_hl, dow_label,
           spx_open, sigma, hours_remaining,
           ic_ceiling, put_spread_ceiling, call_spread_ceiling,
           opening_range_signal, opening_range_pct_consumed, is_event_day
    FROM market_snapshots
    WHERE date = ${dateStr}
    ORDER BY entry_time ASC
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
        ? JSON.parse(row.full_response as string)
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
      dp_total_premium, dp_buyer_initiated, dp_seller_initiated,
      dp_net_bias, dp_cluster_count, dp_top_cluster_dist,
      dp_support_premium, dp_resistance_premium,
      max_pain_0dte, max_pain_dist,
      opt_call_volume, opt_put_volume, opt_call_oi, opt_put_oi,
      opt_call_premium, opt_put_premium,
      opt_bullish_premium, opt_bearish_premium,
      opt_call_vol_ask, opt_put_vol_bid,
      opt_vol_pcr, opt_oi_pcr, opt_premium_ratio,
      opt_call_vol_vs_avg30, opt_put_vol_vs_avg30,
      iv_open, iv_max, iv_range, iv_crush_rate, iv_spike_count, iv_at_t2,
      pcr_open, pcr_max, pcr_min, pcr_range, pcr_trend_t1_t2, pcr_spike_count
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
      ${f.dp_total_premium}, ${f.dp_buyer_initiated}, ${f.dp_seller_initiated},
      ${f.dp_net_bias}, ${f.dp_cluster_count}, ${f.dp_top_cluster_dist},
      ${f.dp_support_premium}, ${f.dp_resistance_premium},
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
      ${f.pcr_range}, ${f.pcr_trend_t1_t2}, ${f.pcr_spike_count}
    )
    ON CONFLICT (date) DO UPDATE SET
      vix = EXCLUDED.vix, vix1d = EXCLUDED.vix1d, vix9d = EXCLUDED.vix9d,
      vvix = EXCLUDED.vvix, vix1d_vix_ratio = EXCLUDED.vix1d_vix_ratio,
      vix_vix9d_ratio = EXCLUDED.vix_vix9d_ratio,
      regime_zone = EXCLUDED.regime_zone, cluster_mult = EXCLUDED.cluster_mult,
      dow_mult = EXCLUDED.dow_mult, dow_label = EXCLUDED.dow_label,
      spx_open = EXCLUDED.spx_open, sigma = EXCLUDED.sigma,
      hours_remaining = EXCLUDED.hours_remaining,
      ic_ceiling = EXCLUDED.ic_ceiling,
      put_spread_ceiling = EXCLUDED.put_spread_ceiling,
      call_spread_ceiling = EXCLUDED.call_spread_ceiling,
      opening_range_signal = EXCLUDED.opening_range_signal,
      opening_range_pct_consumed = EXCLUDED.opening_range_pct_consumed,
      day_of_week = EXCLUDED.day_of_week, is_friday = EXCLUDED.is_friday,
      is_event_day = EXCLUDED.is_event_day,
      mt_ncp_t1 = EXCLUDED.mt_ncp_t1, mt_npp_t1 = EXCLUDED.mt_npp_t1,
      mt_ncp_t2 = EXCLUDED.mt_ncp_t2, mt_npp_t2 = EXCLUDED.mt_npp_t2,
      mt_ncp_t3 = EXCLUDED.mt_ncp_t3, mt_npp_t3 = EXCLUDED.mt_npp_t3,
      mt_ncp_t4 = EXCLUDED.mt_ncp_t4, mt_npp_t4 = EXCLUDED.mt_npp_t4,
      spx_ncp_t1 = EXCLUDED.spx_ncp_t1, spx_npp_t1 = EXCLUDED.spx_npp_t1,
      spx_ncp_t2 = EXCLUDED.spx_ncp_t2, spx_npp_t2 = EXCLUDED.spx_npp_t2,
      spx_ncp_t3 = EXCLUDED.spx_ncp_t3, spx_npp_t3 = EXCLUDED.spx_npp_t3,
      spx_ncp_t4 = EXCLUDED.spx_ncp_t4, spx_npp_t4 = EXCLUDED.spx_npp_t4,
      spy_ncp_t1 = EXCLUDED.spy_ncp_t1, spy_npp_t1 = EXCLUDED.spy_npp_t1,
      spy_ncp_t2 = EXCLUDED.spy_ncp_t2, spy_npp_t2 = EXCLUDED.spy_npp_t2,
      qqq_ncp_t1 = EXCLUDED.qqq_ncp_t1, qqq_npp_t1 = EXCLUDED.qqq_npp_t1,
      qqq_ncp_t2 = EXCLUDED.qqq_ncp_t2, qqq_npp_t2 = EXCLUDED.qqq_npp_t2,
      spy_etf_ncp_t1 = EXCLUDED.spy_etf_ncp_t1, spy_etf_npp_t1 = EXCLUDED.spy_etf_npp_t1,
      spy_etf_ncp_t2 = EXCLUDED.spy_etf_ncp_t2, spy_etf_npp_t2 = EXCLUDED.spy_etf_npp_t2,
      qqq_etf_ncp_t1 = EXCLUDED.qqq_etf_ncp_t1, qqq_etf_npp_t1 = EXCLUDED.qqq_etf_npp_t1,
      qqq_etf_ncp_t2 = EXCLUDED.qqq_etf_ncp_t2, qqq_etf_npp_t2 = EXCLUDED.qqq_etf_npp_t2,
      zero_dte_ncp_t1 = EXCLUDED.zero_dte_ncp_t1, zero_dte_npp_t1 = EXCLUDED.zero_dte_npp_t1,
      zero_dte_ncp_t2 = EXCLUDED.zero_dte_ncp_t2, zero_dte_npp_t2 = EXCLUDED.zero_dte_npp_t2,
      delta_flow_total_t1 = EXCLUDED.delta_flow_total_t1,
      delta_flow_dir_t1 = EXCLUDED.delta_flow_dir_t1,
      delta_flow_total_t2 = EXCLUDED.delta_flow_total_t2,
      delta_flow_dir_t2 = EXCLUDED.delta_flow_dir_t2,
      flow_agreement_t1 = EXCLUDED.flow_agreement_t1,
      flow_agreement_t2 = EXCLUDED.flow_agreement_t2,
      etf_tide_divergence_t1 = EXCLUDED.etf_tide_divergence_t1,
      etf_tide_divergence_t2 = EXCLUDED.etf_tide_divergence_t2,
      ncp_npp_gap_spx_t1 = EXCLUDED.ncp_npp_gap_spx_t1,
      ncp_npp_gap_spx_t2 = EXCLUDED.ncp_npp_gap_spx_t2,
      gex_oi_t1 = EXCLUDED.gex_oi_t1, gex_oi_t2 = EXCLUDED.gex_oi_t2,
      gex_oi_t3 = EXCLUDED.gex_oi_t3, gex_oi_t4 = EXCLUDED.gex_oi_t4,
      gex_vol_t1 = EXCLUDED.gex_vol_t1, gex_vol_t2 = EXCLUDED.gex_vol_t2,
      gex_dir_t1 = EXCLUDED.gex_dir_t1, gex_dir_t2 = EXCLUDED.gex_dir_t2,
      gex_oi_slope = EXCLUDED.gex_oi_slope,
      charm_oi_t1 = EXCLUDED.charm_oi_t1, charm_oi_t2 = EXCLUDED.charm_oi_t2,
      agg_net_gamma = EXCLUDED.agg_net_gamma,
      dte0_net_charm = EXCLUDED.dte0_net_charm,
      dte0_charm_pct = EXCLUDED.dte0_charm_pct,
      gamma_wall_above_dist = EXCLUDED.gamma_wall_above_dist,
      gamma_wall_above_mag = EXCLUDED.gamma_wall_above_mag,
      gamma_wall_below_dist = EXCLUDED.gamma_wall_below_dist,
      gamma_wall_below_mag = EXCLUDED.gamma_wall_below_mag,
      neg_gamma_nearest_dist = EXCLUDED.neg_gamma_nearest_dist,
      neg_gamma_nearest_mag = EXCLUDED.neg_gamma_nearest_mag,
      gamma_asymmetry = EXCLUDED.gamma_asymmetry,
      charm_slope = EXCLUDED.charm_slope,
      charm_max_pos_dist = EXCLUDED.charm_max_pos_dist,
      charm_max_neg_dist = EXCLUDED.charm_max_neg_dist,
      gamma_0dte_allexp_agree = EXCLUDED.gamma_0dte_allexp_agree,
      charm_pattern = EXCLUDED.charm_pattern,
      feature_completeness = EXCLUDED.feature_completeness,
      prev_day_range_pts = EXCLUDED.prev_day_range_pts,
      prev_day_direction = EXCLUDED.prev_day_direction,
      prev_day_vix_change = EXCLUDED.prev_day_vix_change,
      prev_day_range_cat = EXCLUDED.prev_day_range_cat,
      realized_vol_5d = EXCLUDED.realized_vol_5d,
      realized_vol_10d = EXCLUDED.realized_vol_10d,
      rv_iv_ratio = EXCLUDED.rv_iv_ratio,
      vix_term_slope = EXCLUDED.vix_term_slope,
      vvix_percentile = EXCLUDED.vvix_percentile,
      event_type = EXCLUDED.event_type,
      is_fomc = EXCLUDED.is_fomc,
      is_opex = EXCLUDED.is_opex,
      days_to_next_event = EXCLUDED.days_to_next_event,
      event_count = EXCLUDED.event_count,
      dp_total_premium = EXCLUDED.dp_total_premium,
      dp_buyer_initiated = EXCLUDED.dp_buyer_initiated,
      dp_seller_initiated = EXCLUDED.dp_seller_initiated,
      dp_net_bias = EXCLUDED.dp_net_bias,
      dp_cluster_count = EXCLUDED.dp_cluster_count,
      dp_top_cluster_dist = EXCLUDED.dp_top_cluster_dist,
      dp_support_premium = EXCLUDED.dp_support_premium,
      dp_resistance_premium = EXCLUDED.dp_resistance_premium,
      max_pain_0dte = EXCLUDED.max_pain_0dte,
      max_pain_dist = EXCLUDED.max_pain_dist,
      opt_call_volume = EXCLUDED.opt_call_volume,
      opt_put_volume = EXCLUDED.opt_put_volume,
      opt_call_oi = EXCLUDED.opt_call_oi,
      opt_put_oi = EXCLUDED.opt_put_oi,
      opt_call_premium = EXCLUDED.opt_call_premium,
      opt_put_premium = EXCLUDED.opt_put_premium,
      opt_bullish_premium = EXCLUDED.opt_bullish_premium,
      opt_bearish_premium = EXCLUDED.opt_bearish_premium,
      opt_call_vol_ask = EXCLUDED.opt_call_vol_ask,
      opt_put_vol_bid = EXCLUDED.opt_put_vol_bid,
      opt_vol_pcr = EXCLUDED.opt_vol_pcr,
      opt_oi_pcr = EXCLUDED.opt_oi_pcr,
      opt_premium_ratio = EXCLUDED.opt_premium_ratio,
      opt_call_vol_vs_avg30 = EXCLUDED.opt_call_vol_vs_avg30,
      opt_put_vol_vs_avg30 = EXCLUDED.opt_put_vol_vs_avg30,
      iv_open = EXCLUDED.iv_open, iv_max = EXCLUDED.iv_max,
      iv_range = EXCLUDED.iv_range, iv_crush_rate = EXCLUDED.iv_crush_rate,
      iv_spike_count = EXCLUDED.iv_spike_count, iv_at_t2 = EXCLUDED.iv_at_t2,
      pcr_open = EXCLUDED.pcr_open, pcr_max = EXCLUDED.pcr_max,
      pcr_min = EXCLUDED.pcr_min, pcr_range = EXCLUDED.pcr_range,
      pcr_trend_t1_t2 = EXCLUDED.pcr_trend_t1_t2,
      pcr_spike_count = EXCLUDED.pcr_spike_count
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
    ON CONFLICT (date) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id,
      structure_correct = EXCLUDED.structure_correct,
      recommended_structure = EXCLUDED.recommended_structure,
      confidence = EXCLUDED.confidence,
      suggested_delta = EXCLUDED.suggested_delta,
      charm_diverged = EXCLUDED.charm_diverged,
      naive_charm_signal = EXCLUDED.naive_charm_signal,
      spx_flow_signal = EXCLUDED.spx_flow_signal,
      market_tide_signal = EXCLUDED.market_tide_signal,
      spy_flow_signal = EXCLUDED.spy_flow_signal,
      gex_signal = EXCLUDED.gex_signal,
      flow_was_directional = EXCLUDED.flow_was_directional,
      settlement_direction = EXCLUDED.settlement_direction,
      range_category = EXCLUDED.range_category,
      label_completeness = EXCLUDED.label_completeness
  `;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const backfill = req.query.backfill === 'true';

  const guard = cronGuard(req, res, {
    timeCheck: backfill ? () => true : isPostClose,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const sql = getDb();
  await sql`SET statement_timeout = '30000'`; // 30s per statement

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

    if (backfill) {
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
