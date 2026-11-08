/**
 * One-time seed of the per-session front-month tables from UW's daily
 * candles (docs/superpowers/specs/2026-11-06-futures-session-front-month.md,
 * Phase 3b): `futures_contract_volume` (each contract's volume per trade
 * date) and `futures_front_month` (the contract chosen per root and trade
 * date), from 2026-07-27 (`SEED_START`, the first full session in UW's
 * daily candles; 07-21 to 07-24 are only slivers), to the running session.
 *
 * Per root, in this order:
 *   1. `fetchDailyContractVolumes` over the root's listed contracts from
 *      2026-07 to six months past today (`range=6m`). Without the six
 *      months the next quarterly contract would be missing, and the roll
 *      into it could never be seen.
 *   2. The empty-result rule (`requiredContracts`): an empty answer for a
 *      contract near the front fails the root, because an empty answer is
 *      read as no volume and would let a challenger roll early.
 *   3. The decisions already stored (`fetchStoredFrontMonths`), read once.
 *   4. `walkFrontMonths`: the rule `ensureFrontMonth` applies, run in memory
 *      over the sessions, oldest first. A stored row is that date's answer
 *      and the walk carries on from it; a computed answer is never later
 *      than the next stored one, so a re-run over rows another decider
 *      wrote cannot make the series step back. Before anything is written,
 *      the walked series is checked for a step back anyway (rows that were
 *      already out of order are kept, and would leave one): such a root
 *      fails and writes nothing.
 *   5. The volumes of the sessions before the current one, then the
 *      decisions the walk produced (both `ON CONFLICT DO NOTHING`, so a
 *      re-run writes only what is missing), then a read-back: any later
 *      date holding an earlier-expiring contract fails the root, naming
 *      the pair.
 *
 * A root's failure (a fetch error, an empty result, a rejected read or
 * insert, a series that steps back, before or after the write) fails that
 * root alone, by name; the others still run, and the exit code is 1 if any
 * failed. `--dry-run` does steps 1-4, prints what it would write, and does
 * neither the inserts nor the read-back.
 *
 * The current trade date always gets a decision row. Run on a weekday, or
 * after the Sunday 17:00 CT open, to avoid a row for a date with no
 * session; the row is harmless if you do not.
 *
 * No market-hours guard: about 30 light calls. Never prints a secret.
 */

import {
  FUTURES_ROOTS,
  cmeTradeDate,
  compareExpiry,
  decideFrontMonth,
  nullSeedContract,
  parseContract,
  type FuturesRoot,
  type ParsedContract,
} from '../../api/_lib/futures-contracts.js';
import {
  cycleContracts,
  fetchDailyContractVolumes,
  type DailyContractVolume,
} from '../../api/_lib/futures-daily-candles.js';
import {
  ceilingContract,
  fetchStoredFrontMonths,
  insertContractVolumes,
  insertFrontMonthRows,
  type ContractVolumeRow,
  type FrontMonthRow,
} from '../../api/_lib/futures-front-month.js';

/**
 * The first full session in UW's daily candles (owner, 2026-11-08). UW
 * serves daily candles from 2026-07-21, but 07-21 to 07-24 hold only a
 * sliver of each session on every root: RTY September traded 73 to 1,685
 * contracts a day, then 144,241 on 07-27. A roll only moves forward, so
 * decisions read off that noise could roll a contract early and hold it
 * through its expiry (a dry run rolled RTY to December on 07-24, from 218
 * against 73). Those sessions are never stored and never read; the volumes
 * of this session start the first decision.
 */
export const SEED_START = '2026-07-27';

/**
 * The first decision row: the session after `SEED_START`. No earlier trade
 * date has a stored front month, so the history backfills
 * (`futures-flow-backfill.ts`) refuse to read one.
 */
export const FIRST_DECISION_DATE = '2026-07-28';

/** The first contract month listed for each root. */
const FROM_MONTH = '2026-07';

/** UW's range for the seed; counts calendar days back from now. */
const CANDLE_RANGE = '6m';

/** Contract months past today that are fetched. */
const MONTHS_AHEAD = 6;

// ── Arguments ───────────────────────────────────────────────

