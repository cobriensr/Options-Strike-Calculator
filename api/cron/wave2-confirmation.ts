/**
 * GET /api/cron/wave2-confirmation
 *
 * Phase 4 of meta-detectors-2026-05-16.md.
 *
 * For each Lottery Finder fire and Silent Boom alert in the last 60-70 min
 * with wave2_status IS NULL, scan the same table for a second qualifying
 * event on the same underlying_symbol + same option_type within 60 min of
 * the wave-1 trigger time. Write one of three labels:
 *
 *   - 'confirmed' — wave-2 event landed within 0-30 min of wave-1
 *   - 'lagging'   — wave-2 event landed 30-60 min after wave-1
 *   - 'fizzled'   — 60 min elapsed with no qualifying follow-up
 *
 * Rows with no follow-up that are still < 60 min old are SKIPPED — they're
 * still in flight and the next cron tick (every 5 min) will revisit.
 *
 * Status transitions are one-way (NULL → confirmed/lagging/fizzled). The
 * cron never reverses a verdict; the IS NULL guard on the read makes the
 * whole job idempotent. Lottery vs silent-boom run independently — a
 * failure in one table is logged + sent to Sentry but does NOT abort the
 * other; the wrapper still returns a single CronResult merging both.
 *
 * Same-table only: wave-2 for a lottery fire is another lottery fire;
 * wave-2 for a silent boom alert is another silent boom alert. Cross-type
 * detection is deferred to v2.
 *
 * Cadence: every 5 min during market hours (13-21 UTC, Mon-Fri).
 *
 * The 'fizzled' label is itself a training signal — the next weekly takeit
 * retrain gets free "this alert didn't follow through" labels for the
 * meta-classifier to learn from. Surfacing wave2_status as a takeit
 * feature is intentionally out of scope for this phase (the column is
 * persisted; consumption is future work).
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// 60s grace: a wave-2 event arriving within the same minute we're
// classifying needs to land in the table before we mark the wave-1
// fizzled. Without it, a fire at T+60:00 with a wave-2 print queued at
// T+59:30 but not yet inserted would be marked fizzled then re-evaluated
// next tick — except we never re-evaluate (status transitions are one-way),
// so the fizzle would be permanent. The 60s window absorbs ingestion lag.
const GRACE_SECONDS = 60;

// 70-min lookback: 60-min fizzle threshold + 10-min slop so a slow cron
// tick can't drop a candidate that crossed the threshold between scans.
// Anything older than 70 min would already have been visited in a prior
// tick (or is a legacy row pre-migration #164 — still gets classified
// once it appears in the window). The IS NULL guard makes the lookback
// safe to widen; the partial index keeps the scan cheap.
const LOOKBACK_MIN = 70;

// Wave-2 windows, in minutes from wave-1 trigger time.
const CONFIRMED_WINDOW_MIN = 30;
const LAGGING_WINDOW_MIN = 60;

type DbTimestamp = string | Date;

interface CandidateRow {
  id: number;
  underlying_symbol: string;
  option_type: 'C' | 'P';
  trigger_time: DbTimestamp;
}

interface FollowupRow {
  trigger_time: DbTimestamp;
}

interface DbClient {
  // Tagged-template SQL accessor — matches @neondatabase/serverless's
  // call signature without coupling to its concrete type so tests can
  // mock with a plain `vi.fn()`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
}

type TableKey = 'lottery' | 'silentboom';

interface TableConfig {
  /** Display name for logs/metadata. */
  name: TableKey;
  /** Fully qualified SQL identifier for the table. */
  table: 'lottery_finder_fires' | 'silent_boom_alerts';
  /** Name of the trigger-time column on this table. */
  triggerCol: 'trigger_time_ct' | 'bucket_ct';
}

const LOTTERY_TABLE: TableConfig = {
  name: 'lottery',
  table: 'lottery_finder_fires',
  triggerCol: 'trigger_time_ct',
};

const SILENT_BOOM_TABLE: TableConfig = {
  name: 'silentboom',
  table: 'silent_boom_alerts',
  triggerCol: 'bucket_ct',
};

interface TableResult {
  processed: number;
  confirmed: number;
  lagging: number;
  fizzled: number;
}

