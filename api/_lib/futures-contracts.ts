/**
 * Front-month contract selection for the UW futures crons, and the rule
 * that decides which contract each `futures_bars` minute is built from.
 *
 * `futures_bars` rows are keyed by root ('ES'). Since migration #204 a bar
 * also carries the dated outright it came from (`contract`, NULL in all
 * older history). The REST cron that reads per-contract settlement and open
 * interest (`fetch-futures-session-stats`) first needs that root's active
 * contracts. It selects them here:
 *
 *   1. `GET /futures/contracts?days=5`, once per run: every active CME
 *      contract, volume summed over the last 5 sessions.
 *   2. Per root, keep rows whose `product` EQUALS the root (`q=ES` would
 *      also match MES and EST), drop spreads (a spread sym is its own
 *      symbol and can outtrade an outright), and take the top
 *      FRONT_MONTH_CANDIDATES by volume.
 *
 * The contract of a minute is one contract per root per CME trade date,
 * kept in `futures_front_month` (plan:
 * `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`):
 *
 *   - `cmeTradeDate` gives the trade date of a minute.
 *   - `decideFrontMonth` decides a date's contract once, from the previous
 *     decision and the previous date's per-contract volume. It only ever
 *     rolls forward. `api/_lib/futures-front-month.ts` reads those inputs
 *     and stores the answer.
 *   - `pickScheduledFront` builds each minute's bar from the contract its
 *     date was decided on, and from no other.
 *   - `parseContract`, `compareExpiry` and `nullSeedContract` give them
 *     the expiry order and the cold-start seed, and `canonicalContract`
 *     the one name a contract has everywhere.
 *
 * The uw-stream handler carries a Python copy of the per-session rule
 * (`uw-stream/src/futures_front_month.py`). Both copies run the
 * `cmeTradeDate` and `decideFrontMonth` lists of
 * `api/__tests__/fixtures/futures-roll-cases.json`, so the rule can't drift
 * apart. Its third list, `pickScheduledFront`, is TypeScript-only: the live
 * handler folds the spellings of a contract into one bar where this builder
 * picks the larger-volume spelling's row.
 */

import { getCTDateStr } from '../../src/utils/timezone.js';
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

// ── Contract names ────────────────────────────────────────

