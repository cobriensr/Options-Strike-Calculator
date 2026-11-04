/**
 * GET /api/cron/wave2-confirmation
 *
 * Phase 4 of meta-detectors-2026-05-16.md.
 *
 * For each Lottery Finder fire and Silent Boom alert that is 75-90 min old
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
 * A fire the cron misses for longer than LOOKBACK_MIN (90 min) is never
 * labelled by it. On the last tick of the session the cron counts today's
 * rows in that state and raises one Sentry warning per table (see
 * warnOnLostSlice); scripts/backfill-wave2-status.ts repairs them.
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
  type CronContext,
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
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { getETTime } from '../../src/utils/timezone.js';

// Lookback: the 75-min settle age plus 15 min of slop (90 min). The ticks run
// every 5 min, so a fire is a candidate at three of them: the first look
// (at most 5 min after it turns 75) and two retries. Two missed ticks in a
// row (a Vercel incident, or a Neon blip that outlasts withDbRetry) still
// leave one look. With 10 min of slop only two ticks saw a fire, and two
// missed ticks left about 5 min of fires NULL forever, silently. Anything
// older is never revisited by the cron: it is a legacy row pre-migration #164
// or a lost slice, and the backfill labels both (the last tick of the session
// counts today's lost rows, see warnOnLostSlice). The IS NULL guard makes the
// lookback safe to widen; the partial index keeps the scan cheap.
//
// There is no extra grace at the upper bound any more. A 60 s grace used to
// stand in for ingestion lag before a fizzle; the 15-min insert margin inside
// SETTLE_AGE_MIN covers that and far more.
const LOOKBACK_MIN = SETTLE_AGE_MIN + 15;

/**
 * How long past the day's close the cron keeps running (90 min). The fire
 * detectors stop at isMarketHours()' close + 5 gate, so the last wave-1 fires
 * by close + 5:59 (observed max: 16:05:59 ET). It reaches the 75-minute settle
 * age at close + 80:59 (17:20:59 ET), which the close + 85 tick (17:25 ET) of
 * the every-5-minutes schedule is the first to see (age 79:01). The close + 90
 * tick (17:30 ET) is one retry (age 84:01, inside the 90-min LOOKBACK_MIN) and
 * the last tick of the session. The gate, not the lookback, ends the retries:
 * at 17:35 the fire would still be a candidate (age 89:01), but the gate is
 * closed.
 *
 * isMarketHours() compares whole ET minutes with `<= close + afterCloseMin`,
 * so 90 includes the 17:30 tick (17:30 -> 1050 <= 960 + 90) and excludes
 * 17:35. The last tick is therefore the ET minute that equals close + 90
 * (isLastTickOfSession).
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

interface LostSliceRow {
  lost: number;
  earliest: DbTimestamp | null;
  latest: DbTimestamp | null;
}

/**
 * True on the session's final tick: the ET minute that is the day's close +
 * POST_CLOSE_EVAL_MIN, the last minute isMarketHours(POST_CLOSE_EVAL_MIN)
 * admits. The close comes from the market calendar, so a half-day ends at
 * 14:30 ET and a holiday has no last tick. The schedule fires on multiples of
 * 5 and the close + 90 minute is one (17:30 or 14:30 ET), so exactly one tick
 * per session matches.
 */
function isLastTickOfSession(today: string): boolean {
  const closeHour = getMarketCloseHourET(today);
  if (closeHour == null) return false;
  const { hour, minute } = getETTime(new Date());
  return hour * 60 + minute === closeHour * 60 + POST_CLOSE_EVAL_MIN;
}

/**
 * Last-tick check for a lost slice: today's NULL rows that are already older
 * than LOOKBACK_MIN. No later tick can label them (the candidate SELECT stops
 * at LOOKBACK_MIN, and this is the last tick of the session), so they would
 * stay NULL silently: two or more ticks in a row failed or never ran. Raises
 * one fingerprinted Sentry warning per table when any exist.
 *
 * One COUNT per table, served by the partial wave2-pending index (a range on
 * the trigger column over NULL rows). Returns the count, or null when the
 * count itself failed; that failure is captured and logged, and never fails
 * the run (the labels were already written). If the last tick itself is
 * missed, there is no check and no alert.
 *
 * ET midnight is built with `AT TIME ZONE`, not left to the session zone.
 */