/**
 * Scan one table for wave-2 follow-ups. Same-table only — the wave-2
 * event must come from the same detector that produced wave-1.
 *
 * Per-candidate cost is one indexed lookup (the same-ticker + same-type
 * follow-up query). For the volumes this cron handles (~tens of pending
 * fires per 5-min tick during market hours), a per-row UPDATE inside the
 * loop is well under the 60s function budget. If sub-tick latency ever
 * becomes a concern, the UPDATEs can be batched per verdict bucket
 * — the read pattern doesn't depend on it.
 */
async function processTable(
  db: DbClient,
  cfg: TableConfig,
): Promise<TableResult> {
  // Candidate set: rows still in the wave-2 evaluation window OR past
  // it. The 60s grace at the upper bound lets a same-minute follow-up
  // print reach the table before we'd otherwise mark the wave-1 fizzled.
  // The IS NULL guard makes this idempotent — every prior tick's verdicts
  // are excluded automatically.
  const candidates =
    cfg.name === 'lottery'
      ? ((await withDbRetry(
          () => db`
            SELECT id, underlying_symbol, option_type, trigger_time_ct AS trigger_time
            FROM lottery_finder_fires
            WHERE wave2_status IS NULL
              AND trigger_time_ct >= NOW() - (${LOOKBACK_MIN}::int * INTERVAL '1 minute')
              AND trigger_time_ct <= NOW() - (${GRACE_SECONDS}::int * INTERVAL '1 second')
          `,
          2,
          10_000,
        )) as CandidateRow[])
      : ((await withDbRetry(
          () => db`
            SELECT id, underlying_symbol, option_type, bucket_ct AS trigger_time
            FROM silent_boom_alerts
            WHERE wave2_status IS NULL
              AND bucket_ct >= NOW() - (${LOOKBACK_MIN}::int * INTERVAL '1 minute')
              AND bucket_ct <= NOW() - (${GRACE_SECONDS}::int * INTERVAL '1 second')
          `,
          2,
          10_000,
        )) as CandidateRow[]);

  const result: TableResult = {
    processed: 0,
    confirmed: 0,
    lagging: 0,
    fizzled: 0,
  };

  if (candidates.length === 0) {
    return result;
  }

  const nowMs = Date.now();

  for (const cand of candidates) {
    const triggerMs = new Date(cand.trigger_time).getTime();
    const ageMs = nowMs - triggerMs;
    const ageMin = ageMs / 60_000;

    const triggerIso = new Date(triggerMs).toISOString();

    // Look for the earliest qualifying follow-up in (trigger, trigger+60min].
    // id != $3 guards against a row matching itself when wave-1 / wave-2
    // share the same minute (rare but possible with this 5-min cron tick).
    const followups =
      cfg.name === 'lottery'
        ? ((await withDbRetry(
            () => db`
              SELECT trigger_time_ct AS trigger_time
              FROM lottery_finder_fires
              WHERE underlying_symbol = ${cand.underlying_symbol}
                AND option_type = ${cand.option_type}
                AND id != ${cand.id}
                AND trigger_time_ct > ${triggerIso}::timestamptz
                AND trigger_time_ct <= ${triggerIso}::timestamptz + (${LAGGING_WINDOW_MIN}::int * INTERVAL '1 minute')
              ORDER BY trigger_time_ct ASC
              LIMIT 1
            `,
            2,
            10_000,
          )) as FollowupRow[])
        : ((await withDbRetry(
            () => db`
              SELECT bucket_ct AS trigger_time
              FROM silent_boom_alerts
              WHERE underlying_symbol = ${cand.underlying_symbol}
                AND option_type = ${cand.option_type}
                AND id != ${cand.id}
                AND bucket_ct > ${triggerIso}::timestamptz
                AND bucket_ct <= ${triggerIso}::timestamptz + (${LAGGING_WINDOW_MIN}::int * INTERVAL '1 minute')
              ORDER BY bucket_ct ASC
              LIMIT 1
            `,
            2,
            10_000,
          )) as FollowupRow[]);

    const followup = followups[0];

    if (followup) {
      const followupMs = new Date(followup.trigger_time).getTime();
      const deltaMin = (followupMs - triggerMs) / 60_000;
      const followupIso = new Date(followupMs).toISOString();
      const verdict =
        deltaMin <= CONFIRMED_WINDOW_MIN ? 'confirmed' : 'lagging';

      if (cfg.name === 'lottery') {
        await withDbRetry(
          () => db`
            UPDATE lottery_finder_fires
            SET wave2_status = ${verdict},
                wave2_detected_at = ${followupIso}::timestamptz
            WHERE id = ${cand.id}
              AND wave2_status IS NULL
          `,
          2,
          10_000,
        );
      } else {
        await withDbRetry(
          () => db`
            UPDATE silent_boom_alerts
            SET wave2_status = ${verdict},
                wave2_detected_at = ${followupIso}::timestamptz
            WHERE id = ${cand.id}
              AND wave2_status IS NULL
          `,
          2,
          10_000,
        );
      }
      result.processed += 1;
      if (verdict === 'confirmed') {
        result.confirmed += 1;
      } else {
        result.lagging += 1;
      }
      continue;
    }

    // No follow-up. Fizzle only if past the 60-min cutoff; otherwise
    // leave NULL and let the next 5-min tick re-evaluate. This is the
    // only path that lets a candidate survive the cron unchanged.
    if (ageMin >= LAGGING_WINDOW_MIN) {
      if (cfg.name === 'lottery') {
        await withDbRetry(
          () => db`
            UPDATE lottery_finder_fires
            SET wave2_status = 'fizzled'
            WHERE id = ${cand.id}
              AND wave2_status IS NULL
          `,
          2,
          10_000,
        );
      } else {
        await withDbRetry(
          () => db`
            UPDATE silent_boom_alerts
            SET wave2_status = 'fizzled'
            WHERE id = ${cand.id}
              AND wave2_status IS NULL
          `,
          2,
          10_000,
        );
      }
      result.processed += 1;
      result.fizzled += 1;
    }
    // else: still in flight — skip silently. Next tick revisits.
  }

  return result;
}

