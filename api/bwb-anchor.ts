/**
 * GET /api/bwb-anchor
 *
 * Computes proximity-weighted gamma centroids from both 0 DTE and
 * 1 DTE per-strike exposure snapshots. Uses concentration-based
 * regime switching to pick the best anchor strike.
 *
 * Method: weight = |netGamma| / distance_from_price^2
 *         centroid = sum(strike * weight) / sum(weight)
 *
 * Regime: If 0 DTE gamma is concentrated (top-3 share >= 0.40),
 *         use 0 DTE centroid. Otherwise fall back to 1 DTE centroid
 *         which is less noisy.
 *
 * Confidence:  HIGH (disagreement <= 10 pts)
 *              MEDIUM (disagreement <= 20 pts)
 *              LOW (disagreement > 20 pts)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import { checkBot, setCacheHeaders, sendError } from './_lib/api-helpers.js';
import { getStrikeExposuresByExpiry } from './_lib/db-strike-helpers.js';
import type { StrikeExposureRow } from './_lib/db-strike-helpers.js';
import { getETDateStr } from '../src/utils/timezone.js';

// ── Helpers ────────────────────────────────────────────────────

/**
 * Compute proximity-weighted centroid and top-3 gamma concentration.
 */
function computeProxCentroid(
  strikes: StrikeExposureRow[],
): { centroid: number; concentration: number } {
  const price = strikes[0]!.price;
  let weightedSum = 0;
  let totalWeight = 0;

  // Concentration: top-3 |gamma| share
  const absGammas = strikes.map((s) => Math.abs(s.netGamma));
  const totalAbsGamma = absGammas.reduce((a, b) => a + b, 0);
  const top3 = [...absGammas]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((a, b) => a + b, 0);
  const concentration = totalAbsGamma > 0 ? top3 / totalAbsGamma : 0;

  for (const s of strikes) {
    const dist = Math.max(Math.abs(s.strike - price), 1);
    const absGamma = Math.abs(s.netGamma);
    const proxWeight = absGamma / (dist * dist);
    weightedSum += s.strike * proxWeight;
    totalWeight += proxWeight;
  }

  const centroid = totalWeight > 0 ? weightedSum / totalWeight : price;
  return { centroid, concentration };
}

/**
 * Compute charm-adjusted centroid from a set of strikes.
 * Upweights strikes where charm is positive (wall strengthening).
 */
function computeCharmCentroid(strikes: StrikeExposureRow[]): number {
  const price = strikes[0]!.price;
  let charmWeightedSum = 0;
  let charmTotalWeight = 0;

  for (const s of strikes) {
    const dist = Math.max(Math.abs(s.strike - price), 1);
    const absGamma = Math.abs(s.netGamma);
    const charmBoost = s.netCharm > 0 ? 1.5 : 1.0;
    const charmProxWeight = (absGamma * charmBoost) / (dist * dist);
    charmWeightedSum += s.strike * charmProxWeight;
    charmTotalWeight += charmProxWeight;
  }

  return charmTotalWeight > 0 ? charmWeightedSum / charmTotalWeight : price;
}

// ── Handler ────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/bwb-anchor');
    const done = metrics.request('/api/bwb-anchor');

    try {
      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return sendError(res, 403, 'Access denied');
      }

      // Accept ?date=YYYY-MM-DD for backtest mode, default to today
      const dateParam =
        typeof req.query.date === 'string' ? req.query.date : '';
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
        ? dateParam
        : getETDateStr(new Date());

      // Fetch 0 DTE and 1 DTE in parallel
      const [strikes0dte, strikes1dte] = await Promise.all([
        getStrikeExposuresByExpiry(date, '0dte'),
        getStrikeExposuresByExpiry(date, '1dte'),
      ]);

      if (strikes0dte.length === 0) {
        setCacheHeaders(res, 30, 15);
        done({ status: 200 });
        return res.status(200).json({
          anchor: null,
          reason: `No strike exposure data for ${date}`,
        });
      }

      const price = strikes0dte[0]!.price;

      // Compute 0 DTE centroid + concentration
      const { centroid: centroid0dte, concentration } =
        computeProxCentroid(strikes0dte);

      // Compute 1 DTE centroid (null if no data)
      const has1dte = strikes1dte.length > 0;
      const centroid1dte = has1dte
        ? computeProxCentroid(strikes1dte).centroid
        : null;

      // Regime switching: if 0 DTE concentration < 0.40, prefer
      // 1 DTE centroid (less noisy). Fall back to 0 DTE if no
      // 1 DTE data.
      const regime: '0dte' | '1dte' =
        concentration < 0.4 && has1dte ? '1dte' : '0dte';
      const selectedCentroid =
        regime === '1dte' ? centroid1dte! : centroid0dte;

      // Disagreement between centroids (0 if only one available)
      const disagreement =
        centroid1dte !== null
          ? Math.abs(centroid0dte - centroid1dte)
          : 0;

      // Confidence based on disagreement
      const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
        disagreement <= 10
          ? 'HIGH'
          : disagreement <= 20
            ? 'MEDIUM'
            : 'LOW';

      // Round to nearest 5-pt SPX strike
      const anchor = Math.round(selectedCentroid / 5) * 5;

      // Charm-adjusted centroid (stays on 0 DTE data)
      const charmCentroid = computeCharmCentroid(strikes0dte);
      const charmAdjusted = Math.round(charmCentroid / 5) * 5;

      setCacheHeaders(res, 60, 30);
      done({ status: 200 });
      return res.status(200).json({
        // Primary recommendation
        anchor,

        // Both centroids (rounded to 5-pt)
        centroid0dte: Math.round(centroid0dte / 5) * 5,
        centroid1dte:
          centroid1dte !== null
            ? Math.round(centroid1dte / 5) * 5
            : null,

        // Composite strategy signals
        concentration: Math.round(concentration * 1000) / 1000,
        disagreement: Math.round(disagreement * 10) / 10,
        confidence,
        regime,

        // Existing fields
        charmAdjusted,
        price: Math.round(price * 10) / 10,
        distFromPrice: Math.round((anchor - price) * 10) / 10,
        strikesUsed: strikes0dte.length,
        timestamp: strikes0dte[0]!.timestamp,
        method: 'prox_weighted_gamma_centroid_dual_dte',
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      return sendError(res, 500, 'Internal server error');
    }
  });
}
