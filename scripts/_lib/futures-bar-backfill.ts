/**
 * One-time rebuild of missing `futures_bars` rows from UW REST prints
 * (docs/superpowers/specs/2026-11-06-futures-sept-bar-backfill.md): the
 * UTC days 2026-09-04 → 09-28 hold no bar for any root, between the end of
 * Databento and the switch to the uw-stream `futures_trades` handler, and
 * UW's candles can't reach them (1m candles keep the newest 5,000 rows).
 * REST `/futures/{contract}/trades` history is complete from 2026-07-26,
 * and bars built from its deduped, non-spread, non-block prints matched
 * the live bars exactly (probe 2026-11-06), so the backfilled bars come
 * out the same as every other bar in the table.
 *
 * Per root and UTC day, oldest first:
 *   1. The day's stored bars (`fetchFuturesBars`). No missing Globex-open
 *      minute → nothing to do, no UW call and no front-month read, so a
 *      re-run skips what it already filled. A root-day with any missing
 *      minute (a sparse overnight tape, a holiday) is paged again on every
 *      re-run.
 *   2. The day's Globex-open span [00:00, 24:00) UTC is cut at the session
 *      open into pieces, each led by the contract its CME trade date was
 *      decided on (`sessionPieces`, from the stored `futures_front_month`;
 *      see `futures-flow-backfill.ts` for how an undecided date is
 *      handled), and `pageDayContracts` pages that contract's prints over
 *      that piece's window only.
 *   3. A minute's bar comes only from its piece's contract, the one its
 *      trade date was decided on, and carries that name. A minute where
 *      that contract printed nothing stays empty (a back month trades at a
 *      carry basis).
 *   4. A bar for each such minute that has no bar yet and whose `ohlc`
 *      is known (`fetchContractFlow`: null when a counted print had no
 *      usable price or a size of 0 or over 2^31 - 1, which the live
 *      handler would have dropped). Flow
 *      follows the live NULL-vs-0 rule: no print with a known side
 *      (`sideSeen` false) → all four flow columns NULL, otherwise the four
 *      counts, `none`-side prints counting toward volume only. The
 *      `contract` is checked with `parseContract` first: a name that is no
 *      outright of the root would fail the column's CHECK for the whole
 *      chunk, so its bars are stored with a NULL contract and the root-day
 *      prints one warning.
 *   5. `insertFuturesBars`: ON CONFLICT DO NOTHING, so a bar the live
 *      handler wrote is never replaced.
 *
 * `--dry-run` does steps 1-4 and writes nothing. `--compare` writes nothing
 * either: for minutes that already have a bar it counts how many
 * REST-built bars equal the stored bar (prices rounded to 4 dp, as the
 * NUMERIC(12,4) column stores them) and prints the first few differences.
 * That is the acceptance check against a day of full live bars. Its
 * percentage is matched / (compared + stored-only): a stored bar no print
 * rebuilds is a contract or roll disagreement, so it counts against the
 * root. Neither mode writes the front-month table either: both read the
 * stored decisions only (no volume refresh, no decision). A trade date with
 * no stored row is skipped, not paged, and reported once per root at the
 * end; `--compare` leaves its stored bars out of the counts. A real run
 * decides it.
 *
 * The current UTC day is never processed: the live handler is still
 * writing it, and a bar built from a minute still in progress would be
 * locked in by DO NOTHING.
 *
 * Operational limits are the flow backfill's (`futures-flow-backfill.ts`,
 * which supplies the argument parser, plan, session pieces, paging and
 * date loop): at most UW_CONCURRENCY_CAP requests in flight, no start
 * during market hours and a stop between dates if they begin, a page
 * budget checked between dates. A run that fails a root-day or stops
 * before its last date exits 1, and ends by naming the failed root-days
 * and the arguments that re-run them.
 *
 * Open and close can differ from a live bar. Live timestamps are epoch
 * milliseconds, and among prints sharing a millisecond the first arrival
 * is the open and the last arrival the close. REST timestamps are
 * microseconds, with ties broken by trade_id. The two orders can pick
 * different prints, and those prints need not share a price. `--compare`
 * is the arbiter of how often that happens.
 *
 * `--repair` is in `futures-bar-repair.ts`.
 */

