/**
 * GET /api/gexbot
 *
 * Owner-or-guest read endpoint dispatching to multiple GEXBot views.
 * Single endpoint with `?view=` query param keeps the auth surface
 * narrow (one botid entry) and lets the frontend hook fan out without
 * needing a fetch-per-view.
 *
 * Views:
 *   ?view=snapshots-latest     → latest snapshot row per ticker
 *   ?view=convexity-trend      → 60-min zcvr timeseries per ticker
 *   ?view=maxchange-winners    → latest maxchange winner per (ticker, cat)
 *   ?view=sibling-confirm      → requires &ticker=AAPL&side=call|put
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import {
  getConvexityTrend,
  getLatestSnapshots,
  getMaxchangeWinners,
  getSiblingConfirmation,
} from './_lib/gexbot-queries.js';
import logger from './_lib/logger.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { gexbotQuerySchema } from './_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/gexbot');

  if (req.method !== 'GET') {
    done({ status: 405 });
    res.status(405).json({ error: 'GET only' });
    return;
  }

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  const parsed = gexbotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    done({ status: 400 });
    res
      .status(400)
      .json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }

  const { view, ticker, side } = parsed.data;

  try {
    let body: unknown;
    switch (view) {
      case 'snapshots-latest':
        body = { rows: await getLatestSnapshots() };
        break;
      case 'convexity-trend':
        body = { rows: await getConvexityTrend() };
        break;
      case 'maxchange-winners':
        body = { rows: await getMaxchangeWinners() };
        break;
      case 'sibling-confirm': {
        // Zod .refine guarantees these are set, but TS narrowing
        // doesn't propagate through .refine — guard explicitly to
        // avoid non-null assertions on user input.
        if (!ticker || !side) {
          done({ status: 400 });
          res.status(400).json({
            error: 'sibling-confirm requires ticker and side',
          });
          return;
        }
        body = { rows: await getSiblingConfirmation(ticker, side) };
        break;
      }
    }

    // Tight cache — 15s — lets the 30s frontend poll get a fresh read
    // on alternating ticks while shielding the DB from repeated tab
    // refreshes.
    setCacheHeaders(res, 15);
    done({ status: 200 });
    res.status(200).json(body);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: '/api/gexbot', view } });
    logger.error({ err, view, ticker, side }, '/api/gexbot failed');
    done({ status: 500 });
    res.status(500).json({ error: 'Internal error' });
  }
}
