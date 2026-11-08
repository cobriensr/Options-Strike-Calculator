/**
 * The per-session front-month store: one contract per root per CME trade
 * date, in `futures_front_month` (migration #205). Plan:
 * `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`.
 *
 * A trade date's row is written once, by whoever needs it first (the gap
 * cron, a script, or the uw-stream handler through its own copy of the
 * rule), and never updated. The writers race, so:
 *
 *   - the row is read first, and only a missing one is decided;
 *   - the decision (`decideFrontMonth`) reads the latest earlier decision
 *     and the latest earlier date's `futures_contract_volume` rows;
 *   - the insert is `ON CONFLICT DO NOTHING`, and the row is then read back,
 *     so a writer that lost the race returns the winner's contract.
 *
 * The series only moves forward, whatever order the dates are asked for in
 * (`ensureFrontMonth` itself keeps it so, not its callers):
 *
 *   - Fill forward: a date is decided from the latest earlier decision, so
 *     the sessions in between that have volume rows but no decision (a
 *     caller asking for one recent date) are decided first, oldest first.
 *     With no earlier decision there is nothing to fill from.
 *   - Ceiling: a date decided after a later one (an old gap, volume rows
 *     that landed late) is never later than the earliest decision after it.
 *
 * Renew, fail, expire: there is no lease and nothing to expire. A writer
 * that dies before its insert leaves nothing; one that dies mid-fill leaves
 * the decisions it wrote, each a valid one. The next writer decides the
 * rest again from the same inputs, or from newer volume rows if some
 * landed, and either answer is a valid one for a date nobody has decided.
 *
 * Accepted risk, a window of one round trip: the inputs are read in one
 * statement and the decision is inserted in another. A volume row that
 * lands in between, while a second caller decides a different date, can
 * leave a non-monotone pair, and the ceiling cannot help: it bounds a date
 * by the rows that exist when it is read, not by one inserted after. It
 * needs a late volume writer and two processes deciding two dates within
 * the same few tens of milliseconds, and the Python copy has the same
 * window. Closing it would take a conditional insert; it is left open.
 *
 * `insertContractVolumes` and `insertFrontMonthRows` are the bulk inserts
 * the history seed (Phase 3) uses. They write `source = 'candles'`.
 * `fetchStoredFrontMonths` is its read of the decisions already stored.
 *
 * The HTTP driver returns BIGINT as a string and DATE as a JS `Date`.
 * Volumes are read as `float8` (exact below 2^53) and dates are only ever
 * sent, or read as text.
 */

import { BULK_UPSERT_DEFAULT_CHUNK_SIZE } from './bulk-upsert.js';
import { getDb, withDbRetry } from './db.js';
import {
  canonicalContract,
  cmeTradeDate,
  compareExpiry,
  decideFrontMonth,
  parseContract,
  type FuturesRoot,
} from './futures-contracts.js';
import logger from './logger.js';
import { Sentry } from './sentry.js';

type Sql = ReturnType<typeof getDb>;

/** Who is deciding: the gap cron, or an operator script. */
type DeciderSource = 'cron' | 'script';

const RETRIES = 2;
const ATTEMPT_TIMEOUT_MS = 10_000;

const TRADE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Throws unless `tradeDate` is a real calendar date, `YYYY-MM-DD`. `caller`,
 * when given, starts the message: the function, and the argument if it has
 * more than one date.
 */
function assertTradeDate(tradeDate: string, caller?: string): void {
  const ms = TRADE_DATE.test(tradeDate)
    ? Date.parse(`${tradeDate}T00:00:00Z`)
    : Number.NaN;
  if (
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== tradeDate
  ) {
    const prefix = caller == null ? '' : `${caller}: `;
    throw new Error(
      `${prefix}Invalid trade date ${JSON.stringify(tradeDate)}: expected a calendar date as YYYY-MM-DD`,
    );
  }
}

/** The CME trade date of the clock now. */
function currentTradeDate(): string {
  return cmeTradeDate(new Date().toISOString());
}

