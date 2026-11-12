/**
 * One-time history backfill of `futures_bars` order flow from UW REST
 * prints (spec Phase 6b): `buy_volume`, `sell_volume`, `buy_prints` and
 * `sell_prints` on bars written before the websocket handler carried
 * them, back to 2026-07-28, the first trade date with a stored front month
 * (FIRST_DECISION_DATE). UW's REST history reaches back further (ES
 * 2026-06-30, the rest 2026-07-21), but no contract is recorded for those
 * dates, so a root-day on an earlier trade date fails by name.
 *
 * Per root and UTC day, oldest day first:
 *   1. The day's NULL-flow bars in Globex-open minutes
 *      (`fetchNullFlowBars`). None → nothing to do, no UW call and no
 *      front-month read: a re-run resumes where the last one stopped.
 *   2. The contract of each CME trade date the NULL minutes fall on, from
 *      the stored per-session front month (`futures_front_month`,
 *      `api/_lib/futures-front-month.ts`). A trade date before the table
 *      starts fails the root-day. The table is read first; only in a real
 *      run, when a date has no row yet, are the root's contract volumes
 *      refreshed (`refreshFrontMonthVolumes`, once per root per run) and
 *      the date decided (`fetchFrontMonthSchedule`, source 'script').
 *   3. The NULL minutes' span is cut at the session open into pieces, each
 *      led by one contract (`sessionPieces`), and only that contract's
 *      prints are paged, over that piece's window (`fetchContractFlow`).
 *      A minute's contract is the one its trade date was decided on, so no
 *      tally is needed and a late minute pages only its own piece.
 *   4. `matchFlowToBars` keeps a minute only when REST volume is within 2%
 *      of the bar's volume (most bars before 2026-09-29 are Databento-era
 *      OHLCV), and `writeFlowMinutes` writes it with the conditional
 *      `UPDATE … WHERE buy_volume IS NULL`.
 *
 * A day whose minutes all failed the 2% rule still has NULL bars, so a
 * re-run pages it again; pass `--from` to skip ahead.
 *
 * `--dry-run` writes nothing, the front-month table included: it reads the
 * stored decisions only (no volume refresh, no decision). A trade date
 * with no stored row is skipped, not paged, and reported once per root at
 * the end; a real run decides it.
 *
 * Operational limits: at most UW_CONCURRENCY_CAP requests in flight (one
 * root-day per slot, its pieces paged one after another), each through the
 * crons' shared Redis slots; no start during market hours and a stop
 * between dates if they begin; the page budget is checked between dates,
 * so a run overshoots it by at most one date. A run that fails a root-day
 * or stops before its last date exits 1; it ends by naming the root-days it
 * did not reach and the arguments that resume them.
 *
 * The argument parser, date plan, session pieces, per-day paging, date
 * loop and market-hours guard are exported for `futures-bar-backfill.ts`
 * (the September bar rebuild) and `futures-bar-repair.ts`, which run the
 * same loop over the same prints.
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 * (Phase 6b, as amended by probe 0a) and
 * docs/superpowers/specs/2026-11-06-futures-session-front-month.md
 * (Phase 4b).
 */

import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import {
  FUTURES_ROOTS,
  cmeTradeDate,
  type FuturesRoot,
} from '../../api/_lib/futures-contracts.js';
import {
  fetchContractFlow,
  fetchNullFlowBars,
  matchFlowToBars,
  writeFlowMinutes,
  type FlowMinute,
  type PageBudget,
} from '../../api/_lib/futures-flow-repair.js';
import {
  fetchFrontMonthSchedule,
  fetchStoredFrontMonths,
} from '../../api/_lib/futures-front-month.js';
import { refreshFrontMonthVolumes } from '../../api/_lib/futures-volume-refresh.js';
import { UW_CONCURRENCY_CAP } from '../../api/_lib/uw-concurrency.js';
import { mapWithConcurrency } from '../../api/_lib/uw-fetch.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';
import { FIRST_DECISION_DATE } from './futures-front-month-backfill.js';

