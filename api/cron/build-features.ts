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
 * Environment: DATABASE_URL, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

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

// ── Checkpoint times (minutes after midnight ET) ───────────

const CHECKPOINTS = [
  { label: 't1', minutes: 600 }, // 10:00 AM
  { label: 't2', minutes: 630 }, // 10:30 AM
  { label: 't3', minutes: 660 }, // 11:00 AM
  { label: 't4', minutes: 690 }, // 11:30 AM
] as const;

const TOLERANCE_MINUTES = 5;

// ── Flow sources ───────────────────────────────────────────

interface FlowSource {
  source: string;
  prefix: string;
}

const FLOW_SOURCES: FlowSource[] = [
  { source: 'market_tide', prefix: 'mt' },
  { source: 'spx_flow', prefix: 'spx' },
  { source: 'spy_flow', prefix: 'spy' },
  { source: 'qqq_flow', prefix: 'qqq' },
  { source: 'spy_etf_tide', prefix: 'spy_etf' },
  { source: 'qqq_etf_tide', prefix: 'qqq_etf' },
  { source: 'zero_dte_index', prefix: 'zero_dte' },
  { source: 'zero_dte_greek_flow', prefix: 'delta_flow' },
];

// Sources that contribute to flow agreement (directional flow, not delta flow)
const AGREEMENT_SOURCES = [
  'market_tide',
  'market_tide_otm',
  'spx_flow',
  'spy_flow',
  'qqq_flow',
  'spy_etf_tide',
  'qqq_etf_tide',
  'zero_dte_index',
  'zero_dte_greek_flow',
];

// ── Types ──────────────────────────────────────────────────

interface FlowRow {
  timestamp: string;
  source: string;
  ncp: string | null;
  npp: string | null;
}

interface SpotRow {
  timestamp: string;
  gamma_oi: string | null;
  gamma_vol: string | null;
  gamma_dir: string | null;
  charm_oi: string | null;
  price: string | null;
}

interface StrikeRow {
  strike: string;
  price: string | null;
  call_gamma_oi: string | null;
  put_gamma_oi: string | null;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
}

interface GreekRow {
  expiry: string;
  dte: string;
  call_gamma: string | null;
  put_gamma: string | null;
  call_charm: string | null;
  put_charm: string | null;
}

