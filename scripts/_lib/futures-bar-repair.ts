/**
 * The `--repair` mode of the futures bar backfill. The plain backfill,
 * `--dry-run` and `--compare` are in `futures-bar-backfill.ts`.
 *
 * `--repair` (docs/superpowers/specs/2026-11-06-futures-session-front-month.md,
 * Phase 6) brings the bars already stored in line with the one-contract-
 * per-session rule. Per root and UTC day it reads the stored bars, pages the
 * scheduled contract of each session piece (the same prints and the same
 * `toBar` the fill path uses) and sorts every minute (`planRepair`):
 *   - keep: a stored bar whose open, high, low and close all lie within one
 *     tick of the rebuilt minute's low-to-high range. Live bars that missed
 *     websocket prints are a subset of the REST prints, so they pass. Where
 *     its contract is NULL it is tagged with the scheduled contract.
 *   - rewrite: a stored bar outside that band, with a rebuilt minute:
 *     prices, volume, flow and contract are replaced (an old contract is
 *     overwritten).
 *   - delete: a stored bar with no rebuilt minute: the scheduled contract
 *     printed nothing countable, which the rule calls a gap.
 *   - fill: no stored bar, a rebuilt minute: inserted, ON CONFLICT DO NOTHING.
 * A stored bar the rebuild cannot judge is left alone and counted
 * (`unjudged`): a closed minute, or a minute whose prints have no usable
 * price. Deletes are held, not made (`held`), on a root-day where a delete
 * could be a missing minute that was not quiet: UW returned no counted
 * print at all, a piece ran out of UW history (`exhausted`), a minute was
 * withheld as untrustworthy (`withheld`: a malformed print, a burst of one
 * microsecond's prints) or any print was malformed. The repair reads the
 * stored front months and never decides one: a trade date with none fails
 * its root-day (run `scripts/backfill-futures-front-month.ts` first).
 *
 * Writes are guarded and batched (`updateFuturesBars`, `deleteFuturesBars`,
 * `tagFuturesBars`, `insertFuturesBars` in `api/_lib/futures-bars.ts`): each
 * touches a row only while its open and close are what this run read. A
 * write run first appends every row it will rewrite, delete or tag, in full
 * and with the new values, plus every fill, to
 * `<work dir>/front-month-repair-<run id>.jsonl`, and refuses to start when
 * that file cannot be created.
 *
 * A past day's REST tape does not change, so a completed root-day's rebuilt
 * minutes are cached in `<work dir>/front-month-repair-cache/`, keyed by
 * root and day and valid only for the same version and the same contract
 * per piece. Only a day paged back to the start of every piece with nothing
 * withheld is saved. The stored bars are always read fresh. `--no-cache`
 * pages again and refreshes the files. The work dir is resolved to an
 * absolute path, and the re-run lines name it.
 *
 * The `Done:` line totals `held`, `unjudged`, `unbuildable` and
 * `keep-other-tag` (kept bars tagged with another contract) over the run,
 * and a write run adds `planned N, applied M (changed since read K)`: a
 * clean second dry run is judged on those, not on delete and rewrite alone.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  deleteFuturesBars,
  fetchFuturesBars,
  insertFuturesBars,
  tagFuturesBars,
  updateFuturesBars,
  type FuturesBarRow,
  type StoredFuturesBar,
} from '../../api/_lib/futures-bars.js';
import type { FuturesRoot } from '../../api/_lib/futures-contracts.js';
import { isFuturesMarketOpen } from '../../src/utils/timezone.js';
import type { BarBackfillOptions } from './futures-bar-backfill.js';
import {
  PRICE_FIELDS,
  reportIncomplete,
  roundTo4dp,
  storableContract,
  toBar,
} from './futures-bar-rules.js';
import {
  DAY_MS,
  RootDayError,
  createScheduleReader,
  pageDayContracts,
  planDates,
  refuseDuringMarketHours,
  runPlannedDays,
  sessionPieces,
  type PagedMinute,
  type PagingTally,
  type ScheduleReader,
  type SessionPiece,
} from './futures-flow-backfill.js';

/** Rewrites and deletes printed per root-day in `--repair`. */
const MAX_SAMPLES_SHOWN = 3;

// ── Repair: the plan ────────────────────────────────────────

/**
 * One tick of each root, the margin of the keep band. CME minimum price
 * fluctuations: ES and NQ 0.25, RTY 0.10, CL 0.01, GC 0.10, ZN 1/64.
 */
