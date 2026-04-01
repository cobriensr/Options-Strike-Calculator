/**
 * GET /api/bwb-anchor
 *
 * Computes the proximity-weighted gamma centroid from the latest
 * per-strike exposure snapshot. Returns a suggested BWB sweet-spot
 * strike rounded to the nearest 5-pt SPX strike.
 *
 * Method: weight = |netGamma| / distance_from_price²
 *         centroid = sum(strike * weight) / sum(weight)
 *
 * Validated at T-1hr: 10.5 pts avg distance to settlement,
 * 100% within ±20 pts (n=5, as of March 2026).
 *
 * Also returns a charm-adjusted centroid (Option C, not yet
 * validated) that upweights strikes where charm is positive
 * (wall strengthening into close).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import { checkBot, setCacheHeaders, sendError } from './_lib/api-helpers.js';
import { getStrikeExposures } from './_lib/db-strike-helpers.js';
import { getETDateStr } from '../src/utils/timezone.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/bwb-anchor');
    const done = metrics.request('/api/bwb-anchor');

    try {
      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return sendError(res, 403, 'Access denied');
      }

      const today = getETDateStr(new Date());
      const strikes = await getStrikeExposures(today);

      if (strikes.length === 0) {
        setCacheHeaders(res, 30, 15);
        done({ status: 200 });
        return res.status(200).json({
          anchor: null,
          reason: 'No strike exposure data for today',
        });
      }

      const price = strikes[0]!.price;

      // ── Option A: Proximity-weighted gamma centroid ────────
      // weight = |netGamma| / distance²
      let weightedSum = 0;
      let totalWeight = 0;

      // ── Option C prep: Charm-adjusted centroid ─────────────
      // Upweight strikes where charm is positive (wall strengthening)
      // Not yet validated — included for future comparison.
      let charmWeightedSum = 0;
      let charmTotalWeight = 0;

      for (const s of strikes) {
        const dist = Math.max(Math.abs(s.strike - price), 1);
        const absGamma = Math.abs(s.netGamma);
        const proxWeight = absGamma / (dist * dist);

        weightedSum += s.strike * proxWeight;
        totalWeight += proxWeight;

        // Charm boost: 1.5x for positive charm (strengthening wall)
        const charmBoost = s.netCharm > 0 ? 1.5 : 1.0;
        const charmProxWeight = (absGamma * charmBoost) / (dist * dist);
        charmWeightedSum += s.strike * charmProxWeight;
        charmTotalWeight += charmProxWeight;
      }

      const centroid = totalWeight > 0 ? weightedSum / totalWeight : price;
      const charmCentroid =
        charmTotalWeight > 0 ? charmWeightedSum / charmTotalWeight : centroid;

      // Round to nearest 5-pt SPX strike
      const anchor = Math.round(centroid / 5) * 5;
      const charmAnchor = Math.round(charmCentroid / 5) * 5;

      setCacheHeaders(res, 60, 30);
      done({ status: 200 });
      return res.status(200).json({
        anchor,
        rawCentroid: Math.round(centroid * 10) / 10,
        charmAdjusted: charmAnchor,
        charmRawCentroid: Math.round(charmCentroid * 10) / 10,
        price: Math.round(price * 10) / 10,
        distFromPrice: Math.round((anchor - price) * 10) / 10,
        strikesUsed: strikes.length,
        timestamp: strikes[0]!.timestamp,
        method: 'proximity_weighted_gamma_centroid',
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      return sendError(res, 500, 'Internal server error');
    }
  });
}
