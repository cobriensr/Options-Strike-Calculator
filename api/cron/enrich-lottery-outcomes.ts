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
 * Also computes realized_flow_inversion_pct using the per-minute UW REST
 * `/option-contract/{id}/intraday` tape (cached in option_intraday_nbbo)
 * combined with matched-side flow from net_flow_per_ticker_history. See
 * `api/_lib/flow-inversion.ts` for the algorithm and
 * `docs/superpowers/specs/lottery-flow-inversion-automation-2026-05-05.md`
 * for the broader Phase 2 design.
 *
 * Cadence: 21:40 UTC Mon-Fri (40 min after market close).
 *
 * Environment: CRON_SECRET, UW_API_KEY
 */

import { getDb, withDbRetry, safeDbVoid } from '../_lib/db.js';
import logger from '../_lib/logger.js';
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
import { fetchAndCacheOptionIntraday } from '../_lib/option-intraday.js';
import {
  simulateFlowInversion,
  type FlowMinute,
} from '../_lib/flow-inversion.js';

interface UnenrichedFire {
  id: number;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  date: Date | string;
  triggerTimeCt: Date;
  entryTimeCt: Date;
  entryPrice: number;
  expiry: Date;
}

interface TradeTick {
  executedAt: Date;
  price: number;
}

interface FlowRow {
  ts: Date;
  netCallPrem: string | number | null;
  netPutPrem: string | number | null;
}

/**
 * Convert the date column (Date or YYYY-MM-DD string) to YYYY-MM-DD.
 * Neon's serverless driver returns DATE columns as Date when no
 * explicit cast is in the SELECT.
 */
