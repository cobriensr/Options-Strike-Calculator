/**
 * GET /api/cron/enrich-periscope-lottery-outcomes
 *
 * Backfills the realized-outcome columns on periscope_lottery_fires rows
 * where outcome_locked = FALSE. Scheduled once daily at 21:50 UTC Mon-Fri
 * (vercel.json `50 21 * * 1-5`). That is a FIXED UTC time: 16:50 CT
 * during CDT, 15:50 CT during CST — after the 15:00 CT 0DTE close either
 * way. Same post-close slot as enrich-lottery-outcomes (21:40 UTC) and
 * enrich-silent-boom-outcomes (21:45 UTC).
 *
 * For each unenriched fire, one aggregate row is read from ws_option_trades
 * (chunks of READ_CHUNK_SIZE fires per statement):
 *   1. Peak over the hold horizon (120 min call_lottery, 180 min
 *      put_lottery): peak_px = MAX(price), peak_time = earliest print at
 *      that price; peak_pct = peak / entry.
 *   2. EOD close = the last print at or before 15:00 CT on the fire's day
 *      (eodCtForTrigger, DST-aware).
 *   3. realized_r_peak = (peak - entry) / entry, or -1 when nothing
 *      printed in the hold window; realized_r_eod = (eod - entry) / entry,
 *      or -1 when there is no EOD print (assumes worthless expiry).
 *   4. UPDATE the row + set outcome_locked = TRUE.
 *
 * A fire is left UNLOCKED (retried next run, or recovered by
 * scripts/backfill_periscope_lottery_outcomes.py) when:
 *   - its window has not settled yet (prints can still land), or
 *   - its aggregates do not parse (R would be fabricated), or
 *   - it has no prints AND no SPXW tape landed in the last
 *     TAPE_TAIL_MINUTES before it settled — a ws_option_trades gap (e.g.
 *     uw-stream died before the window finished), not an untraded option.
 *     The run emits one fingerprinted Sentry warning and returns status
 *     'error'. A no-print fire whose tail DID have SPXW tape genuinely
 *     never traded and keeps the per-strategy R = -1 lock.
 * "Settled" uses the contract's real close: 15:00 CT, or 12:00 CT on NYSE
 * early-close days (getMarketCloseHourET).
 *
 * Known limits:
 *   - An outage that starts AND recovers inside a window, before its tail,
 *     is not detected: a no-print fire locks at R = -1, and a fire with
 *     pre-outage prints locks on a peak/EOD computed without the gap.
 *   - Tape-gap fires stay unlocked; once they age out of the
 *     WS_OPTION_TRADES_RETENTION_DAYS window this cron never revisits
 *     them, so they need a manual run of
 *     scripts/backfill_periscope_lottery_outcomes.py (from the parquet
 *     tape). The Sentry warning says so.
 *
 * Idempotent — re-running the cron won't double-process a locked row.
 * Per-user direction (open question #3): we track BOTH peak and EOD R
 * because peak is the user-preferred display metric but EOD is the
 * realistic-exit estimator.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { eodCtForTrigger } from '../_lib/flow-inversion.js';
import { Sentry } from '../_lib/sentry.js';

type Sql = ReturnType<typeof getDb>;
type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface UnenrichedFire {
  /** BIGSERIAL — the Neon driver returns int8 as a STRING; normalize. */
  id: DbNumeric;
  fire_type: 'call_lottery' | 'put_lottery';
  fire_time: DbTimestamp;
  expiry: string;
  trade_strike: number;
  entry_px: DbNumeric | null;
}

/** A settled candidate with its per-fire read windows. */
interface FireWindow {
  id: number;
  expiry: string;
  strike: number;
  optionType: 'C' | 'P';
  entryPx: number;
  fireTime: Date;
  horizonEnd: Date;
  closeCutoff: Date;
  /** Tape-liveness tail: [max(fireTime, settledAt - tail), settledAt]. */
  tailStart: Date;
  settledAt: Date;
}