/**
 * Throws on a malformed date and on one after the current trade date. A
 * date later than that has no volume to decide from, and a row written for
 * it would be an incumbent no real session produced.
 */
function assertDecidable(product: FuturesRoot, tradeDate: string): void {
  assertTradeDate(tradeDate);
  const current = currentTradeDate();
  if (tradeDate > current) {
    throw new Error(
      `${product} trade date ${tradeDate} is after the current trade date ${current}`,
    );
  }
}

/** The stored contract for one date, or null. */
async function readStored(
  sql: Sql,
  product: FuturesRoot,
  tradeDate: string,
): Promise<string | null> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT contract
      FROM futures_front_month
      WHERE product = ${product} AND trade_date = ${tradeDate}::date
    `,
    RETRIES,
    ATTEMPT_TIMEOUT_MS,
  )) as Array<{ contract: string }>;
  return rows[0]?.contract ?? null;
}

interface Inputs {
  incumbent: string | null;
  /**
   * The contract of the earliest decision after the date, the most the date
   * may take. Null: nothing is decided after it.
   */
  ceiling: string | null;
  volumes: Map<string, number>;
  /**
   * The sessions between the incumbent and the date that have volume rows
   * and so no decision, oldest first. Empty with no incumbent.
   */
  undecided: string[];
}

/**
 * What the decision for `tradeDate` starts from, in one round trip, as
 * four arms of one UNION ALL:
 *
 *   - `incumbent`: the contract of the latest decision before it;
 *   - `ceiling`: the contract of the earliest decision after it;
 *   - `volume`: every volume row of the latest earlier trade date that has
 *     any (a weekend or holiday has none);
 *   - `undecided`: the trade dates with volume rows after the incumbent's
 *     date and before this one. The incumbent is the latest decision before
 *     the date, so none of them has a decision row. With no incumbent the
 *     comparison is against NULL and the arm is empty: a cold start must not
 *     walk the whole volume history.
 */
async function readInputs(
  sql: Sql,
  product: FuturesRoot,
  tradeDate: string,
): Promise<Inputs> {
  const rows = (await withDbRetry(
    () => sql`
      (SELECT 'incumbent' AS kind, contract, NULL::float8 AS volume,
              NULL::text AS day
         FROM futures_front_month
        WHERE product = ${product} AND trade_date < ${tradeDate}::date
        ORDER BY trade_date DESC
        LIMIT 1)
      UNION ALL
      (SELECT 'ceiling', contract, NULL::float8, NULL::text
         FROM futures_front_month
        WHERE product = ${product} AND trade_date > ${tradeDate}::date
        ORDER BY trade_date
        LIMIT 1)
      UNION ALL
      SELECT 'volume', v.contract, v.volume::float8, NULL::text
        FROM futures_contract_volume v
       WHERE v.product = ${product}
         AND v.trade_date = (SELECT max(trade_date)
                               FROM futures_contract_volume
                              WHERE product = ${product}
                                AND trade_date < ${tradeDate}::date)
      UNION ALL
      SELECT DISTINCT 'undecided', NULL::text, NULL::float8,
             v.trade_date::text
        FROM futures_contract_volume v
       WHERE v.product = ${product}
         AND v.trade_date < ${tradeDate}::date
         AND v.trade_date > (SELECT max(trade_date)
                               FROM futures_front_month
                              WHERE product = ${product}
                                AND trade_date < ${tradeDate}::date)
    `,
    RETRIES,
    ATTEMPT_TIMEOUT_MS,
  )) as Array<{
    kind: string;
    contract: string | null;
    volume: number | string | null;
    day: string | null;
  }>;

  const inputs: Inputs = {
    incumbent: null,
    ceiling: null,
    volumes: new Map(),
    undecided: [],
  };
  for (const r of rows) {
    if (r.kind === 'incumbent') inputs.incumbent = r.contract;
    else if (r.kind === 'ceiling') inputs.ceiling = r.contract;
    else if (r.kind === 'volume' && r.contract != null) {
      inputs.volumes.set(r.contract, Number(r.volume));
    } else if (r.kind === 'undecided' && r.day != null) {
      inputs.undecided.push(r.day);
    }
  }
  // SELECT DISTINCT promises no order (the planner may hash instead of
  // sort), and the fill must run oldest first: keep this sort.
  inputs.undecided.sort();
  return inputs;
}

/**
 * `wanted`, unless it expires after `ceiling`, the contract of the
 * earliest decision stored after the date (null: none): then `ceiling` in
 * its canonical name, with `clamped` true. A decision is write-once, so a
 * date decided after a later one must not be later than it, or the series
 * would step back. Shared by `ensureFrontMonth` and the history seed, which
 * walks the same rule in memory. Throws on a ceiling that is no outright of
 * the product (a corrupt row; fail, don't guess).
 */
export function ceilingContract(
  product: FuturesRoot,
  tradeDate: string,
  wanted: string,
  ceiling: string | null,
): { contract: string; clamped: boolean } {
  if (ceiling == null) return { contract: wanted, clamped: false };
  const cap = canonicalContract(product, ceiling, tradeDate);
  const capExpiry = cap == null ? null : parseContract(product, cap, tradeDate);
  const wantedExpiry = parseContract(product, wanted, tradeDate);
  if (cap == null || capExpiry == null || wantedExpiry == null) {
    throw new Error(
      `${product} front month for ${tradeDate}: the next stored decision, ${JSON.stringify(ceiling)}, is not an outright ${product} contract`,
    );
  }
  return compareExpiry(wantedExpiry, capExpiry) <= 0
    ? { contract: wanted, clamped: false }
    : { contract: cap, clamped: true };
}

/**
 * `ceilingContract`, with a warning that names the incumbent too when it
 * clamps, so a clamp over rows that were already out of order (an incumbent
 * later than the ceiling) is visible. It still writes the ceiling and does
 * not throw.
 */
function capAtCeiling(
  product: FuturesRoot,
  tradeDate: string,
  wanted: string,
  ceiling: string | null,
  incumbent: string | null,
): string {
  const { contract, clamped } = ceilingContract(
    product,
    tradeDate,
    wanted,
    ceiling,
  );
  if (clamped) {
    const message =
      'Front-month decision is later than the next stored decision: using the next stored decision';
    logger.warn(
      { product, tradeDate, wanted, ceiling: contract, incumbent },
      message,
    );
    // Once the seed has run, a clamp means a late volume row or a date
    // decided out of order: a log line alone would go unseen.
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: { product, trade_date: tradeDate },
      extra: { wanted, ceiling: contract, incumbent },
    });
  }
  return contract;
}

/**
 * Decides one date from `inputs` and stores it: the cycle-seed warning,
 * `decideFrontMonth`, the ceiling, then the insert with ON CONFLICT DO
 * NOTHING and a read back, which returns the winner's contract if another
 * writer got there first.
 */
async function decideAndStore(
  sql: Sql,
  product: FuturesRoot,
  tradeDate: string,
  source: DeciderSource,
  inputs: Inputs,
): Promise<string> {
  const { incumbent, ceiling, volumes } = inputs;
  if (incumbent == null && volumes.size === 0) {
    const message =
      'No earlier front-month decision and no earlier volume: using the listing-cycle seed';
    logger.warn({ product, tradeDate }, message);
    // Once the seed has run, this means a root with no history.
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: { product, trade_date: tradeDate },
    });
  }
  const decided = capAtCeiling(
    product,
    tradeDate,
    decideFrontMonth(incumbent, volumes, product, tradeDate),
    ceiling,
    incumbent,
  );
  await withDbRetry(
    () => sql`
      INSERT INTO futures_front_month (product, trade_date, contract, source)
      VALUES (${product}, ${tradeDate}::date, ${decided}, ${source})
      ON CONFLICT (product, trade_date) DO NOTHING
    `,
    RETRIES,
    ATTEMPT_TIMEOUT_MS,
  );
  const winner = await readStored(sql, product, tradeDate);
  if (winner == null) {
    throw new Error(
      `${product} front month for ${tradeDate} is missing after its insert`,
    );
  }
  return winner;
}

/**
 * The contract for one root and trade date: the stored row when there is
 * one, else decided now by `decideFrontMonth` from the latest earlier
 * decision and volume, written with ON CONFLICT DO NOTHING and read back,
 * so every writer returns the same answer. Warns (a log line and a Sentry
 * warning tagged with the product and trade date), and uses the
 * listing-cycle seed, when there is no earlier decision and no volume at
 * all: a seed that is too early can only make the roll late.
 *
 * The series stays forward-only whatever order dates are asked for in. The
 * sessions after the latest earlier decision that have volume rows are
 * decided first, oldest first, each under `source` (one at a time: each
 * starts from the row just written, so there is no concurrency to bound,
 * and the fill is not capped here: the caller owns its time budget). A date
 * is never decided later than the earliest decision after it; when the
 * tally would, that decision is used and a warning is raised the same way.
 * A stored row costs one query, and a miss with nothing to fill or clamp
 * costs four.
 *
 * Throws on a malformed date and on one after the current trade date.
 * Database errors propagate (transient ones after `withDbRetry`'s retries).
 */
export async function ensureFrontMonth(
  product: FuturesRoot,
  tradeDate: string,
  source: DeciderSource,
): Promise<string> {
  assertDecidable(product, tradeDate);
  const sql = getDb();
  const stored = await readStored(sql, product, tradeDate);
  if (stored != null) return stored;

  const first = await readInputs(sql, product, tradeDate);
  for (const gapDate of first.undecided) {
    const gapInputs = await readInputs(sql, product, gapDate);
    await decideAndStore(sql, product, gapDate, source, gapInputs);
  }
  // The date's own incumbent is the last row filled.
  const inputs =
    first.undecided.length > 0
      ? await readInputs(sql, product, tradeDate)
      : first;
  return decideAndStore(sql, product, tradeDate, source, inputs);
}

/** A root's contract per trade date, for the dates a caller asked about. */
export interface FrontMonthSchedule {
  /** The contract for a date asked about; undefined for any other date. */
  contractFor(tradeDate: string): string | undefined;
  /** The distinct contracts, in order of the dates that first use them. */
  contracts: string[];
}

/**
 * `ensureFrontMonth` for each distinct date in `tradeDates`, oldest first,
 * as the schedule `pickScheduledFront` reads. The dates already decided
 * come back in one query. Callers pass only the trade dates their minutes
 * fall on, so a weekend gets no row (a session between two of them that
 * has volume rows is still decided, by `ensureFrontMonth`'s fill). Throws
 * before any query if a date is malformed or after the current trade date.
 */
export async function fetchFrontMonthSchedule(
  product: FuturesRoot,
  tradeDates: readonly string[],
  source: DeciderSource,
): Promise<FrontMonthSchedule> {
  const dates = [...new Set(tradeDates)].sort();
  for (const tradeDate of dates) assertDecidable(product, tradeDate);

  const byDate = new Map<string, string>();
  if (dates.length > 0) {
    const sql = getDb();
    const rows = (await withDbRetry(
      () => sql`
        SELECT trade_date::text AS trade_date, contract
        FROM futures_front_month
        WHERE product = ${product} AND trade_date = ANY(${dates}::date[])
      `,
      RETRIES,
      ATTEMPT_TIMEOUT_MS,
    )) as Array<{ trade_date: string; contract: string }>;
    for (const r of rows) byDate.set(r.trade_date, r.contract);
  }
  // Oldest first, one at a time: each decision starts from the one before,
  // so the fill has nothing to do for these dates.
  for (const tradeDate of dates) {
    if (!byDate.has(tradeDate)) {
      byDate.set(tradeDate, await ensureFrontMonth(product, tradeDate, source));
    }
  }

  const contracts = new Set<string>();
  for (const tradeDate of dates) {
    const contract = byDate.get(tradeDate);
    if (contract != null) contracts.add(contract);
  }
  return {
    contractFor: (tradeDate) => byDate.get(tradeDate),
    contracts: [...contracts],
  };
}

/**
 * The decisions stored for `product` from `fromDate` to `toDate`, both
 * included, as trade date (`YYYY-MM-DD`) → canonical contract, oldest first,
 * in one query. The history seed reads what is already decided before it
 * decides the rest. A date with no row is absent from the map. A stored name
 * is returned canonical (`ESZ26` as `ESZ6`), as `decideFrontMonth` reads its
 * incumbent; one that is no outright of the product throws, naming the date
 * and the name: the table is only written by this rule, so a bad row is
 * corrupt (fail, don't guess).
 *
 * Throws, before any query, on a date that is not a real calendar date and
 * on `fromDate` after `toDate`. `toDate` may be after the current trade
 * date: this only reads, and no row can be stored there. Database errors
 * propagate (transient ones after `withDbRetry`'s retries).
 */
export async function fetchStoredFrontMonths(
  product: FuturesRoot,
  fromDate: string,
  toDate: string,
): Promise<Map<string, string>> {
  assertTradeDate(fromDate, 'fetchStoredFrontMonths fromDate');
  assertTradeDate(toDate, 'fetchStoredFrontMonths toDate');
  if (fromDate > toDate) {
    throw new Error(
      `fetchStoredFrontMonths: ${product} fromDate ${fromDate} is after toDate ${toDate}`,
    );
  }

  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT trade_date::text AS trade_date, contract
      FROM futures_front_month
      WHERE product = ${product}
        AND trade_date BETWEEN ${fromDate}::date AND ${toDate}::date
      ORDER BY futures_front_month.trade_date
    `,
    RETRIES,
    ATTEMPT_TIMEOUT_MS,
  )) as Array<{ trade_date: string; contract: string }>;

  const stored = new Map<string, string>();
  for (const r of rows) {
    const contract = canonicalContract(product, r.contract, r.trade_date);
    if (contract == null) {
      throw new Error(
        `fetchStoredFrontMonths: ${product} front month stored for ${r.trade_date}, ${JSON.stringify(r.contract)}, is not an outright ${product} contract`,
      );
    }
    stored.set(r.trade_date, contract);
  }
  return stored;
}