/** CME month codes, January to December. */
export const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Contract months each root's front month moves through, in calendar
 * order: quarterly for the equity indexes and ZN, every month for CL, the
 * even months for GC (its odd months never lead).
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
 * Root + one month code + one or two ASCII digits: uw-stream's
 * `OUTRIGHT_SYM` fullmatch (`futures_front_month.is_outright`, which the
 * handler uses) and the CHECK on `futures_bars.contract`.
 * Anchored on both ends; without the `m` flag `$` matches only at the very
 * end, so a trailing newline fails (unlike Python's `$`).
 */
const OUTRIGHT_SYM = Object.fromEntries(
  FUTURES_ROOTS.map((root) => [
    root,
    new RegExp(`^${root}[${MONTH_CODES}][0-9]{1,2}$`),
  ]),
) as Record<FuturesRoot, RegExp>;

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
function oneDigitName(root: FuturesRoot, sym: string): string {
  return sym.slice(0, root.length + 1) + sym.slice(-1);
}

/**
 * The one-digit name of `sym` if it names the same year as `sym` does, else
 * null: a two-digit year outside the window has no one-digit name.
 */
function canonicalName(
  root: FuturesRoot,
  sym: string,
  refYear: number,
): string | null {
  const name = oneDigitName(root, sym);
  const sameYear =
    decodeContract(root, sym, refYear).year ===
    decodeContract(root, name, refYear).year;
  return sameYear ? name : null;
}

/**
 * The one name a contract has everywhere (stored `contract` values, seeds,
 * the tally): the one-digit form, `${root}${code}${year % 10}`, so `ESZ26`
 * is `ESZ6`. Null where `parseContract` is null, or where the year is
 * outside the one-digit window [ref - 1, ref + 8]: one digit cannot name
 * that year without colliding with a nearer contract (at ref 2026, `CLZ36`
 * would fold onto `CLZ6`, and a minute where only it printed would be
 * emitted as a `CLZ6` bar ten years of carry away). `parseContract` still
 * reads such a symbol, as 2036. Throws on a bad `refIso`.
 */
export function canonicalContract(
  root: FuturesRoot,
  sym: string,
  refIso: string,
): string | null {
  return canonicalAt(root, sym, utcDate(refIso).getUTCFullYear());
}

/** `canonicalContract` against a year already read from the reference. */
function canonicalAt(
  root: FuturesRoot,
  sym: string,
  refYear: number,
): string | null {
  return isOutright(root, sym) ? canonicalName(root, sym, refYear) : null;
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

// ── The per-session rule ──────────────────────────────────

/** Seven hours: the 17:00 CT open of a session is 00:00 of its date. */
const TRADE_DATE_OFFSET_MS = 7 * 3_600_000;

/**
 * The CME trade date of an instant, `YYYY-MM-DD`: the America/Chicago
 * calendar date of `tsIso` + 7 hours. A session runs from 17:00 CT on the
 * evening before its trade date to 17:00 CT on it, so the instant that
 * opens a session (23:00Z in winter, 22:00Z in summer) is already on its
 * date. (Seven hours on from an instant and seven hours on from its
 * Chicago wall time are one date: the clocks change at 02:00 on a Sunday,
 * never in the seven hours before a Chicago midnight.) Throws on a `tsIso`
 * that does not parse.
 */
export function cmeTradeDate(tsIso: string): string {
  const ms = Date.parse(tsIso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${tsIso}`);
  return getCTDateStr(new Date(ms + TRADE_DATE_OFFSET_MS));
}

/** A contract's total volume, with its expiry to order by. */
interface Traded {
  name: string;
  expiry: ParsedContract;
  volume: number;
}

/** The most volume; a tie goes to the earlier expiry, whatever the order. */
function mostTraded(candidates: Iterable<Traded>): Traded | null {
  let best: Traded | null = null;
  for (const c of candidates) {
    if (
      best == null ||
      c.volume > best.volume ||
      (c.volume === best.volume && compareExpiry(c.expiry, best.expiry) < 0)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * The front month for trade date `tradeDate`, decided once from what the
 * previous date left behind. `incumbent` is the contract of the latest
 * earlier decision (null: none), `volumes` the per-contract volume of the
 * latest earlier date that has any. With C the contract that expires after
 * the incumbent and has the most volume (a tie goes to the earlier expiry):
 *
 *   - the front is C when C's volume is larger than the incumbent's (0 for a
 *     contract missing from `volumes`), else the incumbent: a tie keeps it;
 *   - with no incumbent, the contract with the most volume (a tie goes to
 *     the earlier expiry);
 *   - with no incumbent and no volume, `nullSeedContract` (a seed that is
 *     too early can only make the roll late).
 *
 * A contract expiring on or before the incumbent is never chosen, so the
 * series only moves forward, and a false lead can roll it one session
 * early at most.
 *
 * Every name, the incumbent's included, is first made canonical against
 * `tradeDate` (`ESZ26` is `ESZ6`; their volumes sum), and the answer is
 * canonical. A volume key that is not an outright of `root` (a spread,
 * another root, a two-digit year outside the window) is dropped. A bad
 * incumbent throws: it comes from a table only this rule writes, so
 * treating it as none would reseed over a corrupt row. Throws on a
 * `tradeDate` that does not parse.
 */
export function decideFrontMonth(
  incumbent: string | null,
  volumes: ReadonlyMap<string, number>,
  root: FuturesRoot,
  tradeDate: string,
): string {
  const refYear = utcDate(tradeDate).getUTCFullYear();
  const traded = new Map<string, Traded>();
  for (const [sym, volume] of volumes) {
    const name = canonicalAt(root, sym, refYear);
    if (name == null) continue;
    const seen = traded.get(name);
    if (seen == null) {
      const expiry = decodeContract(root, name, refYear);
      traded.set(name, { name, expiry, volume });
    } else {
      seen.volume += volume;
    }
  }

  if (incumbent == null) {
    return (
      mostTraded(traded.values())?.name ?? nullSeedContract(root, tradeDate)
    );
  }
  const held = canonicalAt(root, incumbent, refYear);
  if (held == null) {
    throw new Error(
      `decideFrontMonth: incumbent ${JSON.stringify(incumbent)} is not an outright ${root} contract on ${tradeDate}`,
    );
  }
  const heldExpiry = decodeContract(root, held, refYear);
  const challenger = mostTraded(
    [...traded.values()].filter((c) => compareExpiry(c.expiry, heldExpiry) > 0),
  );
  const heldVolume = traded.get(held)?.volume ?? 0;
  return challenger != null && challenger.volume > heldVolume
    ? challenger.name
    : held;
}

/** A trade date's scheduled contract, read once per call. */
interface Scheduled {
  root: FuturesRoot;
  refYear: number;
  contract: string;
  /** Canonical name of each key seen on this date (null: not an outright). */
  names: Map<string, string | null>;
}

/**
 * The scheduled contract of `tradeDate` as the root, year and canonical
 * name it implies; null when nothing is scheduled. Throws on a name that is
 * no outright of any root, so a bad schedule is not a quiet day.
 */
function readSchedule(
  tradeDate: string,
  sym: string | undefined,
): Scheduled | null {
  if (sym == null) return null;
  const root = FUTURES_ROOTS.find((r) => isOutright(r, sym));
  const refYear = utcDate(tradeDate).getUTCFullYear();
  const contract = root == null ? null : canonicalAt(root, sym, refYear);
  if (root == null || contract == null) {
    throw new Error(
      `pickScheduledFront: the contract scheduled for ${tradeDate}, ${JSON.stringify(sym)}, is not an outright of any root`,
    );
  }
  return { root, refYear, contract, names: new Map() };
}

/**
 * Builds each minute's bar from the contract its trade date was decided on
 * (`contractFor`, `undefined` for a date with none) and from no other: a
 * minute where that contract has no row is left out, never filled from
 * another month, which trades at a carry basis. Where two spellings of the
 * contract both have a row in a minute (`ESZ6` and `ESZ26`, from the REST
 * paths), the larger volume's row is the bar, a tie going to the key that
 * sorts first by code point. A key is the contract only when its canonical
 * name against the row's own trade date is the scheduled one, so a spread,
 * another root and a two-digit year outside the window never count.
 *
 * The root comes from the scheduled name, so one call serves one root.
 * Results are in time order. Throws on a `ts` that does not parse and on a
 * scheduled name that is no outright. Rows are the caller's objects.
 */
export function pickScheduledFront<T extends ContractMinute>(
  byContract: ReadonlyMap<string, readonly T[]>,
  contractFor: (tradeDate: string) => string | undefined,
): Array<{ contract: string; row: T }> {
  const schedules = new Map<string, Scheduled | null>();
  const picked = new Map<number, { contract: string; key: string; row: T }>();
  for (const [key, rows] of byContract) {
    for (const row of rows) {
      const tradeDate = cmeTradeDate(row.ts);
      if (!schedules.has(tradeDate)) {
        schedules.set(
          tradeDate,
          readSchedule(tradeDate, contractFor(tradeDate)),
        );
      }
      const day = schedules.get(tradeDate);
      if (day == null) continue;
      if (!day.names.has(key)) {
        day.names.set(key, canonicalAt(day.root, key, day.refYear));
      }
      if (day.names.get(key) !== day.contract) continue;

      const ms = Date.parse(row.ts);
      const kept = picked.get(ms);
      if (
        kept == null ||
        row.volume > kept.row.volume ||
        (row.volume === kept.row.volume && key < kept.key)
      ) {
        picked.set(ms, { contract: day.contract, key, row });
      }
    }
  }
  return [...picked]
    .sort(([a], [b]) => a - b)
    .map(([, { contract, row }]) => ({ contract, row }));
}
