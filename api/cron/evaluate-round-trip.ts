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

import { getDb } from '../_lib/db.js';
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

/** Max DTE for which the signal is meaningful — see spec Decisions §6. */
const DTE_MAX = 7;

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
}

interface FlowAgg {
  ask_size: number;
  bid_size: number;
  total_size: number;
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
    const eligible = (await db`
      SELECT 'lottery'::text AS source, id, option_chain_id, trigger_time_ct AS fire_time
        FROM lottery_finder_fires
       WHERE round_trip_net_pct IS NULL
         AND dte <= ${DTE_MAX}
         AND trigger_time_ct <= NOW() - (${LOOKBACK_MIN_FLOOR}::int * INTERVAL '1 minute')
         AND trigger_time_ct >= NOW() - (${CATCHUP_FLOOR_HOURS}::int * INTERVAL '1 hour')
      UNION ALL
      SELECT 'silent_boom'::text AS source, id, option_chain_id, bucket_ct AS fire_time
        FROM silent_boom_alerts
       WHERE round_trip_net_pct IS NULL
         AND dte <= ${DTE_MAX}
         AND bucket_ct <= NOW() - (${LOOKBACK_MIN_FLOOR}::int * INTERVAL '1 minute')
         AND bucket_ct >= NOW() - (${CATCHUP_FLOOR_HOURS}::int * INTERVAL '1 hour')
    `) as EligibleAlert[];

    if (eligible.length === 0) {
      ctx.logger.info('evaluate-round-trip: no eligible alerts in window');
      return { status: 'success', rows: 0 };
    }

    let evaluated = 0;
    let noFlow = 0;
    let deducted = 0;

    for (const alert of eligible) {
      // Aggregate post-fire flow on the contract over a fixed 60-min window
      // starting at the alert's fire_time. side is pre-classified by the
      // uw-stream daemon, so SUM-FILTER-by-side gives us per-print attribution
      // directly (no tag parsing needed — see header comment).
      const aggRows = (await db`
        SELECT
          COALESCE(SUM(size) FILTER (WHERE side = 'ask'), 0)::int AS ask_size,
          COALESCE(SUM(size) FILTER (WHERE side = 'bid'), 0)::int AS bid_size,
          COALESCE(SUM(size), 0)::int                              AS total_size
        FROM ws_option_trades
        WHERE option_chain = ${alert.option_chain_id}
          AND executed_at > ${alert.fire_time}
          AND executed_at <= ${alert.fire_time}::timestamptz + (${WINDOW_MIN}::int * INTERVAL '1 minute')
          AND NOT canceled
      `) as FlowAgg[];

      const agg = aggRows[0] ?? { ask_size: 0, bid_size: 0, total_size: 0 };

      if (agg.total_size === 0) {
        // No post-fire flow on this contract within the window. Common for
        // illiquid expirations or late-day fires. We still mark
        // round_trip_net_pct (to 0.0) so the cron doesn't re-evaluate this
        // alert on the next tick. Deduct stays 0.
        noFlow += 1;
        // Branch by source to avoid `${db(identifier)}` dynamic-identifier
        // interpolation — keeps the SQL static and tests deterministic.
        if (alert.source === 'lottery') {
          await db`
            UPDATE lottery_finder_fires
               SET round_trip_net_pct = 0
             WHERE id = ${alert.id}
               AND round_trip_net_pct IS NULL
          `;
        } else {
          await db`
            UPDATE silent_boom_alerts
               SET round_trip_net_pct = 0
             WHERE id = ${alert.id}
               AND round_trip_net_pct IS NULL
          `;
        }
        continue;
      }

      const netPct = (agg.ask_size - agg.bid_size) / agg.total_size;
      const deduct = computeDeduct(netPct);
      if (deduct < 0) deducted += 1;

      if (alert.source === 'lottery') {
        await db`
          UPDATE lottery_finder_fires
             SET round_trip_net_pct = ${netPct},
                 round_trip_score_deduct = ${deduct}
           WHERE id = ${alert.id}
             AND round_trip_net_pct IS NULL
        `;
      } else {
        await db`
          UPDATE silent_boom_alerts
             SET round_trip_net_pct = ${netPct},
                 round_trip_score_deduct = ${deduct}
           WHERE id = ${alert.id}
             AND round_trip_net_pct IS NULL
        `;
      }
      evaluated += 1;
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
