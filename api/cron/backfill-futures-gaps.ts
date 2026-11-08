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
 *   2. Volume refresh, once per root and before that root's schedule is
 *      read. The front month is one contract per root per CME trade date,
 *      decided once from the previous session's volume and kept in
 *      `futures_front_month` (`api/_lib/futures-front-month.ts`); a
 *      decision made from old volume is permanent. So the root's volumes
 *      are brought up to date first: daily candles
 *      (`GET /futures/{contract}/candles?interval=1d&range=1m`) for the
 *      incumbent (the latest stored decision of the last 30 days, else the
 *      listing-cycle seed) and the next two contracts of its cycle, written
 *      by `insertContractVolumes` for trade dates before the current one
 *      only. Those rows are DO NOTHING, so a session uw-stream tallied keeps
 *      its tally. A UW error, a malformed candle, no candle at all for the
 *      incumbent or a DB reject fails that root by name (Sentry exception
 *      tagged with the root and the range), before any decision row is
 *      written for it. A root with no gaps and no NULL-flow bars reads no
 *      schedule and is not refreshed.
 *   3. Schedule and candles: the CME trade dates of the root's gap minutes
 *      go to `fetchFrontMonthSchedule(root, dates, 'cron')`, which returns
 *      each date's stored contract or decides it now. Then
 *      `GET /futures/{contract}/candles?interval=1m&range=5d` for each
 *      contract in that schedule and no other, and `pickScheduledFront`
 *      builds each minute's bar from the contract its trade date was
 *      decided on. A minute where that contract has no candle stays empty
 *      (never back-filled from another month, which trades at a carry
 *      basis). The live handler follows the same schedule, so a repaired
 *      minute is on the contract the live bar would have been.
 *   4. Batched `INSERT … SELECT FROM unnest(…) ON CONFLICT (symbol, ts)
 *      DO NOTHING` (`insertFuturesBars`, `api/_lib/futures-bars.ts`) for
 *      the scheduled contract's bars inside each gap, each carrying its
 *      `contract`, flow left NULL. DO NOTHING never overwrites a bar the
 *      live handler wrote. A scheduled name that is no outright of the root
 *      is stored as NULL with a warning, because the column's CHECK would
 *      fail the whole chunk.
 *   5. Order-flow pass (spec Phase 6), after the OHLC pass so the bars it
 *      just inserted are included: bars in the same window and Globex-open
 *      minutes whose `buy_volume` is NULL (unknown), in runs of
 *      consecutive bars, oldest run first (ties ES, NQ, … per spec D7).
 *      The root's schedule is read again, from the dates of these bars
 *      (a root refreshed in the OHLC pass is not refreshed again), and
 *      each run is split by each minute's scheduled contract (candles are
 *      loaded once per contract for both passes) into pieces of at most an
 *      hour, oldest first. Each piece pages that contract's REST prints
 *      (`api/_lib/futures-flow-repair.ts`). A minute is
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
 * reject (the schedule read included) fails that symbol in that pass
 * (Sentry exception, tagged `pass: flow` for the order-flow pass, and
 * `pass: volume` for the volume refresh, which is reported once for the
 * run); the run reports 'partial' / 'error' via deriveCronStatus over
 * every symbol either pass worked on, and 'error' turns the Sentry cron
 * monitor red. The Databento version swallowed non-OK responses and
 * reported success.
 *
 * Depth: UW caps 1m candles at 5,000 rows and keeps the NEWEST (probed
 * 2026-09-30: `range=1w` → first 09-24 15:16Z, last = the in-progress
 * minute), ≈3.5 trading days. That still reaches the window start of a
 * 06:00 UTC run on every weekday; a capped payload that doesn't reach
 * the oldest minute to repair fails the symbol rather than reporting a
 * clean run. The in-progress minute is never written: the window ends at
 * 00:00 UTC.
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
import { insertFuturesBars, type FuturesBarRow } from '../_lib/futures-bars.js';
import {
  FUTURES_ROOTS,
  cmeTradeDate,
  nullSeedContract,
  parseContract,
  pickScheduledFront,
  type FuturesRoot,
} from '../_lib/futures-contracts.js';
import {
  cycleContracts,
  fetchDailyContractVolumes,
} from '../_lib/futures-daily-candles.js';
import {
  fetchFrontMonthSchedule,
  fetchStoredFrontMonths,
  insertContractVolumes,
  type FrontMonthSchedule,
} from '../_lib/futures-front-month.js';
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