import {
  fetchFuturesBars,
  insertFuturesBars,
  type FuturesBarRow,
  type StoredFuturesBar,
} from '../../api/_lib/futures-bars.js';
import {
  cmeTradeDate,
  type FuturesRoot,
} from '../../api/_lib/futures-contracts.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';
import {
  PRICE_FIELDS,
  reportIncomplete,
  roundTo4dp,
  storableContract,
  toBar,
} from './futures-bar-rules.js';
import {
  DAY_MS,
  MINUTE_MS,
  RootDayError,
  createScheduleReader,
  logUndecided,
  pageDayContracts,
  parseArgs,
  planDates,
  refuseDuringMarketHours,
  runPlannedDays,
  sessionPieces,
  type BackfillOptions,
  type PagedMinute,
  type PagingTally,
  type ScheduleReader,
} from './futures-flow-backfill.js';

/** Differences printed per root-day in `--compare`. */
const MAX_DIFFS_SHOWN = 3;

/**
 * Where `--repair` keeps its backup and its cache unless `--work-dir` says
 * otherwise (gitignored). Relative to the directory the script runs from.
 */
export const DEFAULT_WORK_DIR = 'docs/tmp/uw-futures-run';

// ── Arguments ───────────────────────────────────────────────

export interface BarBackfillOptions extends BackfillOptions {
  /** Read and compare against the stored bars; write nothing. */
  compare: boolean;
  /** Rewrite the stored bars to the one-contract-per-session rule. */
  repair: boolean;
  /** `--repair`: page again even where a cache file would do. */
  noCache: boolean;
  /**
   * `--repair`: the directory of the backup file and the cache. A knob so
   * the backup can go to a disk with room and a run can be kept apart.
   */
  workDir: string;
}

export const BAR_USAGE = `Usage: npx tsx scripts/backfill-futures-bars.ts
         (--from YYYY-MM-DD --to YYYY-MM-DD | YYYY-MM-DD ...)
         [--roots ES,NQ,...] [--max-pages N] [--dry-run | --compare]
         [--repair [--no-cache] [--work-dir DIR]]`;

/**
 * Parses the CLI arguments. A date range (or explicit dates) is required:
 * there is no all-history default, since every root-day in range is
 * paged in full. Throws an Error naming the bad argument.
 */
export function parseBarArgs(argv: readonly string[]): BarBackfillOptions {
  const rest: string[] = [];
  let compare = false;
  let repair = false;
  let noCache = false;
  let workDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--compare':
        compare = true;
        break;
      case '--repair':
        repair = true;
        break;
      case '--no-cache':
        noCache = true;
        break;
      case '--work-dir': {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          throw new Error(`--work-dir needs a value\n${BAR_USAGE}`);
        }
        workDir = v;
        i += 1;
        break;
      }
      default:
        rest.push(arg);
    }
  }
  if (repair && compare) {
    throw new Error(
      `--repair and --compare exclude each other: --compare writes nothing, ` +
        `--repair rewrites the stored bars. The repair's dry run is ` +
        `--repair --dry-run.\n${BAR_USAGE}`,
    );
  }
  if (!repair && (noCache || workDir !== null)) {
    const flag = noCache ? '--no-cache' : '--work-dir';
    throw new Error(`${flag} only applies to --repair\n${BAR_USAGE}`);
  }

  const opts = parseArgs(rest, BAR_USAGE);
  if (opts.dates === null && (opts.from === null || opts.to === null)) {
    throw new Error(
      `Pass --from and --to (or explicit dates): every root-day in range ` +
        `is paged in full, so there is no default range.\n${BAR_USAGE}`,
    );
  }
  return {
    ...opts,
    compare,
    repair,
    noCache,
    workDir: workDir ?? DEFAULT_WORK_DIR,
  };
}

