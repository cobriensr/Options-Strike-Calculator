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
  executedAt: Date;
  price: number;
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

    for (const alert of alerts) {
      const ticks = (await withDbRetry(
        () => db`
          SELECT
            executed_at AS "executedAt",
            -- price is Postgres NUMERIC; the Neon serverless driver returns
            -- NUMERIC as a STRING. Cast to float8 so downstream comparisons
            -- (peakCeiling/minutesToPeak) are numeric, not lexicographic.
            price::float8 AS price
          FROM ws_option_trades
          WHERE option_chain = ${alert.optionChainId}
            AND executed_at >= ${alert.bucketCt}
            AND canceled = FALSE
            AND price > 0
          ORDER BY executed_at ASC
        `,
        2,
        10_000,
      )) as TradeTick[];

      if (ticks.length === 0) {
        // No post-entry ticks → nothing to compute. Stamp a TERMINAL marker
        // so this alert leaves the candidate set (enriched_at IS NULL).
        // Without it the row is re-selected every run forever, and once
        // ws_option_trades purges (2-day retention) it becomes permanently
        // un-enrichable while still accumulating in the scan. Realized/peak
        // columns stay NULL so a no-tick alert is distinguishable from a real
        // outcome (no bogus 0).
        await withDbRetry(
          () => db`
            UPDATE silent_boom_alerts
            SET enriched_at = NOW()
            WHERE id = ${alert.id}
          `,
          2,
          10_000,
        );
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

      await withDbRetry(
        () => db`
          UPDATE silent_boom_alerts
          SET
            peak_ceiling_pct = ${peak},
            minutes_to_peak = ${minToPeak},
            realized_30m_pct = ${r30},
            realized_60m_pct = ${r60},
            realized_120m_pct = ${r120},
            realized_eod_pct = ${eod},
            realized_trail30_10_pct = ${trail30},
            enriched_at = NOW()
          WHERE id = ${alert.id}
        `,
        2,
        10_000,
      );

      enriched++;
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
