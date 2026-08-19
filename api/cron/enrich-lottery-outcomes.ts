/**
 * GET /api/cron/enrich-lottery-outcomes
 *
 * Enriches lottery_finder_fires rows with realized exit policy outcomes
 * by reading the post-entry price stream from ws_option_trades. Runs
 * after market close (first tick 21:40 UTC / 5:40 PM EDT) so the full
 * day's trade data is available.
 *
 * For each unenriched fire (enriched_at IS NULL), queries ws_option_trades
 * for all prints on that option_chain after entry_time_ct, computes the
 * four exit policies plus peak metrics, and updates the fire record.
 *
 * Volume: 3.6k–5.3k fires/day since the uw-stream universe expansion. One
 * invocation loops over batches of ENRICH_BATCH_SIZE (oldest first) until
 * the candidate SELECT comes back short/empty or the ENRICH_WALL_BUDGET_MS
 * wall budget is exceeded; leftovers roll to the next 5-min run.
 *
 * Also computes realized_flow_inversion_pct using the per-minute UW REST
 * `/option-contract/{id}/intraday` tape (cached in option_intraday_nbbo)
 * combined with matched-side flow from net_flow_per_ticker_history. See
 * `api/_lib/flow-inversion.ts` for the algorithm and
 * `docs/superpowers/specs/lottery-flow-inversion-automation-2026-05-05.md`
 * for the broader Phase 2 design.
 *
 * Cadence: every 5 min from 21:40 to 23:55 UTC Mon-Fri, as TWO vercel.json
 * windows for this path (`40-59/5 21 * * 1-5`, then every 5 min over hours
 * 22-23 — a single crontab can't start at :40 in one hour and :00 in the
 * next). The first tick stays >= 21:40 UTC (the original close buffer, EST
 * and EDT). Capacity ≈ 28 runs × several hundred fires drains a day well
 * inside the 2-day ws_option_trades retention.
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

/**
 * Fires per candidate SELECT. Each fire with post-entry ticks makes one
 * UW /option-contract intraday call (throttled to the shared 115/min cap)
 * plus 2-4 Neon round-trips, so a batch is bounded to ~2-3 min worst case.
 * ORDER BY inserted_at ASC drains oldest first.
 */
const ENRICH_BATCH_SIZE = 300;

/**
 * Wall-clock budget for the batch loop, in ms. vercel.json gives this
 * function `maxDuration: 300` (300s); 240s leaves headroom for one
 * in-flight fire, the two flush UPDATEs and the retention prune. The
 * budget is checked between batches, between tick-read chunks and between
 * fires so an overrun is bounded by one unit of work, not one batch.
 * Leftovers roll to the next 5-min run.
 */
export const ENRICH_WALL_BUDGET_MS = 240_000;

/**
 * Fires per batched tick read. A busy session puts ~2,900 post-entry ticks
 * on an average fire, so 300 fires in ONE query was ~880k rows (~80 MB) in
 * a single Neon HTTP response — it blew the 30s per-attempt budget, burned
 * all withDbRetry attempts and 500ed the run. Chunking keeps every query
 * small while preserving TICK-LEVEL fidelity: the exit policies (trailing
 * stop, hard-stop-at-30m, tier hold) are path-dependent, so aggregating to
 * minute bars would silently change the realized outcomes that become
 * Takeit training labels.
 */
const TICK_READ_CHUNK = 30;

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

/** Per-batch tallies, summed across the loop for the run message. */
interface BatchOutcome {
  enriched: number;
  skipped: number;
  inversionFilled: number;
  /** True when the wall budget tripped inside this batch (partial flush). */
  budgetHit: boolean;
}

/**
 * One candidate SELECT: the oldest ENRICH_BATCH_SIZE unenriched fires.
 * Both the enriched UPDATE and the no-tick terminal stamp set enriched_at,
 * so each processed batch leaves the candidate set and the next SELECT
 * returns strictly newer rows — no keyset needed.
 */