export const FUTURES_TICK_SIZE: Readonly<Record<FuturesRoot, number>> = {
  ES: 0.25,
  NQ: 0.25,
  RTY: 0.1,
  CL: 0.01,
  GC: 0.1,
  ZN: 0.015625,
};

/** Float slack on the band's edges: a tick such as 0.1 is not exact in binary. */
const BAND_SLACK = 1e-9;

interface PriceFields<T> {
  open: T;
  high: T;
  low: T;
  close: T;
}

/**
 * True when all four of a stored bar's prices lie within one tick of the
 * rebuilt minute's range, [rebuilt low - 1 tick, rebuilt high + 1 tick],
 * edges included. A live bar that missed websocket prints holds a subset of
 * the REST prints, so it lies inside; a bar of another contract does not.
 * Prices compare as numbers (the DB returns NUMERIC as text).
 */
export function inKeepBand(
  root: FuturesRoot,
  stored: PriceFields<string>,
  rebuilt: PriceFields<number | string>,
): boolean {
  const tick = FUTURES_TICK_SIZE[root];
  const floor = Number(rebuilt.low) - tick - BAND_SLACK;
  const ceiling = Number(rebuilt.high) + tick + BAND_SLACK;
  return PRICE_FIELDS.every((f) => {
    const px = Number(stored[f]);
    return px >= floor && px <= ceiling;
  });
}

/** What `--repair` will do with one root-day's stored and rebuilt minutes. */
export interface RepairPlan {
  /** In the band and left alone: already tagged, or no storable contract. */
  keep: number;
  /**
   * Of `keep`, the bars tagged with a contract other than the scheduled one.
   * They are left alone (the tag only fills a NULL), so this is the count of
   * wrong-contract bars that survive.
   */
  keepOtherTag: number;
  /** In the band with a NULL contract: only the contract is set. */
  tags: Array<{ old: StoredFuturesBar; contract: string }>;
  /** Outside the band with a rebuilt minute: replaced in full. */
  rewrites: Array<{ old: StoredFuturesBar; bar: FuturesBarRow }>;
  /** Outside the band, the scheduled contract printed nothing countable. */
  deletes: StoredFuturesBar[];
  /** No stored bar, a rebuilt minute. */
  fills: FuturesBarRow[];
  /** Would-be deletes kept because `holdDeletes` was set. */
  held: number;
  /**
   * Stored bars the rebuild cannot judge: a closed minute, a minute outside
   * every piece, or prints with no usable price. The pieces of a root-day
   * cover every open minute (an undecided trade date fails the root-day
   * first), so the second case is a guard.
   */
  unjudged: number;
  /** Minutes with no stored bar whose prints have no usable price. */
  unbuildable: number;
  /** Scheduled names that are no outright of the root. */
  unstorable: string[];
}

interface RepairInput {
  root: FuturesRoot;
  stored: readonly StoredFuturesBar[];
  minutes: ReadonlyMap<string, PagedMinute>;
  pieces: readonly SessionPiece[];
  /**
   * Keep a stored bar that has no rebuilt minute instead of deleting it:
   * set when the rebuilt day may be missing minutes it should have.
   */
  holdDeletes: boolean;
}

function pieceAt(
  pieces: readonly SessionPiece[],
  tsIso: string,
): SessionPiece | undefined {
  const t = Date.parse(tsIso);
  return pieces.find((p) => t >= p.fromMs && t < p.toMs);
}

/**
 * Sorts every minute of a root-day (see the module comment). Pure. A stored
 * bar is judged only in a Globex-open minute inside a piece; any other is
 * `unjudged`.
 */
