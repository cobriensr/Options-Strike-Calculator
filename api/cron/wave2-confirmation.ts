/**
 * GET /api/cron/wave2-confirmation
 *
 * Phase 4 of meta-detectors-2026-05-16.md.
 *
 * For each Lottery Finder fire and Silent Boom alert that is 75-85 min old
 * with wave2_status IS NULL, scan the same table for a second qualifying
 * event on the same underlying_symbol + same option_type within 60 min of
 * the wave-1 trigger time. Write one of three labels:
 *
 *   - 'confirmed' — wave-2 event landed within 0-30 min of wave-1
 *   - 'lagging'   — wave-2 event landed 30-60 min after wave-1
 *   - 'fizzled'   — no qualifying follow-up in the 60 min after wave-1
 *
 * A fire is labelled only once it is 75 min old (SETTLE_AGE_MIN in
 * wave2-rule.ts): the 60-min window plus a 15-min insert margin. The
 * detectors write a fire to the table up to about 9 min after the trigger
 * time it carries, so an earlier look saw an incomplete table. It fizzled
 * fires whose follow-up was not written yet and picked a later follow-up when
 * an earlier one arrived late. At 75 min every follow-up that can count is in
 * the table, so a live label equals the complete-information label the
 * backfill (scripts/_lib/wave2-backfill.ts) writes. The price is a label
 * about 15 min later than before; nothing reads it live. A younger fire is
 * not a candidate and is revisited by the tick that finds it 75 min old.
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
 * Cadence: every 5 min from the 09:25 ET open buffer until 90 min after the
 * day's close (see POST_CLOSE_EVAL_MIN), Mon-Fri.
 *
 * The 'fizzled' label is itself a training signal — the next weekly takeit
 * retrain gets free "this alert didn't follow through" labels for the
 * meta-classifier to learn from. Surfacing wave2_status as a takeit
 * feature is intentionally out of scope for this phase (the column is
 * persisted; consumption is future work).
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { isMarketHours } from '../_lib/cron-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  LAGGING_WINDOW_MIN,
  LOTTERY_TABLE,
  SETTLE_AGE_MIN,
  SILENT_BOOM_TABLE,
  wave2Verdict,
  type Wave2Table,
} from '../_lib/wave2-rule.js';

// Lookback: the 75-min settle age plus 10 min of slop (85 min), so a slow
// cron tick can't drop a candidate that crossed the settle age between
// scans. The tick that first sees a fire is at most 5 min after it turns 75,
// and the one after it is a retry. Anything older would already have been
// visited in a prior tick (or is a legacy row pre-migration #164, which the
// backfill labels). The IS NULL guard makes the lookback safe to widen; the
// partial index keeps the scan cheap.
//
// There is no extra grace at the upper bound any more. A 60 s grace used to
// stand in for ingestion lag before a fizzle; the 15-min insert margin inside
// SETTLE_AGE_MIN covers that and far more.
const LOOKBACK_MIN = SETTLE_AGE_MIN + 10;

/**
 * How long past the day's close the cron keeps running (90 min). The fire
 * detectors stop at isMarketHours()' close + 5 gate, so the last wave-1 fires
 * by close + 5:59 (observed max: 16:05:59 ET). It reaches the 75-minute settle
 * age at close + 80:59 (17:20:59 ET), which the close + 85 tick (17:25 ET) of
 * the every-5-minutes schedule is the first to see (age 79:01). The close + 90
 * tick (17:30 ET) is one retry, and it is the last that still has the fire
 * inside LOOKBACK_MIN (age 84:01 of 85).
 *
 * isMarketHours() compares whole ET minutes with `<= close + afterCloseMin`,
 * so 90 includes the 17:30 tick (17:30 -> 1050 <= 960 + 90) and excludes
 * 17:35.
 *
 * Before the gate ran past the close, a fire after about 15:05 ET never
 * reached the fizzle age while the cron ran, and the next morning it was far
 * outside the lookback: with no follow-up it stayed NULL forever instead of
 * 'fizzled' (1,400 lottery rows from 2026-10-01 to 2026-11-02, all fired
 * 15:06-16:05 ET). That biased the fizzle rate low for late fires.
 *
 * Applied as `isMarketHours(POST_CLOSE_EVAL_MIN)`: same 09:25 ET open buffer,
 * weekend/holiday handling and half-day close (13:00 -> 14:30 ET).
 * vercel.json's UTC hours must reach 17:30 ET in EST (22:30 UTC), and the
 * Sentry monitor schedule in cron-schedules.ts mirrors them. Same shape as
 * evaluate-round-trip's POST_CLOSE_EVAL_MIN.
 */
const POST_CLOSE_EVAL_MIN = 90;

// The wave-2 windows (30 / 60 min), the settle age, the verdict decision and
// the two table descriptors live in api/_lib/wave2-rule.ts, shared with the
// one-shot backfill scripts/_lib/wave2-backfill.ts so the two cannot drift.
// The follow-up lookup below is mirrored there as a LATERAL join; the parity
// test scripts/_lib/wave2-backfill.test.ts keeps them equal.

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
  cfg: Wave2Table,
): Promise<TableResult> {
  // Candidate set: rows that have just settled, i.e. at least SETTLE_AGE_MIN
  // old (every follow-up that can count is written by then) and at most
  // LOOKBACK_MIN old. A younger fire is not a candidate: it is labelled by
  // the tick that finds it SETTLE_AGE_MIN old. The IS NULL guard makes this
  // idempotent — every prior tick's verdicts are excluded automatically.
  const candidates =
    cfg.name === 'lottery'
      ? ((await withDbRetry(
          () => db`
            SELECT id, underlying_symbol, option_type, trigger_time_ct AS trigger_time
            FROM lottery_finder_fires
            WHERE wave2_status IS NULL
              AND trigger_time_ct >= NOW() - (${LOOKBACK_MIN}::int * INTERVAL '1 minute')
              AND trigger_time_ct <= NOW() - (${SETTLE_AGE_MIN}::int * INTERVAL '1 minute')
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
              AND bucket_ct <= NOW() - (${SETTLE_AGE_MIN}::int * INTERVAL '1 minute')
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
    const verdict = wave2Verdict(
      triggerMs,
      followup ? new Date(followup.trigger_time).getTime() : null,
      nowMs,
    );

    // Not settled by this process's clock. The candidate SELECT already
    // limits rows to the settle age by the database clock, so this is only a
    // fire that crossed the bound in the last instant and the clocks differ
    // by less than a second. Leave NULL: the next 5-min tick (the lookback
    // keeps it a candidate) labels it. This is the only path that lets a
    // candidate survive the cron unchanged.
    if (verdict === null) continue;

    if (verdict.status === 'fizzled') {
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
    } else if (cfg.name === 'lottery') {
      await withDbRetry(
        () => db`
          UPDATE lottery_finder_fires
          SET wave2_status = ${verdict.status},
              wave2_detected_at = ${verdict.detectedAtIso}::timestamptz
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
          SET wave2_status = ${verdict.status},
              wave2_detected_at = ${verdict.detectedAtIso}::timestamptz
          WHERE id = ${cand.id}
            AND wave2_status IS NULL
        `,
        2,
        10_000,
      );
    }
    result.processed += 1;
    result[verdict.status] += 1;
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
  {
    requireApiKey: false,
    timeCheck: () => isMarketHours(POST_CLOSE_EVAL_MIN),
  },
);