/** One row per fire from the aggregate read. */
interface FireAggregateRow {
  /** bigint — a string from the Neon driver; normalized with Number(). */
  fire_id: DbNumeric;
  /** Any SPXW trade in the fire's window tail (ingestion was still live). */
  tape_live: boolean;
  /** Prints for this contract inside [fire_time, horizon_end]. */
  horizon_ticks: number;
  peak_px: DbNumeric | null;
  peak_time: DbTimestamp | null;
  /** Last print at or before close_cutoff, or NULL. */
  eod_close_px: DbNumeric | null;
}

/** Enrichment for one fire, staged for the batched UPDATE. */
interface EnrichUpdate {
  id: number;
  peakPx: number | null;
  peakPct: number | null;
  peakTime: string | null;
  eodClosePx: number | null;
  realizedRPeak: number;
  realizedREod: number;
}

type FireOutcome =
  | { kind: 'locked'; update: EnrichUpdate }
  | { kind: 'tapeGap' }
  | { kind: 'unreadable' };

const toNum = (v: DbNumeric): number => (typeof v === 'number' ? v : Number(v));

const toDate = (v: DbTimestamp): Date => (v instanceof Date ? v : new Date(v));

/** Hold horizon per filter — must match periscope-lottery-types.ts. */
function holdMinutes(fireType: 'call_lottery' | 'put_lottery'): number {
  return fireType === 'call_lottery' ? 120 : 180;
}

/**
 * When SPXW on this expiry stops trading: the NYSE close in ET (16:00, or
 * 13:00 on early-close days) — 15:00 / 12:00 CT. No print can land later
 * (the fires are 0DTE, making this the fire-day close).
 */
function expiryClose(expiry: string): Date {
  const closeHourEt = getMarketCloseHourET(expiry) ?? 16;
  const iso = etWallClockToUtcIso(expiry, closeHourEt * 60);
  // Unparseable expiry (DATE NOT NULL, so not expected): regular close.
  return iso === null
    ? eodCtForTrigger(new Date(`${expiry}T17:00:00Z`))
    : new Date(iso);
}

/** SPXW prints every few seconds into the close, so a silent 10 min = feed down. */
const TAPE_TAIL_MINUTES = 10;

/**
 * Fires per aggregate read. Measured on prod 2026-09-30: 3.4-5.8 s per
 * 100-fire chunk with a cold cache, well inside the 30 s per-attempt
 * timeout; one statement for all 355 fires took ~13 s.
 */
const READ_CHUNK_SIZE = 100;

/**
 * ONE statement per chunk, ONE row per fire. Per unnest row:
 *   - g: EXISTS any SPXW trade in the tail [tail_start, tail_end]
 *     (ws_option_trades_ticker_executed_idx; stops at the first hit).
 *     OFFSET 0 keeps the planner from pulling this scalar lateral up and
 *     re-running the EXISTS for every joined row.
 *   - pk: count / MAX(price) / earliest time at the max over the hold
 *     window [fire_time, horizon_end].
 *   - eod: the last print at or before close_cutoff, read in index order
 *     (LIMIT 1, no sort).
 * Both trade laterals are served by ws_option_trades_chain_lookup_idx
 * (ticker, expiry, strike, option_type, executed_at DESC). option_type is
 * CHAR(1), so the array is bound as bpchar[]: text[] would cast the
 * column and drop it from the index condition.
 */