export function planRepair({
  root,
  stored,
  minutes,
  pieces,
  holdDeletes,
}: RepairInput): RepairPlan {
  const plan: RepairPlan = {
    keep: 0,
    keepOtherTag: 0,
    tags: [],
    rewrites: [],
    deletes: [],
    fills: [],
    held: 0,
    unjudged: 0,
    unbuildable: 0,
    unstorable: [],
  };
  const unstorable = new Set<string>();
  const scheduled = (paged: PagedMinute, tsIso: string): string | null => {
    const contract = storableContract(root, paged.contract, tsIso);
    if (contract === null) unstorable.add(paged.contract);
    return contract;
  };

  const storedTs = new Set(stored.map((b) => b.ts));
  for (const old of stored) {
    if (
      pieceAt(pieces, old.ts) === undefined ||
      !isFuturesMarketOpen(new Date(old.ts))
    ) {
      plan.unjudged += 1;
      continue;
    }
    const paged = minutes.get(old.ts);
    if (paged === undefined) {
      if (holdDeletes) plan.held += 1;
      else plan.deletes.push(old);
      continue;
    }
    const bar = toBar(paged.minute);
    if (bar === null) {
      plan.unjudged += 1;
      continue;
    }
    const contract = scheduled(paged, old.ts);
    if (!inKeepBand(root, old, bar)) {
      plan.rewrites.push({ old, bar: { ...bar, contract } });
    } else if (old.contract === null && contract !== null) {
      plan.tags.push({ old, contract });
    } else {
      plan.keep += 1;
      if (
        old.contract !== null &&
        contract !== null &&
        old.contract !== contract
      ) {
        plan.keepOtherTag += 1;
      }
    }
  }

  for (const [ts, paged] of minutes) {
    if (storedTs.has(ts)) continue;
    const bar = toBar(paged.minute);
    if (bar === null) {
      plan.unbuildable += 1;
      continue;
    }
    plan.fills.push({ ...bar, contract: scheduled(paged, ts) });
  }
  plan.unstorable = [...unstorable];
  return plan;
}

// ── Repair: backup and cache ────────────────────────────────

/** `<ROOT>-<date>.json` files live in this folder of the work dir. */
const CACHE_DIR = 'front-month-repair-cache';

/**
 * Bump when the cache file's content or meaning changes. Version 1 (the
 * first `--repair` commit) could hold a day with an exhausted piece or a
 * withheld minute; version 2 is written only for a day with neither, so a
 * version 1 file is never read as a hit.
 */
export const REPAIR_CACHE_VERSION = 2;

const CacheHeaderSchema = z.object({ version: z.number() });

const CacheFileSchema = z.object({
  version: z.literal(REPAIR_CACHE_VERSION),
  root: z.string(),
  date: z.string(),
  /** The contract paged for each piece, and the window it was paged over. */
  pieces: z.array(
    z.object({ contract: z.string(), fromMs: z.number(), toMs: z.number() }),
  ),
  malformed: z.number(),
  minutes: z.array(
    z.object({
      contract: z.string(),
      minute: z.object({
        ts: z.string(),
        volume: z.number(),
        buyVolume: z.number(),
        sellVolume: z.number(),
        buyPrints: z.number(),
        sellPrints: z.number(),
        sideSeen: z.boolean(),
        ohlc: z
          .object({
            open: z.string(),
            high: z.string(),
            low: z.string(),
            close: z.string(),
          })
          .nullable(),
      }),
    }),
  ),
});

interface CachedDay {
  minutes: Map<string, PagedMinute>;
  malformed: number;
}

function samePieces(
  cached: ReadonlyArray<{ contract: string; fromMs: number; toMs: number }>,
  pieces: readonly SessionPiece[],
): boolean {
  return (
    cached.length === pieces.length &&
    cached.every(
      (c, i) =>
        c.contract === pieces[i]!.contract &&
        c.fromMs === pieces[i]!.fromMs &&
        c.toMs === pieces[i]!.toMs,
    )
  );
}

/**
 * A root-day's rebuilt minutes from its cache file, or null to page again:
 * no file, another version, another root or day, or other pieces (the
 * contract or the window of any piece differs). A file that cannot be read
 * or parsed is the same, with a warning naming it.
 */
function readRepairCache(
  path: string,
  root: FuturesRoot,
  date: string,
  pieces: readonly SessionPiece[],
): CachedDay | null {
  const again = `paging ${root} ${date} again`;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(
      `  WARNING: cache file ${path} cannot be read (${String(err)}): ${again}`,
    );
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(
      `  WARNING: cache file ${path} is corrupt (${String(err)}): ${again}`,
    );
    return null;
  }
  const header = CacheHeaderSchema.safeParse(raw);
  if (header.success && header.data.version !== REPAIR_CACHE_VERSION) {
    return null;
  }
  const file = CacheFileSchema.safeParse(raw);
  if (!file.success) {
    const why = file.error.issues[0]?.message ?? 'wrong shape';
    console.error(
      `  WARNING: cache file ${path} is corrupt (${why}): ${again}`,
    );
    return null;
  }
  const c = file.data;
  if (c.root !== root || c.date !== date || !samePieces(c.pieces, pieces)) {
    return null;
  }
  return {
    minutes: new Map(c.minutes.map((m) => [m.minute.ts, m] as const)),
    malformed: c.malformed,
  };
}

