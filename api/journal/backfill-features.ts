/**
 * POST /api/journal/backfill-features
 *
 * Owner-gated proxy that triggers the build-features cron in backfill mode.
 *
 * The cron itself accepts only Bearer CRON_SECRET (no cookie auth), which
 * makes it un-callable from a browser. This endpoint validates the owner
 * via cookie, then forwards the request to the cron handler with the
 * server-side CRON_SECRET attached. The cron writes its JSON response
 * directly to `res`, so the body flows through unchanged.
 *
 * Use case: clicking "Backfill Features" in the UI after running a
 * data backfill (e.g. nope_ticks) to recompute training_features for
 * all dates that have flow_data.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import buildFeaturesHandler from '../cron/build-features.js';

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/journal/backfill-features');

  if (req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'POST only' });
  }

  if (await guardOwnerEndpoint(req, res, done)) return;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    done({ status: 500, error: 'missing_secret' });
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  // Synthesize a GET request that the cron handler will accept.
  // cronGuard reads req.method, req.headers.authorization, and req.query.
  const proxiedReq = {
    ...req,
    method: 'GET',
    query: { ...req.query, backfill: 'true' },
    headers: {
      ...req.headers,
      authorization: `Bearer ${cronSecret}`,
    },
  } as unknown as VercelRequest;

  try {
    await buildFeaturesHandler(proxiedReq, res);
    done({ status: res.statusCode });
  } catch (err) {
    Sentry.captureException(err);
    done({ status: 500, error: 'unhandled' });
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Backfill failed',
      });
    }
  }
}