interface SnapshotRow {
  vix: string | null;
  vix1d: string | null;
  vix9d: string | null;
  vvix: string | null;
  vix1d_vix_ratio: string | null;
  vix_vix9d_ratio: string | null;
  regime_zone: string | null;
  cluster_mult: string | null;
  dow_mult_hl: string | null;
  dow_label: string | null;
  spx_open: string | null;
  sigma: string | null;
  hours_remaining: string | null;
  ic_ceiling: string | null;
  put_spread_ceiling: string | null;
  call_spread_ceiling: string | null;
  opening_range_signal: string | null;
  opening_range_pct_consumed: string | null;
  is_event_day: boolean | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureRow = Record<string, any>;

// ── Helpers ────────────────────────────────────────────────

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Find the flow row closest to a target ET minute, within tolerance. */
function findNearestCandle(
  rows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): FlowRow | null {
  let best: FlowRow | null = null;
  let bestDiff = Infinity;

  for (const row of rows) {
    const ts = new Date(row.timestamp);
    const tsDate = getETDateStr(ts);
    if (tsDate !== dateStr) continue;

    const { hour, minute } = getETTime(ts);
    const totalMin = hour * 60 + minute;
    const diff = Math.abs(totalMin - targetMinutes);

    if (diff < bestDiff && diff <= TOLERANCE_MINUTES) {
      best = row;
      bestDiff = diff;
    }
  }

  return best;
}

function findNearestSpot(
  rows: SpotRow[],
  targetMinutes: number,
  dateStr: string,
): SpotRow | null {
  let best: SpotRow | null = null;
  let bestDiff = Infinity;

  for (const row of rows) {
    const ts = new Date(row.timestamp);
    const tsDate = getETDateStr(ts);
    if (tsDate !== dateStr) continue;

    const { hour, minute } = getETTime(ts);
    const totalMin = hour * 60 + minute;
    const diff = Math.abs(totalMin - targetMinutes);

    if (diff < bestDiff && diff <= TOLERANCE_MINUTES) {
      best = row;
      bestDiff = diff;
    }
  }

  return best;
}

/** Count how many directional flow sources agree on direction at a checkpoint. */
function computeFlowAgreement(
  allFlowRows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): number {
  let bullish = 0;
  let bearish = 0;

  for (const source of AGREEMENT_SOURCES) {
    const sourceRows = allFlowRows.filter((r) => r.source === source);
    const candle = findNearestCandle(sourceRows, targetMinutes, dateStr);
    if (!candle) continue;

    const ncp = num(candle.ncp);
    const npp = num(candle.npp);
    if (ncp == null || npp == null) continue;

    // Bullish = NCP > 0 (calls bought) or NPP < 0 (puts sold)
    // Use NCP direction as primary signal
    if (ncp > 0) bullish++;
    else if (ncp < 0) bearish++;
  }

  return Math.max(bullish, bearish);
}

/** Check if ETF Tide diverges from Net Flow at a checkpoint. */
function computeETFDivergence(
  allFlowRows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): boolean | null {
  const spyNet = findNearestCandle(
    allFlowRows.filter((r) => r.source === 'spy_flow'),
    targetMinutes,
    dateStr,
  );
  const spyETF = findNearestCandle(
    allFlowRows.filter((r) => r.source === 'spy_etf_tide'),
    targetMinutes,
    dateStr,
  );

  if (!spyNet || !spyETF) return null;
  const netNcp = num(spyNet.ncp);
  const etfNcp = num(spyETF.ncp);
  if (netNcp == null || etfNcp == null) return null;

  // Divergence = Net Flow and ETF Tide disagree on direction
  return (netNcp > 0 && etfNcp < 0) || (netNcp < 0 && etfNcp > 0);
}

/** Classify charm pattern from per-strike data. */
function classifyCharmPattern(
  strikes: StrikeRow[],
  atmPrice: number,
): string | null {
  if (strikes.length === 0) return null;

  const nearby = strikes.filter((s) => {
    const strike = num(s.strike);
    return strike != null && Math.abs(strike - atmPrice) <= 50;
  });

  if (nearby.length < 5) return null;

  let posAbove = 0;
  let negAbove = 0;
  let posBelow = 0;
  let negBelow = 0;

  for (const s of nearby) {
    const strike = num(s.strike)!;
    const netCharm = (num(s.call_charm_oi) ?? 0) + (num(s.put_charm_oi) ?? 0);
    if (strike >= atmPrice) {
      if (netCharm > 0) posAbove++;
      else negAbove++;
    } else if (netCharm > 0) posBelow++;
    else negBelow++;
  }

  const total = nearby.length;
  const totalNeg = negAbove + negBelow;
  const totalPos = posAbove + posBelow;

  if (totalNeg / total > 0.8) return 'all_negative';
  if (totalPos / total > 0.8) return 'all_positive';
  if (posAbove > negAbove * 2 && negBelow >= posBelow) return 'ccs_confirming';
  if (posBelow > negBelow * 2 && negAbove >= posAbove) return 'pcs_confirming';
  return 'mixed';
}

/** Engineer per-strike features: gamma walls, charm slope, etc. */
function engineerStrikeFeatures(
  strikes: StrikeRow[],
  atmPrice: number,
): FeatureRow {
  const features: FeatureRow = {};
  if (strikes.length === 0 || atmPrice === 0) return features;

  let wallAboveDist: number | null = null;
  let wallAboveMag: number | null = null;
  let wallBelowDist: number | null = null;
  let wallBelowMag: number | null = null;
  let negNearestDist: number | null = null;
  let negNearestMag: number | null = null;

  // Compute gamma stats for threshold
  const gammas = strikes.map(
    (s) => (num(s.call_gamma_oi) ?? 0) + (num(s.put_gamma_oi) ?? 0),
  );
  const mean = gammas.reduce((a, b) => a + b, 0) / gammas.length;
  const stddev = Math.sqrt(
    gammas.reduce((a, b) => a + (b - mean) ** 2, 0) / gammas.length,
  );
  const posThreshold = mean + 1.5 * stddev;
  const negThreshold = mean - 1.5 * stddev;

  let sumPosAbove = 0;
  let sumPosBelow = 0;
  let charmSumAbove = 0;
  let charmCountAbove = 0;
  let charmSumBelow = 0;
  let charmCountBelow = 0;
  let maxPosCharm = -Infinity;
  let maxPosCharmDist: number | null = null;
  let maxNegCharm = Infinity;
  let maxNegCharmDist: number | null = null;

  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i]!;
    const strike = num(s.strike);
    if (strike == null) continue;