// OHLC worst case per root is one volume-refresh wave (3 daily-candle calls
// at once) plus one 1m candle call per scheduled contract (two at a roll),
// each up to 3 attempts × 15s timeout plus backoff under withRetry ≈ 48s.
// A root whose refresh fails makes no more calls, so a UW that hangs on
// every call costs ~5 min (6 × 48s). The order-flow pass starts no new
// range or page after FLOW_DEADLINE_MS, but one started just before it can
// still refresh a root and load its candles (~3 calls, ~144 s) and fetch a
// page (~48 s) and write: ~600 + 200 s worst case. The Sentry monitor's
// 14 min max runtime (cron-schedules.ts) covers the full 800 s. Typical
// runs finish in a minute or two.
export const config = {
  maxDuration: 800,
};

// ── Constants ───────────────────────────────────────────────

const JOB = 'backfill-futures-gaps';

const LOOKBACK_DAYS = 3;
// UW's documented-by-probe ceiling on one 1m candle response.
const UW_CANDLE_ROW_CAP = 5000;
// NUMERIC(12,4) ceiling — a larger value would reject the whole chunk.
const MAX_PRICE = 99_999_999;

// The volume refresh reads daily candles over this UW `range` (calendar
// days back from now). `1m`, not `1w`: if the cron is down for more than a
// week, `1w` would leave the older missed sessions with no volume rows, and
// the rows are DO NOTHING, so the longer range costs nothing but rows.
const VOLUME_RANGE = '1m';
// How far back from the current trade date the incumbent is looked for.
const INCUMBENT_LOOKBACK_DAYS = 30;
// The contracts refreshed per root: the incumbent and the next two in its
// cycle, searched within this many months after the incumbent's month.
const REFRESH_CONTRACTS = 3;
const REFRESH_SPAN_MONTHS = 12;

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
  /** The CME trade dates of those minutes, ascending. */
  tradeDates: string[];
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
  /** In a minute where the scheduled contract has no candle: left NULL. */
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

/**
 * The Globex-open minutes strictly between two bars, and the CME trade dates
 * they fall on. A halt or weekend minute is no session's, so it adds no date.
 */
