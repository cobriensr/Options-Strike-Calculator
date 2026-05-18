/**
 * GET /api/cron/rollup-ws-gex-strike-expiry
 *
 * Daily EOD rollup: copies today's `ws_gex_strike_expiry` rows into
 * the `strike_exposures` archive with per-minute `ts_minute` values
 * preserved. Gives the Greek Heatmap's historical view a LIVE scrubber
 * for every lottery ticker the WS captured, rather than the single
 * EOD-snapshot row that the one-shot REST backfill writes.
 *
 * Spec: docs/superpowers/specs/ws-gex-strike-expiry-rollup-2026-05-17.md
 *
 * Schedule: `30 22 * * 1-5` (22:30 UTC = 6:30 PM EDT / 5:30 PM EST).
 *   - AFTER the cash close (20:00 UTC EDT / 21:00 UTC EST) so all
 *     intraday WS pushes for the day are landed.
 *   - AFTER the 22:00 UTC restatement-reconcile crons so we don't
 *     compete for DB write locks.
 *   - BEFORE the next-day 12:00 UTC `cleanup-ws-gex-strike-expiry`
 *     retention sweep so the WS source rows still exist.
 *
 * Auth: CRON_SECRET via cronGuard. No UW key — DB-only.
 * Time gate: `marketHours: false` — after-close run.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { rollupWsGexToStrikeExposures } from '../_lib/rollup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  Sentry.setTag('cron.job', 'rollup-ws-gex-strike-expiry');

  const db = getDb();

  try {
    const { inserted, durationMs } = await rollupWsGexToStrikeExposures(
      db,
      today,
    );

    logger.info(
      { today, inserted, durationMs },
      'ws_gex_strike_expiry → strike_exposures rollup complete',
    );

    res.status(200).json({
      today,
      inserted,
      durationMs,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, today }, 'rollup-ws-gex-strike-expiry failed');
    res.status(500).json({ error: 'rollup failed' });
  }
}
