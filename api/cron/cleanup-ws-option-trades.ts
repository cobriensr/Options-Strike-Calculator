/**
 * GET /api/cron/cleanup-ws-option-trades
 *
 * Retention sweep for `ws_option_trades`. Deletes rows older than today's ET
 * date minus WS_OPTION_TRADES_RETENTION_DAYS (api/_lib/constants.ts) CALENDAR
 * days, OLDEST FIRST, as a safety margin for end-of-day outcome enrichment.
 * With N = 2 a session expires at ET midnight three calendar days later
 * (Mon→Thu, …, Fri→Mon), so Friday's session is gone before Monday opens and
 * no Monday reader can rely on Friday's tape here. The user's authoritative
 * full-tape archive is stored locally and on Cloudflare R2 — the DB only
 * needs the hot working set for live features.
 *
 * Read-horizon audit (the enrichment crons read past same-day):
 *   - detect-lottery-fires, detect-silent-boom: NOW() - SCAN_WINDOW_MIN
 *   - enrich-lottery-outcomes, enrich-silent-boom-outcomes,
 *     enrich-periscope-lottery-outcomes: unenriched fires/alerts back to
 *     NOW() - WS_OPTION_TRADES_RETENTION_DAYS
 *     (bounded by this sweep so a pruned or partially-pruned tape is never
 *     read as an outcome)
 *   - evaluate-round-trip: fire_time + WINDOW_MIN minutes
 *   - lottery-contract-tape: UI-supplied [fromTs, toTs] for a single fire, no
 *     retention handling. A fire's tape is empty from the ET midnight its
 *     session expires (Wednesday's fires on Saturday, Thursday's on Sunday);
 *     before the hourly cadence it lingered until the next weekday 12:05 UTC
 *     run. Same rule, now enforced promptly; not a bug.
 *   - opening-flow-signal: opening 5-minute slice
 *   - capture-flow-regime(-daily): one 30-min slot window of today or the
 *     previous weekday, skipped when the date is older than today minus this
 *     constant (flow-regime-slot-daily.ts `isWithinTradeRetention`)
 *
 * Schedule: `5 0-12,22-23 * * *` — hourly at :05 from 22:05 through 12:05 UTC,
 * every day including weekends. Never 13–21 UTC, where batch deletes would
 * contend with uw-stream's market-hours inserts. Cadence math (measured in
 * docs/superpowers/specs/flow-regime-and-retention-2026-10-02.md): intake is
 * ~8.5M rows per session and one session expires each ET midnight Thu–Mon; a
 * run deletes ~5.9M rows, so the 8–9 runs between ET midnight and 12:05 UTC
 * clear a session in two. The old Mon–Fri 12:05 run had 36.5M rows/week of
 * capacity against ~42.6M of intake and fell steadily behind.
 *
 * Ordering: each batch takes the OLDEST expired rows via the `(executed_at)`
 * index, starting at the previous batch's frontier so it never re-walks index
 * entries this run already deleted. The old unordered `LIMIT` planned as a
 * Seq Scan in physical order and left every day it touched partially pruned.
 *
 * Backlog signal: a run that stops on the wall budget with a full last batch
 * logs a warning with the planner's estimate of expired rows remaining and the
 * frontier's lag behind the cutoff. It also sends a fingerprinted Sentry
 * warning when that lag exceeds BACKLOG_ALERT_LAG_HOURS (more than one session
 * outstanding = the sweep is not keeping pace).
 *
 * Auth: CRON_SECRET via cronGuard. No UW key — DB-only.
 * Time gate: none (`marketHours: false`); the schedule keeps it off-hours.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { cronGuard } from '../_lib/api-helpers.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export const config = { maxDuration: 300 };

const JOB = 'cleanup-ws-option-trades';
const BATCH_SIZE = 50_000;

/**
 * Stop issuing batches once elapsed time plus the slowest batch so far would
 * pass this. `startedAt` is taken inside withCronCheckin, so the in-progress
 * and completion check-ins (≤ 5 s each) sit outside it. That leaves ~10 s for
 * the final batch to overrun the slowest so far, plus the backlog estimate and
 * the response. Beyond that the invocation is killed mid-statement; the DELETE
 * is atomic, and the next hourly run picks up where it stopped.
 */