/**
 * Saves a completed root-day, atomically (a temp file renamed over the
 * old). A cache is an optimisation, so a failure warns and the run goes on.
 */
function writeRepairCache(
  path: string,
  root: FuturesRoot,
  date: string,
  pieces: readonly SessionPiece[],
  day: CachedDay,
): void {
  const file: z.infer<typeof CacheFileSchema> = {
    version: REPAIR_CACHE_VERSION,
    root,
    date,
    pieces: pieces.map(({ contract, fromMs, toMs }) => ({
      contract,
      fromMs,
      toMs,
    })),
    malformed: day.malformed,
    minutes: [...day.minutes.values()],
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(file));
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    console.error(
      `  WARNING: could not write the cache ${path} (${String(err)}): ` +
        `${root} ${date} will be paged again next run`,
    );
  }
}

/** The run's backup file, created empty (never truncated) so its path exists. */
function openBackup(workDir: string, runId: string): string {
  mkdirSync(workDir, { recursive: true });
  const path = join(workDir, `front-month-repair-${runId}.jsonl`);
  writeFileSync(path, '', { flag: 'a' });
  return path;
}

/**
 * Appends, synchronously and before the caller's first write, one JSON line
 * for every row the plan changes: the stored row in full and what it
 * becomes (rewrite, tag), the stored row (delete), or the new bar (fill).
 * Undo is the reverse of each line. Throws when the file cannot be written.
 *
 * A `fill` line is the bar the run meant to insert, written before the
 * insert, which is ON CONFLICT DO NOTHING: another writer may have taken the
 * minute since. So a fill is undone only where the stored row still equals
 * `after` on ts, open, close and contract, never by deleting on (symbol, ts)
 * alone. The `id` column is not recorded.
 */
function appendBackup(
  path: string,
  runId: string,
  root: FuturesRoot,
  plan: RepairPlan,
): void {
  const line = (action: string, row?: StoredFuturesBar, after?: unknown) =>
    `${JSON.stringify({ runId, action, symbol: root, row, after })}\n`;
  const lines = [
    ...plan.rewrites.map((r) => line('rewrite', r.old, r.bar)),
    ...plan.deletes.map((d) => line('delete', d)),
    ...plan.tags.map((t) => line('tag', t.old, { contract: t.contract })),
    ...plan.fills.map((f) => line('fill', undefined, f)),
  ];
  if (lines.length > 0) appendFileSync(path, lines.join(''));
}

// ── Repair: one root-day ────────────────────────────────────

interface RepairCounts {
  keep: number;
  /** Of `keep`: tagged with a contract other than the scheduled one. */
  keepOtherTag: number;
  keepTag: number;
  rewrite: number;
  delete: number;
  fill: number;
  held: number;
  unjudged: number;
  unbuildable: number;
}

/** Rows a write run changed. Fewer than planned: changed since the read. */
interface AppliedCounts {
  rewrite: number;
  delete: number;
  tag: number;
  fill: number;
}

interface RepairRootDayResult {
  stored: number;
  counts: RepairCounts;
  /** Null in a dry run. */
  applied: AppliedCounts | null;
  pages: number;
  malformed: number;
  fromCache: boolean;
  /** Pieces to page, and not one counted print came back. */
  noPrints: boolean;
  leaders: string[];
  unstorable: string[];
  /** The first few rewrites and deletes, ready to print. */
  samples: string[];
}

interface RepairRun {
  dryRun: boolean;
  noCache: boolean;
  workDir: string;
  runId: string;
  /** The backup file; null in a dry run. */
  backupPath: string | null;
}

function priceLine(p: PriceFields<number | string>): string {
  const px = (v: number | string) => roundTo4dp(String(v));
  return `o${px(p.open)} h${px(p.high)} l${px(p.low)} c${px(p.close)}`;
}

