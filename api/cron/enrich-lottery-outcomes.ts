/**
 * GET /api/cron/enrich-lottery-outcomes
 *
 * Enriches lottery_finder_fires rows with realized exit policy outcomes
 * by reading the post-entry price stream from ws_option_trades. Runs
 * after market close (21:30 UTC / 4:30 PM ET) to ensure the full day's
 * trade data is available.
 *
 * For each unenriched fire (enriched_at IS NULL), queries ws_option_trades
 * for all prints on that option_chain after entry_time_ct, computes the
 * four exit policies plus peak metrics, and updates the fire record.
 *
 * Cadence: 21:30 UTC Mon-Fri (30 min after market close).
 *
 * Environment: CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  realizedTrailAct30Trail10,
  realizedHardStop30m,
  realizedTier50HoldEod,
  peakCeiling,
  minutesToPeak,
} from '../_lib/lottery-exit-policies.js';

interface UnenrichedFire {
  id: number;
  optionChainId: string;
  entryTimeCt: Date;
  entryPrice: number;
  expiry: Date;
}

interface TradeTick {
  executedAt: Date;
  price: number;
}

export default withCronInstrumentation(
  'enrich-lottery-outcomes',
  async (): Promise<CronResult> => {
    const db = getDb();

    const fires = (await db`
      SELECT
        id,
        option_chain_id AS "optionChainId",
        entry_time_ct AS "entryTimeCt",
        entry_price AS "entryPrice",
        expiry
      FROM lottery_finder_fires
      WHERE enriched_at IS NULL
      ORDER BY inserted_at ASC
      LIMIT 1000
    `) as UnenrichedFire[];

    if (fires.length === 0) {
      return { status: 'success', message: 'No unenriched fires' };
    }

    let enriched = 0;
    let skipped = 0;

    for (const fire of fires) {
      const ticks = (await db`
        SELECT
          executed_at AS "executedAt",
          price
        FROM ws_option_trades
        WHERE option_chain = ${fire.optionChainId}
          AND executed_at >= ${fire.entryTimeCt}
          AND canceled = FALSE
          AND price > 0
        ORDER BY executed_at ASC
      `) as TradeTick[];

      if (ticks.length === 0) {
        skipped++;
        continue;
      }

      const prices = ticks.map((t) => t.price);
      const minutesSinceEntry = ticks.map((t) => {
        const deltaMs = t.executedAt.getTime() - fire.entryTimeCt.getTime();
        return deltaMs / 60_000;
      });

      const trail30_10 = realizedTrailAct30Trail10(prices, fire.entryPrice);
      const hard30m = realizedHardStop30m(
        prices,
        fire.entryPrice,
        minutesSinceEntry,
      );
      const tier50 = realizedTier50HoldEod(prices, fire.entryPrice);
      const eod = ((prices.at(-1)! - fire.entryPrice) / fire.entryPrice) * 100;
      const peak = peakCeiling(prices, fire.entryPrice);
      const minToPeak = minutesToPeak(prices, minutesSinceEntry);

      await db`
        UPDATE lottery_finder_fires
        SET
          realized_trail30_10_pct = ${trail30_10},
          realized_hard30m_pct = ${hard30m},
          realized_tier50_holdeod_pct = ${tier50},
          realized_eod_pct = ${eod},
          peak_ceiling_pct = ${peak},
          minutes_to_peak = ${minToPeak},
          enriched_at = NOW()
        WHERE id = ${fire.id}
      `;

      enriched++;
    }

    return {
      status: 'success',
      message: `Enriched ${enriched} fires, skipped ${skipped} (no post-entry ticks)`,
    };
  },
);