// ── Bar rules ───────────────────────────────────────────────

/** Globex-open minutes of the UTC day that have no stored bar. */
function countMissing(dayStartMs: number, stored: ReadonlySet<string>): number {
  let missing = 0;
  for (let t = dayStartMs; t < dayStartMs + DAY_MS; t += MINUTE_MS) {
    const at = new Date(t);
    if (isFuturesMarketOpen(at) && !stored.has(at.toISOString())) missing += 1;
  }
  return missing;
}

const FLOW_FIELDS = [
  'buyVolume',
  'sellVolume',
  'buyPrints',
  'sellPrints',
] as const;

/** How a REST-built bar differs from the stored one; empty when equal. */
function diffBar(rest: FuturesBarRow, stored: StoredFuturesBar): string[] {
  const diffs: string[] = [];
  for (const f of PRICE_FIELDS) {
    const want = roundTo4dp(String(rest[f]));
    if (Number(want) !== Number(stored[f])) {
      diffs.push(`${f} rest ${want} stored ${stored[f]}`);
    }
  }
  if (rest.volume !== stored.volume) {
    diffs.push(`volume rest ${rest.volume} stored ${stored.volume}`);
  }
  for (const f of FLOW_FIELDS) {
    const want = rest[f] ?? null;
    if (want !== stored[f]) {
      diffs.push(`${f} rest ${want ?? 'NULL'} stored ${stored[f] ?? 'NULL'}`);
    }
  }
  return diffs;
}

// ── One root-day ────────────────────────────────────────────

type Mode = 'write' | 'dry' | 'compare';

interface CompareCounts {
  /** Stored minutes the prints rebuild. */
  compared: number;
  matched: number;
  /** Stored minutes no print rebuilds (contract silent, or no usable price). */
  storedOnly: number;
  /** Rebuildable minutes with no stored bar. */
  restOnly: number;
  /** The first MAX_DIFFS_SHOWN differing minutes, ready to print. */
  diffs: string[];
}

interface BarRootDayResult {
  /** Nothing to do: no UW call was made. */
  skipped: boolean;
  stored: number;
  /** Globex-open minutes with no stored bar. */
  missing: number;
  /** Bars built for minutes with no stored bar. */
  built: number;
  /** Rows written, or in a dry run the rows that would be. */
  inserted: number;
  /** Missing minutes whose prints had no usable price. */
  invalidPrice: number;
  malformed: number;
  pages: number;
  /**
   * No scheduled contract returned a counted print all day: a hole in
   * UW's history, a holiday, or a wrong schedule.
   */
  noPrints: boolean;
  /** Contracts that led at least one built minute. */
  leaders: string[];
  /**
   * Scheduled names that are no outright of the root: their built bars
   * are stored with a NULL contract.
   */
  unstorable: string[];
  /** Trade dates with no stored front month (read-only modes): skipped. */
  undecided: string[];
  compare: CompareCounts | null;
}

function emptyResult(over: Partial<BarRootDayResult>): BarRootDayResult {
  return {
    skipped: false,
    stored: 0,
    missing: 0,
    built: 0,
    inserted: 0,
    invalidPrice: 0,
    malformed: 0,
    pages: 0,
    noPrints: false,
    leaders: [],
    unstorable: [],
    undecided: [],
    compare: null,
    ...over,
  };
}

function compareStored(
  minutes: ReadonlyMap<string, PagedMinute>,
  stored: readonly StoredFuturesBar[],
): CompareCounts {
  const counts: CompareCounts = {
    compared: 0,
    matched: 0,
    storedOnly: 0,
    restOnly: 0,
    diffs: [],
  };
  const have = new Set(stored.map((b) => b.ts));
  for (const [ts, paged] of minutes) {
    if (!have.has(ts) && toBar(paged.minute) !== null) counts.restOnly += 1;
  }
  for (const b of stored) {
    const paged = minutes.get(b.ts);
    const rest = paged ? toBar(paged.minute) : null;
    if (rest === null) {
      counts.storedOnly += 1;
      continue;
    }
    counts.compared += 1;
    const diffs = diffBar(rest, b);
    if (diffs.length === 0) {
      counts.matched += 1;
    } else if (counts.diffs.length < MAX_DIFFS_SHOWN) {
      counts.diffs.push(`${b.ts.slice(11, 19)}Z ${diffs.join('; ')}`);
    }
  }
  return counts;
}