function sampleLines(
  plan: RepairPlan,
  pieces: readonly SessionPiece[],
): string[] {
  const at = (iso: string) => `${iso.slice(11, 19)}Z`;
  const lines: string[] = [];
  for (const { old, bar } of plan.rewrites.slice(0, MAX_SAMPLES_SHOWN)) {
    lines.push(
      `    rewrite ${at(old.ts)} ${bar.contract ?? '-'}  ` +
        `stored ${priceLine(old)}  rebuilt ${priceLine(bar)}`,
    );
  }
  for (const old of plan.deletes.slice(0, MAX_SAMPLES_SHOWN)) {
    const scheduled = pieceAt(pieces, old.ts)?.contract ?? '-';
    lines.push(
      `    delete ${at(old.ts)} ${scheduled}  ` +
        `stored ${priceLine(old)}  no counted print`,
    );
  }
  return lines;
}

/**
 * Applies a plan, one guarded batched statement per kind, rewrites first
 * and fills last. A rejected statement throws and the later ones do not run;
 * a re-run converges, since each is idempotent and re-reads the day.
 */
async function applyPlan(
  root: FuturesRoot,
  plan: RepairPlan,
): Promise<AppliedCounts> {
  const guard = (b: StoredFuturesBar) => ({
    ts: b.ts,
    wasOpen: b.open,
    wasClose: b.close,
  });
  const rewrote = await updateFuturesBars(
    root,
    plan.rewrites.map(({ old, bar }) => ({ ...bar, ...guard(old) })),
  );
  const deleted = await deleteFuturesBars(root, plan.deletes.map(guard));
  const tagged = await tagFuturesBars(
    root,
    plan.tags.map(({ old, contract }) => ({ ...guard(old), contract })),
  );
  const filled = await insertFuturesBars(root, plan.fills);
  return {
    rewrite: rewrote.length,
    delete: deleted.length,
    tag: tagged.length,
    fill: filled,
  };
}

async function repairRootDay(
  apiKey: string,
  schedules: ScheduleReader,
  root: FuturesRoot,
  date: string,
  run: RepairRun,
): Promise<RepairRootDayResult> {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const dayEndMs = dayStartMs + DAY_MS;
  const stored = await fetchFuturesBars(
    root,
    new Date(dayStartMs).toISOString(),
    new Date(dayEndMs).toISOString(),
  );

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
    // The repair reads the stored front months and never decides one, and a
    // bar on a date with none cannot be judged: the root-day fails, and
    // nothing is paged or written for it.
    if (undecided.length > 0) {
      throw new Error(
        `${root}: no stored front month for ${undecided.join(', ')}; ` +
          `run scripts/backfill-futures-front-month.ts`,
      );
    }
    const cachePath = join(run.workDir, CACHE_DIR, `${root}-${date}.json`);
    const cached =
      run.noCache || pieces.length === 0
        ? null
        : readRepairCache(cachePath, root, date, pieces);
    const day: CachedDay = cached ?? {
      minutes: await pageDayContracts(apiKey, pieces, tally),
      malformed: tally.malformed,
    };
    // A day is saved only when every piece was paged back to its start
    // (`exhausted` 0) and no minute was withheld: a hit then stands in for
    // paging, and the stop signals need not be stored. pageDayContracts
    // throws on the page guard, so a budget-stopped day never gets here.
    // A day with no counted print is not saved either: a hole in UW's
    // history may be filled later.
    if (
      cached === null &&
      tally.exhausted === 0 &&
      tally.withheld === 0 &&
      day.minutes.size > 0
    ) {
      writeRepairCache(cachePath, root, date, pieces, day);
    }

    const noPrints = pieces.length > 0 && day.minutes.size === 0;
    // A minute with no rebuilt bar is a gap only if the day was rebuilt in
    // full. A piece that ran out of UW history (exhausted), a minute
    // withheld as untrustworthy (a malformed print, a burst of one
    // microsecond's prints) and a day with no print at all (a hole in UW's
    // history) each leave minutes missing that were not quiet: none of them
    // may delete a stored bar.
    const plan = planRepair({
      root,
      stored,
      minutes: day.minutes,
      pieces,
      holdDeletes:
        noPrints ||
        day.malformed > 0 ||
        tally.exhausted > 0 ||
        tally.withheld > 0,
    });

    let applied: AppliedCounts | null = null;
    if (!run.dryRun) {
      if (run.backupPath !== null) {
        appendBackup(run.backupPath, run.runId, root, plan);
      }
      applied = await applyPlan(root, plan);
    }
    return {
      stored: stored.length,
      counts: {
        keep: plan.keep,
        keepOtherTag: plan.keepOtherTag,
        keepTag: plan.tags.length,
        rewrite: plan.rewrites.length,
        delete: plan.deletes.length,
        fill: plan.fills.length,
        held: plan.held,
        unjudged: plan.unjudged,
        unbuildable: plan.unbuildable,
      },
      applied,
      pages: tally.pages,
      malformed: day.malformed,
      fromCache: cached !== null,
      noPrints,
      leaders: [...new Set(pieces.map((p) => p.contract))],
      unstorable: plan.unstorable,
      samples: sampleLines(plan, pieces),
    };
  } catch (err) {
    throw new RootDayError(err, tally.pages);
  }
}