function scanOpenMinutes(
  prevMs: number,
  nextMs: number,
): { openMinutes: number; tradeDates: string[] } {
  let openMinutes = 0;
  const tradeDates = new Set<string>();
  for (let t = prevMs + MINUTE_MS; t < nextMs; t += MINUTE_MS) {
    const minute = new Date(t);
    if (isFuturesMarketOpen(minute)) {
      openMinutes += 1;
      tradeDates.add(cmeTradeDate(minute.toISOString()));
    }
  }
  return { openMinutes, tradeDates: [...tradeDates] };
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
    const { openMinutes, tradeDates } = scanOpenMinutes(prevMs, nextMs);
    if (openMinutes === 0) continue;
    const list = gaps.get(symbol) ?? [];
    list.push({ prevMs, nextMs, openMinutes, tradeDates });
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

// ── Candles ─────────────────────────────────────────────────

/** One contract's 1m candles, as loaded once per run. */
interface ContractCandles {
  bars: Bar[];
  /** The raw row count when the payload hit UW's row cap, else null. */
  cappedAt: number | null;
  malformed: number;
}

/** A root's 1m candles for the contracts a pass's schedule names. */
interface RootCandles {
  contracts: string[];
  byContract: Map<string, Bar[]>;
  /** Raw row count of each payload that hit UW's row cap. */
  capped: Map<string, number>;
  malformed: number;
}

/** What both passes share for the run, per root. */
interface RootLoaders {
  /**
   * Refreshes the root's contract volumes, once per run, before its first
   * schedule read. False: the refresh failed, and was reported.
   */
  volumesRefreshed(symbol: FuturesRoot): Promise<boolean>;
  /** The root's 1m candles for `contracts`; each contract loads once per run. */
  candlesFor(
    symbol: FuturesRoot,
    contracts: readonly string[],
  ): Promise<RootCandles>;
}

/**
 * One scheduled contract's 1m candles. Throws on a UW error, a non-array
 * payload, an empty payload, or a payload of only malformed candles. Other
 * malformed candles are skipped and surfaced as a Sentry warning.
 */
async function loadCandles(
  ctx: CronContext,
  symbol: FuturesRoot,
  contract: string,
): Promise<ContractCandles> {
  const raw: unknown = await withRetry(() =>
    uwFetch<unknown>(
      ctx.apiKey,
      `/futures/${encodeURIComponent(contract)}/candles?interval=1m&range=5d`,
    ),
  );
  if (!Array.isArray(raw)) {
    throw new Error(`UW candles for ${contract}: non-array payload`);
  }
  // A contract scheduled as a front month inside the window always has
  // candles over 5 days; an empty payload (also what UW returns for an
  // unknown contract) is a fault.
  if (raw.length === 0) {
    throw new Error(`UW returned no candles for ${contract}`);
  }
  const bars = raw.map(parseCandle).filter((b): b is Bar => b !== null);
  if (bars.length === 0) {
    throw new Error(`UW candles for ${contract}: all ${raw.length} malformed`);
  }
  const malformed = raw.length - bars.length;
  if (malformed > 0) {
    ctx.logger.warn(
      { symbol, contract, malformed },
      `${JOB}: skipped malformed UW candles`,
    );
    metrics.increment('backfill_futures_gaps.malformed_candle');
    Sentry.captureMessage(`${JOB}: malformed UW candles skipped`, {
      level: 'warning',
      extra: { symbol, contract, malformed },
    });
  }
  return {
    bars,
    cappedAt: raw.length >= UW_CANDLE_ROW_CAP ? raw.length : null,
    malformed,
  };
}

/**
 * A capped payload (UW keeps the NEWEST rows) must reach `firstMinuteMs`,
 * the oldest minute to repair. Throws, so a truncated payload fails the
 * symbol rather than reporting a clean run.
 */
function assertCandleDepth(candles: RootCandles, firstMinuteMs: number): void {
  for (const [contract, rows] of candles.capped) {
    const bars = candles.byContract.get(contract) ?? [];
    const earliestMs = Math.min(...bars.map((b) => Date.parse(b.ts)));
    if (earliestMs > firstMinuteMs) {
      const earliest = new Date(earliestMs).toISOString();
      const needed = new Date(firstMinuteMs).toISOString();
      throw new Error(
        `UW candles for ${contract}: depth truncated at ${rows} rows (earliest ${earliest}, gap needs ${needed})`,
      );
    }
  }
}

// ── Volume refresh ──────────────────────────────────────────

/** What one root's volume refresh offered and stored. */
interface RefreshResult {
  contracts: string[];
  /** Rows given to `insertContractVolumes`: sessions before the current one. */
  offered: number;
  /** Rows it inserted; the rest were already stored. */
  inserted: number;
}

/** `date` (`YYYY-MM-DD`) moved by whole days. */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The incumbent and the next contracts of its cycle, `REFRESH_CONTRACTS` in
 * all: the cycle contracts from the incumbent's contract month to
 * `REFRESH_SPAN_MONTHS` later. The incumbent comes first even where it is
 * not itself a cycle contract (GC's odd months), so its volume is always
 * read.
 */
function refreshContracts(
  root: FuturesRoot,
  incumbent: string,
  tradeDate: string,
): string[] {
  const expiry = parseContract(root, incumbent, tradeDate);
  if (expiry == null) {
    throw new Error(`the incumbent ${incumbent} is not an outright ${root}`);
  }
  const month = expiry.year * 12 + expiry.month - 1;
  const label = (index: number) =>
    `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  const cycle = cycleContracts(
    root,
    label(month),
    label(month + REFRESH_SPAN_MONTHS),
  );
  return [incumbent, ...cycle.filter((c) => c !== incumbent)].slice(
    0,
    REFRESH_CONTRACTS,
  );
}

/**
 * Brings one root's `futures_contract_volume` up to date before its
 * schedule is read: daily candles over `VOLUME_RANGE` for the incumbent
 * (the latest decision stored in the last `INCUMBENT_LOOKBACK_DAYS` days,
 * else the listing-cycle seed for the current trade date) and the next
 * contracts of its cycle, stored by `insertContractVolumes` for trade dates
 * before the current one only. A decision made from old volume is
 * permanent, and nothing else writes volume when uw-stream is down.
 *
 * Throws on a UW error, a malformed candle, a DB error, and when no candle
 * at all comes back for the incumbent (it has traded every session of the
 * month, and UW answers a fault with an empty body).
 */
async function refreshVolumes(
  ctx: CronContext,
  root: FuturesRoot,
): Promise<RefreshResult> {
  const current = cmeTradeDate(new Date().toISOString());
  const stored = await fetchStoredFrontMonths(
    root,
    shiftDate(current, -INCUMBENT_LOOKBACK_DAYS),
    current,
  );
  // Oldest first, so the last entry is the latest decision.
  const incumbent =
    [...stored.values()].at(-1) ?? nullSeedContract(root, current);
  const contracts = refreshContracts(root, incumbent, current);

  const candles = await fetchDailyContractVolumes(
    ctx.apiKey,
    root,
    contracts,
    VOLUME_RANGE,
  );
  if (!candles.some((c) => c.contract === incumbent)) {
    throw new Error(`UW returned no daily candles for ${incumbent}`);
  }
  // The running session has only partial volume, and the next decision
  // reads this table: store the sessions that are over.
  const rows = candles
    .filter((c) => c.tradeDate < current)
    .map((c) => ({
      product: root,
      tradeDate: c.tradeDate,
      contract: c.contract,
      volume: c.volume,
    }));
  const inserted = await insertContractVolumes(rows);
  return { contracts, offered: rows.length, inserted };
}

// ── OHLC pass ───────────────────────────────────────────────

async function repairSymbol(
  ctx: CronContext,
  symbol: FuturesRoot,
  gaps: Gap[],
  candles: RootCandles,
  schedule: FrontMonthSchedule,
): Promise<SymbolResult> {
  assertCandleDepth(
    candles,
    Math.min(...gaps.map((g) => g.prevMs)) + MINUTE_MS,
  );

  const inGap = (bar: Bar) => {
    const t = Date.parse(bar.ts);
    return gaps.some((g) => t > g.prevMs && t < g.nextMs);
  };
  // The column's CHECK runs before the conflict arbiter, so one name that
  // is no outright of this root would fail the whole 500-row chunk, bars
  // already stored included. A decision row is canonical by construction;
  // a bad one is stored as NULL (unknown) and warned about.
  const unstorable = new Set<string>();
  const bars: FuturesBarRow[] = pickScheduledFront(
    candles.byContract,
    schedule.contractFor,
  )
    .filter((e) => inGap(e.row))
    .map(({ contract, row }) => {
      if (parseContract(symbol, contract, row.ts) !== null) {
        return { ...row, contract };
      }
      unstorable.add(contract);
      return { ...row, contract: null };
    });
  if (unstorable.size > 0) {
    ctx.logger.warn(
      { symbol, contracts: [...unstorable] },
      `${JOB}: scheduled contract is not an outright of the root, bars stored with a NULL contract`,
    );
  }
  const inserted = await insertFuturesBars(symbol, bars);

  return {
    contracts: candles.contracts,
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
 * FLOW_PAGE_BUDGET pages. A symbol whose schedule, candles, prints or write
 * fail is a failure (Sentry exception); its remaining runs are skipped. A
 * symbol in `skip` (its volume refresh or candles already failed, and were
 * reported, in the OHLC pass) is left out. A symbol that fails its volume
 * refresh here is reported by `loaders`, once. Throws only when the
 * NULL-flow scan itself fails.
 */
async function repairFlow(
  ctx: CronContext,
  windowStart: Date,
  windowEnd: Date,
  loaders: RootLoaders,
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
  // The next run's window starts as many days later as the next scheduled
  // run (0 6 * * 1-6): Saturday's next run is Monday, two days on, every
  // other day's is the next day. A bar before that start is not seen
  // again, so leaving it NULL leaves it NULL for good.
  const daysToNextRun = windowEnd.getUTCDay() === 6 ? 2 : 1;
  const agesOutBeforeMs = windowStart.getTime() + daysToNextRun * DAY_MS;
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
  // The CME trade dates of each symbol's bars: its schedule is read once.
  const tradeDates = new Map<string, Set<string>>();
  for (const bar of nullBars) {
    if (!oldestMs.has(bar.symbol)) {
      oldestMs.set(bar.symbol, Date.parse(bar.ts));
    }
    const dates = tradeDates.get(bar.symbol) ?? new Set<string>();
    dates.add(cmeTradeDate(bar.ts));
    tradeDates.set(bar.symbol, dates);
  }
  // Each minute's scheduled contract, where that contract has a candle.
  const leaderMaps = new Map<FuturesRoot, Map<string, string>>();
  const leadersFor = async (symbol: FuturesRoot) => {
    const cached = leaderMaps.get(symbol);
    if (cached) return cached;
    const schedule = await fetchFrontMonthSchedule(
      symbol,
      [...tradeDates.get(symbol)!].sort(),
      'cron',
    );
    const candles = await loaders.candlesFor(symbol, schedule.contracts);
    assertCandleDepth(candles, oldestMs.get(symbol)!);
    const leaders = new Map(
      pickScheduledFront(candles.byContract, schedule.contractFor).map((e) => [
        e.row.ts,
        e.contract,
      ]),
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
    // Before the schedule is read, which may write a decision row.
    if (!(await loaders.volumesRefreshed(symbol))) {
      failed.add(symbol);
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

    const symbols: Partial<Record<FuturesRoot, SymbolResult>> = {};
    const failures: string[] = [];
    const volumeRefresh: Partial<Record<FuturesRoot, RefreshResult>> = {};

    // Both passes read a root's schedule, which may write a decision row from
    // the root's volume, so a root's volumes are refreshed first, once per
    // run. A failure is reported here, once, and fails the root: no schedule
    // is read for it.
    const refreshes = new Map<FuturesRoot, Promise<boolean>>();
    const volumesRefreshed = (symbol: FuturesRoot): Promise<boolean> => {
      let refresh = refreshes.get(symbol);
      if (!refresh) {
        refresh = refreshVolumes(ctx, symbol).then(
          (result) => {
            volumeRefresh[symbol] = result;
            ctx.logger.info(
              { symbol, ...result, range: VOLUME_RANGE },
              `${JOB}: contract volumes refreshed`,
            );
            return true;
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            failures.push(`${symbol} volume refresh: ${message}`);
            ctx.logger.error(
              { err, symbol, range: VOLUME_RANGE },
              `${JOB}: volume refresh failed`,
            );
            metrics.increment('backfill_futures_gaps.volume_refresh_error');
            Sentry.captureException(err, {
              tags: { cron: JOB, symbol, pass: 'volume' },
              extra: { root: symbol, range: VOLUME_RANGE },
            });
            return false;
          },
        );
        refreshes.set(symbol, refresh);
      }
      return refresh;
    };

    // Each contract's candles load once, whichever pass asks first, so a
    // contract both passes need is fetched once.
    const candleLoads = new Map<string, Promise<ContractCandles>>();
    const candlesFor = async (
      symbol: FuturesRoot,
      contracts: readonly string[],
    ): Promise<RootCandles> => {
      const byContract = new Map<string, Bar[]>();
      const capped = new Map<string, number>();
      let malformed = 0;
      for (const contract of contracts) {
        let load = candleLoads.get(contract);
        if (!load) {
          load = loadCandles(ctx, symbol, contract);
          candleLoads.set(contract, load);
        }
        const loaded = await load;
        byContract.set(contract, loaded.bars);
        if (loaded.cappedAt !== null) capped.set(contract, loaded.cappedAt);
        malformed += loaded.malformed;
      }
      return { contracts: [...contracts], byContract, capped, malformed };
    };

    // Roots the flow pass leaves out: their volume refresh or candles failed
    // (and were reported) here, and it would only get the same failure.
    const flowSkip = new Set<FuturesRoot>();
    for (const [symbol, symbolGaps] of gaps) {
      if (!(await volumesRefreshed(symbol))) {
        flowSkip.add(symbol);
        continue;
      }
      try {
        const schedule = await fetchFrontMonthSchedule(
          symbol,
          [...new Set(symbolGaps.flatMap((g) => g.tradeDates))].sort(),
          'cron',
        );
        const candles = await candlesFor(symbol, schedule.contracts).catch(
          (err: unknown) => {
            flowSkip.add(symbol);
            throw err;
          },
        );
        symbols[symbol] = await repairSymbol(
          ctx,
          symbol,
          symbolGaps,
          candles,
          schedule,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${symbol}: ${message}`);
        ctx.logger.error({ err, symbol }, `${JOB}: symbol repair failed`);
        metrics.increment('backfill_futures_gaps.symbol_error');
        Sentry.captureException(err, { tags: { cron: JOB, symbol } });
      }
    }
    const rows = Object.values(symbols).reduce((n, r) => n + r.inserted, 0);

    // After the OHLC pass, so the bars it just inserted get flow too.
    const flow = await repairFlow(
      ctx,
      windowStart,
      windowEnd,
      { volumesRefreshed, candlesFor },
      flowSkip,
    );
    failures.push(...flow.failures);
    const flowSymbols = Object.keys(flow.symbols).length;

    // Legs: each symbol with gaps, plus each symbol the flow pass worked
    // on. Minutes that age out of the window still NULL are a shortfall
    // too: no later run will repair them.
    let status = deriveCronStatus(failures.length, gaps.size + flowSymbols);
    if (status === 'success' && flow.agedOut > 0) status = 'partial';
    ctx.logger.info(
      { range, status, rows, symbols, volumeRefresh, flow, failures },
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
        volumeRefresh,
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
