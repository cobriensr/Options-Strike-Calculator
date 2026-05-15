/**
 * GET /api/greek-heatmap?ticker=<SYMBOL>
 *
 * Returns the per-ticker 0DTE Greek heatmap snapshot used by the
 * GreekHeatmap section between Lottery Finder and SilentBoom:
 *
 *   {
 *     ticker, date, asOf,
 *     underlyingPrice, atmStrike,
 *     regime: 'Long Γ' | 'Short Γ' | null,
 *     netGexK,
 *     topStrikes: [...up to 5 by |net gamma OI|],
 *     netFlow: { cumulativeCallPrem, cumulativeCallVol,
 *                cumulativePutPrem, cumulativePutVol, asOf } | null,
 *   }
 *
 * Auth: owner-or-guest (matches /api/lottery-finder, /api/silent-boom-
 * feed). Endpoint is read-only and idempotent; the underlying data is
 * websocket-fed by uw-stream into ws_gex_strike_expiry + ws_net_flow_
 * per_ticker.
 *
 * Cache: 30s edge / 60s SWR — matches the frontend's 30s poll cadence
 * so brief fan-out coalesces without dropping the next minute's write.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { getETDateStr } from '../src/utils/timezone.js';

import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import {
  getGreekHeatmapNetFlow,
  getGreekHeatmapSnapshot,
} from './_lib/db-greek-heatmap.js';
import logger from './_lib/logger.js';
import { Sentry } from './_lib/sentry.js';
import { greekHeatmapQuerySchema } from './_lib/validation.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = greekHeatmapQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const { ticker, date } = parsed.data;

    // Default = ET-today for the live read. Historical dates (within
    // the 90-day Zod-enforced window) route through the same query
    // helpers, which transparently switch between live (ws_*) and
    // backfilled (net_flow_per_ticker_history) tables.
    const today = getETDateStr(new Date());
    const expiry = date ?? today;

    const [snapshot, netFlow] = await Promise.all([
      getGreekHeatmapSnapshot(ticker, expiry, today),
      getGreekHeatmapNetFlow(ticker, expiry, today),
    ]);

    // Today's data refreshes minutely; historical data is static.
    // Cache headers reflect that — historical snapshots can sit in
    // the edge for an hour without losing accuracy.
    if (expiry === today) {
      setCacheHeaders(res, 30, 60);
    } else {
      setCacheHeaders(res, 3600, 60);
    }
    res.status(200).json({
      ticker,
      date: expiry,
      asOf: snapshot.asOf,
      underlyingPrice: snapshot.underlyingPrice,
      atmStrike: snapshot.atmStrike,
      regime: snapshot.regime,
      netGexK: snapshot.netGexK,
      chainStrikes: snapshot.chainStrikes,
      topStrikes: snapshot.topStrikes,
      netFlow,
    });
  } catch (err) {
    logger.error({ err }, 'greek-heatmap endpoint failed');
    Sentry.captureException(err);
    res.status(500).json({ error: 'internal error' });
  }
}
