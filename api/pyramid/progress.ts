/**
 * GET /api/pyramid/progress — pyramid trade tracker progress counters.
 *
 * Returns the shape produced by `getProgressCounts()` in db-pyramid.ts:
 *   - total_chains
 *   - chains_by_day_type (trend, chop, news, mixed, unspecified)
 *   - elapsed_calendar_days (since first logged chain, in ET)
 *   - fill_rates (per-column fraction of non-null leg values in [0, 1])
 *
 * Owner-only. No caching — volumes stay small for single-owner use.
 */

import { Sentry, metrics } from '../_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { getProgressCounts } from '../_lib/db-pyramid.js';
import logger from '../_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/pyramid/progress');

  if (req.method !== 'GET') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET only' });
  }

  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;

  try {
    const progress = await getProgressCounts();
    done({ status: 200 });
    return res.status(200).json(progress);
  } catch (err) {
    done({ status: 500, error: 'unhandled' });
    Sentry.captureException(err);
    logger.error({ err }, 'pyramid progress endpoint error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