const WALL_BUDGET_MS = 280_000;

/**
 * A budget stop sends a Sentry warning only when the oldest expired row still
 * present is more than this far behind the cutoff, i.e. more than one session
 * is outstanding. The first post-midnight run of a normal ~9M-row session
 * stops on the budget ~10–14 h behind and drains on the next hourly run; that
 * is logged, not paged.
 */
const BACKLOG_ALERT_LAG_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * The cutoff instant: ET midnight N calendar days before `today` ($1).
 * Computed in Postgres so DST is tzdata's job. The TZ conversion sits on the
 * constant side, so the column comparison stays bare and the `(executed_at)`
 * B-tree index serves the range scan.
 */
const CUTOFF_SQL =
  `(($1::date - INTERVAL '${WS_OPTION_TRADES_RETENTION_DAYS} days') ` +
  `AT TIME ZONE 'America/New_York')`;

/**
 * One oldest-first batch. ctid rather than id: the table is insert-only
 * (uw-stream INSERT … ON CONFLICT DO NOTHING; pg_stat n_tup_upd = 0), and the
 * ctids are read and deleted inside one statement under one snapshot, so a
 * selected tuple can neither move nor have its slot reused before the DELETE
 * reaches it (VACUUM can't reclaim a tuple this snapshot still sees as live).
 * That makes the delete a Tid Scan instead of 50k primary-key probes. A
 * concurrent run that already deleted a tuple just makes this one skip it.
 *
 * $2 is the previous batch's frontier (null on the first batch). Starting the
 * index scan there skips the entries this run already deleted. Without it,
 * batch k would walk all (k − 1) × 50k dead entries from the front of
 * executed_idx, heap-fetching the latest batch's. `>=` keeps rows tied on the
 * frontier that the previous LIMIT cut off. A late insert older than the
 * frontier is caught by the next run's unbounded first batch.
 *
 * Returns the count, the newest executed_at deleted (the frontier: every
 * expired row still present is at or after it) and the cutoff — never the
 * 50k ids.
 */
const BATCH_SQL = `
  WITH del AS (
    DELETE FROM ws_option_trades
    WHERE ctid = ANY (ARRAY(
      SELECT ctid FROM ws_option_trades
      WHERE executed_at < ${CUTOFF_SQL}
        AND executed_at >= COALESCE($2::timestamptz, '-infinity')
      ORDER BY executed_at
      LIMIT ${BATCH_SIZE}
    ))
    RETURNING executed_at
  )
  SELECT count(*)::int AS deleted,
         max(executed_at) AS frontier,
         ${CUTOFF_SQL} AS cutoff
  FROM del`;

/** Planner-only row estimate of the expired rows still present (no execution). */
const BACKLOG_ESTIMATE_SQL =
  'EXPLAIN (FORMAT JSON) SELECT 1 FROM ws_option_trades ' +
  `WHERE executed_at < ${CUTOFF_SQL}`;

/** A timestamptz as the Neon driver returns it. */
type RawTimestamp = Date | string | null | undefined;

interface BatchResult {
  deleted: number;
  frontier: RawTimestamp;
  cutoff: RawTimestamp;
}

interface Backlog {
  estimatedBacklogRows: number | null;
  /** Newest row deleted in the last batch ≈ the oldest expired row left. */
  oldestRemaining: string | null;
  cutoff: string | null;
  /** Hours the deletion frontier trails the cutoff. */
  lagHours: number | null;
}

function toDate(v: RawTimestamp): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validate the batch aggregate. `count(*)` over the DELETE always yields one
 * row, so anything else is a driver/DB fault — thrown so it surfaces as a
 * failed run rather than being read as "0 deleted → drained → success".
 */