// ── Run ─────────────────────────────────────────────────────

interface RootTotals {
  stored: number;
  counts: RepairCounts;
}

/** The root-day's line: every count, then where its prints came from. */
function repairLine(
  root: FuturesRoot,
  date: string,
  res: RepairRootDayResult,
): string {
  const c = res.counts;
  const source = res.fromCache ? 'from cache' : `pages ${res.pages}`;
  let line =
    `  ${root} ${date}  stored ${res.stored}  keep ${c.keep}  ` +
    `keep+tag ${c.keepTag}  rewrite ${c.rewrite}  delete ${c.delete}  ` +
    `fill ${c.fill}  held ${c.held}  unjudged ${c.unjudged}  ` +
    `unbuildable ${c.unbuildable}  keep-other-tag ${c.keepOtherTag}  ` +
    `malformed ${res.malformed}  ${source}  ` +
    `front ${res.leaders.join('/') || '-'}`;
  const a = res.applied;
  if (a !== null) {
    line +=
      `  wrote rewrite ${a.rewrite}  delete ${a.delete}  tag ${a.tag}  ` +
      `fill ${a.fill}`;
    // A guarded write that matched no row: the stored bar changed since the
    // read, or was already fixed. The next run's plan shows what is left.
    const missed =
      c.rewrite -
      a.rewrite +
      (c.delete - a.delete) +
      (c.keepTag - a.tag) +
      (c.fill - a.fill);
    if (missed > 0) line += `  changed since read ${missed}`;
  }
  // A hole in UW's history shows here, not as a clean empty day.
  if (res.noPrints) line += '  prints 0';
  return line;
}

/**
 * `--repair`, after the market-hours guard: reads each root-day, pages (or
 * loads) the scheduled contracts' prints, plans (`planRepair`) and, in a
 * write run, backs up and applies. It reads the front-month table and never
 * decides a date.
 */
