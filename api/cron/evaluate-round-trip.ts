/**
 * GET /api/cron/evaluate-round-trip
 *
 * Runs every 10 min from the 09:25 ET open buffer until 80 min after the
 * day's close (see POST_CLOSE_EVAL_MIN). Computes
 * `post_fire_net_pct_of_volume` for alerts fired 60-75 min ago, stores
 * it on the alert row, and applies a stepped score deduct based on the
 * Phase 1 EDA brackets.
 *
 * Spec: docs/superpowers/specs/round-trip-score-deduct-production-2026-05-16.md
 *
 * Source schema: ws_option_trades.side is already classified as
 * 'ask'|'bid'|'mid'|'no_side' by the WS daemon — we DON'T need to
 * parse `tags` like the EDA notebook does (the parquet stores the raw
 * Postgres array literal; the WS daemon normalises to a single column
 * at ingest). The cron is simpler as a result.
 *
 * Bracket thresholds (locked in Phase 2A backfill which matched dry-run
 * to the row):
 *   net_pct < -0.50 → -3
 *   net_pct < -0.30 → -2
 *   net_pct < -0.10 → -1
 *   else            →  0
 *
 * DTE ≤ 7 only (signal collapses to AUC ~0.50 above per the 2026-05-16
 * per-DTE slice).
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { isMarketHours } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

/** Look-forward window length for the net-pct computation. */
const WINDOW_MIN = 60;

/** How far back to wait before evaluating. Alerts younger than this haven't
 *  accumulated the full 60-min post-fire flow window yet. */
const LOOKBACK_MIN_FLOOR = 60;

/**
 * How long past the day's close the cron keeps running. The fire detectors
 * stop at isMarketHours()' close + 5 gate, so the last alert fires by
 * close + 5:59 (observed max: 16:05:13 ET). It becomes evaluable
 * LOOKBACK_MIN_FLOOR later, at close + 65:59, which the close + 70 tick of
 * the every-10-min schedule is the first to see. The close + 80 tick is one
 * retry (the cron's heavy LATERAL has a history of timeouts): before a
 * weekend or holiday a missed evaluation is permanent — the next
 * session's run is past the 24 h CATCHUP_FLOOR_HOURS window, and over a
 * weekend Monday's 12:05 UTC ws_option_trades sweep has already pruned
 * Friday's tape.
 *
 * Before 2026-10-02 the gate was isMarketHours() (close + 5), so fires
 * after ~15:05 ET waited for the next morning's run. Mon-Thu that worked;
 * Friday's never got evaluated (1,946 lottery + 137 silent-boom rows in 30
 * days), reading as "no penalty".
 *
 * Applied as `isMarketHours(POST_CLOSE_EVAL_MIN)`: same 09:25 ET open
 * buffer, weekend/holiday handling and half-day close (13:00 → 14:20 ET).
 * vercel.json's UTC hours must reach 17:20 ET in EST (22:20 UTC), and the
 * Sentry monitor window in cron-schedules.ts must cover the post-close ticks.
 */
const POST_CLOSE_EVAL_MIN = 80;

/** Catch-up floor for stale alerts. If the cron pauses for hours, alerts
 *  from the same trading day still get picked up on resume. The
 *  `round_trip_net_pct IS NULL` guard handles idempotency; this just bounds
 *  the SELECT cost so we don't scan all-time on every tick. */
const CATCHUP_FLOOR_HOURS = 24;

/**
 * Max DTE for which the SCORE-PENALTY signal is outcome-predictive — see
 * Phase 1 EDA in `ml/experiments/round-trip-suppression-eda/`: AUC against
 * realized_trail30_10_pct loss is 0.59+ at 0-7 DTE and collapses to 0.528
 * at 8-30 DTE. So score_deduct is gated to ≤7. We STILL compute net_pct
 * for all DTEs (no DTE filter on the SELECT) so the front-end "Hide
 * round-tripped (any DTE)" structural filter can read it.
 */
const SCORE_DEDUCT_DTE_MAX = 7;