/** Default `--max-pages`: about 20 ES sessions, roughly half an hour. */
export const DEFAULT_MAX_PAGES = 20_000;

/**
 * A guard against a runaway cursor, not a budget: a piece is at most one
 * UTC day of one contract, and an ES day is about 1,025 pages.
 */
const MAX_PAGES_PER_PIECE = 5_000;

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

// ── Arguments ───────────────────────────────────────────────

export interface BackfillOptions {
  /** Explicit UTC dates, or null to use the from/to range. */
  dates: string[] | null;
  /** Range start; null = the first date with a stored front month. */
  from: string | null;
  /** Range end (inclusive); null = today (UTC). */
  to: string | null;
  roots: FuturesRoot[];
  dryRun: boolean;
  /** Soft page budget for the run, checked between dates. */
  maxPages: number;
}

export const USAGE = `Usage: npx tsx scripts/backfill-futures-flow.ts [YYYY-MM-DD ...]
         [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--roots ES,NQ,...]
         [--max-pages N] [--dry-run]`;

function isDate(s: string): boolean {
  if (!DATE_RX.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Parses the CLI arguments. Throws an Error naming the bad argument, with
 * `usage` (the calling script's) where the message points at the syntax.
 */
export function parseArgs(
  argv: readonly string[],
  usage: string = USAGE,
): BackfillOptions {
  const out: BackfillOptions = {
    dates: null,
    from: null,
    to: null,
    roots: [...FUTURES_ROOTS],
    dryRun: false,
    maxPages: DEFAULT_MAX_PAGES,
  };
  const dates: string[] = [];
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value\n${usage}`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--from':
      case '--to': {
        const v = value(i, arg);
        if (!isDate(v)) throw new Error(`${arg} must be YYYY-MM-DD, got ${v}`);
        if (arg === '--from') out.from = v;
        else out.to = v;
        i += 1;
        break;
      }
      case '--max-pages': {
        const v = value(i, arg);
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--max-pages must be a positive integer, got ${v}`);
        }
        out.maxPages = n;
        i += 1;
        break;
      }
      case '--roots': {
        const v = value(i, arg);
        // A repeated root would run its root-days twice, concurrently.
        out.roots = [
          ...new Set(
            v.split(',').map((raw) => {
              const root = FUTURES_ROOTS.find(
                (r) => r === raw.trim().toUpperCase(),
              );
              if (!root) {
                throw new Error(
                  `--roots: unknown root ${raw} (one of ${FUTURES_ROOTS.join(', ')})`,
                );
              }
              return root;
            }),
          ),
        ];
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag ${arg}\n${usage}`);
        }
        if (!isDate(arg)) {
          throw new Error(`Dates must be YYYY-MM-DD, got ${arg}`);
        }
        dates.push(arg);
    }
  }

  if (dates.length > 0) {
    if (out.from !== null || out.to !== null) {
      throw new Error('Pass either explicit dates or --from/--to, not both');
    }
    out.dates = dates;
  }
  if (out.from !== null && out.to !== null && out.from > out.to) {
    throw new Error(`--from ${out.from} is after --to ${out.to}`);
  }
  return out;
}

// ── Planning ────────────────────────────────────────────────

export interface DayPlan {
  date: string;
  roots: FuturesRoot[];
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The UTC dates to process, oldest first, each with every root asked for.
 * Dates after `today` are dropped. With no dates and no `--from`, the range
 * starts at FIRST_DECISION_DATE: no earlier trade date has a stored front
 * month to page, and a root-day on one fails by name (the schedule reader).
 */
export function planDates(opts: BackfillOptions, today: string): DayPlan[] {
  let dates: string[];
  if (opts.dates !== null) {
    dates = [...new Set(opts.dates)].sort();
  } else {
    const from = opts.from ?? FIRST_DECISION_DATE;
    const to = opts.to ?? today;
    dates = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  }

  const plan: DayPlan[] = [];
  for (const date of dates) {
    if (date > today) continue;
    plan.push({ date, roots: [...opts.roots] });
  }
  return plan;
}

// ── Sessions ────────────────────────────────────────────────

/** The Globex-open part of a window that falls on one CME trade date. */
export interface SessionSpan {
  tradeDate: string;
  fromMs: number;
  toMs: number;
}

/**
 * The Globex-open parts of [fromMs, toMs), one span per CME trade date,
 * oldest first: the window cut at each session open (22:00Z in summer,
 * 23:00Z in winter) with the halt hour and the weekend left out, so a
 * Friday has no span on Saturday's date.
 *
 * Every open, close and change of trade date falls on a whole UTC hour
 * (Chicago's offset is whole hours), so the window is walked an hour at a
 * time: an hour is open or closed throughout, and sits on one trade date.
 * A window's own bounds may be mid-hour; they clip the first and last hour.
 */
export function sessionSpans(fromMs: number, toMs: number): SessionSpan[] {
  const spans: SessionSpan[] = [];
  for (let start = fromMs; start < toMs; ) {
    const end = Math.min(toMs, (Math.floor(start / HOUR_MS) + 1) * HOUR_MS);
    const at = new Date(start);
    if (isFuturesMarketOpen(at)) {
      const tradeDate = cmeTradeDate(at.toISOString());
      const last = spans.at(-1);
      if (last?.tradeDate === tradeDate) last.toMs = end;
      else spans.push({ tradeDate, fromMs: start, toMs: end });
    }
    start = end;
  }
  return spans;
}

/** A window led by one contract: the part of a session it is the front of. */
export interface SessionPiece {
  contract: string;
  fromMs: number;
  toMs: number;
}

/**
 * Reads a root's front months for ascending, distinct trade dates: trade
 * date → contract, for the dates that have one. See `createScheduleReader`.
 */
export type ScheduleReader = (
  root: FuturesRoot,
  tradeDates: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/**
 * A schedule reader for one run. A trade date before FIRST_DECISION_DATE
 * (the stored table starts there) rejects, naming the root and the date,
 * before any read: nothing earlier has a front month to page.
 *
 * With `decide` false (`--dry-run`, `--compare`) it reads the stored
 * decisions and nothing else, so a date with no row is simply missing from
 * the answer: it never refreshes volumes or decides a date.
 *
 * With `decide` true it reads the stored decisions first and touches UW only
 * when a date has none: then it refreshes the root's contract volumes (daily
 * candles over `1m`, as the gap cron does) and `fetchFrontMonthSchedule`
 * decides the date, so every date asked about is in the answer. The refresh
 * comes first because a decision made from old volume is permanent. Each
 * root is refreshed once per run; a refresh that fails is not remembered, so
 * the root's next root-day tries again.
 *
 * Any failure (UW, a stale candle, the database) rejects, nothing is decided
 * from stale volume, and the date loop reports the root-day as
 * `<root> <date> FAILED: <message>`.
 */
export function createScheduleReader(
  apiKey: string,
  { decide }: { decide: boolean },
): ScheduleReader {
  const refreshed = new Set<FuturesRoot>();
  return async (root, tradeDates) => {
    const first = tradeDates[0]!;
    if (first < FIRST_DECISION_DATE) {
      throw new Error(
        `${root}: trade date ${first} is before the stored front month, which starts ${FIRST_DECISION_DATE}`,
      );
    }
    const stored = await fetchStoredFrontMonths(
      root,
      first,
      tradeDates.at(-1)!,
    );
    if (!decide) return stored;

    if (!refreshed.has(root) && tradeDates.some((d) => !stored.has(d))) {
      await refreshFrontMonthVolumes(apiKey, root, '1m');
      refreshed.add(root);
    }
    const schedule = await fetchFrontMonthSchedule(root, tradeDates, 'script');
    const decided = new Map<string, string>();
    for (const tradeDate of tradeDates) {
      const contract = schedule.contractFor(tradeDate);
      if (contract === undefined) {
        throw new Error(`${root}: no front month for ${tradeDate}`);
      }
      decided.set(tradeDate, contract);
    }
    return decided;
  };
}

/** What `sessionPieces` cut a window into. */
export interface SessionPieces {
  pieces: SessionPiece[];
  /** Trade dates the reader had no front month for: not paged. */
  undecided: string[];
}

/**
 * The pieces of [fromMs, toMs) for `root`: one per run of trade dates that
 * share a contract, each with that contract. Nothing is paged here. An
 * empty window (no Globex-open minute) has no piece and reads no schedule.
 * A trade date the reader returned no contract for is left out and listed
 * in `undecided`; a piece never spans it. A deciding reader leaves none.
 */
export async function sessionPieces(
  schedules: ScheduleReader,
  root: FuturesRoot,
  fromMs: number,
  toMs: number,
): Promise<SessionPieces> {
  const spans = sessionSpans(fromMs, toMs);
  if (spans.length === 0) return { pieces: [], undecided: [] };
  const contracts = await schedules(
    root,
    spans.map((s) => s.tradeDate),
  );
  const pieces: SessionPiece[] = [];
  const undecided: string[] = [];
  let tail: SessionPiece | undefined;
  for (const span of spans) {
    const contract = contracts.get(span.tradeDate);
    if (contract === undefined) {
      undecided.push(span.tradeDate);
      tail = undefined;
    } else if (tail?.contract === contract) {
      tail.toMs = span.toMs;
    } else {
      tail = { contract, fromMs: span.fromMs, toMs: span.toMs };
      pieces.push(tail);
    }
  }
  return { pieces, undecided };
}

/**
 * Says, once, which trade dates each root had no stored decision for in a
 * read-only run. Silent when there were none.
 */
export function logUndecided(
  byRoot: ReadonlyMap<FuturesRoot, ReadonlySet<string>>,
): void {
  for (const [root, dates] of byRoot) {
    if (dates.size === 0) continue;
    console.log(
      `  ${root}  undecided trade dates ${dates.size}: ` +
        `${[...dates].sort().join(', ')} (skipped; a real run decides them)`,
    );
  }
}

// ── One root-day ────────────────────────────────────────────

interface RootDayResult {
  nullMinutes: number;
  /** Rows updated, or in a dry run the rows that would be. */
  written: number;
  skippedTolerance: number;
  pages: number;
  /** Contracts that led at least one written minute. */
  leaders: string[];
  /** Trade dates with no stored front month (read-only runs): skipped. */
  undecided: string[];
}

/** A failed root-day, carrying the UW pages it used before failing. */
export class RootDayError extends Error {
  readonly pages: number;

  constructor(cause: unknown, pages: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RootDayError';
    this.pages = pages;
  }
}

/**
 * What one root-day's paging has used so far. The caller owns it, so a
 * fetch that throws part-way still leaves the pages it used on it.
 */
export interface PagingTally {
  pages: number;
  /** Malformed prints skipped (each withholds its minute). */
  malformed: number;
  /**
   * Pieces whose paging stopped on UW's empty page (`exhausted`) instead of
   * reaching the piece's start: UW holds no older prints for the contract,
   * so the minutes before its oldest print are not rebuilt.
   */
  exhausted: number;
  /**
   * Minutes inside a piece's covered range that were dropped because their
   * count could not be trusted (`ContractFlow.withheld`).
   */
  withheld: number;
}

/** A minute's counted prints, with the contract they are the front of. */
export interface PagedMinute {
  contract: string;
  minute: FlowMinute;
}

/**
 * Pages each piece's contract over that piece's window only, one piece
 * after another, and returns the counted minutes keyed by minute, oldest
 * first. Pieces are disjoint windows, so a minute has one contract: the
 * one its trade date was decided on, and no other. Throws on an upstream
 * error, and when a piece needs more than MAX_PAGES_PER_PIECE pages.
 *
 * A minute absent from the result is not always a quiet minute: the tally
 * says when it may not be. `exhausted` counts the pieces whose paging ran
 * into UW's empty page, and `withheld` the minutes dropped as untrustworthy.
 * A caller that reads absence as "nothing printed" must not when either is
 * above 0 (the bar repair holds its deletes).
 */
export async function pageDayContracts(
  apiKey: string,
  pieces: readonly SessionPiece[],
  tally: PagingTally,
): Promise<Map<string, PagedMinute>> {
  const paged = new Map<string, PagedMinute>();
  for (const { contract, fromMs, toMs } of pieces) {
    const budget: PageBudget = {
      pagesLeft: MAX_PAGES_PER_PIECE,
      deadlineMs: Number.POSITIVE_INFINITY,
    };
    const flow = await fetchContractFlow(
      apiKey,
      contract,
      fromMs,
      toMs,
      budget,
    ).finally(() => {
      tally.pages += MAX_PAGES_PER_PIECE - budget.pagesLeft;
    });
    tally.malformed += flow.malformed;
    tally.withheld += flow.withheld;
    if (flow.stop === 'budget') {
      throw new Error(
        `${contract}: more than ${MAX_PAGES_PER_PIECE} pages for one day`,
      );
    }
    if (flow.stop === 'exhausted') tally.exhausted += 1;
    for (const minute of flow.minutes.values()) {
      paged.set(minute.ts, { contract, minute });
    }
  }
  // A piece's minutes come newest first; ISO minutes sort chronologically.
  return new Map([...paged].sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function backfillRootDay(
  apiKey: string,
  schedules: ScheduleReader,
  root: FuturesRoot,
  date: string,
  dryRun: boolean,
): Promise<RootDayResult> {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const bars = await fetchNullFlowBars(
    [root],
    new Date(dayStartMs).toISOString(),
    new Date(dayStartMs + DAY_MS).toISOString(),
  );
  if (bars.length === 0) {
    return {
      nullMinutes: 0,
      written: 0,
      skippedTolerance: 0,
      pages: 0,
      leaders: [],
      undecided: [],
    };
  }

  // A fetch that throws part-way still charges the pages it used to the
  // run's budget.
  const tally: PagingTally = {
    pages: 0,
    malformed: 0,
    exhausted: 0,
    withheld: 0,
  };
  try {
    const { pieces, undecided } = await sessionPieces(
      schedules,
      root,
      Date.parse(bars[0]!.ts),
      Date.parse(bars.at(-1)!.ts) + MINUTE_MS,
    );
    const paged = await pageDayContracts(apiKey, pieces, tally);

    const front = new Map(
      [...paged].map(([ts, { minute }]) => [ts, minute] as const),
    );
    // A bar on an undecided date has no prints to match: it is reported with
    // its date, not counted as outside 2%.
    const matchable =
      undecided.length === 0
        ? bars
        : bars.filter((b) => !undecided.includes(cmeTradeDate(b.ts)));
    const { updates, skippedTolerance } = matchFlowToBars(matchable, front);
    const written = dryRun
      ? updates.length
      : await writeFlowMinutes(root, updates);
    const leaders = [
      ...new Set(updates.flatMap((u) => paged.get(u.ts)?.contract ?? [])),
    ];
    return {
      nullMinutes: bars.length,
      written,
      skippedTolerance,
      pages: tally.pages,
      leaders,
      undecided,
    };
  } catch (err) {
    throw new RootDayError(err, tally.pages);
  }
}

// ── Run ─────────────────────────────────────────────────────

/**
 * True, after saying why, when it is market hours. UW_CONCURRENCY_CAP is
 * UW's plan-wide in-flight limit, shared with the live crons through
 * Redis, so a backfill stays out of the session entirely.
 */
export function refuseDuringMarketHours(): boolean {
  if (!isMarketHours()) return false;
  console.error(
    'Refusing to run during market hours: UW concurrency is shared with ' +
      'the live crons. Run after the close.',
  );
  return true;
}

type RootDayOutcome<R> =
  | { root: FuturesRoot; ok: R }
  | { root: FuturesRoot; err: string; pages: number };

/** A root-day that threw. */
export interface FailedRootDay {
  root: FuturesRoot;
  date: string;
}

/**
 * The arguments that re-run `dates` for `roots` with this run's page
 * budget: explicit dates stay dates, a range is re-given as --from/--to.
 * `flag` is the run's mode flag with its leading space, or ''.
 */
export function rerunArgs(
  opts: BackfillOptions,
  dates: readonly string[],
  roots: readonly FuturesRoot[],
  flag: string,
): string {
  const when =
    opts.dates !== null
      ? dates.join(' ')
      : `--from ${dates[0] ?? ''} --to ${dates.at(-1) ?? ''}`;
  return `${when} --roots ${roots.join(',')} --max-pages ${opts.maxPages}${flag}`;
}

/**
 * Says where a run that stopped early (market hours began, or the page
 * budget was spent) left off: the arguments that resume it and the
 * root-days it never reached. Silent when `stoppedBefore` is null.
 */
export function reportStoppedEarly(
  opts: BackfillOptions,
  plan: readonly DayPlan[],
  stoppedBefore: string | null,
  flag: string,
): void {
  if (stoppedBefore === null) return;
  const left = plan.filter((d) => d.date >= stoppedBefore);
  const dates = left.map((d) => d.date);
  const rootDays = left.reduce((n, d) => n + d.roots.length, 0);
  console.error(
    `Incomplete: stopped before ${stoppedBefore}. ` +
      `Resume with ${rerunArgs(opts, dates, opts.roots, flag)}`,
  );
  console.error(
    `Not reached: ${dates[0]} → ${dates.at(-1)}, ` +
      `roots ${opts.roots.join(',')} (${rootDays} root-days)`,
  );
}

export interface DayLoopResult {
  pages: number;
  failures: number;
  /** Per root, the trade dates a read-only run found no front month for. */
  undecided: Map<FuturesRoot, Set<string>>;
  /** The failed root-days, in the order they finished. */
  failed: FailedRootDay[];
  /**
   * The first date left unprocessed because market hours began or the page
   * budget was spent, or null when the loop reached the end of the plan.
   */
  stoppedBefore: string | null;
}

/**
 * The date loop both backfills share, oldest date first: stops before a
 * date once market hours begin or the page budget is spent (it names the
 * stop; `reportStoppedEarly` gives the resume arguments), runs a date's
 * roots up to UW_CONCURRENCY_CAP at a
 * time, and hands each finished root-day to `report`. A root-day that
 * throws is logged with its pages, counted as a failure, and the run goes
 * on. Returns the pages used, the failed root-days, the trade dates a
 * read-only run found no front month for (per root; a result without an
 * `undecided` list, like the bar repair's, reports none because it fails
 * the root-day instead), and where it stopped early (if it did).
 */
export async function runPlannedDays<
  R extends { pages: number; undecided?: readonly string[] },
>(
  plan: readonly DayPlan[],
  maxPages: number,
  work: (root: FuturesRoot, date: string) => Promise<R>,
  report: (root: FuturesRoot, date: string, result: R) => void,
): Promise<DayLoopResult> {
  let pages = 0;
  const undecided = new Map<FuturesRoot, Set<string>>();
  const failed: FailedRootDay[] = [];
  let stoppedBefore: string | null = null;
  for (const [i, day] of plan.entries()) {
    if (isMarketHours()) {
      console.error(
        `\nMarket hours began: stopping before ${day.date}. ` +
          `The Incomplete line at the end has the arguments to resume.`,
      );
      stoppedBefore = day.date;
      break;
    }
    if (pages >= maxPages) {
      console.log(
        `\nPage budget spent (${pages} of ${maxPages}): stopping before ` +
          `${day.date}. The Incomplete line at the end has the arguments to resume.`,
      );
      stoppedBefore = day.date;
      break;
    }
    console.log(`[${i + 1}/${plan.length}] ${day.date} ${day.roots.join(',')}`);

    const results = await mapWithConcurrency(
      day.roots,
      UW_CONCURRENCY_CAP,
      async (root): Promise<RootDayOutcome<R>> => {
        try {
          return { root, ok: await work(root, day.date) };
        } catch (err) {
          return {
            root,
            err: err instanceof Error ? err.message : String(err),
            pages: err instanceof RootDayError ? err.pages : 0,
          };
        }
      },
    );

    for (const r of results) {
      if ('err' in r) {
        failed.push({ root: r.root, date: day.date });
        pages += r.pages;
        console.error(
          `  ${r.root} ${day.date} FAILED: ${r.err} (after ${r.pages} pages)`,
        );
        continue;
      }
      pages += r.ok.pages;
      const missing = r.ok.undecided ?? [];
      if (missing.length > 0) {
        const dates = undecided.get(r.root) ?? new Set<string>();
        for (const d of missing) dates.add(d);
        undecided.set(r.root, dates);
      }
      report(r.root, day.date, r.ok);
    }
  }
  return { pages, failures: failed.length, undecided, failed, stoppedBefore };
}

/** Runs the backfill and returns the process exit code. */
export async function runBackfill(
  opts: BackfillOptions & { apiKey: string },
): Promise<number> {
  if (refuseDuringMarketHours()) return 1;

  const today = new Date().toISOString().slice(0, 10);
  const plan = planDates(opts, today);
  const verb = opts.dryRun ? 'would write' : 'repaired';
  console.log(
    `Futures order-flow backfill${opts.dryRun ? ' (DRY RUN: no writes)' : ''}: ` +
      `${plan.length} dates, ${plan[0]?.date ?? '-'} → ${plan.at(-1)?.date ?? '-'}, ` +
      `roots ${opts.roots.join(',')}, page budget ${opts.maxPages}`,
  );

  const schedules = createScheduleReader(opts.apiKey, {
    decide: !opts.dryRun,
  });
  let written = 0;
  let skipped = 0;
  const { pages, failures, undecided, stoppedBefore } = await runPlannedDays(
    plan,
    opts.maxPages,
    (root, date) =>
      backfillRootDay(opts.apiKey, schedules, root, date, opts.dryRun),
    (root, date, res) => {
      written += res.written;
      skipped += res.skippedTolerance;
      if (res.nullMinutes === 0) return;
      console.log(
        `  ${root} ${date}  null ${res.nullMinutes}  ${verb} ${res.written}` +
          `  skipped ${res.skippedTolerance}  pages ${res.pages}` +
          `  front ${res.leaders.join('/') || '-'}` +
          (res.undecided.length > 0
            ? `  undecided ${res.undecided.join(',')}`
            : ''),
      );
    },
  );
  logUndecided(undecided);

  console.log(
    `\nDone: ${verb} ${written} minutes, skipped ${skipped} (outside 2%), ` +
      `${pages} pages, ${failures} failed root-days.`,
  );
  if (failures > 0) {
    console.error('Re-run the failed dates; finished root-days are skipped.');
  }
  reportStoppedEarly(
    opts,
    plan,
    stoppedBefore,
    opts.dryRun ? ' --dry-run' : '',
  );
  // Dates the loop never reached are as unfinished as failed root-days.
  return failures > 0 || stoppedBefore !== null ? 1 : 0;
}