    const netGamma = gammas[i]!;
    const netCharm = (num(s.call_charm_oi) ?? 0) + (num(s.put_charm_oi) ?? 0);
    const dist = strike - atmPrice;

    // Gamma walls
    if (netGamma > posThreshold) {
      if (dist > 0 && (wallAboveDist == null || dist < wallAboveDist)) {
        wallAboveDist = dist;
        wallAboveMag = netGamma;
      }
      if (
        dist < 0 &&
        (wallBelowDist == null || Math.abs(dist) < Math.abs(wallBelowDist))
      ) {
        wallBelowDist = Math.abs(dist);
        wallBelowMag = netGamma;
      }
    }
    if (netGamma < negThreshold) {
      const absDist = Math.abs(dist);
      if (negNearestDist == null || absDist < negNearestDist) {
        negNearestDist = absDist;
        negNearestMag = netGamma;
      }
    }

    // Gamma asymmetry
    if (netGamma > 0) {
      if (dist > 0) sumPosAbove += netGamma;
      else sumPosBelow += netGamma;
    }

    // Charm slope
    if (dist > 0) {
      charmSumAbove += netCharm;
      charmCountAbove++;
    } else if (dist < 0) {
      charmSumBelow += netCharm;
      charmCountBelow++;
    }

    // Max charm strikes
    if (netCharm > maxPosCharm) {
      maxPosCharm = netCharm;
      maxPosCharmDist = dist;
    }
    if (netCharm < maxNegCharm) {
      maxNegCharm = netCharm;
      maxNegCharmDist = dist;
    }
  }

  features.gamma_wall_above_dist = wallAboveDist;
  features.gamma_wall_above_mag = wallAboveMag;
  features.gamma_wall_below_dist = wallBelowDist;
  features.gamma_wall_below_mag = wallBelowMag;
  features.neg_gamma_nearest_dist = negNearestDist;
  features.neg_gamma_nearest_mag = negNearestMag;

  features.gamma_asymmetry = sumPosBelow > 0 ? sumPosAbove / sumPosBelow : null;

  const avgCharmAbove =
    charmCountAbove > 0 ? charmSumAbove / charmCountAbove : 0;
  const avgCharmBelow =
    charmCountBelow > 0 ? charmSumBelow / charmCountBelow : 0;
  features.charm_slope = avgCharmAbove - avgCharmBelow;

  features.charm_max_pos_dist =
    maxPosCharmDist != null && Number.isFinite(maxPosCharm)
      ? maxPosCharmDist
      : null;
  features.charm_max_neg_dist =
    maxNegCharmDist != null && Number.isFinite(maxNegCharm)
      ? maxNegCharmDist
      : null;

  features.charm_pattern = classifyCharmPattern(strikes, atmPrice);

  return features;
}