function parseBatch(rows: unknown): BatchResult {
  const row = Array.isArray(rows)
    ? (rows[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!row || typeof row.deleted !== 'number') {
    throw new Error(
      `${JOB}: unexpected batch result ${JSON.stringify(rows)?.slice(0, 200)}`,
    );
  }
  return {
    deleted: row.deleted,
    frontier: row.frontier as RawTimestamp,
    cutoff: row.cutoff as RawTimestamp,
  };
}

/** Pull `Plan Rows` out of an `EXPLAIN (FORMAT JSON)` result, or null. */
function planRows(rows: unknown): number | null {
  const first = Array.isArray(rows)
    ? (rows[0] as Record<string, unknown> | undefined)
    : undefined;
  let plan: unknown = first?.['QUERY PLAN'];
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      return null;
    }
  }
  const top = Array.isArray(plan)
    ? (plan[0] as { Plan?: Record<string, unknown> } | undefined)
    : undefined;
  const n = top?.Plan?.['Plan Rows'];
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Describe the backlog left by a budget stop. The estimate is best-effort: a
 * failed EXPLAIN is logged and reported as null, never fatal to a run that
 * already deleted rows.
 */
async function measureBacklog(
  db: ReturnType<typeof getDb>,
  today: string,
  last: BatchResult,
): Promise<Backlog> {
  const frontier = toDate(last.frontier);
  const cutoff = toDate(last.cutoff);
  const lagHours =
    frontier && cutoff
      ? Math.round(((cutoff.getTime() - frontier.getTime()) / HOUR_MS) * 10) /
        10
      : null;

  let estimatedBacklogRows: number | null = null;
  try {
    estimatedBacklogRows = planRows(
      await db.query(BACKLOG_ESTIMATE_SQL, [today]),
    );
  } catch (err) {
    logger.warn({ err, today }, `${JOB}: backlog estimate failed`);
  }

  return {
    estimatedBacklogRows,
    oldestRemaining: frontier?.toISOString() ?? null,
    cutoff: cutoff?.toISOString() ?? null,
    lagHours,
  };
}

async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  Sentry.setTag('cron.job', JOB);

  const startedAt = Date.now();
  const db = getDb();
  let totalDeleted = 0;
  let batches = 0;
  let slowestBatchMs = 0;
  let last: BatchResult | null = null;
  let stopReason: 'drained' | 'wall_budget' = 'drained';

  try {
    while (true) {
      if (
        batches > 0 &&
        Date.now() - startedAt + slowestBatchMs > WALL_BUDGET_MS
      ) {
        stopReason = 'wall_budget';
        break;
      }
      const batchStartedAt = Date.now();
      const fromFrontier = last ? toDate(last.frontier)?.toISOString() : null;
      last = parseBatch(
        await db.query(BATCH_SQL, [today, fromFrontier ?? null]),
      );
      slowestBatchMs = Math.max(slowestBatchMs, Date.now() - batchStartedAt);
      totalDeleted += last.deleted;
      batches += 1;
      // A short batch means nothing older than the cutoff is left.
      if (last.deleted < BATCH_SIZE) break;
    }
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
    return;
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    today,
    totalDeleted,
    batches,
    durationMs,
    rowsPerSec:
      durationMs > 0 ? Math.round(totalDeleted / (durationMs / 1000)) : 0,
    stopReason,
  };

  if (stopReason === 'drained' || !last) {
    logger.info(summary, 'ws_option_trades retention sweep complete');
    res.status(200).json(summary);
    return;
  }

  const backlog = await measureBacklog(db, today, last);
  logger.warn(
    { ...summary, ...backlog },
    'ws_option_trades retention: wall budget exhausted with expired rows remaining',
  );
  if (backlog.lagHours == null || backlog.lagHours > BACKLOG_ALERT_LAG_HOURS) {
    const estimate = backlog.estimatedBacklogRows ?? 'unknown';
    const lag = backlog.lagHours ?? 'unknown';
    Sentry.captureMessage(
      `${JOB}: retention backlog — ~${estimate} expired rows left, ` +
        `frontier ${lag} h behind the cutoff`,
      {
        level: 'warning',
        fingerprint: [JOB, 'backlog'],
        tags: { 'cron.anomaly': 'ws-option-trades-retention-backlog' },
        extra: { ...summary, ...backlog },
      },
    );
  }
  res.status(200).json({ ...summary, backlog });
}

export default withCronCheckin(JOB, handler);
