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
    const { ticker } = parsed.data;

    // 0DTE expiry == ET-today. The endpoint is intentionally strict
    // about "today" — no date param. If you want a historical snapshot
    // you're reaching for a different feature (ML backfill).
    const today = getETDateStr(new Date());

    const [snapshot, netFlow] = await Promise.all([
      getGreekHeatmapSnapshot(ticker, today),
      getGreekHeatmapNetFlow(ticker, today),
    ]);

    setCacheHeaders(res, 30, 60);
    res.status(200).json({
      ticker,
      date: today,
      asOf: snapshot.asOf,
      underlyingPrice: snapshot.underlyingPrice,
      atmStrike: snapshot.atmStrike,
      regime: snapshot.regime,
      netGexK: snapshot.netGexK,
      topStrikes: snapshot.topStrikes,
      netFlow,
    });
  } catch (err) {
    logger.error({ err }, 'greek-heatmap endpoint failed');
    Sentry.captureException(err);
    res.status(500).json({ error: 'internal error' });
  }
}
