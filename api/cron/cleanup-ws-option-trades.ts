/**
 * GET /api/cron/cleanup-ws-option-trades
 *
 * Daily pre-market retention sweep for `ws_option_trades`. Deletes
 * rows older than today's ET date minus 2 days, so the table holds
 * the current trading day plus one prior session as a safety margin
 * for end-of-day outcome enrichment. The user's authoritative full-
 * tape archive is stored locally and on Cloudflare R2 — the DB only
 * needs the hot working set for live features.
 *
 * Read-horizon audit (no consumer reaches further than same-day):
 *   - detect-lottery-fires, detect-silent-boom: NOW() - SCAN_WINDOW_MIN
 *   - enrich-{lottery,silent-boom}-outcomes: today's fires/alerts forward
 *   - evaluate-round-trip: fire_time + WINDOW_MIN minutes
 *   - lottery-contract-tape: UI-supplied [fromTs, toTs] for a single fire
 *   - opening-flow-signal: opening 5-minute slice
 *
 * See docs/superpowers/specs/ws-option-trades-retention-2026-05-16.md
 * for the full design and verified scale.
 *
 * Schedule: `5 12 * * 1-5` (12:05 UTC, 5 min after the
 * cleanup-ws-gex-strike-expiry cron so they don't contend for the
 * 1 CU autoscale ceiling).
 * Auth: CRON_SECRET via cronGuard. No UW key — DB-only.
 * Time gate: none (pre-market run; `marketHours: false`).
 *
 * Batching: 50k-row chunks with a 295 s wall budget. Daily
 * steady-state load is ~6M rows so the cron drains in 2-3 minutes;
 * the loop exists for the one-time post-deploy catch-up (also
 * handled by docs/tmp/ws-option-trades-cleanup-psql-2026-05-16.sh).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 300 };

const BATCH_SIZE = 50_000;
const WALL_BUDGET_MS = 295_000;
const RETENTION_DAYS = 2;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  Sentry.setTag('cron.job', 'cleanup-ws-option-trades');

  const startedAt = Date.now();
  const db = getDb();
  let totalDeleted = 0;
  let batches = 0;
  let stopReason: 'drained' | 'wall_budget' = 'drained';

  // Sargable predicate: the TZ conversion is on the constant side, so
  // the column comparison stays bare and the `(executed_at)` B-tree
  // index serves the range scan directly. Computing the cutoff inside
  // Postgres also keeps DST handling delegated to tzdata.
  const cutoffSql =
    'executed_at < ($1::date - ' +
    `INTERVAL '${RETENTION_DAYS} days') AT TIME ZONE 'America/New_York'`;

  try {
    while (true) {
      const result = (await db.query(
        `WITH batch AS (
           SELECT id FROM ws_option_trades
           WHERE ${cutoffSql}
           LIMIT ${BATCH_SIZE}
         )
         DELETE FROM ws_option_trades
         WHERE id IN (SELECT id FROM batch)
         RETURNING id`,
        [today],
      )) as { id: number }[];

      const deleted = result.length;
      totalDeleted += deleted;
      batches += 1;

      if (deleted === 0) break;
      if (Date.now() - startedAt > WALL_BUDGET_MS) {
        stopReason = 'wall_budget';
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      { today, totalDeleted, batches, durationMs, stopReason },
      'ws_option_trades retention sweep complete',
    );

    res.status(200).json({
      today,
      totalDeleted,
      batches,
      durationMs,
      stopReason,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, today, totalDeleted, batches },
      'cleanup-ws-option-trades failed',
    );
    res.status(500).json({
      error: 'cleanup failed',
      totalDeleted,
      batches,
    });
  }
}
