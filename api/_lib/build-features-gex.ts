/**
 * GEX and Greek exposure feature engineering for build-features cron.
 *
 * Extracts checkpoint GEX values (gamma OI, volume, direction, charm),
 * GEX trend slope, aggregate gamma, 0DTE charm, and per-strike features
 * (gamma walls, charm slope, charm pattern, 0DTE/all-expiry agreement).
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import {
  type FeatureRow,
  type SpotRow,
  type StrikeRow,
  type GreekRow,
  CHECKPOINTS,
  num,
  findNearestSpot,
} from './build-features-types.js';

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
    const netCharm =
      (num(s.call_charm_oi) ?? 0) + (num(s.put_charm_oi) ?? 0);
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
  if (posAbove > negAbove * 2 && negBelow >= posBelow)
    return 'ccs_confirming';
  if (posBelow > negBelow * 2 && negAbove >= posAbove)
    return 'pcs_confirming';
  return 'mixed';
}

/** Engineer per-strike features: gamma walls, charm slope, etc. */
function computeStrikeFeatures(
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
    const netCharm =
      (num(s.call_charm_oi) ?? 0) + (num(s.put_charm_oi) ?? 0);
    const dist = strike - atmPrice;

    // Gamma walls
    if (netGamma > posThreshold) {
      if (dist > 0 && (wallAboveDist == null || dist < wallAboveDist)) {
        wallAboveDist = dist;
        wallAboveMag = netGamma;
      }
      if (
        dist < 0 &&
        (wallBelowDist == null ||
          Math.abs(dist) < Math.abs(wallBelowDist))
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

  features.gamma_asymmetry =
    sumPosBelow > 0 ? sumPosAbove / sumPosBelow : null;

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

/**
 * Engineer GEX checkpoint features, Greek exposure features,
 * and per-strike features (gamma walls, charm, 0DTE agreement).
 * Mutates `features` in place.
 */
export async function engineerGexFeatures(
  sql: NeonQueryFunction<false, false>,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  // GEX checkpoint features (from spot_exposures)
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

  // Greek exposure features
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
        sum +
        Math.abs((num(r.call_charm) ?? 0) + (num(r.put_charm) ?? 0)),
      0,
    );
    const dte0Charm = Math.abs(features.dte0_net_charm as number);
    features.dte0_charm_pct =
      totalCharm > 0
        ? Math.round((dte0Charm / totalCharm) * 10000) / 10000
        : null;
  }

  // Per-strike features (latest snapshot)
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

  const atmPrice =
    strikeRows.length > 0 ? (num(strikeRows[0]!.price) ?? 0) : 0;
  const strikeFeatures = computeStrikeFeatures(strikeRows, atmPrice);
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
    const topZeroDte = strikeRows
      .map((s) => ({
        strike: num(s.strike)!,
        gamma:
          (num(s.call_gamma_oi) ?? 0) + (num(s.put_gamma_oi) ?? 0),
      }))
      .sort((a, b) => b.gamma - a.gamma)
      .slice(0, 3);

    const topAllExp = allExpStrikes
      .map((s) => ({
        strike: num(s.strike)!,
        gamma:
          (num(s.call_gamma_oi) ?? 0) + (num(s.put_gamma_oi) ?? 0),
      }))
      .sort((a, b) => b.gamma - a.gamma)
      .slice(0, 3);

    // Agreement = at least 1 top wall within +/-10 pts
    const agrees = topZeroDte.some((z) =>
      topAllExp.some((a) => Math.abs(z.strike - a.strike) <= 10),
    );
    features.gamma_0dte_allexp_agree = agrees;
  }
}
