/**
 * GET /api/cron/cleanup-ws-gex-strike-expiry
 *
 * Daily pre-market retention sweep for `ws_gex_strike_expiry`. Deletes
 * rows whose `ts_minute` is older than today (ET), so the table holds
 * at most one trading day's worth of per-minute snapshots per
 * (ticker, expiry, strike).
 *
 * Pairs with the uw-stream daemon's expiry==today_ET filter
 * (`uw-stream/src/handlers/gex_strike_expiry.py`). Together they
 * enforce the invariant from the May 2026 retention spec:
 *
 *   docs/superpowers/specs/greek-heatmap-ws-retention-2026-05-15.md
 *
 * Without this sweep, the table grew to ~931k rows for a single
 * (ticker, expiry) slice and pushed the Greek Heatmap snapshot query
 * to ~18 s. Bounded retention drops cold-load to under a second.
 *
 * Schedule: `0 12 * * 1-5` (12:00 UTC, ~7-8am ET pre-market).
 * Auth: CRON_SECRET via cronGuard. No UW key — DB-only.
 * Time gate: none (pre-market run; `marketHours: false`).
 *
 * Batching: deletes are issued in 50k-row chunks until either the
 * table is drained or the per-run wall budget is exhausted. Daily
 * steady-state load across the full lottery universe lands in the
 * ~400k–700k rows / day range (peaks ~1M on days when several
 * individual-name weeklies expire alongside the ETF dailies); a
 * handful of batches drains it. The loop also exists for the
 * one-time post-deploy catch-up.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 300 };

const BATCH_SIZE = 50_000;
// Leave 5 s of headroom before maxDuration so the loop can exit
// cleanly with a partial report rather than getting killed mid-DELETE.
const WALL_BUDGET_MS = 295_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  Sentry.setTag('cron.job', 'cleanup-ws-gex-strike-expiry');

  const startedAt = Date.now();
  const db = getDb();
  let totalDeleted = 0;
  let batches = 0;
  let stopReason: 'drained' | 'wall_budget' = 'drained';

  // Two-pass DELETE preserving today's ET session, both passes sargable
  // against the (ticker, expiry, ts_minute) UNIQUE index. The earlier
  // single-predicate version wrapped `ts_minute` in `AT TIME ZONE
  // … ::date` which is non-sargable and seq-scanned per batch (~18 s
  // on the snapshot probe). The two-pass form:
  //
  // 1. `expiry < $today::date` — every past expiry's rows. The
  //    (ticker, expiry, …) index lets Postgres skip-scan or BitmapOr
  //    across tickers. Validated at ~10 s / 100k rows in the
  //    docs/tmp/greek-heatmap-cleanup-psql-2026-05-15.sh run.
  // 2. `expiry >= $today::date AND ts_minute < $cutoffUtc` — today's
  //    and future expiries that landed before today's ET midnight.
  //    `$cutoffUtc` is a `timestamptz` so the column comparison stays
  //    bare (no per-row function call), keeping the index usable.
  //
  // The cutoff is derived in Postgres from `$today::date AT TIME ZONE
  // 'America/New_York'` so DST is handled by tzdata (the daemon and
  // server cron run in UTC, but the trading-day boundary is ET).
  try {
    const passes: { label: string; where: string }[] = [
      { label: 'past_expiry', where: 'expiry < $1::date' },
      {
        label: 'pre_today_minutes',
        where:
          'expiry >= $1::date ' +
          "AND ts_minute < ($1::date AT TIME ZONE 'America/New_York')",
      },
    ];

    for (const pass of passes) {
      while (true) {
        const result = (await db.query(
          `WITH batch AS (
             SELECT id FROM ws_gex_strike_expiry
             WHERE ${pass.where}
             LIMIT ${BATCH_SIZE}
           )
           DELETE FROM ws_gex_strike_expiry
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
      if (stopReason === 'wall_budget') break;
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      { today, totalDeleted, batches, durationMs, stopReason },
      'ws_gex_strike_expiry retention sweep complete',
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
      'cleanup-ws-gex-strike-expiry failed',
    );
    res.status(500).json({
      error: 'cleanup failed',
      totalDeleted,
      batches,
    });
  }
}
