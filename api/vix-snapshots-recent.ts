/**
 * GET /api/vix-snapshots-recent
 *
 * Returns today's intraday VIX snapshots (vix, vix1d, vix9d, spx) so
 * the frontend can compute rolling deltas for the VIX term-structure
 * trajectory indicator — the "is the VIX9D/VIX ratio climbing while
 * SPX rallies?" co-movement signal.
 *
 * Ratios are intentionally NOT pre-computed here: the frontend renders
 * them in its own convention (`vix9d / vix`), so returning raw values
 * keeps direction unambiguous and lets the client pick any window it
 * wants (5m, 15m, 30m) without endpoint changes.
 *
 * Owner-or-guest — snapshot history is part of the owner's workflow,
 * not guest-facing data.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecentVixSnapshots } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/vix-snapshots-recent');
    const done = metrics.request('/api/vix-snapshots-recent');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });

      const snapshots = await getRecentVixSnapshots(today);

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ date: today, snapshots });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'vix-snapshots-recent fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