/** Normalize a Neon DATE value to YYYY-MM-DD string. */
function toDateStr(val: unknown): string {
  // Neon returns DATE columns as native JS Date objects
  if (val instanceof Date) {
    return val.toISOString().split('T')[0]!;
  }
  const s = String(val);
  // Handle ISO strings like "2026-02-09T00:00:00.000Z" — use regex to avoid matching T in GMT
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (match) return match[1]!;
  return s;
}

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

  // Day of week from date string (use noon ET to avoid DST edge cases)
  const d = new Date(`${dateStr}T12:00:00-05:00`);
  const dow = Number.isNaN(d.getTime()) ? null : d.getDay();
  features.day_of_week = dow;
  features.is_friday = dow === 5;

  // 2. Flow checkpoint features
  const allFlowRows = (await sql`
    SELECT timestamp, source, ncp, npp
    FROM flow_data
    WHERE date = ${dateStr}
    ORDER BY timestamp ASC
  `) as FlowRow[];

  for (const cp of CHECKPOINTS) {
    for (const fs of FLOW_SOURCES) {
      const sourceRows = allFlowRows.filter((r) => r.source === fs.source);
      const candle = findNearestCandle(sourceRows, cp.minutes, dateStr);

      if (fs.prefix === 'delta_flow') {
        features[`${fs.prefix}_total_${cp.label}`] = candle
          ? num(candle.ncp)
          : null;
        features[`${fs.prefix}_dir_${cp.label}`] = candle
          ? num(candle.npp)
          : null;
      } else {
        features[`${fs.prefix}_ncp_${cp.label}`] = candle
          ? num(candle.ncp)
          : null;
        features[`${fs.prefix}_npp_${cp.label}`] = candle
          ? num(candle.npp)
          : null;
      }
    }

    // Aggregated flow features
    features[`flow_agreement_${cp.label}`] = computeFlowAgreement(
      allFlowRows,
      cp.minutes,
      dateStr,
    );
    features[`etf_tide_divergence_${cp.label}`] = computeETFDivergence(
      allFlowRows,
      cp.minutes,
      dateStr,
    );

    const spxCandle = findNearestCandle(
      allFlowRows.filter((r) => r.source === 'spx_flow'),
      cp.minutes,
      dateStr,
    );
    features[`ncp_npp_gap_spx_${cp.label}`] = spxCandle
      ? (num(spxCandle.ncp) ?? 0) - (num(spxCandle.npp) ?? 0)
      : null;
  }

  // 3. GEX checkpoint features (from spot_exposures)
  const spotRows = (await sql`
    SELECT timestamp, gamma_oi, gamma_vol, gamma_dir, charm_oi, price
    FROM spot_exposures
    WHERE date = ${dateStr} AND ticker = 'SPX'
    ORDER BY timestamp ASC
  `) as SpotRow[];

  const firstCp = CHECKPOINTS[0];
  const lastCp = CHECKPOINTS.at(-1);
  const firstSpot = firstCp
    ? findNearestSpot(spotRows, firstCp.minutes, dateStr)
    : null;
  const lastSpot = lastCp
    ? findNearestSpot(spotRows, lastCp.minutes, dateStr)
    : null;

  for (const cp of CHECKPOINTS) {
    const spot = findNearestSpot(spotRows, cp.minutes, dateStr);
    features[`gex_oi_${cp.label}`] = spot ? num(spot.gamma_oi) : null;
    features[`gex_vol_${cp.label}`] = spot ? num(spot.gamma_vol) : null;
    features[`gex_dir_${cp.label}`] = spot ? num(spot.gamma_dir) : null;
    features[`charm_oi_${cp.label}`] = spot ? num(spot.charm_oi) : null;
  }

  // GEX trend slope: linear slope from T1 to T4
  const firstGex = firstSpot ? num(firstSpot.gamma_oi) : null;
  const lastGex = lastSpot ? num(lastSpot.gamma_oi) : null;
  features.gex_oi_slope =
    firstGex != null && lastGex != null ? lastGex - firstGex : null;

  // 4. Greek exposure features
  const greekRows = (await sql`
    SELECT expiry, dte, call_gamma, put_gamma, call_charm, put_charm
    FROM greek_exposure
    WHERE date = ${dateStr} AND ticker = 'SPX'
  `) as GreekRow[];

  const aggRow = greekRows.find((r) => Number(r.dte) === -1);
  const dte0Row = greekRows.find((r) => Number(r.dte) === 0);

  if (aggRow) {
    features.agg_net_gamma =
      (num(aggRow.call_gamma) ?? 0) + (num(aggRow.put_gamma) ?? 0);
  }

  if (dte0Row) {
    features.dte0_net_charm =
      (num(dte0Row.call_charm) ?? 0) + (num(dte0Row.put_charm) ?? 0);

    // 0DTE charm as % of total
    const totalCharm = greekRows.reduce(
      (sum, r) =>
        sum + Math.abs((num(r.call_charm) ?? 0) + (num(r.put_charm) ?? 0)),
      0,
    );
    const dte0Charm = Math.abs(features.dte0_net_charm as number);
    features.dte0_charm_pct =
      totalCharm > 0
        ? Math.round((dte0Charm / totalCharm) * 10000) / 10000
        : null;
  }

  // 5. Per-strike features (latest snapshot)
  const strikeRows = (await sql`
    WITH latest AS (
      SELECT MAX(timestamp) AS ts
      FROM strike_exposures
      WHERE date = ${dateStr} AND ticker = 'SPX' AND expiry = ${dateStr}::date
    )
    SELECT s.strike, s.price, s.call_gamma_oi, s.put_gamma_oi,
           s.call_charm_oi, s.put_charm_oi
    FROM strike_exposures s, latest l
    WHERE s.date = ${dateStr} AND s.ticker = 'SPX'
      AND s.expiry = ${dateStr}::date AND s.timestamp = l.ts
    ORDER BY s.strike ASC
  `) as StrikeRow[];

  const atmPrice = strikeRows.length > 0 ? (num(strikeRows[0]!.price) ?? 0) : 0;
  const strikeFeatures = engineerStrikeFeatures(strikeRows, atmPrice);
  Object.assign(features, strikeFeatures);

  // 0DTE vs all-expiry gamma agreement
  const allExpStrikes = (await sql`
    WITH latest AS (
      SELECT MAX(timestamp) AS ts
      FROM strike_exposures
      WHERE date = ${dateStr} AND ticker = 'SPX' AND expiry = '1970-01-01'
    )
    SELECT s.strike, s.call_gamma_oi, s.put_gamma_oi
    FROM strike_exposures s, latest l
    WHERE s.date = ${dateStr} AND s.ticker = 'SPX'
      AND s.expiry = '1970-01-01' AND s.timestamp = l.ts
    ORDER BY s.strike ASC
  `) as StrikeRow[];

  if (strikeRows.length > 0 && allExpStrikes.length > 0) {
    // Compare: do the top gamma walls align?
    const topZeroDte = strikeRows
      .map((s) => ({
        strike: num(s.strike)!,
        gamma: (num(s.call_gamma_oi) ?? 0) + (num(s.put_gamma_oi) ?? 0),
      }))
      .sort((a, b) => b.gamma - a.gamma)
      .slice(0, 3);

    const topAllExp = allExpStrikes
      .map((s) => ({
        strike: num(s.strike)!,
        gamma: (num(s.call_gamma_oi) ?? 0) + (num(s.put_gamma_oi) ?? 0),
      }))
      .sort((a, b) => b.gamma - a.gamma)
      .slice(0, 3);

    // Agreement = at least 1 top wall within ±10 pts
    const agrees = topZeroDte.some((z) =>
      topAllExp.some((a) => Math.abs(z.strike - a.strike) <= 10),
    );
    features.gamma_0dte_allexp_agree = agrees;
  }

  // 6. Phase 2 features: Previous day, realized vol, events, VIX term structure

  // Previous day features (from outcomes table)
  const prevDayRows = await sql`
    SELECT date, day_range_pts, close_vs_open, vix_close,
           CASE WHEN close_vs_open > 0 THEN 'UP' ELSE 'DOWN' END AS direction,
           CASE
             WHEN day_range_pts < 30 THEN 'NARROW'
             WHEN day_range_pts < 60 THEN 'NORMAL'
             WHEN day_range_pts < 100 THEN 'WIDE'
             ELSE 'EXTREME'
           END AS range_cat
    FROM outcomes
    WHERE date < ${dateStr}
    ORDER BY date DESC
    LIMIT 10
  `;

  if (prevDayRows.length > 0) {
    const prev = prevDayRows[0]!;
    features.prev_day_range_pts = num(prev.day_range_pts);
    features.prev_day_direction = prev.direction as string;
    features.prev_day_range_cat = prev.range_cat as string;

    // VIX change: today's VIX minus yesterday's VIX close
    if (features.vix != null && prev.vix_close != null) {
      features.prev_day_vix_change = features.vix - Number(prev.vix_close);
    }
  }

  // Realized volatility from log returns of settlement prices.
  // Query includes settlement so we can compute ln(S[i] / S[i-1]).
  // prevDayRows is ORDER BY date DESC, so index 0 is the most recent.
  const settlements = await sql\`
    SELECT settlement FROM outcomes
    WHERE date <= ${dateStr} AND settlement IS NOT NULL
    ORDER BY date DESC
    LIMIT 11
  \`;

  const prices = settlements.map((r) => Number(r.settlement));

  if (prices.length >= 6) {
    // Log returns: ln(P[i] / P[i+1]) — note: prices[0] is most recent
    const logReturns5: number[] = [];
    for (let i = 0; i < 5 && i + 1 < prices.length; i++) {
      logReturns5.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns5.length >= 5) {
      const mean5 =
        logReturns5.reduce((a, b) => a + b, 0) / logReturns5.length;
      const variance5 =
        logReturns5.reduce((a, b) => a + (b - mean5) ** 2, 0) /
        (logReturns5.length - 1);
      // Annualise: daily stdev * sqrt(252), express as percentage
      features.realized_vol_5d = Math.sqrt(variance5) * Math.sqrt(252) * 100;
    }
  }

  if (prices.length >= 11) {
    const logReturns10: number[] = [];
    for (let i = 0; i < 10 && i + 1 < prices.length; i++) {
      logReturns10.push(Math.log(prices[i]! / prices[i + 1]!));
    }
    if (logReturns10.length >= 10) {
      const mean10 =
        logReturns10.reduce((a, b) => a + b, 0) / logReturns10.length;
      const variance10 =
        logReturns10.reduce((a, b) => a + (b - mean10) ** 2, 0) /
        (logReturns10.length - 1);
      features.realized_vol_10d =
        Math.sqrt(variance10) * Math.sqrt(252) * 100;
    }
  }

  // RV/IV ratio: both realized_vol_5d and VIX are now annualised percentages
  if (
    features.realized_vol_5d != null &&
    features.vix != null &&
    features.vix > 0
  ) {
    features.rv_iv_ratio = features.realized_vol_5d / features.vix;
  }

  // VIX term structure
  if (
    features.vix1d != null &&
    features.vix9d != null &&
    features.vix != null &&
    features.vix > 0
  ) {
    features.vix_term_slope = (features.vix9d - features.vix1d) / features.vix;
  }

  // VVIX percentile (trailing 20-day)
  if (features.vvix != null) {
    const vvixHistory = await sql`
      SELECT vvix FROM training_features
      WHERE date < ${dateStr} AND vvix IS NOT NULL
      ORDER BY date DESC LIMIT 20
    `;
    if (vvixHistory.length >= 10) {
      const vvixValues = vvixHistory.map((r) => Number(r.vvix));
      const belowCount = vvixValues.filter((v) => v <= features.vvix!).length;
      features.vvix_percentile = belowCount / vvixValues.length;
    }
  }

  // Economic event features (from economic_events table)
  features.is_opex = false; // Default; overridden below if 3rd Friday
  features.is_fomc = false;
  features.event_count = 0;

  const eventRows = await sql`
    SELECT event_name, event_type, event_time
    FROM economic_events
    WHERE date = ${dateStr}
  `;

  if (eventRows.length > 0) {
    features.event_count = eventRows.length;
    // Use the most significant event type
    const types = new Set(eventRows.map((r) => r.event_type as string));
    const priority = [
      'FOMC',
      'CPI',
      'PCE',
      'JOBS',
      'GDP',
      'PMI',
      'RETAIL',
      'SENTIMENT',
      'OTHER',
    ];
    features.event_type = priority.find((p) => types.has(p)) ?? null;
    features.is_fomc = types.has('FOMC');
  }

  // Check if today is OPEX (3rd Friday of month)
  const opexDate = new Date(`${dateStr}T12:00:00-05:00`);
  if (!Number.isNaN(opexDate.getTime()) && opexDate.getDay() === 5) {
    const dayOfMonth = opexDate.getDate();
    features.is_opex = dayOfMonth >= 15 && dayOfMonth <= 21;
  }

  // Days to next event
  const nextEventRow = await sql`
    SELECT MIN(date) AS next_date
    FROM economic_events
    WHERE date > ${dateStr}
  `;
  if (nextEventRow.length > 0 && nextEventRow[0]!.next_date != null) {
    const nextDate = new Date(String(nextEventRow[0]!.next_date));
    const thisDate = new Date(`${dateStr}T12:00:00-05:00`);
    if (
      !Number.isNaN(nextDate.getTime()) &&
      !Number.isNaN(thisDate.getTime())
    ) {
      features.days_to_next_event = Math.round(
        (nextDate.getTime() - thisDate.getTime()) / (24 * 60 * 60 * 1000),
      );
    }
  }

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

    // Get T2 (10:30 AM = 630 min) flow direction
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
      event_type, is_fomc, is_opex, days_to_next_event, event_count
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
      ${f.event_type}, ${f.is_fomc}, ${f.is_opex}, ${f.days_to_next_event}, ${f.event_count}
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
      event_count = EXCLUDED.event_count
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const backfill = req.query.backfill === 'true';

  if (!backfill && !isPostClose()) {
    return res.status(200).json({
      skipped: true,
      reason: 'Outside post-close window (4:30-6:00 PM ET)',
    });
  }

  const startTime = Date.now();
  const sql = getDb();
  await sql`SET statement_timeout = '30000'`; // 30s per statement

  // Diagnostic: log flow_data coverage for today before doing any work
  const today = new Date().toISOString().slice(0, 10);
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