async function readBatch(
  db: ReturnType<typeof getDb>,
): Promise<UnenrichedFire[]> {
  return (await withDbRetry(
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
      LIMIT ${ENRICH_BATCH_SIZE}
    `,
    2,
    10_000,
  )) as UnenrichedFire[];
}

/**
 * Enrich one batch: chunked tick read → per-fire exit policies + flow
 * inversion → two batched writes. `pastDeadline()` is polled between tick
 * chunks and between fires; when it trips, whatever has been staged so far
 * is flushed and every fire not yet processed is left UNSTAMPED
 * (enriched_at IS NULL) so the next run picks it up.
 */
async function enrichBatch(
  db: ReturnType<typeof getDb>,
  apiKey: string,
  fires: readonly UnenrichedFire[],
  flowCache: Map<string, FlowMinute[]>,
  pastDeadline: () => boolean,
): Promise<BatchOutcome> {
  let enriched = 0;
  let skipped = 0;
  let inversionFilled = 0;
  let budgetHit = false;

  // ── Batched read of the fires' post-entry ticks, in chunks ────────────────
  // unnest the fires into a virtual input table, then JOIN LATERAL the
  // per-chain tape window. JOIN (not LEFT) so no-tick fires simply don't
  // appear in the result — they're recovered below via the ids that never
  // land in the Map. ORDER BY u.fire_id, t.executed_at keeps each fire's
  // ticks chronological. Mirrors the evaluate-round-trip.ts LATERAL
  // pattern; heavy on ws_option_trades, so the longer 30s retry timeout.
  //
  // Only fires whose chunk was actually read are `covered`; if the budget
  // trips mid-read the remaining fires are NOT processed (and crucially NOT
  // stamped no-tick — their ticks were never looked at).
  const covered: UnenrichedFire[] = [];
  const tickRows: BatchedTickRow[] = [];
  for (let i = 0; i < fires.length; i += TICK_READ_CHUNK) {
    if (pastDeadline()) {
      budgetHit = true;
      break;
    }
    const slice = fires.slice(i, i + TICK_READ_CHUNK);
    const ids = slice.map((f) => f.id);
    const chains = slice.map((f) => f.optionChainId);
    const entries = slice.map((f) => f.entryTimeCt.toISOString());

    const chunkRows = (await withDbRetry(
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

    for (const row of chunkRows) tickRows.push(row);
    for (const f of slice) covered.push(f);
  }

  // Group ticks by fire id. Rows arrive ordered by (fire_id, executed_at),
  // so each fire's ticks stay chronological as they're pushed in order.
  //
  // Keys are Number()-normalized on BOTH sides. The Neon driver returns
  // lottery_finder_fires.id (bigint) as a STRING ("601"), while the batched
  // read's u.fire_id comes from `unnest(...::int[])` and arrives as a NUMBER
  // (601). A Map keyed by one and probed by the other misses every time —
  // `map.get("601")` does not find `601` — so every fire was recorded as
  // "no post-entry ticks" and terminally stamped, permanently voiding its
  // outcome labels (600 fires lost on 2026-08-17 before this was caught).
  // Do not drop these casts; the tests pin the mixed-type case.
  const ticksByFire = new Map<number, TradeTick[]>();
  for (const row of tickRows) {
    const key = Number(row.fireId);
    let arr = ticksByFire.get(key);
    if (arr === undefined) {
      arr = [];
      ticksByFire.set(key, arr);
    }
    arr.push({ executedAt: row.executedAt, price: row.price });
  }

  // Stage results in JS, then flush in two batched writes after the loop.
  const noTickIds: number[] = [];
  const updates: EnrichUpdate[] = [];

  for (const fire of covered) {
    // Budget check per fire: the UW intraday call below is the slow unit
    // of work. Fires after the cutoff stay unstamped for the next run.
    if (pastDeadline()) {
      budgetHit = true;
      break;
    }

    const ticks = ticksByFire.get(Number(fire.id)) ?? [];

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

  return { enriched, skipped, inversionFilled, budgetHit };
}

export default withCronInstrumentation(
  'enrich-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const db = getDb();
    const { apiKey } = ctx;

    const startMs = Date.now();
    const deadlineMs = startMs + ENRICH_WALL_BUDGET_MS;
    const pastDeadline = (): boolean => Date.now() > deadlineMs;

    let batches = 0;
    let enriched = 0;
    let skipped = 0;
    let inversionFilled = 0;
    let budgetHit = false;
    const flowCache = new Map<string, FlowMinute[]>();

    // Progress guard. Every processed fire is stamped (enriched or no-tick),
    // so a re-selected id means a stamp did not land; rather than spin on
    // the same rows until the budget, stop and let the next run retry.
    const seenIds = new Set<number>();

    // ── Loop-until-budget ────────────────────────────────────────────────────
    // Drain batches oldest-first until the SELECT comes back short (nothing
    // left behind it) or empty, or the wall budget trips. Each batch is
    // self-contained (own reads + own flush writes), so a budget stop between
    // batches loses nothing and a stop inside a batch flushes what it has.
    for (;;) {
      if (pastDeadline()) {
        budgetHit = true;
        break;
      }
      const rows = await readBatch(db);
      if (rows.length === 0) break;

      const fresh = rows.filter((f) => !seenIds.has(Number(f.id)));
      if (fresh.length === 0) {
        logger.warn(
          { batch: batches + 1, rows: rows.length },
          'enrich-lottery-outcomes: batch re-selected only already-processed fires — stopping to avoid a spin',
        );
        break;
      }
      for (const f of fresh) seenIds.add(Number(f.id));

      batches++;
      const out = await enrichBatch(db, apiKey, fresh, flowCache, pastDeadline);
      enriched += out.enriched;
      skipped += out.skipped;
      inversionFilled += out.inversionFilled;
      if (out.budgetHit) {
        budgetHit = true;
        break;
      }
      // A short batch means the candidate set is drained — no need to pay
      // for one more SELECT just to see it come back empty.
      if (rows.length < ENRICH_BATCH_SIZE) break;
    }

    // Best-effort retention prune, AFTER all enrichment work has landed so a
    // prune failure can never roll back or fail the primary job.
    await pruneKeptTickers();

    if (batches === 0 && !budgetHit) {
      return { status: 'success', message: 'No unenriched fires' };
    }

    const elapsedMs = Date.now() - startMs;
    const batchWord = batches === 1 ? 'batch' : 'batches';
    const budgetNote = budgetHit
      ? ` — wall budget ${ENRICH_WALL_BUDGET_MS}ms hit, leftovers roll to the next run`
      : '';
    return {
      status: 'success',
      message: `Enriched ${enriched} fires in ${batches} ${batchWord} (flow_inversion populated ${inversionFilled}), skipped ${skipped} (no post-entry ticks), ${elapsedMs}ms elapsed${budgetNote}`,
      metadata: { batches, enriched, skipped, inversionFilled, budgetHit },
    };
  },
  // Runs post-close (first tick 21:40 UTC = 17:40 EDT / 16:40 EST), well
  // past the market-hours gate's 16:05 ET close-buffer. Without disabling
  // the gate, cronGuard would skip every scheduled run with 'Outside time
  // window' (manual Python runs of scripts/enrich_lottery_outcomes.py had
  // been masking this in prod — verified by 21:49-22:11 UTC enrichment
  // timestamps on multiple weekdays). UW is still required for
  // flow-inversion.
  { marketHours: false },
);
