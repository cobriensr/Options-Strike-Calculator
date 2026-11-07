/**
 * Front-month contract selection for the UW futures crons, and the rule
 * that decides which contract each `futures_bars` minute is built from.
 *
 * `futures_bars` rows are keyed by root ('ES'). Since migration #203 a bar
 * also carries the dated outright it came from (`contract`, NULL in all
 * older history). The REST crons that read per-contract data
 * (`backfill-futures-gaps` for candles, `fetch-futures-session-stats` for
 * settlement and open interest) first need that root's active contracts.
 * Both select them here, the same way:
 *
 *   1. `GET /futures/contracts?days=5`, once per run: every active CME
 *      contract, volume summed over the last 5 sessions.
 *   2. Per root, keep rows whose `product` EQUALS the root (`q=ES` would
 *      also match MES and EST), drop spreads (a spread sym is its own
 *      symbol and can outtrade an outright), and take the top
 *      FRONT_MONTH_CANDIDATES by volume.
 *
 * Two rules for the contract of a minute live here:
 *
 *   - `replayFrontMonth`, the old one: the leader of the UTC-day volume
 *     tally, with no memory. It can step back and forth around a roll.
 *     Superseded.
 *   - `replayRollForward`, the one Phase 6 of
 *     `docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md`
 *     moves every writer to: each root has one front that only ever rolls
 *     forward, and a later contract takes over only after leading the
 *     tally for `ROLL_GUARD_CLOSES` consecutive minute closes.
 *     `parseContract`, `compareExpiry` and `nullSeedContract` give it the
 *     expiry order and the cold-start seed, and `canonicalContract` the one
 *     name a contract has everywhere.
 *
 * The uw-stream handler will carry a Python copy of the new rule (Task
 * 6d). Both copies are to run the cases in
 * `api/__tests__/fixtures/futures-roll-cases.json`, so they can't drift
 * apart.
 */

import { uwFetch, withRetry } from './api-helpers.js';

/**
 * Mirrors `_TARGET_PRODUCTS` in the uw-stream futures_trades handler.
 * DX (ICE) and VX (Cboe CFE) have no UW source.
 */
export const FUTURES_ROOTS = ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'] as const;

export type FuturesRoot = (typeof FUTURES_ROOTS)[number];

/** Front + next month: the pair a roll moves between. */
const FRONT_MONTH_CANDIDATES = 2;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Every active contract, volume-ranked over 5 sessions (~365 rows, all
 * roots in one call). Throws on an upstream error or a non-array payload,
 * so a caller never selects from a list it didn't get.
 */
export async function fetchFuturesContracts(
  apiKey: string,
): Promise<unknown[]> {
  const contracts: unknown = await withRetry(() =>
    uwFetch<unknown>(apiKey, '/futures/contracts?days=5'),
  );
  if (!Array.isArray(contracts)) {
    throw new Error('UW /futures/contracts returned a non-array payload');
  }
  return contracts;
}

/**
 * Top candidates for a root, most active first (volume, then name). An
 * empty result means UW lists no outright for the root.
 */
export function frontMonthCandidates(
  contracts: unknown[],
  root: string,
): string[] {
  const rows: Array<{ name: string; volume: number }> = [];
  for (const c of contracts) {
    if (!isRecord(c) || c.product !== root || c.is_spread === true) continue;
    if (typeof c.name !== 'string' || c.name === '') continue;
    rows.push({
      name: c.name,
      volume: typeof c.volume === 'number' ? c.volume : 0,
    });
  }
  // Codepoint order on ties, like the uw-stream front-month rule (names are
  // unique).
  rows.sort((a, b) => b.volume - a.volume || (a.name < b.name ? 1 : -1));
  return rows.slice(0, FRONT_MONTH_CANDIDATES).map((r) => r.name);
}

/** One contract's activity in one minute. `ts` is an ISO minute in UTC. */
export interface ContractMinute {
  ts: string;
  volume: number;
}

/**
 * Superseded by `replayRollForward`: this rule has no memory, so it can
 * step back and forth between months around a roll. Task 6c moves the gap
 * cron's two calls to the new rule and Task 6e moves the two history
 * scripts; 6e deletes this function.
 *
 * Replays the uw-stream front-month rule over per-contract minute rows
 * (candles in `backfill-futures-gaps`, trade-derived minutes in the order
 * flow repair): per minute, add every contract's volume to a UTC-day tally
 * (reset at each new UTC date), then emit the tally leader's row for that
 * minute if it has one. A minute where the leader has no row is left out,
 * never filled from another month, which trades at a carry basis. Ties go
 * to the larger contract symbol, matching Python's
 * `max(tally.items(), key=lambda kv: (kv[1], kv[0]))`.
 *
 * `ts` must be the `toISOString()` form: equal-length UTC strings sort
 * chronologically and their first 10 characters are the UTC date.
 */
