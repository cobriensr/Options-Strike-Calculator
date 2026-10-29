/**
 * One-time history backfill of `futures_bars` order flow from UW REST
 * prints (spec Phase 6b): `buy_volume`, `sell_volume`, `buy_prints` and
 * `sell_prints` on bars written before the websocket handler carried
 * them, back to the start of UW's REST history.
 *
 * Per root and UTC day, oldest day first:
 *   1. The day's NULL-flow bars in Globex-open minutes
 *      (`fetchNullFlowBars`). None → nothing to do, no UW call: a re-run
 *      resumes where the last one stopped.
 *   2. Every candidate contract's prints from 00:00 UTC to the last NULL
 *      minute (`fetchContractFlow`). The front month's tally runs from
 *      00:00 UTC, so the whole span is needed even for one late minute.
 *      The candidates come from the CME listing cycle, because
 *      `/futures/contracts` lists only contracts active in the last 30
 *      sessions and the roll replay needs expired ones (ESU6 in July).
 *   3. `replayFrontMonth` over those minutes picks each minute's contract,
 *      the same rule the live handler and the nightly repair use.
 *   4. `matchFlowToBars` keeps a minute only when REST volume is within 2%
 *      of the bar's volume (most bars before 2026-09-29 are Databento-era
 *      OHLCV), and `writeFlowMinutes` writes it with the conditional
 *      `UPDATE … WHERE buy_volume IS NULL`.
 *
 * A day whose minutes all failed the 2% rule still has NULL bars, so a
 * re-run pages it again; pass `--from` to skip ahead.
 *
 * Operational limits: at most UW_CONCURRENCY_CAP requests in flight (one
 * root-day per slot, its candidates paged one after another), each
 * through the crons' shared Redis slots; no start during market hours and
 * a stop between dates if they begin; the page budget is checked between
 * dates, so a run overshoots it by at most one date.
 *
 * Spec: docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md
 * (Phase 6b, as amended by probe 0a).
 */