async function backfillBarRootDay(
  apiKey: string,
  schedules: ScheduleReader,
  root: FuturesRoot,
  date: string,
  mode: Mode,
): Promise<BarRootDayResult> {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const dayEndMs = dayStartMs + DAY_MS;
  const stored = await fetchFuturesBars(
    root,
    new Date(dayStartMs).toISOString(),
    new Date(dayEndMs).toISOString(),
  );
  const storedTs = new Set(stored.map((b) => b.ts));
  const missing = countMissing(dayStartMs, storedTs);
  const nothingToDo = mode === 'compare' ? stored.length === 0 : missing === 0;
  if (nothingToDo) {
    return emptyResult({ skipped: true, stored: stored.length, missing });
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
      dayStartMs,
      dayEndMs,
    );
    const minutes = await pageDayContracts(apiKey, pieces, tally);
    const base = emptyResult({
      stored: stored.length,
      missing,
      malformed: tally.malformed,
      pages: tally.pages,
      // Nothing paged is not a hole in UW's history.
      noPrints: pieces.length > 0 && minutes.size === 0,
      undecided,
    });
    if (mode === 'compare') {
      // A stored bar on an undecided date has no print to be rebuilt from:
      // it is reported with its date, not counted as a disagreement.
      const comparable =
        undecided.length === 0
          ? stored
          : stored.filter((b) => !undecided.includes(cmeTradeDate(b.ts)));
      return { ...base, compare: compareStored(minutes, comparable) };
    }

    const bars: FuturesBarRow[] = [];
    const front = new Set<string>();
    // The column's CHECK runs before the conflict arbiter, so a name that is
    // no outright of this root (see `storableContract`) is stored as NULL
    // and warned about.
    const unstorable = new Set<string>();
    let invalidPrice = 0;
    for (const [ts, { contract, minute }] of minutes) {
      if (storedTs.has(ts)) continue;
      const bar = toBar(minute);
      if (bar === null) {
        invalidPrice += 1;
        continue;
      }
      const storable = storableContract(root, contract, ts);
      if (storable === null) unstorable.add(contract);
      bars.push({ ...bar, contract: storable });
      front.add(contract);
    }
    const inserted =
      mode === 'write' ? await insertFuturesBars(root, bars) : bars.length;
    return {
      ...base,
      built: bars.length,
      inserted,
      invalidPrice,
      leaders: [...front],
      unstorable: [...unstorable],
    };
  } catch (err) {
    throw new RootDayError(err, tally.pages);
  }
}

// ── Run ─────────────────────────────────────────────────────

function percent(matched: number, compared: number): string {
  return compared === 0 ? '-' : `${((100 * matched) / compared).toFixed(2)}%`;
}

function modeOf(opts: BarBackfillOptions): Mode {
  if (opts.compare) return 'compare';
  return opts.dryRun ? 'dry' : 'write';
}