export function replayFrontMonth<T extends ContractMinute>(
  byContract: ReadonlyMap<string, readonly T[]>,
): Array<{ contract: string; row: T }> {
  const byMinute = new Map<string, Map<string, T>>();
  for (const [contract, rows] of byContract) {
    for (const row of rows) {
      const minute = byMinute.get(row.ts) ?? new Map<string, T>();
      minute.set(contract, row);
      byMinute.set(row.ts, minute);
    }
  }

  const out: Array<{ contract: string; row: T }> = [];
  const tally = new Map<string, number>();
  let day = '';
  for (const ts of [...byMinute.keys()].sort()) {
    const minute = byMinute.get(ts)!;
    if (ts.slice(0, 10) !== day) {
      day = ts.slice(0, 10);
      tally.clear();
    }
    for (const [contract, row] of minute) {
      tally.set(contract, (tally.get(contract) ?? 0) + row.volume);
    }
    let leader = '';
    let leaderVolume = -1;
    for (const [contract, volume] of tally) {
      if (
        volume > leaderVolume ||
        (volume === leaderVolume && contract > leader)
      ) {
        leader = contract;
        leaderVolume = volume;
      }
    }
    const row = minute.get(leader);
    if (row) out.push({ contract: leader, row });
  }
  return out;
}

// ── Roll forward only ─────────────────────────────────────

/**
 * Consecutive wall-clock minute closes a later contract must lead the
 * UTC-day tally before it becomes the front, the same for every root.
 * Replayed on 64 ES and 64 NQ rolls plus 278,112 simulated restarts, 60 is
 * the smallest N with no early step on ES and NQ, but thinned RTY/CL-like
 * proxies still let 0 to 2 through after a restart; 120 lets none through
 * (an early step can't be undone, a late one stays on a liquid old front).
 * Report: `docs/tmp/es-contract-month-2026-11-06/h-roll-tuning.md` (main
 * checkout).
 */
export const ROLL_GUARD_CLOSES = 120;

/**
 * How far back a seed lookup reads for the root's newest tagged bar. The
 * gap cron (Task 6c) and the uw-stream handler (Task 6d) bound their seed
 * query with it, on the existing `(symbol, ts DESC)` index.
 */
export const SEED_LOOKBACK_DAYS = 7;

/** CME month codes, January to December. */
export const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Contract months each root's front month moves through, in calendar
 * order: quarterly for the equity indexes and ZN, every month for CL, the
 * even months for GC (its odd months never lead). Task 6e makes
 * `scripts/_lib/futures-flow-backfill.ts` import this and `MONTH_CODES`
 * instead of keeping its own copies.
 */
export const CONTRACT_CYCLE: Readonly<Record<FuturesRoot, string>> = {
  ES: 'HMUZ',
  NQ: 'HMUZ',
  RTY: 'HMUZ',
  ZN: 'HMUZ',
  CL: MONTH_CODES,
  GC: 'GJMQVZ',
};

/**
 * Months before its contract month that a root stops trading. CL stops in
 * the month before (CLZ6 stops in November); the rest trade through it.
 */
const MONTHS_STOPPED_EARLY: Readonly<Record<FuturesRoot, number>> = {
  ES: 0,
  NQ: 0,
  RTY: 0,
  CL: 1,
  GC: 0,
  ZN: 0,
};

/** A one-digit year resolves to the one year in [ref - 1, ref + 8]. */
const YEARS_BEFORE_REF = 1;

/**
 * Root + one month code + one or two ASCII digits: the uw-stream handler's
 * `_OUTRIGHT_SYM` fullmatch and the CHECK on `futures_bars.contract`.
 * Anchored on both ends; without the `m` flag `$` matches only at the very
 * end, so a trailing newline fails (unlike Python's `$`).
 */