async function readAggregates(
  sql: Sql,
  chunk: FireWindow[],
): Promise<FireAggregateRow[]> {
  const ids = chunk.map((w) => w.id);
  const expiries = chunk.map((w) => w.expiry);
  const strikes = chunk.map((w) => w.strike);
  const optionTypes = chunk.map((w) => w.optionType);
  const fireTimes = chunk.map((w) => w.fireTime.toISOString());
  const horizonEnds = chunk.map((w) => w.horizonEnd.toISOString());
  const closeCutoffs = chunk.map((w) => w.closeCutoff.toISOString());
  const tailStarts = chunk.map((w) => w.tailStart.toISOString());
  const tailEnds = chunk.map((w) => w.settledAt.toISOString());

  return (await withDbRetry(
    () => sql`
      SELECT u.id AS fire_id, g.tape_live, pk.horizon_ticks, pk.peak_px,
             pk.peak_time, eod.eod_close_px
        FROM unnest(
               ${ids}::bigint[],
               ${expiries}::date[],
               ${strikes}::int[],
               ${optionTypes}::bpchar[],
               ${fireTimes}::timestamptz[],
               ${horizonEnds}::timestamptz[],
               ${closeCutoffs}::timestamptz[],
               ${tailStarts}::timestamptz[],
               ${tailEnds}::timestamptz[]
             ) AS u(id, expiry, strike, option_type, fire_time, horizon_end,
                    close_cutoff, tail_start, tail_end)
        CROSS JOIN LATERAL (
               SELECT EXISTS (
                        SELECT 1
                          FROM ws_option_trades
                         WHERE ticker = 'SPXW'
                           AND executed_at >= u.tail_start
                           AND executed_at <= u.tail_end
                      ) AS tape_live
               OFFSET 0
             ) g
        CROSS JOIN LATERAL (
               SELECT count(*)::int AS horizon_ticks,
                      max(t.price) AS peak_px,
                      (array_agg(t.executed_at ORDER BY t.price DESC, t.executed_at ASC))[1] AS peak_time
                 FROM ws_option_trades t
                WHERE t.ticker = 'SPXW'
                  AND t.expiry = u.expiry
                  AND t.strike = u.strike
                  AND t.option_type = u.option_type
                  AND t.executed_at >= u.fire_time
                  AND t.executed_at <= u.horizon_end
                  AND t.canceled = FALSE
                  AND t.price > 0
             ) pk
        LEFT JOIN LATERAL (
               SELECT t.price AS eod_close_px
                 FROM ws_option_trades t
                WHERE t.ticker = 'SPXW'
                  AND t.expiry = u.expiry
                  AND t.strike = u.strike
                  AND t.option_type = u.option_type
                  AND t.executed_at >= u.fire_time
                  AND t.executed_at <= u.close_cutoff
                  AND t.canceled = FALSE
                  AND t.price > 0
                ORDER BY t.executed_at DESC
                LIMIT 1
             ) eod ON TRUE
       ORDER BY u.id
    `,
    2,
    30_000,
  )) as FireAggregateRow[];
}

/**
 * Turn one fire's aggregates into its outcome. Same R semantics as the
 * former per-tick loop: peak = earliest print at the max price in the hold
 * window, EOD = last print at or before the close cutoff, -1 when either
 * is absent.
 */
function outcomeFor(
  w: FireWindow,
  row: FireAggregateRow | undefined,
): FireOutcome {
  // The read returns exactly one row per fire; a missing row means the
  // read is not trustworthy — never a total loss.
  if (row === undefined) return { kind: 'tapeGap' };
  const hasPrints = Number(row.horizon_ticks) > 0 || row.eod_close_px != null;
  if (!hasPrints && !row.tape_live) return { kind: 'tapeGap' };

  const peakPx = row.peak_px == null ? null : toNum(row.peak_px);
  const eodClosePx = row.eod_close_px == null ? null : toNum(row.eod_close_px);
  const peakTime = row.peak_time == null ? null : toDate(row.peak_time);
  if (
    (peakPx !== null && Number.isNaN(peakPx)) ||
    (eodClosePx !== null && Number.isNaN(eodClosePx)) ||
    (peakTime !== null && Number.isNaN(peakTime.getTime()))
  ) {
    return { kind: 'unreadable' };
  }

  return {
    kind: 'locked',
    update: {
      id: w.id,
      peakPx,
      peakPct: peakPx === null ? null : peakPx / w.entryPx,
      peakTime: peakTime === null ? null : peakTime.toISOString(),
      eodClosePx,
      // No print in the hold window / no EOD print = expired worthless.
      realizedRPeak: peakPx === null ? -1 : (peakPx - w.entryPx) / w.entryPx,
      realizedREod:
        eodClosePx === null ? -1 : (eodClosePx - w.entryPx) / w.entryPx,
    },
  };
}

/**
 * ONE batched UPDATE per chunk: unnest the staged rows (NULL-preserving
 * typed arrays for the nullable columns) and join on id. Every locked
 * fire gets the same column set and outcome_locked = TRUE.
 */