async function warnOnLostSlice(
  db: DbClient,
  cfg: Wave2Table,
  today: string,
): Promise<number | null> {
  try {
    const rows =
      cfg.name === 'lottery'
        ? ((await withDbRetry(
            () => db`
              SELECT COUNT(*)::int AS lost,
                     MIN(trigger_time_ct) AS earliest,
                     MAX(trigger_time_ct) AS latest
              FROM lottery_finder_fires
              WHERE wave2_status IS NULL
                AND trigger_time_ct >= ((${today}::date)::timestamp AT TIME ZONE 'America/New_York')
                AND trigger_time_ct < NOW() - (${LOOKBACK_MIN}::int * INTERVAL '1 minute')
            `,
            2,
            10_000,
          )) as LostSliceRow[])
        : ((await withDbRetry(
            () => db`
              SELECT COUNT(*)::int AS lost,
                     MIN(bucket_ct) AS earliest,
                     MAX(bucket_ct) AS latest
              FROM silent_boom_alerts
              WHERE wave2_status IS NULL
                AND bucket_ct >= ((${today}::date)::timestamp AT TIME ZONE 'America/New_York')
                AND bucket_ct < NOW() - (${LOOKBACK_MIN}::int * INTERVAL '1 minute')
            `,
            2,
            10_000,
          )) as LostSliceRow[]);

    // An aggregate without GROUP BY always returns one row; none is a driver
    // fault, not "zero lost".
    const row = rows[0];
    if (!row) throw new Error('lost-slice count returned no row');
    const lost = Number(row.lost);
    if (lost > 0) {
      // The driver returns a timestamptz as an ISO string or a Date.
      const earliestTrigger = row.earliest
        ? new Date(row.earliest).toISOString()
        : null;
      const latestTrigger = row.latest
        ? new Date(row.latest).toISOString()
        : null;
      const message =
        `wave2-confirmation: ${lost} ${cfg.table} row(s) from ${today} were ` +
        `never labelled and are older than the ${LOOKBACK_MIN}-min lookback; ` +
        'the cron cannot label them any more. ' +
        'scripts/backfill-wave2-status.ts repairs them (it labels any NULL ' +
        'row older than 2 h).';
      logger.warn(
        { table: cfg.table, lost, earliestTrigger, latestTrigger },
        'wave2-confirmation: lost slice',
      );
      Sentry.captureMessage(message, {
        level: 'warning',
        fingerprint: ['wave2-confirmation', 'lost-slice', cfg.table],
        tags: { 'cron.anomaly': 'wave2-lost-slice' },
        extra: {
          table: cfg.table,
          date: today,
          lost,
          earliestTrigger,
          latestTrigger,
          lookbackMin: LOOKBACK_MIN,
        },
      });
    }
    return lost;
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err },
      `wave2-confirmation: ${cfg.name} lost-slice count failed`,
    );
    return null;
  }
}

async function wave2ConfirmationHandler(ctx: CronContext): Promise<CronResult> {
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

  // Last tick of the session only: count the rows no later tick can label.
  // A count that failed is null in the metadata (and was captured above).
  const lastTick = isLastTickOfSession(ctx.today);
  const lotteryLost = lastTick
    ? await warnOnLostSlice(db, LOTTERY_TABLE, ctx.today)
    : null;
  const silentboomLost = lastTick
    ? await warnOnLostSlice(db, SILENT_BOOM_TABLE, ctx.today)
    : null;

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
      ...(lastTick
        ? {
            lotteryLostSlice: lotteryLost,
            silentBoomLostSlice: silentboomLost,
          }
        : {}),
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