const OUTRIGHT_SYM = Object.fromEntries(
  FUTURES_ROOTS.map((root) => [
    root,
    new RegExp(`^${root}[${MONTH_CODES}][0-9]{1,2}$`),
  ]),
) as Record<FuturesRoot, RegExp>;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A contract's expiry order: calendar month (1 to 12) and year. */
export interface ParsedContract {
  month: number;
  year: number;
}

function utcDate(iso: string): Date {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid reference time: ${iso}`);
  return new Date(ms);
}

function isOutright(root: FuturesRoot, sym: string): boolean {
  return OUTRIGHT_SYM[root].test(sym);
}

/** `sym` must already pass `isOutright`. */
function decodeContract(
  root: FuturesRoot,
  sym: string,
  refYear: number,
): ParsedContract {
  const month = MONTH_CODES.indexOf(sym.charAt(root.length)) + 1;
  const digits = sym.slice(root.length + 1);
  const value = Number.parseInt(digits, 10);
  if (digits.length === 2) return { month, year: 2000 + value };
  const first = refYear - YEARS_BEFORE_REF;
  return { month, year: first + ((value - (first % 10) + 10) % 10) };
}

function formatContract(root: FuturesRoot, { month, year }: ParsedContract) {
  return `${root}${MONTH_CODES.charAt(month - 1)}${year % 10}`;
}

/**
 * The expiry order of a dated outright, or null unless `sym` is exactly
 * `root` + one CME month code + one or two ASCII digits (so no spread, no
 * other root, no lowercase, no trailing newline).
 *
 * A two-digit year is 20YY. A one-digit year is the one year in
 * [ref - 1, ref + 8] that ends in that digit, ref being the UTC year of
 * `refIso`: at ref 2026, `Z6` is 2026, `H7` is 2027, `H0` is 2030 and `Z5`
 * is 2025. Throws if `refIso` does not parse.
 */
export function parseContract(
  root: FuturesRoot,
  sym: string,
  refIso: string,
): ParsedContract | null {
  const refYear = utcDate(refIso).getUTCFullYear();
  return isOutright(root, sym) ? decodeContract(root, sym, refYear) : null;
}

/** `sym` must already pass `isOutright`: root + month code + last digit. */
function canonicalName(root: FuturesRoot, sym: string): string {
  return sym.slice(0, root.length + 1) + sym.slice(-1);
}

/**
 * The one name a contract has everywhere (stored `contract` values, seeds,
 * the tally): the one-digit form, `${root}${code}${year % 10}`, so `ESZ26`
 * is `ESZ6`. Null where `parseContract` is null, and it throws on a bad
 * `refIso` the same way; the name itself does not depend on `refIso`.
 * A two-digit year folds to its last digit even when it lies outside the
 * one-digit window, so spellings a decade apart are not told apart.
 */
export function canonicalContract(
  root: FuturesRoot,
  sym: string,
  refIso: string,
): string | null {
  return parseContract(root, sym, refIso) == null
    ? null
    : canonicalName(root, sym);
}

/** Orders two contracts by (year, month): negative when `a` expires first. */
export function compareExpiry(a: ParsedContract, b: ParsedContract): number {
  return a.year - b.year || a.month - b.month;
}

/**
 * The first contract in the root's cycle whose last-trade month isn't
 * before `ref`'s UTC month. One always exists within a year, so the loop
 * ends without a fallback.
 */
function firstLiveContract(root: FuturesRoot, ref: Date): ParsedContract {
  const refIndex = ref.getUTCFullYear() * 12 + ref.getUTCMonth();
  const early = MONTHS_STOPPED_EARLY[root];
  for (let year = ref.getUTCFullYear(); ; year++) {
    for (const code of CONTRACT_CYCLE[root]) {
      const month = MONTH_CODES.indexOf(code) + 1;
      if (year * 12 + month - 1 - early >= refIndex) return { month, year };
    }
  }
}

/**
 * The seed when no tagged bar is found: the first contract in the root's
 * `CONTRACT_CYCLE` whose last-trade month is not before the UTC month of
 * `refIso`, in the one-digit form (`ESZ6`). ES on 2026-12-20 is still
 * `ESZ6`: it has expired, and the rule moves on from there, late.
 *
 * Why the cycle and not the earliest contract seen printing: the live
 * handler has no candidate list at a cold start, and the session's first
 * print can be a back month. A seed that is too early can only make the
 * roll late. One that is too late can never come back.
 */
export function nullSeedContract(root: FuturesRoot, refIso: string): string {
  return formatContract(root, firstLiveContract(root, utcDate(refIso)));
}

interface Contender {
  contract: string;
  expiry: ParsedContract;
}

/**
 * A challenger that is leading the tally. `matures` is the minute of its
 * first bar as the front, or null when its `ROLL_GUARD_CLOSES` closes would
 * cross 00:00 UTC (the streak then dies at the reset).
 */
interface Streak {
  challenger: Contender;
  matures: number | null;
}

function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function maturityOf(startMs: number): number | null {
  const lastClose = startMs + (ROLL_GUARD_CLOSES - 1) * MINUTE_MS;
  return dayOf(lastClose) === dayOf(startMs) ? lastClose + MINUTE_MS : null;
}

/** One key's row at one minute, with the canonical name of its contract. */
interface Spelled<T> {
  name: string;
  row: T;
}

/**
 * One minute's rows by canonical name. Spellings of one contract sum their
 * volumes; the row kept is the larger volume's, a tie going to the
 * codepoint-smaller key, whatever the iteration order.
 */
function foldSpellings<T extends ContractMinute>(
  spelled: ReadonlyMap<string, Spelled<T>>,
): Map<string, { key: string; row: T; total: number }> {
  const byName = new Map<string, { key: string; row: T; total: number }>();
  for (const [key, { name, row }] of spelled) {
    const seen = byName.get(name);
    if (seen == null) {
      byName.set(name, { key, row, total: row.volume });
      continue;
    }
    seen.total += row.volume;
    if (
      row.volume > seen.row.volume ||
      (row.volume === seen.row.volume && key < seen.key)
    ) {
      seen.key = key;
      seen.row = row;
    }
  }
  return byName;
}

export interface RollForwardResult<T extends ContractMinute> {
  /** The front's row for each minute it has one, in time order. */
  rows: Array<{ contract: string; row: T }>;
  /** Each change of front: `ts` is the first minute on `contract`. */
  takeovers: Array<{ ts: string; contract: string }>;
  /**
   * The front for the minute after the last row, which Task 6c seeds the
   * next hole from. Null only when there is no seed and no row to date one.
   */
  front: string | null;
  /** Keys that are no outright of the root, sorted. Left out of the replay. */
  skipped: string[];
}

/**
 * The roll-forward-only rule over per-contract minute rows. One front per
 * root, starting at `seed` (null: `nullSeedContract` at the first minute).
 * Per minute m with rows, in time order:
 *
 *   1. A streak whose maturity time is at or before m makes its challenger
 *      the front from that time on, even if the time fell in a quiet gap.
 *   2. At the first minute of a new UTC day, the tally and the streak are
 *      cleared (after step 1, so a streak whose 120th close was 23:59
 *      still takes over at 00:00).
 *   3. The front's row for m is emitted, if it has one. A minute without
 *      one is left out, never filled from another month.
 *   4. m's volumes are added to the UTC-day tally.
 *   5. The close of m is evaluated. The challenger is the contract
 *      expiring after the front with the largest tally (a tie goes to the
 *      nearer expiry). It leads when its tally is strictly greater than
 *      the front's (0 if the front has none). A lead without a streak, or
 *      for another contract, starts a streak at m. No lead ends it.
 *
 * A streak matures after `ROLL_GUARD_CLOSES` consecutive wall-clock closes
 * m0 .. m0 + N - 1, so the bar at m0 + N is the first on the new contract.
 * The tally only changes on rows, so a lead holds through quiet minutes.
 * The closes must lie in m0's UTC day. An earlier-expiring contract never
 * becomes the front.
 *
 * At the end of the input a streak that has matured by the minute after
 * the last row is applied, and recorded as a takeover (its `ts` may then be
 * that next minute), so `front` is what the next minute would be on.
 *
 * Every key and the seed are first folded to their canonical one-digit name
 * (`canonicalContract`), and `takeovers`, `front` and each emitted
 * `contract` use it. If two keys fold into one contract (`ESZ6` and
 * `ESZ26`), their volumes sum in the tally, and the minute's emitted row is
 * the one with the larger volume (a tie goes to the codepoint-smaller key).
 * Otherwise a front fed under a second spelling would be tallied at 0 and
 * the next contract would take over early.
 *
 * Keys that are not an outright of `root` are left out and listed in
 * `skipped`. One-digit years resolve against the UTC year of the first
 * minute. Throws on a seed that is not an outright of `root` (it comes
 * from the CHECK'd column, so that is a bug) and on a row whose `ts` does
 * not parse. `ts` must be the `toISOString()` minute form.
 */
export function replayRollForward<T extends ContractMinute>(
  byContract: ReadonlyMap<string, readonly T[]>,
  { root, seed }: { root: FuturesRoot; seed: string | null },
): RollForwardResult<T> {
  if (seed != null && !isOutright(root, seed)) {
    throw new Error(
      `replayRollForward: seed ${JSON.stringify(seed)} is not an outright ${root} contract`,
    );
  }
  const seedName = seed == null ? null : canonicalName(root, seed);

  const skipped: string[] = [];
  const names = new Set<string>();
  const byMinute = new Map<number, Map<string, Spelled<T>>>();
  for (const [key, rows] of byContract) {
    if (!isOutright(root, key)) {
      skipped.push(key);
      continue;
    }
    const name = canonicalName(root, key);
    names.add(name);
    for (const row of rows) {
      const ms = Date.parse(row.ts);
      if (Number.isNaN(ms)) {
        throw new Error(
          `replayRollForward: ${key} row has an unparseable ts ${JSON.stringify(row.ts)}`,
        );
      }
      const minute = byMinute.get(ms) ?? new Map<string, Spelled<T>>();
      minute.set(key, { name, row });
      byMinute.set(ms, minute);
    }
  }
  skipped.sort();

  const minutes = [...byMinute].sort((a, b) => a[0] - b[0]);
  const firstMs = minutes[0]?.[0];
  if (firstMs == null) {
    return { rows: [], takeovers: [], front: seedName, skipped };
  }

  const refYear = new Date(firstMs).getUTCFullYear();
  const byExpiry: Contender[] = [...names]
    .map((contract) => ({
      contract,
      expiry: decodeContract(root, contract, refYear),
    }))
    .sort(
      (a, b) =>
        compareExpiry(a.expiry, b.expiry) || (a.contract < b.contract ? -1 : 1),
    );
  const cycleSeed = firstLiveContract(root, new Date(firstMs));

  const rows: Array<{ contract: string; row: T }> = [];
  const takeovers: Array<{ ts: string; contract: string }> = [];
  const tally = new Map<string, number>();
  // One object, so TypeScript doesn't narrow these across the closure below
  // the way it would plain `let`s.
  const state: { front: Contender; streak: Streak | null } = {
    front:
      seedName == null
        ? { contract: formatContract(root, cycleSeed), expiry: cycleSeed }
        : {
            contract: seedName,
            expiry: decodeContract(root, seedName, refYear),
          },
    streak: null,
  };

  const applyMatured = (byMs: number): void => {
    const { streak } = state;
    if (streak?.matures == null || streak.matures > byMs) return;
    takeovers.push({
      ts: new Date(streak.matures).toISOString(),
      contract: streak.challenger.contract,
    });
    state.front = streak.challenger;
    state.streak = null;
  };

  let day = dayOf(firstMs);
  let lastMs = firstMs;
  for (const [ms, spelled] of minutes) {
    lastMs = ms;
    applyMatured(ms);
    if (dayOf(ms) !== day) {
      day = dayOf(ms);
      tally.clear();
      state.streak = null;
    }

    const atMinute = foldSpellings(spelled);
    const frontRow = atMinute.get(state.front.contract)?.row;
    if (frontRow != null) {
      rows.push({ contract: state.front.contract, row: frontRow });
    }
    for (const [contract, { total }] of atMinute) {
      tally.set(contract, (tally.get(contract) ?? 0) + total);
    }

    // Ascending expiry, replacing only on a strictly larger tally: a tie
    // stays with the nearer expiry.
    let challenger: Contender | null = null;
    let challengerTally = 0;
    for (const candidate of byExpiry) {
      if (compareExpiry(candidate.expiry, state.front.expiry) <= 0) continue;
      const volume = tally.get(candidate.contract) ?? 0;
      if (challenger == null || volume > challengerTally) {
        challenger = candidate;
        challengerTally = volume;
      }
    }
    if (
      challenger != null &&
      challengerTally > (tally.get(state.front.contract) ?? 0)
    ) {
      if (state.streak?.challenger.contract !== challenger.contract) {
        state.streak = { challenger, matures: maturityOf(ms) };
      }
    } else {
      state.streak = null;
    }
  }
  applyMatured(lastMs + MINUTE_MS);

  return { rows, takeovers, front: state.front.contract, skipped };
}