/** Throws unless `contract` is `product`'s canonical name on `tradeDate`. */
function assertCanonical(
  caller: string,
  product: FuturesRoot,
  tradeDate: string,
  contract: string,
): void {
  assertTradeDate(tradeDate);
  if (canonicalContract(product, contract, tradeDate) !== contract) {
    throw new Error(
      `${caller}: expected a canonical ${product} contract on ${tradeDate} (such as ${product}Z6, never ${product}Z26), got ${JSON.stringify(contract)}`,
    );
  }
}

export interface ContractVolumeRow {
  product: FuturesRoot;
  tradeDate: string;
  /** The canonical name, such as `ESZ6`. */
  contract: string;
  /** Whole contracts traded in that session, 0 or more. */
  volume: number;
}

/**
 * Seeds `futures_contract_volume` from daily candles: batched `INSERT …
 * SELECT FROM unnest(…) ON CONFLICT DO NOTHING`, 500 rows a statement,
 * `source = 'candles'`. A row already stored (the live tally's included) is
 * never revised. Returns the rows this call inserted: a retry after an
 * attempt that timed out client-side but committed counts 0 for those rows.
 * Every row is checked first, so a bad one writes nothing: a non-canonical
 * contract (the caller folds `ESZ26` into `ESZ6` and sums), a volume that
 * is not a whole number of contracts, 0 or more, or a trade date that is
 * not before the current one (a session still running has only partial
 * volume, and the next date's decision reads it). Throws on a rejected
 * INSERT; batches already inserted stay.
 */