export async function runRepair(
  opts: BarBackfillOptions & { apiKey: string },
): Promise<number> {
  if (!opts.repair) {
    throw new Error(
      'runRepair needs --repair; other modes run through runBarBackfill',
    );
  }
  if (refuseDuringMarketHours()) return 1;

  const lastDay = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const plan = planDates(opts, lastDay);
  const runId = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');

  // Every path the run opens or prints is absolute, so the backup and the
  // cache are found again whatever directory a later run starts from.
  const workDir = resolve(opts.workDir);

  // The backup file comes first: a run that cannot record what it changes
  // changes nothing.
  let backupPath: string | null = null;
  if (!opts.dryRun) {
    try {
      backupPath = openBackup(workDir, runId);
    } catch (err) {
      console.error(
        `Cannot create the backup file in ${workDir}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Nothing was read or written.`,
      );
      return 1;
    }
  }
  const label = opts.dryRun ? ' (REPAIR, DRY RUN: no writes)' : ' (REPAIR)';
  console.log(
    `Futures bar backfill from REST prints${label}: ` +
      `${plan.length} dates, ${plan[0]?.date ?? '-'} → ${plan.at(-1)?.date ?? '-'}, ` +
      `roots ${opts.roots.join(',')}, page budget ${opts.maxPages}`,
  );
  if (backupPath !== null) {
    console.log(
      `Backup of every row this run rewrites, deletes or tags, and every ` +
        `fill: ${backupPath}`,
    );
  }

  const run: RepairRun = {
    dryRun: opts.dryRun,
    noCache: opts.noCache,
    workDir,
    runId,
    backupPath,
  };
  const byRoot = new Map<FuturesRoot, RootTotals>();
  const planned = { rewrite: 0, delete: 0, tag: 0, fill: 0 };
  const applied = { rewrite: 0, delete: 0, tag: 0, fill: 0 };
  const source = { cache: 0, paged: 0 };

  // Reads the stored decisions only: the repair never decides a trade date.
  const schedules = createScheduleReader(opts.apiKey, { decide: false });
  const loop = await runPlannedDays(
    plan,
    opts.maxPages,
    (root, date) => repairRootDay(opts.apiKey, schedules, root, date, run),
    (root, date, res) => {
      const c = res.counts;
      const total = byRoot.get(root) ?? {
        stored: 0,
        counts: {
          keep: 0,
          keepOtherTag: 0,
          keepTag: 0,
          rewrite: 0,
          delete: 0,
          fill: 0,
          held: 0,
          unjudged: 0,
          unbuildable: 0,
        },
      };
      total.stored += res.stored;
      for (const k of Object.keys(c) as Array<keyof RepairCounts>) {
        total.counts[k] += c[k];
      }
      byRoot.set(root, total);
      planned.rewrite += c.rewrite;
      planned.delete += c.delete;
      planned.tag += c.keepTag;
      planned.fill += c.fill;
      if (res.applied !== null) {
        applied.rewrite += res.applied.rewrite;
        applied.delete += res.applied.delete;
        applied.tag += res.applied.tag;
        applied.fill += res.applied.fill;
      }
      if (res.fromCache) source.cache += 1;
      else source.paged += 1;

      console.log(repairLine(root, date, res));
      for (const s of res.samples) console.log(s);
      if (res.unstorable.length > 0) {
        console.error(
          `  ${root} ${date}  WARNING: scheduled contract ` +
            `${res.unstorable.join(', ')} is not an outright of ${root}: ` +
            `it is never tagged, and a rewrite or fill stores a NULL contract`,
        );
      }
    },
  );

  const left = { held: 0, unjudged: 0, unbuildable: 0, keepOtherTag: 0 };
  for (const root of opts.roots) {
    const total = byRoot.get(root);
    if (total === undefined) continue;
    const c = total.counts;
    left.held += c.held;
    left.unjudged += c.unjudged;
    left.unbuildable += c.unbuildable;
    left.keepOtherTag += c.keepOtherTag;
    let line =
      `  ${root}  stored ${total.stored}  keep ${c.keep}  ` +
      `keep+tag ${c.keepTag}  rewrite ${c.rewrite}  delete ${c.delete}  ` +
      `fill ${c.fill}`;
    if (c.held > 0) line += `  held ${c.held}`;
    if (c.unjudged > 0) line += `  unjudged ${c.unjudged}`;
    if (c.unbuildable > 0) line += `  unbuildable ${c.unbuildable}`;
    if (c.keepOtherTag > 0) line += `  keep-other-tag ${c.keepOtherTag}`;
    console.log(line);
  }
  // The Done line carries every total a clean second dry run is judged on:
  // a delete held back, a bar left unjudged (and so untagged) or a
  // wrong-contract bar kept all read as zero deletes and zero rewrites.
  const sum = (n: typeof planned) => n.rewrite + n.delete + n.tag + n.fill;
  const done = [
    opts.dryRun
      ? `would rewrite ${planned.rewrite}, delete ${planned.delete}, ` +
        `tag ${planned.tag}, fill ${planned.fill}`
      : `rewrote ${applied.rewrite}, deleted ${applied.delete}, ` +
        `tagged ${applied.tag}, filled ${applied.fill}`,
  ];
  if (!opts.dryRun) {
    done.push(
      `planned ${sum(planned)}, applied ${sum(applied)} ` +
        `(changed since read ${sum(planned) - sum(applied)})`,
    );
  }
  done.push(
    `held ${left.held}, unjudged ${left.unjudged}, ` +
      `unbuildable ${left.unbuildable}, keep-other-tag ${left.keepOtherTag}`,
    `${source.cache} root-days from the cache, ${source.paged} paged`,
    `${loop.pages} pages, ${loop.failures} failed root-days.`,
  );
  console.log(`\nDone: ${done.join('; ')}`);
  if (backupPath !== null) console.log(`Backup: ${backupPath}`);
  reportIncomplete(opts, plan, loop);
  // Dates the loop never reached are as unfinished as failed root-days.
  return loop.failures > 0 || loop.stoppedBefore !== null ? 1 : 0;
}