/**
 * Per-run work bound (2026-10-24). Before this, a run evaluated every
 * eligible alert in one LATERAL aggregation and wrote nothing until it had
 * finished. On 2026-10-16 one run outgrew vercel.json's 60 s maxDuration.
 * Vercel killed it before its UPDATEs and before its Sentry completion
 * check-in, so its alerts rolled into the next tick. Every later session
 * tick then carried ~4,500 alerts (~18 ms each with a cold cache) and died
 * the same way: 10-16, 10-20, 10-21, 10-22, and 10-23 until 19:00 UTC,
 * when the 24 h CATCHUP_FLOOR_HOURS had shed enough of 10-22 for a run to
 * finish in 59.2 s. Sentry saw only `in_progress` (a timeout check-in),
 * and ~16,200 lottery fires aged out unevaluated.
 *
 * Now alerts go newest-first in single-source chunks of CHUNK_SIZE, and
 * each chunk is written before the next one starts. No chunk starts after
 * RUN_BUDGET_MS. A slow tick defers its remainder to the next tick and
 * keeps what it wrote. The run always returns, so the completion check-in
 * always goes out. Newest first because the deduct is read live, and
 * because a Friday's post-close ticks must reach the session's last fires
 * before the weekend prune (see POST_CLOSE_EVAL_MIN); older backlog still
 * drains, since a tick clears about twice the peak inflow (below).
 *
 * Worst case against the 60 s maxDuration. ctx.startTimeMs is taken before
 * the wrapper's in_progress POST, so that POST counts against the budget:
 *   last chunk starts by                         20 s
 *   aggregation, 2 attempts × 8 s + 1 s backoff  17 s
 *   UPDATE,      2 attempts × 5 s + 1 s backoff  11 s
 *   handler returns by                           48 s
 *   completion check-in POST (5 s abort)         53 s, leaving 7 s for the
 *                                                Axiom event + response
 * The eligible SELECT (2 × 8 s + 1 s; one cold read of it took 4.7 s)
 * ends by 22 s even after a 5 s in_progress POST. If it ends past 20 s no
 * chunk starts, so it cannot push the run past 48 s either.
 *
 * Throughput: EXPLAIN ANALYZE of 500 alerts against the 10-23 tape took
 * 9.1 s, so a 100-alert chunk is ~2 s and a tick clears roughly 1,000
 * alerts. That is about twice the busiest 10-minute fire count since
 * 09-28 (491), so a backlog drains instead of compounding.
 */
const CHUNK_SIZE = 100;
const RUN_BUDGET_MS = 20_000;
/** Per-attempt DB timeouts, one retry each; see the arithmetic above. */
const SELECT_ATTEMPT_TIMEOUT_MS = 8_000;
const AGG_ATTEMPT_TIMEOUT_MS = 8_000;
const UPDATE_ATTEMPT_TIMEOUT_MS = 5_000;
const DB_RETRIES = 1;

/** Stepped bracket — keep in sync with scripts/backfill_round_trip_score.py
 *  and the migration #154 description. Order matters: most-negative first. */
const BRACKETS: readonly { cutoff: number; deduct: number }[] = [
  { cutoff: -0.5, deduct: -3 },
  { cutoff: -0.3, deduct: -2 },
  { cutoff: -0.1, deduct: -1 },
];

function computeDeduct(netPct: number): number {
  for (const b of BRACKETS) {
    if (netPct < b.cutoff) return b.deduct;
  }
  return 0;
}

type Sql = ReturnType<typeof getDb>;
type AlertSource = 'lottery' | 'silent_boom';

interface EligibleAlert {
  source: AlertSource;
  id: number;
  option_chain_id: string;
  fire_time: Date;
  dte: number;
}

interface AggRow {
  id: number;
  source: AlertSource;
  dte: number;
  ask_size: number;
  bid_size: number;
  total_size: number;
}

interface UpdatePayload {
  id: number;
  netPct: number;
  deduct: number;
}

interface AlertChunk {
  source: AlertSource;
  alerts: EligibleAlert[];
}

/**
 * Split the newest-first eligible list into single-source chunks, so each
 * chunk costs one aggregation and one UPDATE. Silent-boom goes first: it is
 * ~3% of the volume, so it never waits behind a lottery backlog.
 */
function chunkBySource(eligible: EligibleAlert[]): AlertChunk[] {
  const chunks: AlertChunk[] = [];
  for (const source of ['silent_boom', 'lottery'] as const) {
    const ofSource = eligible.filter((a) => a.source === source);
    for (let i = 0; i < ofSource.length; i += CHUNK_SIZE) {
      chunks.push({ source, alerts: ofSource.slice(i, i + CHUNK_SIZE) });
    }
  }
  return chunks;
}