import { isMarketHours } from '../../api/_lib/cron-helpers.js';
import {
  FUTURES_ROOTS,
  replayFrontMonth,
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
import { UW_CONCURRENCY_CAP } from '../../api/_lib/uw-concurrency.js';
import { mapWithConcurrency } from '../../api/_lib/uw-fetch.js';

/**
 * First UTC day UW's REST /trades history reaches, per root (probe 0a,
 * 2026-10-28): ESU6 from 2026-06-30T18:06Z, the others from 2026-07-21.
 * A fixed archive start, not a rolling window.
 */
export const UW_TRADES_HISTORY_START: Readonly<Record<FuturesRoot, string>> = {
  ES: '2026-06-30',
  NQ: '2026-07-21',
  RTY: '2026-07-21',
  CL: '2026-07-21',
  GC: '2026-07-21',
  ZN: '2026-07-21',
};

/** Default `--max-pages`: about 20 ES sessions, roughly half an hour. */
export const DEFAULT_MAX_PAGES = 20_000;

/**
 * A guard against a runaway cursor, not a budget: an ES UTC day is about
 * 1,025 pages, and a roll day pages two busy contracts.
 */
const MAX_PAGES_PER_CONTRACT_DAY = 5_000;

const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Contract months each root's front month moves through: quarterly for
 * the equity indexes and ZN, every month for CL, the even months for GC
 * (its odd months never lead).
 */
const CONTRACT_CYCLE: Readonly<Record<FuturesRoot, string>> = {
  ES: 'HMUZ',
  NQ: 'HMUZ',
  RTY: 'HMUZ',
  ZN: 'HMUZ',
  CL: MONTH_CODES,
  GC: 'GJMQVZ',
};

/**
 * Three listed months from the date's month on cover the front month and
 * the one it rolls to on every root: CL's front is the next month or the
 * one after (it expires in the month before its own), and an expired
 * month simply has no prints that day.
 */
const CANDIDATES_PER_DAY = 3;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

// ── Arguments ───────────────────────────────────────────────

export interface BackfillOptions {
  /** Explicit UTC dates, or null to use the from/to range. */
  dates: string[] | null;
  /** Range start; null = each root's UW history start. */
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

/** Parses the CLI arguments. Throws an Error naming the bad argument. */
export function parseArgs(argv: readonly string[]): BackfillOptions {
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
      throw new Error(`${flag} needs a value\n${USAGE}`);
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
          throw new Error(`Unknown flag ${arg}\n${USAGE}`);
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
 * The UTC dates to process, oldest first, each with the roots whose UW
 * history reaches it. Dates after `today` are dropped.
 */
export function planDates(opts: BackfillOptions, today: string): DayPlan[] {
  let dates: string[];
  if (opts.dates !== null) {
    dates = [...new Set(opts.dates)].sort();
  } else {
    const earliest = opts.roots
      .map((r) => UW_TRADES_HISTORY_START[r])
      .sort()[0];
    const from = opts.from ?? earliest;
    const to = opts.to ?? today;
    dates = [];
    if (from !== undefined) {
      for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    }
  }

  const plan: DayPlan[] = [];
  for (const date of dates) {
    if (date > today) continue;
    const roots = opts.roots.filter((r) => date >= UW_TRADES_HISTORY_START[r]);
    if (roots.length > 0) plan.push({ date, roots });
  }
  return plan;
}

/**
 * The CANDIDATES_PER_DAY listed contracts of `root` from `date`'s month
 * on, in UW's symbol form (`ESU6`: root, month code, last year digit).
 */
export function contractCandidates(root: FuturesRoot, date: string): string[] {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const out: string[] = [];
  // Every cycle lists at least one month a quarter, so a year is enough.
  for (let i = 0; i < 12; i += 1) {
    const code = MONTH_CODES[(month + i) % 12]!;
    if (!CONTRACT_CYCLE[root].includes(code)) continue;
    const y = year + Math.floor((month + i) / 12);
    out.push(`${root}${code}${y % 10}`);
    if (out.length === CANDIDATES_PER_DAY) break;
  }
  return out;
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
}

type RootDayOutcome =
  | { root: FuturesRoot; ok: RootDayResult }
  | { root: FuturesRoot; err: string; pages: number };

/** A failed root-day, carrying the UW pages it used before failing. */
class RootDayError extends Error {
  readonly pages: number;

  constructor(cause: unknown, pages: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RootDayError';
    this.pages = pages;
  }
}

async function backfillRootDay(
  apiKey: string,
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
    };
  }
  const endMs = Date.parse(bars.at(-1)!.ts) + MINUTE_MS;

  // Counted from each contract's budget, so a fetch that throws part-way
  // still charges the pages it used to the run's budget.
  let pages = 0;
  try {
    const byContract = new Map<string, FlowMinute[]>();
    for (const contract of contractCandidates(root, date)) {
      const budget: PageBudget = {
        pagesLeft: MAX_PAGES_PER_CONTRACT_DAY,
        deadlineMs: Number.POSITIVE_INFINITY,
      };
      const flow = await fetchContractFlow(
        apiKey,
        contract,
        dayStartMs,
        endMs,
        budget,
      ).finally(() => {
        pages += MAX_PAGES_PER_CONTRACT_DAY - budget.pagesLeft;
      });
      if (flow.stop === 'budget') {
        throw new Error(
          `${contract}: more than ${MAX_PAGES_PER_CONTRACT_DAY} pages for one day`,
        );
      }
      byContract.set(contract, [...flow.minutes.values()]);
    }

    const leaderOf = new Map<string, string>();
    const front = new Map<string, FlowMinute>();
    for (const { contract, row } of replayFrontMonth(byContract)) {
      front.set(row.ts, row);
      leaderOf.set(row.ts, contract);
    }
    const { updates, skippedTolerance } = matchFlowToBars(bars, front);
    const written = dryRun
      ? updates.length
      : await writeFlowMinutes(root, updates);
    const leaders = [
      ...new Set(updates.flatMap((u) => leaderOf.get(u.ts) ?? [])),
    ];
    return {
      nullMinutes: bars.length,
      written,
      skippedTolerance,
      pages,
      leaders,
    };
  } catch (err) {
    throw new RootDayError(err, pages);
  }
}

// ── Run ─────────────────────────────────────────────────────

/** Runs the backfill and returns the process exit code. */
export async function runBackfill(
  opts: BackfillOptions & { apiKey: string },
): Promise<number> {
  // UW_CONCURRENCY_CAP is UW's plan-wide in-flight limit, shared with the
  // live crons through Redis, so stay out of the session entirely.
  if (isMarketHours()) {
    console.error(
      'Refusing to run during market hours: UW concurrency is shared with ' +
        'the live crons. Run after the close.',
    );
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const plan = planDates(opts, today);
  const verb = opts.dryRun ? 'would write' : 'repaired';
  console.log(
    `Futures order-flow backfill${opts.dryRun ? ' (DRY RUN: no writes)' : ''}: ` +
      `${plan.length} dates, ${plan[0]?.date ?? '-'} → ${plan.at(-1)?.date ?? '-'}, ` +
      `roots ${opts.roots.join(',')}, page budget ${opts.maxPages}`,
  );

  let pages = 0;
  let failures = 0;
  let written = 0;
  let skipped = 0;
  for (const [i, day] of plan.entries()) {
    if (isMarketHours()) {
      console.error(
        `\nMarket hours began: stopping before ${day.date}. ` +
          `Re-run after the close with --from ${day.date}.`,
      );
      break;
    }
    if (pages >= opts.maxPages) {
      console.log(
        `\nPage budget spent (${pages} of ${opts.maxPages}): stopping before ` +
          `${day.date}. Resume with --from ${day.date}.`,
      );
      break;
    }
    console.log(`[${i + 1}/${plan.length}] ${day.date} ${day.roots.join(',')}`);

    const results = await mapWithConcurrency(
      day.roots,
      UW_CONCURRENCY_CAP,
      async (root): Promise<RootDayOutcome> => {
        try {
          return {
            root,
            ok: await backfillRootDay(opts.apiKey, root, day.date, opts.dryRun),
          };
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
        failures += 1;
        pages += r.pages;
        console.error(
          `  ${r.root} ${day.date} FAILED: ${r.err} (after ${r.pages} pages)`,
        );
        continue;
      }
      const res = r.ok;
      pages += res.pages;
      written += res.written;
      skipped += res.skippedTolerance;
      if (res.nullMinutes === 0) continue;
      console.log(
        `  ${r.root} ${day.date}  null ${res.nullMinutes}  ${verb} ${res.written}` +
          `  skipped ${res.skippedTolerance}  pages ${res.pages}` +
          `  front ${res.leaders.join('/') || '-'}`,
      );
    }
  }

  console.log(
    `\nDone: ${verb} ${written} minutes, skipped ${skipped} (outside 2%), ` +
      `${pages} pages, ${failures} failed root-days.`,
  );
  if (failures > 0) {
    console.error('Re-run the failed dates; finished root-days are skipped.');
  }
  return failures > 0 ? 1 : 0;
}
