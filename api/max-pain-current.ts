/**
 * GET /api/max-pain-current
 *
 * Returns the current SPX max-pain strike (0DTE attractor, with fallback
 * to the nearest upcoming monthly expiry) for the `FuturesGammaPlaybook`
 * live view. Wraps the existing `api/_lib/max-pain.ts::fetchMaxPain`
 * helper used by the analyze-context pipeline.
 *
 * Response:
 *   { ticker: string, maxPain: number | null, asOf: string }
 *
 * Max pain is a nice-to-have signal, not a critical-path input — a UW
 * outage, non-OK response, or malformed payload returns `maxPain: null`
 * with status 200 rather than 500. Failures are still logged to Sentry.
 *
 * Historical max-pain is explicitly out of scope: the frontend computes
 * it client-side from per-strike open interest via `useGexPerStrike`.
 *
 * Owner-gated — max_pain derives from UW API data (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from './_lib/sentry.js';
import {
  checkBot,
  isMarketOpen,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { fetchMaxPain } from './_lib/max-pain.js';
import { getETDateStr } from '../src/utils/timezone.js';

const TICKER = 'SPX';

export interface MaxPainCurrentResponse {
  ticker: string;
  maxPain: number | null;
  asOf: string;
}

/**
 * Resolve the 0DTE-or-nearest entry from a list of UW max-pain entries.
 * Mirrors the selection rule in `max-pain.ts::formatMaxPainForClaude`:
 * exact match on the analysis date wins, otherwise the nearest expiry
 * on or after that date is the dominant gravitational anchor.
 */
function resolveMaxPainStrike(
  entries: Array<{ expiry: string; max_pain: string }>,
  analysisDate: string,
): number | null {
  if (entries.length === 0) return null;

  const chosen =
    entries.find((e) => e.expiry === analysisDate) ??
    entries
      .filter((e) => e.expiry >= analysisDate)
      .sort((a, b) => a.expiry.localeCompare(b.expiry))[0];

  if (!chosen) return null;

  const strike = Number.parseFloat(chosen.max_pain);
  return Number.isNaN(strike) ? null : strike;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/max-pain-current');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const asOf = new Date().toISOString();
    const today = getETDateStr(new Date());

    try {
      const apiKey = process.env.UW_API_KEY ?? '';
      const outcome = await fetchMaxPain(apiKey, today);

      let maxPain: number | null = null;
      if (outcome.kind === 'ok') {
        maxPain = resolveMaxPainStrike(outcome.data, today);
      } else if (outcome.kind === 'error') {
        // fetchMaxPain already logged + captured the error; we just
        // degrade to null so the frontend can render its empty state.
        logger.warn(
          { reason: outcome.reason },
          'max-pain-current: upstream UW fetch failed',
        );
      }

      const response: MaxPainCurrentResponse = {
        ticker: TICKER,
        maxPain,
        asOf,
      };
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(response);
    } catch (err) {
      // Unexpected failure (out-of-band from fetchMaxPain). Preserve
      // the never-throw contract: log to Sentry, return null payload.
      Sentry.captureException(err);
      logger.error({ err }, 'max-pain-current unexpected error');
      const fallback: MaxPainCurrentResponse = {
        ticker: TICKER,
        maxPain: null,
        asOf,
      };
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(fallback);
    }
  });
}