export interface SeedOptions {
  dryRun: boolean;
  roots: FuturesRoot[];
}

const SEED_USAGE = `Usage: npx tsx scripts/backfill-futures-front-month.ts
         [--roots ES,NQ,...] [--dry-run]`;

function parseRoots(value: string): FuturesRoot[] {
  const roots = value.split(',').map((raw) => {
    const root = FUTURES_ROOTS.find((r) => r === raw.trim().toUpperCase());
    if (root === undefined) {
      throw new Error(
        `--roots: unknown root ${raw} (one of ${FUTURES_ROOTS.join(', ')})`,
      );
    }
    return root;
  });
  return [...new Set(roots)];
}

/** Parses the CLI arguments. Throws an Error naming the bad argument. */
export function parseSeedArgs(argv: readonly string[]): SeedOptions {
  const options: SeedOptions = { dryRun: false, roots: [...FUTURES_ROOTS] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--roots') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--roots needs a value\n${SEED_USAGE}`);
      }
      options.roots = parseRoots(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}\n${SEED_USAGE}`);
    } else {
      throw new Error(`Unexpected argument ${arg}\n${SEED_USAGE}`);
    }
  }
  return options;
}

// ── Dates and contracts ─────────────────────────────────────

/** The month `months` after the one `tradeDate` is in, as `YYYY-MM`. */
export function monthPlus(tradeDate: string, months: number): string {
  const index =
    Number(tradeDate.slice(0, 4)) * 12 +
    (Number(tradeDate.slice(5, 7)) - 1) +
    months;
  const month = String((index % 12) + 1).padStart(2, '0');
  return `${Math.floor(index / 12)}-${month}`;
}

/** Throws unless `contract` is an outright of `root`. */
function expiryOf(
  root: FuturesRoot,
  contract: string,
  tradeDate: string,
): ParsedContract {
  const expiry = parseContract(root, contract, tradeDate);
  if (expiry === null) {
    throw new Error(
      `${JSON.stringify(contract)} is not an outright ${root} contract on ${tradeDate}`,
    );
  }
  return expiry;
}

/** Contract months as one number, to compare with a calendar month. */
function monthNumber(expiry: ParsedContract): number {
  return expiry.year * 12 + expiry.month;
}

/**
 * Where the required contracts start: the first contract still trading in
 * the month after the first decision date. `nullSeedContract` is
 * month-granular, so asking it about the first decision date itself (a day
 * in July) keeps every contract that stops in July; the first day of the
 * next month drops them. That is CLQ6, whose last session is 2026-07-21 and
 * which UW serves no candles for (probe 2026-11-07). None of the other
 * roots has a contract that stops in July. Any first decision date in July
 * gives the same bound (2026-08-01), so moving the seed start within July
 * does not change the required contracts.
 */
const REQUIRED_FROM = `${monthPlus(FIRST_DECISION_DATE, 1)}-01`;

/**
 * The listed contracts whose empty result fails the root: from the first
 * contract still trading after the first decision date's month up to and
 * including the second cycle contract after the month of `today` (ES on
 * 2026-11-06: ESU6, ESZ6 and ESH7; CL: CLU6 through CLF7). Read as no
 * volume, an empty answer would let a challenger roll early. A contract
 * that stopped trading before then (CLN6, June 2026; CLQ6, whose last
 * session is 2026-07-21) is not required: UW has no candles for it, and it
 * can be neither the incumbent nor the challenger of any decision from
 * 07-28 on. With fewer than two contracts after the current month, every
 * listed contract from the first one on is required. `contracts` is in
 * expiry order.
 */
export function requiredContracts(
  root: FuturesRoot,
  contracts: readonly string[],
  today: string,
): string[] {
  const current = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
  const first = monthNumber(
    expiryOf(root, nullSeedContract(root, REQUIRED_FROM), today),
  );
  const after = contracts
    .map((c) => monthNumber(expiryOf(root, c, today)))
    .filter((month) => month > current)
    .sort((a, b) => a - b);
  const last = after[1] ?? Number.POSITIVE_INFINITY;
  return contracts.filter((c) => {
    const month = monthNumber(expiryOf(root, c, today));
    return month >= first && month <= last;
  });
}

/** Throws, naming the contracts, when a required one came back empty. */
function requireCandles(
  required: readonly string[],
  candles: readonly DailyContractVolume[],
): void {
  const seen = new Set(candles.map((c) => c.contract));
  const missing = required.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    throw new Error(
      `UW returned no daily candles for ${missing.join(', ')}; read as no volume, an empty result could let a challenger roll early`,
    );
  }
}

/**
 * The candle rows to store: trade dates from `SEED_START` up to the day
 * before `today`. The running session is left out (its volume is partial,
 * and the next date's decision would read it), and so is anything before
 * the seed start.
 */
export function volumeRowsToStore(
  root: FuturesRoot,
  candles: readonly DailyContractVolume[],
  today: string,
): ContractVolumeRow[] {
  return candles
    .filter((c) => c.tradeDate >= SEED_START && c.tradeDate < today)
    .map((c) => ({
      product: root,
      tradeDate: c.tradeDate,
      contract: c.contract,
      volume: c.volume,
    }));
}

// ── The walk ────────────────────────────────────────────────

type Origin = 'stored' | 'candles';

export interface SeriesEntry {
  tradeDate: string;
  contract: string;
  /** A row that was already stored, or the walk's own answer. */
  source: Origin;
}

/** A change of contract between two consecutive decisions. */
export interface Switch {
  tradeDate: string;
  from: string;
  to: string;
  /** The session whose volumes the decision read. */
  volumeDate: string;
  fromVolume: number;
  toVolume: number;
  source: Origin;
}

/** A stored row the candles would not have chosen. */
export interface KeptRow {
  tradeDate: string;
  stored: string;
  candles: string;
}

/** An answer lowered to the next stored decision. */
export interface Clamp {
  tradeDate: string;
  wanted: string;
  ceiling: string;
}

export interface Walk {
  /** Every decision from the first date, stored rows included. */
  series: SeriesEntry[];
  /** The decisions with no stored row: what gets written. */
  rows: FrontMonthRow[];
  switches: Switch[];
  kept: KeptRow[];
  clamped: Clamp[];
}

/**
 * The rule `ensureFrontMonth` applies, run in memory over the sessions
 * from the day after `SEED_START` to `today`, oldest first. The dates are
 * every trade date with candle volume after the seed start, the current
 * trade date, and any date with a stored row. For a date D:
 *
 *   - V is the volume of the latest candle date before D (so the current
 *     date reads the last full session, and the first date reads
 *     `SEED_START`), and I the contract of the decision before it (none
 *     for the first, which `decideFrontMonth` turns into the contract with
 *     the most volume in V).
 *   - A stored row is D's answer, whatever the candles say, and the next I.
 *     Where the candles would have chosen another contract it is listed in
 *     `kept`.
 *   - Otherwise the answer is `decideFrontMonth(I, V)`, lowered to the
 *     contract of the earliest stored row after D if it would expire after
 *     it (listed in `clamped`): rows are never updated, so the series must
 *     not step back into a row already there.
 *
 * `volumes` holds only the rows `volumeRowsToStore` keeps; `stored` the
 * decisions already in the table from the first decision date to `today`.
 * Throws when there is no volume on `SEED_START`, the session the first
 * decision starts from.
 */
export function walkFrontMonths(
  root: FuturesRoot,
  volumes: readonly ContractVolumeRow[],
  stored: ReadonlyMap<string, string>,
  today: string,
): Walk {
  const bySession = new Map<string, Map<string, number>>();
  for (const v of volumes) {
    const session = bySession.get(v.tradeDate) ?? new Map<string, number>();
    session.set(v.contract, v.volume);
    bySession.set(v.tradeDate, session);
  }
  if (!bySession.has(SEED_START)) {
    throw new Error(
      `no candle volume on ${SEED_START}, the session the first decision starts from`,
    );
  }
  const volumeDates = [...bySession.keys()].sort();
  const candleDates = new Set(volumeDates);
  candleDates.add(today);
  const dates = [...new Set([...candleDates, ...stored.keys()])]
    .filter((d) => d > SEED_START)
    .sort();

  // The contract of the earliest stored row after each date.
  const ceilings = new Map<string, string | null>();
  let ceiling: string | null = null;
  for (const date of [...dates].reverse()) {
    ceilings.set(date, ceiling);
    ceiling = stored.get(date) ?? ceiling;
  }

  const walk: Walk = {
    series: [],
    rows: [],
    switches: [],
    kept: [],
    clamped: [],
  };
  let incumbent: string | null = null;
  for (const date of dates) {
    const volumeDate = volumeDates.filter((d) => d < date).at(-1) ?? SEED_START;
    const session = bySession.get(volumeDate) ?? new Map<string, number>();
    const wanted = decideFrontMonth(incumbent, session, root, date);
    const storedContract = stored.get(date);

    let contract: string;
    let source: Origin;
    if (storedContract !== undefined) {
      contract = storedContract;
      source = 'stored';
      if (candleDates.has(date) && wanted !== storedContract) {
        walk.kept.push({
          tradeDate: date,
          stored: storedContract,
          candles: wanted,
        });
      }
    } else {
      const capped = ceilingContract(
        root,
        date,
        wanted,
        ceilings.get(date) ?? null,
      );
      contract = capped.contract;
      if (capped.clamped) {
        walk.clamped.push({ tradeDate: date, wanted, ceiling: contract });
      }
      source = 'candles';
      walk.rows.push({ product: root, tradeDate: date, contract });
    }

    const previous = walk.series.at(-1);
    if (previous !== undefined && previous.contract !== contract) {
      walk.switches.push({
        tradeDate: date,
        from: previous.contract,
        to: contract,
        volumeDate,
        fromVolume: session.get(previous.contract) ?? 0,
        toVolume: session.get(contract) ?? 0,
        source,
      });
    }
    walk.series.push({ tradeDate: date, contract, source });
    incumbent = contract;
  }
  return walk;
}

// ── The order check ─────────────────────────────────────────

/** Two consecutive decisions, the later one expiring first. */
export interface OutOfOrder {
  earlierDate: string;
  earlierContract: string;
  laterDate: string;
  laterContract: string;
}

function formatPair(v: OutOfOrder): string {
  return (
    `${v.earlierDate} ${v.earlierContract}, then ` +
    `${v.laterDate} ${v.laterContract}`
  );
}

/**
 * The first pair of consecutive dates (by date, whatever the map's order)
 * where the later date holds a contract that expires before the earlier
 * date's, or null. A series that never steps back has no such pair.
 */
export function findOutOfOrder(
  root: FuturesRoot,
  series: ReadonlyMap<string, string>,
): OutOfOrder | null {
  const entries = [...series].sort(([a], [b]) => (a < b ? -1 : 1));
  let previous: { date: string; contract: string } | null = null;
  for (const [date, contract] of entries) {
    if (
      previous !== null &&
      compareExpiry(
        expiryOf(root, contract, date),
        expiryOf(root, previous.contract, previous.date),
      ) < 0
    ) {
      return {
        earlierDate: previous.date,
        earlierContract: previous.contract,
        laterDate: date,
        laterContract: contract,
      };
    }
    previous = { date, contract };
  }
  return null;
}

// ── One root ────────────────────────────────────────────────

interface RootSeed {
  walk: Walk;
  volumeRows: number;
  /** Rows written per table; null in a dry run. */
  inserted: { volumes: number; decisions: number } | null;
  /** The pair the read-back found stepping back; null if none, or no read-back. */
  violation: OutOfOrder | null;
}

async function seedRoot(
  apiKey: string,
  root: FuturesRoot,
  today: string,
  dryRun: boolean,
): Promise<RootSeed> {
  const contracts = cycleContracts(
    root,
    FROM_MONTH,
    monthPlus(today, MONTHS_AHEAD),
  );
  const candles = await fetchDailyContractVolumes(
    apiKey,
    root,
    contracts,
    CANDLE_RANGE,
  );
  requireCandles(requiredContracts(root, contracts, today), candles);

  const volumes = volumeRowsToStore(root, candles, today);
  const stored = await fetchStoredFrontMonths(root, FIRST_DECISION_DATE, today);
  const walk = walkFrontMonths(root, volumes, stored, today);
  // Rows are write-once. Stored rows that were already out of order are
  // kept by the walk, so the series it would leave behind can step back:
  // refuse that before anything is written, in a dry run too.
  const stepBack = findOutOfOrder(
    root,
    new Map(walk.series.map((s) => [s.tradeDate, s.contract])),
  );
  if (stepBack !== null) {
    throw new Error(
      `the series to write steps back: ${formatPair(stepBack)}; nothing written`,
    );
  }
  if (dryRun) {
    return {
      walk,
      volumeRows: volumes.length,
      inserted: null,
      violation: null,
    };
  }

  // Volumes first: the decision for a date reads the volumes before it.
  const insertedVolumes = await insertContractVolumes(volumes);
  const insertedDecisions = await insertFrontMonthRows(walk.rows);
  const violation = findOutOfOrder(
    root,
    await fetchStoredFrontMonths(root, FIRST_DECISION_DATE, today),
  );
  return {
    walk,
    volumeRows: volumes.length,
    inserted: { volumes: insertedVolumes, decisions: insertedDecisions },
    violation,
  };
}

// ── Run ─────────────────────────────────────────────────────

function formatSwitch(root: FuturesRoot, s: Switch): string {
  const origin = s.source === 'stored' ? ' [stored row]' : '';
  return (
    `  ${root}  ${s.tradeDate}  ${s.from} → ${s.to}  ` +
    `(${s.volumeDate} volumes: ${s.to} ${s.toVolume} vs ${s.from} ${s.fromVolume})` +
    origin
  );
}

function printRoot(root: FuturesRoot, res: RootSeed): void {
  const { walk } = res;
  const first = walk.series[0]?.tradeDate ?? '-';
  const last = walk.series.at(-1)?.tradeDate ?? '-';
  console.log(
    `${root}: ${walk.series.length} decisions ${first} → ${last}, ` +
      `${walk.switches.length} switches`,
  );
  for (const s of walk.switches) console.log(formatSwitch(root, s));
  for (const k of walk.kept) {
    console.log(
      `  ${root}  kept stored row ${k.tradeDate} ${k.stored} ` +
        `(candles say ${k.candles})`,
    );
  }
  for (const c of walk.clamped) {
    console.log(
      `  ${root}  lowered ${c.tradeDate} from ${c.wanted} to the next ` +
        `stored decision ${c.ceiling}`,
    );
  }
  if (res.inserted === null) {
    console.log(
      `  ${root}  would insert ${res.volumeRows} volume rows and ` +
        `${walk.rows.length} decision rows (dry run: nothing written, ` +
        `no read-back)`,
    );
    return;
  }
  console.log(
    `  ${root}  volumes: inserted ${res.inserted.volumes} of ${res.volumeRows}, ` +
      `decisions: inserted ${res.inserted.decisions} of ${walk.rows.length}`,
  );
}

/** Runs the seed and returns the process exit code. */
export async function runFrontMonthSeed(
  opts: SeedOptions & { apiKey: string },
): Promise<number> {
  const today = cmeTradeDate(new Date().toISOString());
  const label = opts.dryRun ? ' (DRY RUN: no writes)' : '';
  console.log(
    `Futures front-month seed from daily candles${label}: ` +
      `${SEED_START} → ${today}, roots ${opts.roots.join(',')}`,
  );

  const failed: FuturesRoot[] = [];
  for (const root of opts.roots) {
    try {
      const res = await seedRoot(opts.apiKey, root, today, opts.dryRun);
      printRoot(root, res);
      if (res.violation !== null) {
        failed.push(root);
        console.error(
          `  ${root} FAILED: the stored series steps back: ` +
            formatPair(res.violation),
        );
      }
    } catch (err) {
      failed.push(root);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${root} FAILED: ${message}`);
    }
  }

  if (failed.length > 0) {
    console.error(
      `\nFailed roots: ${failed.join(', ')}. Re-run with ` +
        `--roots ${failed.join(',')}${opts.dryRun ? ' --dry-run' : ''}.`,
    );
    return 1;
  }
  console.log(`\nDone: ${opts.roots.length} roots seeded.`);
  return 0;
}
