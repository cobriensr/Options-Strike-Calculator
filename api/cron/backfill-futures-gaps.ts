/**
 * GET /api/cron/backfill-futures-gaps
 *
 * Daily gap repair for `futures_bars`. Live bars come from the uw-stream
 * `futures_trades` handler (`uw-stream/src/handlers/futures_trades.py`);
 * this cron finds holes it left over the three prior UTC days — deploys,
 * lease handoffs, websocket drops — and refills them from Unusual Whales
 * REST 1-minute candles.
 *
 *   1. Gap detection (Postgres only): any CME Globex-open minute with no
 *      bar — a deploy or lease handoff typically drops 1–2. Halts and
 *      weekends don't count. A genuinely untraded minute also reads as a
 *      gap (ZN/RTY go quiet for up to ~4 minutes overnight), which only
 *      costs the UW calls: UW has no candle for it, so nothing is
 *      inserted. A run with no gaps makes no UW calls.
 *   2. Front month: `GET /futures/contracts?days=5` (volume ranked over
 *      the 5 sessions the candles span), the six roots filtered by EXACT
 *      `product` (`q=ES` would also match MES/EST) with spreads excluded,
 *      top 2 by volume (`api/_lib/futures-contracts.ts`).
 *   3. `GET /futures/{contract}/candles?interval=1m&range=5d` per
 *      candidate, then the uw-stream rule replayed per minute
 *      (`replayFrontMonth`, shared with the order-flow repair): the
 *      contract with the larger cumulative UTC-day volume is the front
 *      month, ties to the larger symbol, and a minute where the leader
 *      has no candle stays empty (never back-filled from another month,
 *      which trades at a carry basis). This keeps repaired minutes on
 *      the same contract the live handler would have written, including
 *      through a roll — for an uninterrupted live handler. Its tally is
 *      in-memory, so a mid-day uw-stream restart restarts it from zero;
 *      on a roll day the two can then pick different months for a minute.
 *   4. Batched `INSERT … SELECT FROM unnest(…) ON CONFLICT (symbol, ts)
 *      DO NOTHING` for the leader's bars inside each gap. DO NOTHING
 *      never overwrites a bar the live handler wrote.
 *   5. Order-flow pass (spec Phase 6), after the OHLC pass so the bars it
 *      just inserted are included: bars in the same window and Globex-open
 *      minutes whose `buy_volume` is NULL (unknown), in runs of
 *      consecutive bars, oldest run first (ties ES, NQ, … per spec D7).
 *      Each run is split by the replay's leader per minute (the same
 *      candles, loaded once per root for both passes) into pieces of at
 *      most an hour, oldest first, and each piece pages that contract's
 *      REST prints (`api/_lib/futures-flow-repair.ts`). A minute is
 *      written only when its REST volume is within 2% of the bar's, by one
 *      batched `UPDATE … WHERE buy_volume IS NULL`, so websocket flow is
 *      never overwritten. At most FLOW_PAGE_BUDGET pages per run; the rest
 *      stays NULL and is found again next run, unless it is on the
 *      window's oldest day, which ages out (flow_minutes_aged_out, run
 *      'partial'). Anything deferred or unrepairable raises one Sentry
 *      warning. Counts go to Axiom `meta`: flow_minutes_repaired,
 *      flow_minutes_skipped_tolerance, flow_ranges_unrepairable (UW's
 *      history ended inside the run), flow_ranges_deferred and
 *      flow_minutes_aged_out.
 *
 * Candle `start` is the bar's minute (UTC), which is exactly the
 * handler's `ts` (executed_at floored to the minute); `symbol` is the
 * root ('ES'), not the contract.
 *
 * Failures surface: a UW error, an empty or malformed payload, or a DB
 * reject fails that symbol in that pass (Sentry exception, tagged
 * `pass: flow` for the order-flow pass); the run reports 'partial' /
 * 'error' via deriveCronStatus over every symbol either pass worked on,
 * and 'error' turns the Sentry cron monitor red. The Databento version
 * swallowed non-OK responses and reported success.
 *
 * Depth: UW caps 1m candles at 5,000 rows and keeps the NEWEST (probed
 * 2026-09-30: `range=1w` → first 09-24 15:16Z, last = the in-progress
 * minute), ≈3.5 trading days. That still reaches the window start of a
 * 06:00 UTC run on every weekday; a capped payload that doesn't reach
 * the oldest gap fails the symbol rather than reporting a clean run. The
 * in-progress minute is never written: the window ends at 00:00 UTC.
 *
 * Schedule: 0 6 * * 1-6 (06:00 UTC, after the previous UTC day closes).
 *
 * Environment: CRON_SECRET, UW_API_KEY
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';
import {
  FUTURES_ROOTS,
  fetchFuturesContracts,
  frontMonthCandidates,
  replayFrontMonth,
  type FuturesRoot,
} from '../_lib/futures-contracts.js';
import {
  fetchContractFlow,
  fetchNullFlowBars,
  groupFlowRanges,
  matchFlowToBars,
  writeFlowMinutes,
  type FlowBar,
  type FlowRange,
  type PageBudget,
} from '../_lib/futures-flow-repair.js';

// OHLC worst case is ~13 UW calls (1 contracts + 2 candles × 6 roots),
// each up to 3 attempts × 15s timeout plus backoff under withRetry ≈ 48s
// → ~10 min if UW hangs on every call. The order-flow pass starts no new
// range or page after FLOW_DEADLINE_MS, but one started just before it can
// still load a root's candles (2 calls, ~96 s) and fetch a page (~48 s)
// and write: ~600 + 150 s worst case. The Sentry monitor's 14 min max
// runtime (cron-schedules.ts) covers the full 800 s. Typical runs finish
// in a minute or two.
export const config = {
  maxDuration: 800,
};

// ── Constants ───────────────────────────────────────────────

const JOB = 'backfill-futures-gaps';

const LOOKBACK_DAYS = 3;
const INSERT_CHUNK = 500;
// UW's documented-by-probe ceiling on one 1m candle response.
const UW_CANDLE_ROW_CAP = 5000;
// NUMERIC(12,4) ceiling — a larger value would reject the whole chunk.
const MAX_PRICE = 99_999_999;

// UW /trades pages per run for the order-flow pass, oldest range first
// (spec Phase 6). About 84 ms a page, so roughly a minute of paging.
const FLOW_PAGE_BUDGET = 600;
// No order-flow range or page starts this long after the run began, so a
// slow UW can't carry the run past maxDuration (800 s). Work started just
// before it can add one root's candle load (~96 s worst case under
// withRetry, if the OHLC pass didn't load them) and one page (~48 s).
// What's left resumes on the next run.
const FLOW_DEADLINE_MS = 600_000;
// Longest span one order-flow fetch covers, so a long range is repaired
// oldest first (UW pages newest-first within a fetch).
const FLOW_PIECE_MS = 60 * 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ── Types ───────────────────────────────────────────────────

interface Bar {
  ts: string; // ISO minute, UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Bars are missing strictly between `prevMs` and `nextMs`. */