async function lockOutcomes(sql: Sql, updates: EnrichUpdate[]): Promise<void> {
  const uIds = updates.map((u) => u.id);
  const uPeakPx = updates.map((u) => u.peakPx);
  const uPeakPct = updates.map((u) => u.peakPct);
  const uPeakTime = updates.map((u) => u.peakTime);
  const uEodPx = updates.map((u) => u.eodClosePx);
  const uRPeak = updates.map((u) => u.realizedRPeak);
  const uREod = updates.map((u) => u.realizedREod);
  await withDbRetry(
    () => sql`
      UPDATE periscope_lottery_fires AS p SET
        peak_px = u.peak_px,
        peak_pct = u.peak_pct,
        peak_time = u.peak_time,
        eod_close_px = u.eod_close_px,
        realized_r_peak = u.realized_r_peak,
        realized_r_eod = u.realized_r_eod,
        outcome_locked = TRUE
      FROM unnest(
             ${uIds}::bigint[],
             ${uPeakPx}::numeric[],
             ${uPeakPct}::numeric[],
             ${uPeakTime}::timestamptz[],
             ${uEodPx}::numeric[],
             ${uRPeak}::numeric[],
             ${uREod}::numeric[]
           ) AS u(id, peak_px, peak_pct, peak_time, eod_close_px,
                  realized_r_peak, realized_r_eod)
      WHERE p.id = u.id
    `,
    2,
    30_000,
  );
}