export async function insertContractVolumes(
  rows: ReadonlyArray<ContractVolumeRow>,
): Promise<number> {
  const current = currentTradeDate();
  for (const r of rows) {
    assertCanonical(
      'insertContractVolumes',
      r.product,
      r.tradeDate,
      r.contract,
    );
    if (r.tradeDate >= current) {
      throw new Error(
        `insertContractVolumes: trade date ${r.tradeDate} is not before the current trade date ${current}`,
      );
    }
    if (!Number.isSafeInteger(r.volume) || r.volume < 0) {
      throw new Error(
        `insertContractVolumes: volume of ${r.contract} on ${r.tradeDate} must be a whole number, 0 or more, got ${r.volume}`,
      );
    }
  }
  const sql = getDb();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BULK_UPSERT_DEFAULT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_UPSERT_DEFAULT_CHUNK_SIZE);
    const done = (await withDbRetry(
      () => sql`
        INSERT INTO futures_contract_volume
          (product, trade_date, contract, volume, source)
        SELECT t.product, t.trade_date, t.contract, t.volume, 'candles'
        FROM unnest(
          ${chunk.map((r) => r.product)}::text[],
          ${chunk.map((r) => r.tradeDate)}::date[],
          ${chunk.map((r) => r.contract)}::text[],
          ${chunk.map((r) => r.volume)}::bigint[]
        ) AS t(product, trade_date, contract, volume)
        ON CONFLICT (product, trade_date, contract) DO NOTHING
        RETURNING contract
      `,
      RETRIES,
      ATTEMPT_TIMEOUT_MS,
    )) as unknown[];
    inserted += done.length;
  }
  return inserted;
}

