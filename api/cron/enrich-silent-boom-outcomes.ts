/**
 * GET /api/cron/enrich-silent-boom-outcomes
 *
 * Enriches silent_boom_alerts rows with realized exit policy outcomes by
 * reading the post-spike price stream from ws_option_trades. Runs after
 * market close (21:30 UTC / 4:30 PM ET) to ensure the full day's trade
 * data is available.
 *
 * For each unenriched alert (enriched_at IS NULL), queries ws_option_trades
 * for all prints on that option_chain at or after bucket_ct (the
 * 5-min spike bucket start is the entry timestamp), computes peak +
 * minutes-to-peak, fixed-horizon returns at +30m / +60m / +120m, EoD,
 * and the trail-30/10 exit policy, then updates the alert record.
 *
 * Mirrors `api/cron/enrich-lottery-outcomes.ts`. Differences from the
 * lottery template:
 *
 *   - Table is `silent_boom_alerts` (not `lottery_finder_fires`).
 *   - Entry timestamp is `bucket_ct` (the 5-min spike bucket start),
 *     not a separate `entry_time_ct` column.
 *   - Drops hard30m / tier50 / flow-inversion policies — silent boom
 *     does not store those columns; the only realized policy here is
 *     trail-30/10. Adds fixed-horizon 30m / 60m / 120m returns which
 *     ARE columns on silent_boom_alerts (mirror the Python script's
 *     at_horizon() logic in scripts/enrich_silent_boom_outcomes.py).
 *
 * Cadence: 21:30 UTC Mon-Fri (30 min after market close).
 *
 * Environment: CRON_SECRET
 *
 * Spec: docs/superpowers/specs/silent-boom-otm-tide-and-trail-2026-05-13.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  realizedTrailAct30Trail10,
  peakCeiling,
  minutesToPeak,
} from '../_lib/lottery-exit-policies.js';

interface UnenrichedAlert {
  id: number;
  optionChainId: string;
  bucketCt: Date;
  entryPrice: number;
}

interface TradeTick {
  alertId: number;
  executedAt: Date;
  price: number;
}

/** Enriched UPDATE payload — one per alert that had post-entry ticks.
 *  r30/r60/r120 are nullable: returnAtHorizon returns null when no tick
 *  falls inside the horizon, and that NULL must survive into the DB so a
 *  sparse-chain alert isn't coded as a bogus 0%. peak/minToPeak/eod/trail30
 *  are always numeric (their exit-policy helpers never return null). */
interface EnrichUpdate {
  id: number;
  peak: number;
  minToPeak: number;
  r30: number | null;
  r60: number | null;
  r120: number | null;
  eod: number;
  trail30: number;
}

/**
 * Fixed-horizon forward return — last price at or before `horizonMin`
 * minutes after entry. Returns `null` when no tick falls inside the
 * horizon so the column stays NULL in the DB; coding "no data" as 0%
 * would silently inflate win rates for sparse chains. Mirrors the
 * Python `at_horizon()` in scripts/enrich_silent_boom_outcomes.py.
 */
function returnAtHorizon(
  prices: number[],
  minutesSinceEntry: number[],
  entryPrice: number,
  horizonMin: number,
): number | null {
  let lastInIdx = -1;
  for (let i = 0; i < minutesSinceEntry.length; i++) {
    if (minutesSinceEntry[i]! <= horizonMin) lastInIdx = i;
    else break;
  }
  if (lastInIdx === -1) return null;
  return ((prices[lastInIdx]! - entryPrice) / entryPrice) * 100;
}