export default withCronInstrumentation(
  'enrich-periscope-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    // Retention window: cleanup-ws-option-trades prunes trades older than
    // WS_OPTION_TRADES_RETENTION_DAYS (its cutoff is ET midnight N days
    // back, which is at or before NOW() - N days, so this bound never
    // reaches pruned data). A fire older than that has had its trades
    // deleted, and the no-trades branch would falsely lock it at
    // realized R = -1. So only retained fires are candidates, newest
    // first so today's fires are never starved by the LIMIT. The older
    // unlocked backlog is recovered from the parquet tape by
    // scripts/backfill_periscope_lottery_outcomes.py, not by this cron.
    // Whether a candidate's window has settled is checked per fire below.
    const unenriched = (await withDbRetry(
      () => sql`
        SELECT id, fire_type, fire_time, expiry::text AS expiry,
               trade_strike, entry_px
        FROM periscope_lottery_fires
        WHERE outcome_locked = FALSE
          AND entry_px IS NOT NULL
          AND fire_time >= NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
        ORDER BY fire_time DESC
        LIMIT 500
      `,
      2,
      10_000,
    )) as UnenrichedFire[];

    if (unenriched.length === 0) {
      return {
        status: 'success',
        rows: 0,
        metadata: { unenrichedCount: 0 },
      };
    }

    // Pre-pass: derive the per-fire windows (pure JS, no I/O). Fires with
    // a NaN/≤0 entry_px are skipped (no DB write).
    const nowMs = Date.now();
    const windows: FireWindow[] = [];
    let skipped = 0;
    let inFlight = 0;
    for (const f of unenriched) {
      const fireTime = toDate(f.fire_time);
      const entryPx = f.entry_px == null ? Number.NaN : toNum(f.entry_px);
      if (Number.isNaN(entryPx) || entryPx <= 0) {
        skipped += 1;
        continue;
      }
      const horizonEnd = new Date(
        fireTime.getTime() + holdMinutes(f.fire_type) * 60_000,
      );
      // 15:00 CT (DST-aware) — 20:00 UTC during CDT, 21:00 UTC during CST.
      const closeCutoff = eodCtForTrigger(fireTime);
      const readEnd = horizonEnd > closeCutoff ? horizonEnd : closeCutoff;
      // Settled = no more prints can land in [fireTime, readEnd]: the
      // window has passed, or the contract has stopped trading (a late
      // fire's horizon can run past the close; on early-close days that is
      // 12:00 CT). Nothing else enforces this — marketHours: false leaves
      // the run time ungated, so a manual mid-session run would otherwise
      // lock today's fires (first, given newest-first order) on a partial
      // peak/EOD.
      const contractClose = expiryClose(f.expiry);
      const settledAt = readEnd < contractClose ? readEnd : contractClose;
      if (settledAt.getTime() > nowMs) {
        inFlight += 1;
        continue;
      }
      const tailFloor = new Date(
        settledAt.getTime() - TAPE_TAIL_MINUTES * 60_000,
      );
      windows.push({
        // Number(): the int8 id arrives as a string from the driver.
        id: Number(f.id),
        expiry: f.expiry,
        strike: f.trade_strike,
        optionType: f.fire_type === 'call_lottery' ? 'C' : 'P',
        entryPx,
        fireTime,
        horizonEnd,
        closeCutoff,
        tailStart: tailFloor > fireTime ? tailFloor : fireTime,
        settledAt,
      });
    }

    // Read + lock chunk by chunk, so a slow or failing later chunk never
    // throws away the fires an earlier chunk already settled.
    let updated = 0;
    const unreadableFireIds: number[] = [];
    const tapeGapFireIds: number[] = [];
    let tapeGapMessage: string | undefined;
    try {
      for (let i = 0; i < windows.length; i += READ_CHUNK_SIZE) {
        const chunk = windows.slice(i, i + READ_CHUNK_SIZE);
        const rows = await readAggregates(sql, chunk);
        const rowById = new Map(rows.map((r) => [Number(r.fire_id), r]));
        const updates: EnrichUpdate[] = [];
        for (const w of chunk) {
          const outcome = outcomeFor(w, rowById.get(w.id));
          if (outcome.kind === 'locked') updates.push(outcome.update);
          else if (outcome.kind === 'tapeGap') tapeGapFireIds.push(w.id);
          else unreadableFireIds.push(w.id);
        }
        if (updates.length > 0) {
          await lockOutcomes(sql, updates);
          updated += updates.length;
        }
      }
    } finally {
      // One event per run (fingerprinted), listing the tape-gap fires. In
      // `finally` so gaps found in earlier chunks are still named when a
      // later chunk throws — on a Friday they would otherwise be lost for
      // good, since Monday's retention window no longer reaches Friday.
      if (tapeGapFireIds.length > 0) {
        tapeGapMessage =
          `enrich-periscope-lottery-outcomes: ${tapeGapFireIds.length} ` +
          'settled fire(s) had no SPXW tape in their window tail ' +
          '(ws_option_trades gap, e.g. uw-stream down); left unlocked. ' +
          'Retried while inside the retention window; after that run ' +
          'scripts/backfill_periscope_lottery_outcomes.py';
        const detail = {
          candidates: unenriched.length,
          tapeGap: tapeGapFireIds.length,
          tapeGapFireIds,
        };
        ctx.logger.warn(detail, tapeGapMessage);
        Sentry.captureMessage(tapeGapMessage, {
          level: 'warning',
          fingerprint: ['enrich-periscope-lottery-outcomes', 'tape-gap'],
          tags: { 'cron.anomaly': 'periscope-lottery-tape-gap' },
          extra: detail,
        });
      }
    }

    const summary = {
      candidates: unenriched.length,
      updated,
      skipped,
      inFlight,
      unreadable: unreadableFireIds.length,
      tapeGap: tapeGapFireIds.length,
    };

    if (unreadableFireIds.length > 0) {
      ctx.logger.warn(
        { ...summary, unreadableFireIds },
        'enrich-periscope-lottery-outcomes: unreadable aggregates; fires left unlocked',
      );
    }

    ctx.logger.info(summary, 'enrich-periscope-lottery-outcomes completed');

    if (tapeGapMessage !== undefined) {
      return {
        status: 'error',
        rows: updated,
        message: tapeGapMessage,
        metadata: summary,
      };
    }
    return {
      status: unreadableFireIds.length > 0 ? 'partial' : 'success',
      rows: updated,
      metadata: summary,
    };
  },
  // marketHours: false is REQUIRED — this cron runs at 21:50 UTC, after
  // the close (cronGuard defaults to marketHours: true and would reject
  // the request).
  { marketHours: false, requireApiKey: false },
);