export interface FrontMonthRow {
  product: FuturesRoot;
  tradeDate: string;
  /** The canonical name, such as `ESZ6`. */
  contract: string;
}

/**
 * Seeds `futures_front_month` with decisions made elsewhere (the history
 * seed's replay of the rule over daily candles): batched `INSERT … SELECT
 * FROM unnest(…) ON CONFLICT DO NOTHING`, 500 rows a statement, `source =
 * 'candles'`. A date that already has a row keeps it. Returns the rows this
 * call inserted: a retry after an attempt that timed out client-side but
 * committed counts 0 for those rows. Every row is checked first, so a bad
 * one writes nothing: a non-canonical contract, or a trade date after the
 * current one (the current date is allowed: the seed writes the row of the
 * session that is running). A decision row is also the ceiling of every
 * earlier decision, so a stray future row would clamp them all down to it.
 * Throws on a rejected INSERT; batches already inserted stay.
 */
export async function insertFrontMonthRows(
  rows: ReadonlyArray<FrontMonthRow>,
): Promise<number> {
  const current = currentTradeDate();
  for (const r of rows) {
    assertCanonical('insertFrontMonthRows', r.product, r.tradeDate, r.contract);
    if (r.tradeDate > current) {
      throw new Error(
        `insertFrontMonthRows: trade date ${r.tradeDate} is after the current trade date ${current}`,
      );
    }
  }
  const sql = getDb();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BULK_UPSERT_DEFAULT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_UPSERT_DEFAULT_CHUNK_SIZE);
    const done = (await withDbRetry(
      () => sql`
        INSERT INTO futures_front_month (product, trade_date, contract, source)
        SELECT t.product, t.trade_date, t.contract, 'candles'
        FROM unnest(
          ${chunk.map((r) => r.product)}::text[],
          ${chunk.map((r) => r.tradeDate)}::date[],
          ${chunk.map((r) => r.contract)}::text[]
        ) AS t(product, trade_date, contract)
        ON CONFLICT (product, trade_date) DO NOTHING
        RETURNING contract
      `,
      RETRIES,
      ATTEMPT_TIMEOUT_MS,
    )) as unknown[];
    inserted += done.length;
  }
  return inserted;
}