export default withCronInstrumentation(
  'enrich-silent-boom-outcomes',
  async (): Promise<CronResult> => {
    const db = getDb();

    const alerts = (await withDbRetry(
      () => db`
        SELECT
          id,
          option_chain_id AS "optionChainId",
          bucket_ct AS "bucketCt",
          -- NUMERIC → float8 so entryPrice is a real number, not a string.
          entry_price::float8 AS "entryPrice"
        FROM silent_boom_alerts
        WHERE enriched_at IS NULL
        ORDER BY inserted_at ASC
        -- Bound the batch so a backlog can't queue 1000s of UW intraday
        -- calls in one run, overrunning the shared 115/min UW cap + 300s
        -- maxDuration (the "UW 429" pile-up fix). Leftover alerts drain
        -- oldest-first on the next run. Mirrors enrich-lottery-outcomes.
        LIMIT 300
      `,
      2,
      10_000,
    )) as UnenrichedAlert[];

    if (alerts.length === 0) {
      return { status: 'success', message: 'No unenriched fires' };
    }

    let enriched = 0;
    let skipped = 0;

    // ONE batched ticks read — unnest the candidate alerts into a virtual
    // input table, JOIN LATERAL the per-alert post-entry print stream.
    // Replaces the prior per-alert SELECT loop (1 + 2N queries → ≤3 queries
    // flat). Same shape as evaluate-round-trip.ts:148 and
    // enrich-lottery-outcomes' batched refactor. Rows arrive ordered by
    // (alert id, executed_at) so a single linear pass buckets them per alert.
    const ids = alerts.map((a) => a.id);
    const chains = alerts.map((a) => a.optionChainId);
    const entries = alerts.map((a) =>
      a.bucketCt instanceof Date
        ? a.bucketCt.toISOString()
        : new Date(a.bucketCt).toISOString(),
    );

    const tickRows = (await withDbRetry(
      () => db`
        SELECT
          u.id AS "alertId",
          t.executed_at AS "executedAt",
          -- price is Postgres NUMERIC; the Neon serverless driver returns
          -- NUMERIC as a STRING. Cast to float8 so downstream comparisons
          -- (peakCeiling/minutesToPeak) are numeric, not lexicographic.
          t.price::float8 AS price
        FROM unnest(
               ${ids}::int[],
               ${chains}::text[],
               ${entries}::timestamptz[]
             ) AS u(id, chain, entry)
        JOIN LATERAL (
               SELECT executed_at, price
                 FROM ws_option_trades
                WHERE option_chain = u.chain
                  AND executed_at >= u.entry
                  AND canceled = FALSE
                  AND price > 0
                ORDER BY executed_at ASC
             ) t ON TRUE
        ORDER BY u.id, t.executed_at
      `,
      2,
      30_000,
    )) as TradeTick[];

    // Bucket ticks per alert. Rows arrive ordered by (alert id, executed_at),
    // so each alert's ticks are already contiguous and ascending.
    const ticksByAlert = new Map<number, TradeTick[]>();
    for (const row of tickRows) {
      const bucket = ticksByAlert.get(row.alertId);
      if (bucket) bucket.push(row);
      else ticksByAlert.set(row.alertId, [row]);
    }

    const updates: EnrichUpdate[] = [];
    const noTickIds: number[] = [];

    for (const alert of alerts) {
      const ticks = ticksByAlert.get(alert.id);

      if (!ticks || ticks.length === 0) {
        // No post-entry ticks → nothing to compute. Collect for a TERMINAL
        // marker stamp so this alert leaves the candidate set
        // (enriched_at IS NULL). Without it the row is re-selected every run
        // forever, and once ws_option_trades purges (2-day retention) it
        // becomes permanently un-enrichable while still accumulating in the
        // scan. Realized/peak columns stay NULL so a no-tick alert is
        // distinguishable from a real outcome (no bogus 0).
        noTickIds.push(alert.id);
        skipped++;
        continue;
      }

      const prices = ticks.map((t) => t.price);
      const minutesSinceEntry = ticks.map((t) => {
        const deltaMs = t.executedAt.getTime() - alert.bucketCt.getTime();
        return deltaMs / 60_000;
      });

      const peak = peakCeiling(prices, alert.entryPrice);
      const minToPeak = minutesToPeak(prices, minutesSinceEntry);
      const r30 = returnAtHorizon(
        prices,
        minutesSinceEntry,
        alert.entryPrice,
        30,
      );
      const r60 = returnAtHorizon(
        prices,
        minutesSinceEntry,
        alert.entryPrice,
        60,
      );
      const r120 = returnAtHorizon(
        prices,
        minutesSinceEntry,
        alert.entryPrice,
        120,
      );
      const eod =
        ((prices.at(-1)! - alert.entryPrice) / alert.entryPrice) * 100;
      const trail30 = realizedTrailAct30Trail10(prices, alert.entryPrice);

      updates.push({
        id: alert.id,
        peak,
        minToPeak,
        r30,
        r60,
        r120,
        eod,
        trail30,
      });
      enriched++;
    }

    // TWO batched writes after the loop, each guarded on non-empty.
    //
    // (1) Enriched UPDATE — unnest of typed arrays joined back by id. The
    // realized_30m/60m/120m arrays are float8[] and PRESERVE NULL elements
    // (a sparse-chain alert keeps NULL columns, not a bogus 0). Mirrors the
    // evaluate-round-trip.ts batched UPDATE shape.
    if (updates.length > 0) {
      const upIds = updates.map((u) => u.id);
      const upPeak = updates.map((u) => u.peak);
      const upMinToPeak = updates.map((u) => u.minToPeak);
      const upR30 = updates.map((u) => u.r30);
      const upR60 = updates.map((u) => u.r60);
      const upR120 = updates.map((u) => u.r120);
      const upEod = updates.map((u) => u.eod);
      const upTrail30 = updates.map((u) => u.trail30);
      await withDbRetry(
        () => db`
          UPDATE silent_boom_alerts AS s
          SET
            peak_ceiling_pct = u.peak,
            minutes_to_peak = u.min_to_peak,
            realized_30m_pct = u.r30,
            realized_60m_pct = u.r60,
            realized_120m_pct = u.r120,
            realized_eod_pct = u.eod,
            realized_trail30_10_pct = u.trail30,
            enriched_at = NOW()
          FROM unnest(
                 ${upIds}::int[],
                 ${upPeak}::float8[],
                 ${upMinToPeak}::float8[],
                 ${upR30}::float8[],
                 ${upR60}::float8[],
                 ${upR120}::float8[],
                 ${upEod}::float8[],
                 ${upTrail30}::float8[]
               ) AS u(id, peak, min_to_peak, r30, r60, r120, eod, trail30)
          WHERE s.id = u.id
        `,
        2,
        30_000,
      );
    }

    // (2) No-tick terminal UPDATE — stamp enriched_at on the un-enrichable
    // alerts in one statement so they leave the candidate set. Realized/peak
    // columns stay NULL.
    if (noTickIds.length > 0) {
      await withDbRetry(
        () => db`
          UPDATE silent_boom_alerts
          SET enriched_at = NOW()
          WHERE id = ANY(${noTickIds}::int[])
        `,
        2,
        30_000,
      );
    }

    return {
      status: 'success',
      message: `Enriched ${enriched} fires, skipped ${skipped} (no post-entry ticks)`,
    };
  },
  // Scheduled at 21:30 UTC = 17:30 ET = 90 min after the market-hours
  // gate's 16:05 ET close-buffer. Disable the gate so the run actually
  // happens. UW is not called, so apiKey is not required either.
  { marketHours: false, requireApiKey: false },
);