function dateToIso(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // Use UTC to avoid TZ-shift on the JS Date.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Per-ticker-per-date matched-side flow loader with a process-local
 * cache so 1000 fires across ~50 tickers do not emit 1000 SELECTs.
 */
async function loadMatchedFlow(
  cache: Map<string, FlowMinute[]>,
  ticker: string,
  date: string,
  optionType: 'C' | 'P',
): Promise<FlowMinute[]> {
  const key = `${ticker}|${date}|${optionType}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const db = getDb();
  const rows = (await withDbRetry(
    () => db`
      SELECT ts, net_call_prem AS "netCallPrem", net_put_prem AS "netPutPrem"
      FROM net_flow_per_ticker_history
      WHERE ticker = ${ticker}
        AND ts >= ${`${date}T00:00:00Z`}::timestamptz
        AND ts <  ${`${date}T00:00:00Z`}::timestamptz + INTERVAL '1 day'
      ORDER BY ts ASC
    `,
    2,
    10_000,
  )) as FlowRow[];
  const out: FlowMinute[] = rows
    .map((r) => {
      const raw =
        optionType === 'C' ? (r.netCallPrem ?? 0) : (r.netPutPrem ?? 0);
      const value = typeof raw === 'number' ? raw : Number.parseFloat(raw);
      return Number.isFinite(value) ? { ts: r.ts, value } : null;
    })
    .filter((m): m is FlowMinute => m != null);
  cache.set(key, out);
  return out;
}

/**
 * Best-effort retention prune for `lottery_kept_tickers` (the DB-backed
 * never-vanish kept-set). The table grows one row per (trade_date,
 * underlying_symbol) with no other cleanup, so without this it accumulates
 * forever. Keep ~1 week of history and drop anything older.
 *
 * Wrapped in `safeDbVoid` so a prune failure is swallowed (increments the
 * `db.error` metric) and NEVER fails this cron's primary enrichment job —
 * retention is strictly secondary to outcome enrichment.
 *
 * 7-day window: today's rows (and any from the last 7 days) are never
 * touched. This preserves the Phase 1 write-amplification invariant in
 * `lottery-finder.ts`, whose diff-skip on `addKeptTickers` depends on
 * today's rows always being present in the table.
 */
async function pruneKeptTickers(): Promise<void> {
  await safeDbVoid(async () => {
    const db = getDb();
    await db`
      DELETE FROM lottery_kept_tickers
      WHERE trade_date
            < ((now() AT TIME ZONE 'America/New_York')::date - INTERVAL '7 days')::date
    `;
  });
}

export default withCronInstrumentation(
  'enrich-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const db = getDb();
    const { apiKey } = ctx;

    // Each fire with post-entry ticks makes one UW /option-contract
    // intraday call. Steady state is ~52 fires/day, but a backlog (cron
    // outage) could otherwise queue 1000s of UW calls in one run —
    // throttled to the shared 115/min UW cap, that overruns the 300s
    // maxDuration and spews "UW 429" warnings. Cap the batch so a run
    // always fits the budget + timeout; leftover fires roll to the next
    // run (ORDER BY inserted_at ASC drains oldest first). Paired with the
    // 21:40 schedule slot (staggered off the 21:30 enrich-* pile-up).
    const fires = (await withDbRetry(
      () => db`
        SELECT
          id,
          option_chain_id AS "optionChainId",
          underlying_symbol AS "underlyingSymbol",
          option_type AS "optionType",
          date,
          trigger_time_ct AS "triggerTimeCt",
          entry_time_ct AS "entryTimeCt",
          entry_price AS "entryPrice",
          expiry
        FROM lottery_finder_fires
        WHERE enriched_at IS NULL
        ORDER BY inserted_at ASC
        LIMIT 300
      `,
      2,
      10_000,
    )) as UnenrichedFire[];

    if (fires.length === 0) {
      await pruneKeptTickers();
      return { status: 'success', message: 'No unenriched fires' };
    }

    let enriched = 0;
    let skipped = 0;
    let inversionFilled = 0;
    const flowCache = new Map<string, FlowMinute[]>();

    for (const fire of fires) {
      const ticks = (await withDbRetry(
        () => db`
          SELECT
            executed_at AS "executedAt",
            price
          FROM ws_option_trades
          WHERE option_chain = ${fire.optionChainId}
            AND executed_at >= ${fire.entryTimeCt}
            AND canceled = FALSE
            AND price > 0
          ORDER BY executed_at ASC
        `,
        2,
        10_000,
      )) as TradeTick[];

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

      // Flow-inversion: failures are non-fatal — column stays NULL for
      // this fire and the rest of the enrichment still lands.
      let flowInversion: number | null = null;
      try {
        const dateStr = dateToIso(fire.date);
        const minutes = await fetchAndCacheOptionIntraday(
          apiKey,
          fire.optionChainId,
          dateStr,
        );
        if (minutes.length > 0) {
          const flow = await loadMatchedFlow(
            flowCache,
            fire.underlyingSymbol,
            dateStr,
            fire.optionType,
          );
          const result = simulateFlowInversion(
            minutes,
            flow,
            fire.entryPrice,
            fire.triggerTimeCt,
          );
          if (result.exitPct != null && Number.isFinite(result.exitPct)) {
            flowInversion = result.exitPct;
          }
        }
      } catch (err) {
        logger.warn(
          { err, fireId: fire.id, optionChainId: fire.optionChainId },
          'enrich-lottery-outcomes: flow-inversion failed',
        );
      }
      if (flowInversion != null) inversionFilled++;

      await withDbRetry(
        () => db`
          UPDATE lottery_finder_fires
          SET
            realized_trail30_10_pct = ${trail30_10},
            realized_hard30m_pct = ${hard30m},
            realized_tier50_holdeod_pct = ${tier50},
            realized_eod_pct = ${eod},
            realized_flow_inversion_pct = ${flowInversion},
            peak_ceiling_pct = ${peak},
            minutes_to_peak = ${minToPeak},
            enriched_at = NOW()
          WHERE id = ${fire.id}
        `,
        2,
        10_000,
      );

      enriched++;
    }

    // Best-effort retention prune, AFTER all enrichment work has landed so a
    // prune failure can never roll back or fail the primary job.
    await pruneKeptTickers();

    return {
      status: 'success',
      message: `Enriched ${enriched} fires (flow_inversion populated ${inversionFilled}), skipped ${skipped} (no post-entry ticks)`,
    };
  },
  // Scheduled at 21:30 UTC = 17:30 ET = 90 min past the market-hours
  // gate's 16:05 ET close-buffer. Without disabling the gate, cronGuard
  // would skip every scheduled run with 'Outside time window' (manual
  // Python runs of scripts/enrich_lottery_outcomes.py had been masking
  // this in prod — verified by 21:49-22:11 UTC enrichment timestamps
  // on multiple weekdays). UW is still required for flow-inversion.
  { marketHours: false },
);