/**
 * Post-fire flow for one chunk. The chunk is unnested into a virtual input
 * table and LEFT JOIN LATERAL'd to its 60-min ws_option_trades window: one
 * query per chunk, never one per alert (the pattern in
 * fetch-net-flow-history.ts and _lib/path-shape.ts; see memory
 * feedback_batched_inserts.md).
 */
async function aggregateChunk(
  db: Sql,
  chunk: EligibleAlert[],
): Promise<AggRow[]> {
  const ids = chunk.map((a) => a.id);
  const sources = chunk.map((a) => a.source);
  const chains = chunk.map((a) => a.option_chain_id);
  const fires = chunk.map((a) =>
    a.fire_time instanceof Date
      ? a.fire_time.toISOString()
      : new Date(a.fire_time).toISOString(),
  );
  const dtes = chunk.map((a) => a.dte);

  return (await withDbRetry(
    () => db`
      SELECT t.id, t.source, t.dte::int AS dte,
             COALESCE(f.ask_size, 0)::int   AS ask_size,
             COALESCE(f.bid_size, 0)::int   AS bid_size,
             COALESCE(f.total_size, 0)::int AS total_size
        FROM unnest(
               ${ids}::int[],
               ${sources}::text[],
               ${chains}::text[],
               ${fires}::timestamptz[],
               ${dtes}::int[]
             ) AS t(id, source, chain, fire_time, dte)
   LEFT JOIN LATERAL (
               SELECT
                 SUM(size) FILTER (WHERE side = 'ask') AS ask_size,
                 SUM(size) FILTER (WHERE side = 'bid') AS bid_size,
                 SUM(size)                              AS total_size
                 FROM ws_option_trades
                WHERE option_chain = t.chain
                  AND executed_at > t.fire_time
                  AND executed_at <= t.fire_time + (${WINDOW_MIN}::int * INTERVAL '1 minute')
                  AND NOT canceled
             ) f ON TRUE
    `,
    DB_RETRIES,
    AGG_ATTEMPT_TIMEOUT_MS,
  )) as AggRow[];
}

/**
 * One batched UPDATE for a chunk's source table (unnest of three typed
 * arrays, as in fetch-net-flow-history.ts). The IS NULL guard keeps it
 * idempotent: a concurrent or retried run cannot overwrite a written value.
 */
async function writeChunk(
  db: Sql,
  source: AlertSource,
  updates: UpdatePayload[],
): Promise<void> {
  const ids = updates.map((u) => u.id);
  const net = updates.map((u) => u.netPct);
  const ded = updates.map((u) => u.deduct);
  if (source === 'lottery') {
    await withDbRetry(
      () => db`
        UPDATE lottery_finder_fires AS l
           SET round_trip_net_pct      = u.net_pct,
               round_trip_score_deduct = u.deduct
          FROM unnest(${ids}::int[], ${net}::numeric[], ${ded}::smallint[])
                 AS u(id, net_pct, deduct)
         WHERE l.id = u.id
           AND l.round_trip_net_pct IS NULL
      `,
      DB_RETRIES,
      UPDATE_ATTEMPT_TIMEOUT_MS,
    );
    return;
  }
  await withDbRetry(
    () => db`
      UPDATE silent_boom_alerts AS s
         SET round_trip_net_pct      = u.net_pct,
             round_trip_score_deduct = u.deduct
        FROM unnest(${ids}::int[], ${net}::numeric[], ${ded}::smallint[])
               AS u(id, net_pct, deduct)
       WHERE s.id = u.id
         AND s.round_trip_net_pct IS NULL
    `,
    DB_RETRIES,
    UPDATE_ATTEMPT_TIMEOUT_MS,
  );
}