async function wave2ConfirmationHandler(): Promise<CronResult> {
  const db = getDb();

  // Run lottery + silent-boom independently. A thrown error on one table
  // must not lose the other table's work. Each path catches + reports to
  // Sentry + emits a zeroed result for that side so the wrapper still
  // returns a sensible CronResult. The outer instrumentation only catches
  // a genuinely fatal error (e.g. the DB client itself failed to init).
  let lottery: TableResult = {
    processed: 0,
    confirmed: 0,
    lagging: 0,
    fizzled: 0,
  };
  let lotteryErr: Error | null = null;
  try {
    lottery = await processTable(db, LOTTERY_TABLE);
  } catch (err) {
    lotteryErr = err as Error;
    Sentry.captureException(err);
    logger.error({ err }, 'wave2-confirmation: lottery scan failed');
  }

  let silentboom: TableResult = {
    processed: 0,
    confirmed: 0,
    lagging: 0,
    fizzled: 0,
  };
  let silentboomErr: Error | null = null;
  try {
    silentboom = await processTable(db, SILENT_BOOM_TABLE);
  } catch (err) {
    silentboomErr = err as Error;
    Sentry.captureException(err);
    logger.error({ err }, 'wave2-confirmation: silent-boom scan failed');
  }

  const totalProcessed = lottery.processed + silentboom.processed;
  const status =
    lotteryErr && silentboomErr
      ? 'error'
      : lotteryErr || silentboomErr
        ? 'partial'
        : 'success';

  return {
    status,
    rows: totalProcessed,
    metadata: {
      lotteryProcessed: lottery.processed,
      lotteryConfirmed: lottery.confirmed,
      lotteryLagging: lottery.lagging,
      lotteryFizzled: lottery.fizzled,
      silentBoomProcessed: silentboom.processed,
      silentBoomConfirmed: silentboom.confirmed,
      silentBoomLagging: silentboom.lagging,
      silentBoomFizzled: silentboom.fizzled,
      ...(lotteryErr ? { lotteryError: lotteryErr.message } : {}),
      ...(silentboomErr ? { silentboomError: silentboomErr.message } : {}),
    },
  };
}

export default withCronInstrumentation(
  'wave2-confirmation',
  wave2ConfirmationHandler,
  { requireApiKey: false },
);