/** Runs the rebuild and returns the process exit code. */
export async function runBarBackfill(
  opts: BarBackfillOptions & { apiKey: string },
): Promise<number> {
  if (refuseDuringMarketHours()) return 1;

  const mode = modeOf(opts);
  const lastDay = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const plan = planDates(opts, lastDay);
  const label = {
    write: '',
    dry: ' (DRY RUN: no writes)',
    compare: ' (COMPARE: no writes)',
  }[mode];
  console.log(
    `Futures bar backfill from REST prints${label}: ` +
      `${plan.length} dates, ${plan[0]?.date ?? '-'} → ${plan.at(-1)?.date ?? '-'}, ` +
      `roots ${opts.roots.join(',')}, page budget ${opts.maxPages}`,
  );

  const verb = mode === 'dry' ? 'would insert' : 'inserted';
  const totals = { built: 0, inserted: 0, unbuildable: 0, nothingToDo: 0 };
  const byRoot = new Map<
    FuturesRoot,
    { matched: number; compared: number; storedOnly: number; restOnly: number }
  >();

  // Only a real run decides a date; --dry-run and --compare read what is stored.
  const schedules = createScheduleReader(opts.apiKey, {
    decide: mode === 'write',
  });
  const loop = await runPlannedDays(
    plan,
    opts.maxPages,
    (root, date) =>
      backfillBarRootDay(opts.apiKey, schedules, root, date, mode),
    (root, date, res) => {
      if (res.skipped) {
        totals.nothingToDo += 1;
        return;
      }
      const front = res.leaders.join('/') || '-';
      // A hole in UW's history shows here, not as a clean empty day.
      const marker =
        (res.noPrints ? '  prints 0' : '') +
        (res.undecided.length > 0
          ? `  undecided ${res.undecided.join(',')}`
          : '');
      if (res.compare !== null) {
        const c = res.compare;
        const sum = byRoot.get(root) ?? {
          matched: 0,
          compared: 0,
          storedOnly: 0,
          restOnly: 0,
        };
        sum.matched += c.matched;
        sum.compared += c.compared;
        sum.storedOnly += c.storedOnly;
        sum.restOnly += c.restOnly;
        byRoot.set(root, sum);
        console.log(
          `  ${root} ${date}  stored ${res.stored}  compared ${c.compared}` +
            `  matched ${c.matched}  differ ${c.compared - c.matched}` +
            `  stored-only ${c.storedOnly}  rest-only ${c.restOnly}` +
            `  malformed ${res.malformed}  pages ${res.pages}${marker}`,
        );
        for (const d of c.diffs) console.log(`    ${d}`);
        return;
      }
      totals.built += res.built;
      totals.inserted += res.inserted;
      totals.unbuildable += res.invalidPrice;
      console.log(
        `  ${root} ${date}  missing ${res.missing}  built ${res.built}` +
          `  ${verb} ${res.inserted}  unbuildable ${res.invalidPrice}` +
          `  malformed ${res.malformed}  front ${front}  pages ${res.pages}${marker}`,
      );
      if (res.unstorable.length > 0) {
        console.error(
          `  ${root} ${date}  WARNING: scheduled contract ` +
            `${res.unstorable.join(', ')} is not an outright of ${root}: ` +
            `its bars carry a NULL contract`,
        );
      }
    },
  );

  logUndecided(loop.undecided);

  if (mode === 'compare') {
    // A stored bar REST can't rebuild is a contract or roll disagreement, so
    // it counts against the root: the denominator is every stored bar.
    for (const [root, s] of byRoot) {
      const stored = s.compared + s.storedOnly;
      console.log(
        `  ${root}  matched ${s.matched} of ${stored} stored ` +
          `(${percent(s.matched, stored)})  compared ${s.compared}` +
          `  stored-only ${s.storedOnly}  rest-only ${s.restOnly}`,
      );
    }
    console.log(
      `\nDone: ${loop.pages} pages, ${totals.nothingToDo} root-days with no ` +
        `stored bar, ${loop.failures} failed root-days.`,
    );
  } else {
    console.log(
      `\nDone: ${verb} ${totals.inserted} bars (built ${totals.built}, ` +
        `unbuildable ${totals.unbuildable}), ${loop.pages} pages, ` +
        `${totals.nothingToDo} root-days with nothing to do, ` +
        `${loop.failures} failed root-days.`,
    );
  }
  reportIncomplete(opts, plan, loop);
  // Dates the loop never reached are as unfinished as failed root-days.
  return loop.failures > 0 || loop.stoppedBefore !== null ? 1 : 0;
}