interface Gap {
  prevMs: number;
  nextMs: number;
  /** Globex-open minutes strictly inside the gap. */
  openMinutes: number;
}

interface GapRow {
  symbol: string;
  prev_bar: Date | string;
  next_bar: Date | string;
}

interface SymbolResult {
  contracts: string[];
  /** Total Globex-open minutes missing across the symbol's gaps. */
  gapMinutes: number;
  inserted: number;
  malformed: number;
}

interface FlowSymbolResult {
  /** Runs of consecutive NULL-flow bars, and the bars in them. */
  ranges: number;
  minutes: number;
  repaired: number;
  /** REST volume missed the bar's by more than 2%: left NULL. */
  skippedTolerance: number;
  /** In a minute where the replay's leader has no candle: left NULL. */
  unattributed: number;
  pages: number;
  /** Malformed REST prints skipped (each withholds its minute). */
  malformed: number;
}

interface FlowPassResult {
  symbols: Partial<Record<FuturesRoot, FlowSymbolResult>>;
  /** Left out: their candles failed, and were reported, in the OHLC pass. */
  skippedSymbols: FuturesRoot[];
  failures: string[];
  repaired: number;
  skippedTolerance: number;
  /** Ranges where UW's history ended (an empty page) before the range did. */
  unrepairable: number;
  /** Ranges the page or time budget left for the next run. */
  deferred: number;
  /** Deferred bars on the window's oldest day: no later run will see them. */
  agedOut: number;
  pages: number;
}

// ── Gap detection ───────────────────────────────────────────

