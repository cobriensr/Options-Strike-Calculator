/**
 * GET /api/flow-regime
 *
 * Flow Regime Recognition badge — read endpoint (Phase 2 of
 * docs/superpowers/specs/flow-regime-badge-2026-06-06.md).
 *
 * Serves the captured 30-min slot series for an ET trading day plus the
 * latest/current slot snapshot. The capture-flow-regime cron writes
 * (and refines) the in-progress slot every 5 min during market hours;
 * this endpoint just reads `flow_regime_snapshots`.
 *
 * RECOGNITION ONLY — the badge surfaces "today's flow is abnormal for
 * this time of day, as it forms" (useful for sizing / not fighting the
 * tape). It does NOT forecast direction. The 106-day point-in-time
 * backtest found options flow has no forward edge.
 *
 * - `?date=YYYY-MM-DD` (optional) replays a historical day; defaults to
 *   ET-today.
 * - Auth: owner-or-guest, same gating as the other data endpoints.
 * - 15s edge cache (setCacheHeaders(res, 15, 15)) — hot during the
 *   polling window, brief reuse keeps cost down.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { flowRegimeQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';
import { readFlowRegimeDay } from './_lib/flow-regime-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = flowRegimeQuerySchema.safeParse(req.query);
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

    const date = parsed.data.date ?? getETDateStr(new Date());
    const { slots, latest } = await readFlowRegimeDay(date);

    // 15s CDN cache. Live data is fast-moving but the endpoint is hot
    // during the polling window — brief reuse keeps cost down.
    setCacheHeaders(res, 15, 15);
    res.status(200).json({ date, slots, latest });
  } catch (err) {
    // Don't surface raw exception messages to the client — they can leak
    // DB connection strings or driver internals. Sentry + pino retain
    // the full details server-side.
    Sentry.captureException(err);
    logger.error({ err }, 'flow-regime error');
    res.status(500).json({ error: 'Internal server error' });
  }
}