export default withCronInstrumentation(
  'evaluate-round-trip',
  async (ctx): Promise<CronResult> => {
    const db = getDb();

    // Pull both alert types in one query, newest first (see the per-run
    // work bound above for why). The catch-up floor (24h) lets the cron
    // recover from extended pauses without losing alerts; the IS NULL
    // idempotency guard prevents re-evaluation.
    //
    // INTERVAL is constructed via `(${N}::int * INTERVAL '1 minute')` rather
    // than `INTERVAL '${N} minutes'` — the latter would serialise as
    // `INTERVAL '$1 minutes'` and Postgres parses the placeholder inside
    // the literal as raw text (silent failure). Same pattern as
    // detect-silent-boom.ts:248 and detect-lottery-fires.ts:179.
    const eligible = (await withDbRetry(
      () => db`
        SELECT 'lottery'::text AS source, id, option_chain_id, trigger_time_ct AS fire_time, dte
          FROM lottery_finder_fires
         WHERE round_trip_net_pct IS NULL
           AND trigger_time_ct <= NOW() - (${LOOKBACK_MIN_FLOOR}::int * INTERVAL '1 minute')
           AND trigger_time_ct >= NOW() - (${CATCHUP_FLOOR_HOURS}::int * INTERVAL '1 hour')
        UNION ALL
        SELECT 'silent_boom'::text AS source, id, option_chain_id, bucket_ct AS fire_time, dte
          FROM silent_boom_alerts
         WHERE round_trip_net_pct IS NULL
           AND bucket_ct <= NOW() - (${LOOKBACK_MIN_FLOOR}::int * INTERVAL '1 minute')
           AND bucket_ct >= NOW() - (${CATCHUP_FLOOR_HOURS}::int * INTERVAL '1 hour')
         ORDER BY fire_time DESC
      `,
      DB_RETRIES,
      SELECT_ATTEMPT_TIMEOUT_MS,
    )) as EligibleAlert[];

    if (eligible.length === 0) {
      ctx.logger.info('evaluate-round-trip: no eligible alerts in window');
      return { status: 'success', rows: 0 };
    }

    let evaluated = 0;
    let noFlow = 0;
    let deducted = 0;
    let deferred = 0;

    const chunks = chunkBySource(eligible);
    for (const [index, chunk] of chunks.entries()) {
      if (Date.now() - ctx.startTimeMs >= RUN_BUDGET_MS) {
        deferred = chunks.slice(index).reduce((n, c) => n + c.alerts.length, 0);
        break;
      }

      const aggRows = await aggregateChunk(db, chunk.alerts);
      const updates: UpdatePayload[] = [];
      for (const row of aggRows) {
        const isNoFlow = row.total_size === 0;
        // No post-fire flow on this contract within the window. Common for
        // illiquid expirations or late-day fires. We still write
        // round_trip_net_pct (to 0.0) so the cron doesn't re-evaluate this
        // alert on the next tick. round_trip_score_deduct is NOT NULL
        // DEFAULT 0 (migration #154) so writing 0 explicitly is a no-op
        // semantically — kept here to make the batched UPDATE shape uniform.
        const netPct = isNoFlow
          ? 0
          : (row.ask_size - row.bid_size) / row.total_size;
        // Deduct is gated to 0-7 DTE per the Phase 1 EDA (outcome-predictive
        // window). At 8+ DTE we still write net_pct so the front-end "Hide
        // round-tripped (any DTE)" structural filter can read it, but we
        // skip the score penalty (AUC 0.528 there — not ship-worthy).
        const deduct =
          isNoFlow || row.dte > SCORE_DEDUCT_DTE_MAX
            ? 0
            : computeDeduct(netPct);
        if (isNoFlow) {
          noFlow += 1;
        } else {
          evaluated += 1;
          if (deduct < 0) deducted += 1;
        }
        updates.push({ id: row.id, netPct, deduct });
      }

      // Written before the next chunk starts: if this run dies anyway, the
      // chunks already written stay written.
      if (updates.length > 0) await writeChunk(db, chunk.source, updates);
    }

    if (deferred > 0) {
      ctx.logger.warn(
        {
          eligible: eligible.length,
          deferred,
          budgetMs: RUN_BUDGET_MS,
        },
        'evaluate-round-trip: run budget spent; deferring the rest to the next tick',
      );
    }

    ctx.logger.info(
      { eligible: eligible.length, evaluated, deducted, noFlow, deferred },
      'evaluate-round-trip completed',
    );

    return {
      status: 'success',
      rows: evaluated + noFlow,
      metadata: {
        eligible: eligible.length,
        evaluated,
        deducted,
        noFlow,
        deferred,
      },
    };
  },
  {
    requireApiKey: false,
    timeCheck: () => isMarketHours(POST_CLOSE_EVAL_MIN),
  },
);