/** Globex-open minutes strictly between two bars. */
function countOpenMinutes(prevMs: number, nextMs: number): number {
  let open = 0;
  for (let t = prevMs + MINUTE_MS; t < nextMs; t += MINUTE_MS) {
    if (isFuturesMarketOpen(new Date(t))) open += 1;
  }
  return open;
}

/**
 * Per root, the missing intervals that contain at least one Globex-open
 * minute. Sentinel rows at both window edges make a hole touching either
 * edge — or a root with no bars at all — pair up like any other.
 */
async function detectGaps(
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<FuturesRoot, Gap[]>> {
  const sql = getDb();
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();
  const symbols = [...FUTURES_ROOTS];

  const rows = (await withDbRetry(
    () => sql`
      WITH bars AS (
        SELECT symbol, ts
        FROM futures_bars
        WHERE symbol = ANY(${symbols}::text[])
          AND ts >= ${startIso}::timestamptz
          AND ts < ${endIso}::timestamptz
        UNION ALL
        SELECT s, ${startIso}::timestamptz - interval '1 minute'
        FROM unnest(${symbols}::text[]) AS s
        UNION ALL
        SELECT s, ${endIso}::timestamptz
        FROM unnest(${symbols}::text[]) AS s
      ),
      paired AS (
        SELECT symbol, ts,
               LEAD(ts) OVER (PARTITION BY symbol ORDER BY ts) AS next_ts
        FROM bars
      )
      SELECT symbol, ts AS prev_bar, next_ts AS next_bar
      FROM paired
      WHERE next_ts - ts > interval '1 minute'
      ORDER BY symbol, ts
    `,
    2,
    10_000,
  )) as GapRow[];

  const gaps = new Map<FuturesRoot, Gap[]>();
  for (const row of rows) {
    const symbol = FUTURES_ROOTS.find((s) => s === row.symbol);
    if (!symbol) continue;
    const prevMs = new Date(row.prev_bar).getTime();
    const nextMs = new Date(row.next_bar).getTime();
    const openMinutes = countOpenMinutes(prevMs, nextMs);
    if (openMinutes === 0) continue;
    const list = gaps.get(symbol) ?? [];
    list.push({ prevMs, nextMs, openMinutes });
    gaps.set(symbol, list);
  }
  return gaps;
}

// ── UW payload parsing ──────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parsePrice(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_PRICE ? n : null;
}

