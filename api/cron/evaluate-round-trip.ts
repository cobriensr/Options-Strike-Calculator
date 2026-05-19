/**
 * GET /api/cron/evaluate-round-trip
 *
 * Runs every 10 min during market hours. Computes
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
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

/** Look-forward window length for the net-pct computation. */
const WINDOW_MIN = 60;

/** How far back to wait before evaluating. Alerts younger than this haven't
 *  accumulated the full 60-min post-fire flow window yet. */
const LOOKBACK_MIN_FLOOR = 60;

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

interface EligibleAlert {
  source: 'lottery' | 'silent_boom';
  id: number;
  option_chain_id: string;
  fire_time: Date;
  dte: number;
}

interface AggRow {
  id: number;
  source: 'lottery' | 'silent_boom';
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

export default withCronInstrumentation(
  'evaluate-round-trip',
  async (ctx): Promise<CronResult> => {
    const db = getDb();

    // Pull both alert types in one query — UNION ALL keeps the row order
    // deterministic by source so logging is readable. The catch-up floor
    // (24h) lets the cron recover from extended pauses without losing
    // alerts; the IS NULL idempotency guard prevents re-evaluation.
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
      `,
      2,
      10_000,
    )) as EligibleAlert[];

    if (eligible.length === 0) {
      ctx.logger.info('evaluate-round-trip: no eligible alerts in window');
      return { status: 'success', rows: 0 };
    }

    // ONE batched aggregation — unnest the eligible alerts into a virtual
    // input table, LEFT JOIN LATERAL the per-row post-fire window aggregation.
    // Replaces the prior per-row SELECT loop (1 + 2N queries → 4 queries
    // flat). The pattern matches fetch-net-flow-history.ts:149 and
    // _lib/path-shape.ts:110. See memory feedback_batched_inserts.md.
    const ids = eligible.map((a) => a.id);
    const sources = eligible.map((a) => a.source);
    const chains = eligible.map((a) => a.option_chain_id);
    const fires = eligible.map((a) =>
      a.fire_time instanceof Date
        ? a.fire_time.toISOString()
        : new Date(a.fire_time).toISOString(),
    );
    const dtes = eligible.map((a) => a.dte);

    const aggRows = (await withDbRetry(
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
      2,
      10_000,
    )) as AggRow[];

    let evaluated = 0;
    let noFlow = 0;
    let deducted = 0;
    const lotUpdates: UpdatePayload[] = [];
    const sbUpdates: UpdatePayload[] = [];

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
        isNoFlow || row.dte > SCORE_DEDUCT_DTE_MAX ? 0 : computeDeduct(netPct);
      if (isNoFlow) {
        noFlow += 1;
      } else {
        evaluated += 1;
        if (deduct < 0) deducted += 1;
      }
      const update: UpdatePayload = { id: row.id, netPct, deduct };
      if (row.source === 'lottery') lotUpdates.push(update);
      else sbUpdates.push(update);
    }

    // Up to TWO batched UPDATEs total — one per source table — regardless
    // of how many alerts were evaluated. unnest of 3 typed arrays mirrors
    // fetch-net-flow-history.ts:149. The IS NULL guard preserves
    // idempotency (concurrent re-run can't overwrite an already-written
    // value).
    if (lotUpdates.length > 0) {
      const lotIds = lotUpdates.map((u) => u.id);
      const lotNet = lotUpdates.map((u) => u.netPct);
      const lotDed = lotUpdates.map((u) => u.deduct);
      await withDbRetry(
        () => db`
          UPDATE lottery_finder_fires AS l
             SET round_trip_net_pct      = u.net_pct,
                 round_trip_score_deduct = u.deduct
            FROM unnest(${lotIds}::int[], ${lotNet}::numeric[], ${lotDed}::smallint[])
                   AS u(id, net_pct, deduct)
           WHERE l.id = u.id
             AND l.round_trip_net_pct IS NULL
        `,
        2,
        10_000,
      );
    }
    if (sbUpdates.length > 0) {
      const sbIds = sbUpdates.map((u) => u.id);
      const sbNet = sbUpdates.map((u) => u.netPct);
      const sbDed = sbUpdates.map((u) => u.deduct);
      await withDbRetry(
        () => db`
          UPDATE silent_boom_alerts AS s
             SET round_trip_net_pct      = u.net_pct,
                 round_trip_score_deduct = u.deduct
            FROM unnest(${sbIds}::int[], ${sbNet}::numeric[], ${sbDed}::smallint[])
                   AS u(id, net_pct, deduct)
           WHERE s.id = u.id
             AND s.round_trip_net_pct IS NULL
        `,
        2,
        10_000,
      );
    }

    ctx.logger.info(
      { eligible: eligible.length, evaluated, deducted, noFlow },
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
      },
    };
  },
  { requireApiKey: false },
);
