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
import { metrics } from '../_lib/sentry.js';
import { KEPT_RETENTION_DAYS } from '../_lib/constants.js';
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

/** One row of the batched LATERAL read — joins a fire id to a single tick. */
interface BatchedTickRow {
  fireId: number;
  executedAt: Date;
  price: number;
}

/** Accumulated enrichment for one fire, staged for the batched UPDATE. */
interface EnrichUpdate {
  id: number;
  trail30_10: number;
  hard30m: number;
  tier50: number;
  eod: number;
  flowInversion: number | null;
  peak: number;
  minToPeak: number;
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
 * forever. Keep `KEPT_RETENTION_DAYS` of history and drop anything older.
 *
 * Wrapped in `safeDbVoid` so a prune failure is swallowed (increments the
 * `db.error` metric) and NEVER fails this cron's primary enrichment job —
 * retention is strictly secondary to outcome enrichment.
 *
 * Retention window: today's rows (and any from the last KEPT_RETENTION_DAYS
 * days) are never touched. The strict `<` cutoff is LOAD-BEARING — it
 * preserves the Phase 1 write-amplification invariant in
 * `lottery-finder.ts`, whose set-difference diff-skip on `addKeptTickers`
 * depends on today's rows always being present in the table.
 *
 * SQL form: `(now() AT TIME ZONE 'America/New_York')::date
 * - ${KEPT_RETENTION_DAYS}::int` stays a `date` (date − integer = date), no
 * double-cast. The `::int` cast on the bound param resolves the otherwise-
 * ambiguous `date - $param` operator (Postgres can't infer the param type
 * for bare `-`), matching the codebase's existing numeric-param-vs-temporal
 * pattern (e.g. gexbot-queries.ts `${windowMinutes}::int * INTERVAL ...`).
 * KEPT_RETENTION_DAYS is a trusted compile-time constant, so binding it as
 * a param is safe (and keeps it observable in the cron test's mock harness).
 *
 * Emits the `lottery.kept_prune` heartbeat counter on each successful prune
 * so a silently-disabled/renamed cron shows up as a flatlined metric.
 */
async function pruneKeptTickers(): Promise<void> {
  await safeDbVoid(async () => {
    const db = getDb();
    await db`
      DELETE FROM lottery_kept_tickers
      WHERE trade_date
            < (now() AT TIME ZONE 'America/New_York')::date - ${KEPT_RETENTION_DAYS}::int
    `;
    metrics.increment('lottery.kept_prune');
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
          -- NUMERIC → float8 so entryPrice is a real number, not a string.
          entry_price::float8 AS "entryPrice",
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

    // ── ONE batched read of EVERY fire's post-entry ticks ────────────────────
    // Replaces the prior per-fire SELECT loop (N awaited reads → 1). unnest the
    // fires into a virtual input table, then JOIN LATERAL the per-chain tape
    // window. JOIN (not LEFT) so no-tick fires simply don't appear in the
    // result — they're recovered below via the ids that never land in the Map.
    // ORDER BY u.fire_id, t.executed_at keeps each fire's ticks chronological,
    // matching the prior per-fire `ORDER BY executed_at ASC`. Mirrors the
    // evaluate-round-trip.ts LATERAL pattern; heavy on ws_option_trades, so the
    // longer 30s retry timeout (vs the prior 10s) matches that cron.
    const ids = fires.map((f) => f.id);
    const chains = fires.map((f) => f.optionChainId);
    const entries = fires.map((f) => f.entryTimeCt.toISOString());

    const tickRows = (await withDbRetry(
      () => db`
        SELECT
          u.fire_id AS "fireId",
          t.executed_at AS "executedAt",
          -- price is Postgres NUMERIC; the Neon serverless driver returns
          -- NUMERIC as a STRING. Cast to float8 so downstream comparisons
          -- (peakCeiling/minutesToPeak) are numeric, not lexicographic.
          t.price::float8 AS price
        FROM unnest(
               ${ids}::int[],
               ${chains}::text[],
               ${entries}::timestamptz[]
             ) AS u(fire_id, chain, entry)
        JOIN LATERAL (
          SELECT executed_at, price
            FROM ws_option_trades
           WHERE option_chain = u.chain
             AND executed_at >= u.entry
             AND canceled = FALSE
             AND price > 0
           ORDER BY executed_at ASC
        ) t ON TRUE
        ORDER BY u.fire_id, t.executed_at ASC
      `,
      2,
      30_000,
    )) as BatchedTickRow[];

    // Group ticks by fire id. Rows arrive ordered by (fire_id, executed_at),
    // so each fire's ticks stay chronological as they're pushed in order.
    const ticksByFire = new Map<number, TradeTick[]>();
    for (const row of tickRows) {
      let arr = ticksByFire.get(row.fireId);
      if (arr === undefined) {
        arr = [];
        ticksByFire.set(row.fireId, arr);
      }
      arr.push({ executedAt: row.executedAt, price: row.price });
    }

    // Stage results in JS, then flush in two batched writes after the loop.
    const noTickIds: number[] = [];
    const updates: EnrichUpdate[] = [];

    for (const fire of fires) {
      const ticks = ticksByFire.get(fire.id) ?? [];

      if (ticks.length === 0) {
        // No post-entry ticks → nothing to compute. Stamp a TERMINAL marker
        // so this fire leaves the candidate set (enriched_at IS NULL). Without
        // it the row is re-selected every run forever, and once ws_option_trades
        // purges (2-day retention) it becomes permanently un-enrichable while
        // still accumulating in the scan. Realized/peak columns stay NULL so a
        // no-tick fire is distinguishable from a real outcome (no bogus 0).
        noTickIds.push(fire.id);
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

      // Flow-inversion: per-fire because it hits the rate-limited UW REST API
      // (NOT batchable). Failures are non-fatal — column stays NULL for this
      // fire and the rest of the enrichment still lands.
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

      updates.push({
        id: fire.id,
        trail30_10,
        hard30m,
        tier50,
        eod,
        flowInversion,
        peak,
        minToPeak,
      });
      enriched++;
    }

    // ── Batched write #1: enriched fires ─────────────────────────────────────
    // ONE UPDATE for all enriched fires via unnest of typed arrays. The inv
    // array preserves null elements (flow-inversion failures) — Postgres
    // unnest passes NULLs straight through, so realized_flow_inversion_pct
    // lands NULL for those fires exactly as the prior per-fire write did.
    if (updates.length > 0) {
      const uIds = updates.map((u) => u.id);
      const trail = updates.map((u) => u.trail30_10);
      const hard = updates.map((u) => u.hard30m);
      const tier = updates.map((u) => u.tier50);
      const eod = updates.map((u) => u.eod);
      const inv = updates.map((u) => u.flowInversion);
      const peak = updates.map((u) => u.peak);
      const mtp = updates.map((u) => u.minToPeak);
      await withDbRetry(
        () => db`
          UPDATE lottery_finder_fires AS f
          SET
            realized_trail30_10_pct = u.trail,
            realized_hard30m_pct = u.hard,
            realized_tier50_holdeod_pct = u.tier,
            realized_eod_pct = u.eod,
            realized_flow_inversion_pct = u.inv,
            peak_ceiling_pct = u.peak,
            minutes_to_peak = u.mtp,
            enriched_at = NOW()
          FROM unnest(
                 ${uIds}::int[],
                 ${trail}::float8[],
                 ${hard}::float8[],
                 ${tier}::float8[],
                 ${eod}::float8[],
                 ${inv}::float8[],
                 ${peak}::float8[],
                 ${mtp}::float8[]
               ) AS u(id, trail, hard, tier, eod, inv, peak, mtp)
          WHERE f.id = u.id
        `,
        2,
        30_000,
      );
    }

    // ── Batched write #2: no-tick terminal stamps ────────────────────────────
    // Stamp enriched_at on every no-tick fire in one UPDATE so they leave the
    // candidate set. Realized/peak columns stay NULL (a no-tick fire is NOT a
    // 0% outcome).
    if (noTickIds.length > 0) {
      await withDbRetry(
        () => db`
          UPDATE lottery_finder_fires
          SET enriched_at = NOW()
          WHERE id = ANY(${noTickIds}::int[])
        `,
        2,
        30_000,
      );
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