function parseCandle(raw: unknown): Bar | null {
  if (!isRecord(raw) || typeof raw.start !== 'string') return null;
  const startMs = Date.parse(raw.start);
  if (!Number.isFinite(startMs) || startMs % MINUTE_MS !== 0) return null;
  const open = parsePrice(raw.o);
  const high = parsePrice(raw.h);
  const low = parsePrice(raw.l);
  const close = parsePrice(raw.c);
  if (open === null || high === null || low === null || close === null) {
    return null;
  }
  if (low > Math.min(open, close) || high < Math.max(open, close)) return null;
  const volume = raw.v;
  if (typeof volume !== 'number' || !Number.isSafeInteger(volume)) return null;
  if (volume < 0) return null;
  return {
    ts: new Date(startMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

// ── DB write ────────────────────────────────────────────────

async function insertBars(symbol: FuturesRoot, bars: Bar[]): Promise<number> {
  const sql = getDb();
  let inserted = 0;
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
        SELECT ${symbol}, t.ts, t.open, t.high, t.low, t.close, t.volume
        FROM unnest(
          ${chunk.map((b) => b.ts)}::timestamptz[],
          ${chunk.map((b) => b.open)}::numeric[],
          ${chunk.map((b) => b.high)}::numeric[],
          ${chunk.map((b) => b.low)}::numeric[],
          ${chunk.map((b) => b.close)}::numeric[],
          ${chunk.map((b) => b.volume)}::bigint[]
        ) AS t(ts, open, high, low, close, volume)
        ON CONFLICT (symbol, ts) DO NOTHING
        RETURNING ts
      `,
      2,
      10_000,
    )) as unknown[];
    inserted += rows.length;
  }
  return inserted;
}

// ── Candles ─────────────────────────────────────────────────

/** One root's 1m candles for its front-month candidates. */
interface RootCandles {
  candidates: string[];
  byContract: Map<string, Bar[]>;
  /** Raw row count of each payload that hit UW's row cap. */
  capped: Map<string, number>;
  malformed: number;
}

/**
 * 1m candles for a root's top-2 contracts. Throws when UW lists no
 * contract for the root, on a UW error, a non-array payload, an empty
 * payload for the most-active contract, or a payload of only malformed
 * candles. Other malformed candles are skipped and surfaced as a Sentry
 * warning.
 */
async function loadCandles(
  ctx: CronContext,
  symbol: FuturesRoot,
  contracts: unknown[],
): Promise<RootCandles> {
  const candidates = frontMonthCandidates(contracts, symbol);
  if (candidates.length === 0) {
    throw new Error(`UW /futures/contracts lists no ${symbol} contract`);
  }

  const byContract = new Map<string, Bar[]>();
  const capped = new Map<string, number>();
  let malformed = 0;
  for (const [idx, contract] of candidates.entries()) {
    const raw: unknown = await withRetry(() =>
      uwFetch<unknown>(
        ctx.apiKey,
        `/futures/${encodeURIComponent(contract)}/candles?interval=1m&range=5d`,
      ),
    );
    if (!Array.isArray(raw)) {
      throw new Error(`UW candles for ${contract}: non-array payload`);
    }
    // The most-active contract always has candles over 5 days; an empty
    // payload (also what UW returns for an unknown contract) is a fault.
    if (idx === 0 && raw.length === 0) {
      throw new Error(`UW returned no candles for ${contract}`);
    }
    const bars = raw.map(parseCandle).filter((b): b is Bar => b !== null);
    if (raw.length > 0 && bars.length === 0) {
      throw new Error(
        `UW candles for ${contract}: all ${raw.length} malformed`,
      );
    }
    if (raw.length >= UW_CANDLE_ROW_CAP) capped.set(contract, raw.length);
    malformed += raw.length - bars.length;
    byContract.set(contract, bars);
  }

  if (malformed > 0) {
    ctx.logger.warn(
      { symbol, contracts: candidates, malformed },
      `${JOB}: skipped malformed UW candles`,
    );
    metrics.increment('backfill_futures_gaps.malformed_candle');
    Sentry.captureMessage(`${JOB}: malformed UW candles skipped`, {
      level: 'warning',
      extra: { symbol, contracts: candidates, malformed },
    });
  }

  return { candidates, byContract, capped, malformed };
}

/**
 * A capped payload (UW keeps the NEWEST rows) must reach 00:00 UTC of the
 * day holding `firstMinuteMs`: the front-month replay needs that whole
 * day's volume tally, not just the minutes being repaired. Throws, so a
 * truncated payload fails the symbol rather than reporting a clean run.
 */
function assertCandleDepth(candles: RootCandles, firstMinuteMs: number): void {
  const oldestNeededMs = firstMinuteMs - (firstMinuteMs % DAY_MS);
  for (const [contract, rows] of candles.capped) {
    const bars = candles.byContract.get(contract) ?? [];
    const earliestMs = Math.min(...bars.map((b) => Date.parse(b.ts)));
    if (earliestMs > oldestNeededMs) {
      const earliest = new Date(earliestMs).toISOString();
      const needed = new Date(oldestNeededMs).toISOString();
      throw new Error(
        `UW candles for ${contract}: depth truncated at ${rows} rows (earliest ${earliest}, gap needs ${needed})`,
      );
    }
  }
}

// ── OHLC pass ───────────────────────────────────────────────

async function repairSymbol(
  symbol: FuturesRoot,
  gaps: Gap[],
  candles: RootCandles,
): Promise<SymbolResult> {
  assertCandleDepth(
    candles,
    Math.min(...gaps.map((g) => g.prevMs)) + MINUTE_MS,
  );

  const inGap = (bar: Bar) => {
    const t = Date.parse(bar.ts);
    return gaps.some((g) => t > g.prevMs && t < g.nextMs);
  };
  const bars = replayFrontMonth(candles.byContract)
    .map((e) => e.row)
    .filter(inGap);
  const inserted = await insertBars(symbol, bars);

  return {
    contracts: candles.candidates,
    gapMinutes: gaps.reduce((sum, g) => sum + g.openMinutes, 0),
    inserted,
    malformed: candles.malformed,
  };
}

// ── Order-flow pass (Phase 6) ───────────────────────────────

function emptyFlowStats(): FlowSymbolResult {
  return {
    ranges: 0,
    minutes: 0,
    repaired: 0,
    skippedTolerance: 0,
    unattributed: 0,
    pages: 0,
    malformed: 0,
  };
}

function budgetSpent(budget: PageBudget): boolean {
  return budget.pagesLeft <= 0 || Date.now() >= budget.deadlineMs;
}

/**
 * Splits a range into pieces led by one contract and spanning at most
 * FLOW_PIECE_MS, oldest first. UW pages newest-first, so one long fetch
 * stopped by the budget would fill its newest minutes and leave its oldest,
 * the ones closest to aging out of the window.
 */
function flowPieces(
  range: FlowRange,
  leaders: ReadonlyMap<string, string>,
  stats: FlowSymbolResult,
): Array<{ contract: string; bars: FlowBar[] }> {
  const pieces: Array<{ contract: string; bars: FlowBar[] }> = [];
  for (const bar of range.bars) {
    const contract = leaders.get(bar.ts);
    if (contract === undefined) {
      stats.unattributed += 1;
      continue;
    }
    const last = pieces.at(-1);
    if (
      last?.contract === contract &&
      Date.parse(bar.ts) - Date.parse(last.bars[0]!.ts) < FLOW_PIECE_MS
    ) {
      last.bars.push(bar);
    } else {
      pieces.push({ contract, bars: [bar] });
    }
  }
  return pieces;
}

/**
 * Repairs one run of NULL-flow bars, piece by piece (`flowPieces`):
 * pages each piece's prints and writes the minutes that match. Adds to
 * `stats` as it goes, so work done before a throw still counts. Returns
 * the bars the budget left undecided, and whether UW's history ended
 * inside the range.
 */
async function repairFlowRange(
  ctx: CronContext,
  symbol: FuturesRoot,
  range: FlowRange,
  leaders: ReadonlyMap<string, string>,
  budget: PageBudget,
  stats: FlowSymbolResult,
): Promise<{ deferred: FlowBar[]; unrepairable: boolean }> {
  const deferred: FlowBar[] = [];
  let unrepairable = false;
  for (const piece of flowPieces(range, leaders, stats)) {
    if (budgetSpent(budget)) {
      deferred.push(...piece.bars);
      continue;
    }
    const flow = await fetchContractFlow(
      ctx.apiKey,
      piece.contract,
      Date.parse(piece.bars[0]!.ts),
      Date.parse(piece.bars.at(-1)!.ts) + MINUTE_MS,
      budget,
    );
    stats.pages += flow.pages;
    stats.malformed += flow.malformed;
    const covered: FlowBar[] = [];
    for (const bar of piece.bars) {
      if (Date.parse(bar.ts) >= flow.coveredFromMs) covered.push(bar);
      else if (flow.stop === 'exhausted') unrepairable = true;
      else deferred.push(bar);
    }
    const { updates, skippedTolerance } = matchFlowToBars(
      covered,
      flow.minutes,
    );
    stats.skippedTolerance += skippedTolerance;
    stats.repaired += await writeFlowMinutes(symbol, updates);
  }
  return { deferred, unrepairable };
}

/**
 * Fills NULL order flow on the window's Globex-open bars, oldest run
 * first (ties in FUTURES_ROOTS order: ES and NQ first, spec D7), within
 * FLOW_PAGE_BUDGET pages. A symbol whose candles, prints or write fail is
 * a failure (Sentry exception); its remaining runs are skipped. A symbol
 * in `skip` (its candles already failed, and were reported, in the OHLC
 * pass) is left out. Throws only when the NULL-flow scan itself fails.
 */
async function repairFlow(
  ctx: CronContext,
  windowStart: Date,
  windowEnd: Date,
  candlesFor: (symbol: FuturesRoot) => Promise<RootCandles>,
  skip: ReadonlySet<FuturesRoot>,
): Promise<FlowPassResult> {
  const result: FlowPassResult = {
    symbols: {},
    skippedSymbols: [],
    failures: [],
    repaired: 0,
    skippedTolerance: 0,
    unrepairable: 0,
    deferred: 0,
    agedOut: 0,
    pages: 0,
  };
  // The next run's window starts a day later: a bar before this is not
  // seen again, so leaving it NULL leaves it NULL for good.
  const agesOutBeforeMs = windowStart.getTime() + DAY_MS;
  const defer = (bars: readonly FlowBar[]) => {
    result.deferred += 1;
    result.agedOut += bars.filter(
      (b) => Date.parse(b.ts) < agesOutBeforeMs,
    ).length;
  };
  const nullBars = await fetchNullFlowBars(
    FUTURES_ROOTS,
    windowStart.toISOString(),
    windowEnd.toISOString(),
  );
  if (nullBars.length === 0) return result;

  // Ordered by symbol, then time: the first row per symbol is its oldest.
  const oldestMs = new Map<string, number>();
  for (const bar of nullBars) {
    if (!oldestMs.has(bar.symbol)) {
      oldestMs.set(bar.symbol, Date.parse(bar.ts));
    }
  }
  const leaderMaps = new Map<FuturesRoot, Map<string, string>>();
  const leadersFor = async (symbol: FuturesRoot) => {
    const cached = leaderMaps.get(symbol);
    if (cached) return cached;
    const candles = await candlesFor(symbol);
    assertCandleDepth(candles, oldestMs.get(symbol)!);
    const leaders = new Map(
      replayFrontMonth(candles.byContract).map((e) => [e.row.ts, e.contract]),
    );
    leaderMaps.set(symbol, leaders);
    return leaders;
  };

  const rootOrder = (symbol: string) =>
    FUTURES_ROOTS.findIndex((r) => r === symbol);
  const ranges = groupFlowRanges(nullBars).sort(
    (a, b) =>
      a.bars[0]!.ts.localeCompare(b.bars[0]!.ts) ||
      rootOrder(a.symbol) - rootOrder(b.symbol),
  );
  const budget: PageBudget = {
    pagesLeft: FLOW_PAGE_BUDGET,
    deadlineMs: ctx.startTimeMs + FLOW_DEADLINE_MS,
  };
  const failed = new Set<FuturesRoot>();

  for (const range of ranges) {
    const symbol = FUTURES_ROOTS.find((s) => s === range.symbol);
    if (!symbol) continue;
    if (skip.has(symbol)) {
      if (!result.skippedSymbols.includes(symbol)) {
        result.skippedSymbols.push(symbol);
      }
      continue;
    }
    const stats = (result.symbols[symbol] ??= emptyFlowStats());
    stats.ranges += 1;
    stats.minutes += range.bars.length;
    if (failed.has(symbol)) continue;
    if (budgetSpent(budget)) {
      defer(range.bars);
      continue;
    }
    try {
      const leaders = await leadersFor(symbol);
      const outcome = await repairFlowRange(
        ctx,
        symbol,
        range,
        leaders,
        budget,
        stats,
      );
      if (outcome.unrepairable) result.unrepairable += 1;
      if (outcome.deferred.length > 0) defer(outcome.deferred);
    } catch (err) {
      failed.add(symbol);
      const message = err instanceof Error ? err.message : String(err);
      result.failures.push(`${symbol} flow: ${message}`);
      ctx.logger.error({ err, symbol }, `${JOB}: order-flow repair failed`);
      metrics.increment('backfill_futures_gaps.flow_symbol_error');
      Sentry.captureException(err, {
        tags: { cron: JOB, symbol, pass: 'flow' },
      });
    }
  }

  for (const [symbol, stats] of Object.entries(result.symbols)) {
    result.repaired += stats.repaired;
    result.skippedTolerance += stats.skippedTolerance;
    result.pages += stats.pages;
    if (stats.malformed > 0) {
      ctx.logger.warn(
        { symbol, malformed: stats.malformed },
        `${JOB}: skipped malformed UW prints`,
      );
      metrics.increment('backfill_futures_gaps.malformed_print');
      Sentry.captureMessage(`${JOB}: malformed UW prints skipped`, {
        level: 'warning',
        extra: { symbol, malformed: stats.malformed },
      });
    }
  }
  // Minutes left NULL are visible, not silent: a deferred backlog the
  // budget can't clear (e.g. bars written before the order-flow columns
  // existed, which scripts/backfill-futures-flow.ts is for) or a gap in
  // UW's history.
  if (result.deferred > 0 || result.unrepairable > 0) {
    if (result.deferred > 0) {
      metrics.increment('backfill_futures_gaps.flow_deferred');
    }
    if (result.unrepairable > 0) {
      metrics.increment('backfill_futures_gaps.flow_unrepairable');
    }
    const extra = {
      deferred: result.deferred,
      agedOut: result.agedOut,
      unrepairable: result.unrepairable,
      pages: result.pages,
    };
    ctx.logger.warn(extra, `${JOB}: order-flow minutes left NULL`);
    Sentry.captureMessage(
      `${JOB}: order-flow minutes left NULL (deferred or unrepairable)`,
      { level: 'warning', extra },
    );
  }
  return result;
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  JOB,
  async (ctx): Promise<CronResult> => {
    const now = Date.now();
    const windowEnd = new Date(now - (now % DAY_MS)); // today 00:00 UTC
    const windowStart = new Date(windowEnd.getTime() - LOOKBACK_DAYS * DAY_MS);
    const range = `${windowStart.toISOString()} to ${windowEnd.toISOString()}`;

    const gaps = await detectGaps(windowStart, windowEnd);

    // One unfiltered contract list covers every root (~365 rows), and each
    // root's candles feed both passes, so both are loaded at most once.
    let contractsLoad: Promise<unknown[]> | null = null;
    const contracts = () =>
      (contractsLoad ??= fetchFuturesContracts(ctx.apiKey));
    const candleLoads = new Map<FuturesRoot, Promise<RootCandles>>();
    const candlesFor = (symbol: FuturesRoot): Promise<RootCandles> => {
      let load = candleLoads.get(symbol);
      if (!load) {
        load = contracts().then((c) => loadCandles(ctx, symbol, c));
        candleLoads.set(symbol, load);
      }
      return load;
    };

    const symbols: Partial<Record<FuturesRoot, SymbolResult>> = {};
    const failures: string[] = [];
    // Roots whose candles failed (and were reported) here: the flow pass
    // would only get the same cached rejection.
    const candlesFailed = new Set<FuturesRoot>();
    if (gaps.size > 0) {
      // A failed contract list here fails the whole run: the wrapper
      // captures it and reports 'error'.
      await contracts();
      for (const [symbol, symbolGaps] of gaps) {
        try {
          const candles = await candlesFor(symbol).catch((err: unknown) => {
            candlesFailed.add(symbol);
            throw err;
          });
          symbols[symbol] = await repairSymbol(symbol, symbolGaps, candles);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${symbol}: ${message}`);
          ctx.logger.error({ err, symbol }, `${JOB}: symbol repair failed`);
          metrics.increment('backfill_futures_gaps.symbol_error');
          Sentry.captureException(err, { tags: { cron: JOB, symbol } });
        }
      }
    }
    const rows = Object.values(symbols).reduce((n, r) => n + r.inserted, 0);

    // After the OHLC pass, so the bars it just inserted get flow too.
    const flow = await repairFlow(
      ctx,
      windowStart,
      windowEnd,
      candlesFor,
      candlesFailed,
    );
    failures.push(...flow.failures);
    const flowSymbols = Object.keys(flow.symbols).length;

    // Legs: each symbol with gaps, plus each symbol the flow pass worked
    // on. Minutes that age out of the window still NULL are a shortfall
    // too: no later run will repair them.
    let status = deriveCronStatus(failures.length, gaps.size + flowSymbols);
    if (status === 'success' && flow.agedOut > 0) status = 'partial';
    ctx.logger.info(
      { range, status, rows, symbols, flow, failures },
      `${JOB} completed`,
    );

    return {
      status,
      rows,
      ...(gaps.size === 0 && flowSymbols === 0 ? { message: 'no gaps' } : {}),
      metadata: {
        range,
        gapSymbols: [...gaps.keys()],
        symbols,
        // Not Axiom columns, so reportCronRun routes them into `meta`.
        flow_minutes_repaired: flow.repaired,
        flow_minutes_skipped_tolerance: flow.skippedTolerance,
        flow_ranges_unrepairable: flow.unrepairable,
        flow_ranges_deferred: flow.deferred,
        flow_minutes_aged_out: flow.agedOut,
        flow_pages: flow.pages,
        flowSymbols: flow.symbols,
        ...(flow.skippedSymbols.length > 0
          ? { flowSkippedSymbols: flow.skippedSymbols }
          : {}),
        ...(failures.length > 0 ? { failures } : {}),
      },
    };
  },
  { marketHours: false },
);
