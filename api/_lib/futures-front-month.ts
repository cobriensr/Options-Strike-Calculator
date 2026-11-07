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
 * Renew, fail, expire: there is no lease and nothing to expire. A writer
 * that dies before its insert leaves nothing; the next one decides again
 * from the same inputs, or from newer volume rows if some landed, and
 * either answer is a valid one for a date nobody has decided.
 *
 * `insertContractVolumes` and `insertFrontMonthRows` are the bulk inserts
 * the history seed (Phase 3) uses. They write `source = 'candles'`.
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
  decideFrontMonth,
  type FuturesRoot,
} from './futures-contracts.js';
import logger from './logger.js';

type Sql = ReturnType<typeof getDb>;

/** Who is deciding: the gap cron, or an operator script. */
type DeciderSource = 'cron' | 'script';

const RETRIES = 2;
const ATTEMPT_TIMEOUT_MS = 10_000;

const TRADE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws unless `tradeDate` is a real calendar date, `YYYY-MM-DD`. */
function assertTradeDate(tradeDate: string): void {
  const ms = TRADE_DATE.test(tradeDate)
    ? Date.parse(`${tradeDate}T00:00:00Z`)
    : Number.NaN;
  if (
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== tradeDate
  ) {
    throw new Error(
      `Invalid trade date ${JSON.stringify(tradeDate)}: expected a calendar date as YYYY-MM-DD`,
    );
  }
}

/**
 * Throws on a malformed date and on one after the current trade date. A
 * date later than that has no volume to decide from, and a row written for
 * it would be an incumbent no real session produced.
 */
function assertDecidable(product: FuturesRoot, tradeDate: string): void {
  assertTradeDate(tradeDate);
  const current = cmeTradeDate(new Date().toISOString());
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
  volumes: Map<string, number>;
}

/**
 * What the decision for `tradeDate` starts from, in one round trip: the
 * contract of the latest decision before it, and every volume row of the
 * latest earlier trade date that has any (a weekend or holiday has none).
 */
async function readInputs(
  sql: Sql,
  product: FuturesRoot,
  tradeDate: string,
): Promise<Inputs> {
  const rows = (await withDbRetry(
    () => sql`
      (SELECT 'incumbent' AS kind, contract, NULL::float8 AS volume
         FROM futures_front_month
        WHERE product = ${product} AND trade_date < ${tradeDate}::date
        ORDER BY trade_date DESC
        LIMIT 1)
      UNION ALL
      SELECT 'volume', v.contract, v.volume::float8
        FROM futures_contract_volume v
       WHERE v.product = ${product}
         AND v.trade_date = (SELECT max(trade_date)
                               FROM futures_contract_volume
                              WHERE product = ${product}
                                AND trade_date < ${tradeDate}::date)
    `,
    RETRIES,
    ATTEMPT_TIMEOUT_MS,
  )) as Array<{
    kind: string;
    contract: string;
    volume: number | string | null;
  }>;

  const inputs: Inputs = { incumbent: null, volumes: new Map() };
  for (const r of rows) {
    if (r.kind === 'incumbent') inputs.incumbent = r.contract;
    else inputs.volumes.set(r.contract, Number(r.volume));
  }
  return inputs;
}

/**
 * The contract for one root and trade date: the stored row when there is
 * one, else decided now by `decideFrontMonth` from the latest earlier
 * decision and volume, written with ON CONFLICT DO NOTHING and read back,
 * so every writer returns the same answer. Logs a warning, and uses the
 * listing-cycle seed, when there is no earlier decision and no volume at
 * all: a seed that is too early can only make the roll late.
 *
 * Decide a root's dates oldest first: a date decided before an earlier one
 * does not see that one's row. Throws on a malformed date and on one after
 * the current trade date. Database errors propagate (transient ones after
 * `withDbRetry`'s retries).
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

  const { incumbent, volumes } = await readInputs(sql, product, tradeDate);
  if (incumbent == null && volumes.size === 0) {
    logger.warn(
      { product, tradeDate },
      'No earlier front-month decision and no earlier volume: using the listing-cycle seed',
    );
  }
  const decided = decideFrontMonth(incumbent, volumes, product, tradeDate);
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
 * fall on, so a weekend gets no row. Throws before any query if a date is
 * malformed or after the current trade date.
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
  // Oldest first, one at a time: each decision starts from the one before.
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
 * never revised. Returns the rows actually inserted. Every row is checked
 * first, so a bad one writes nothing: a non-canonical contract (the caller
 * folds `ESZ26` into `ESZ6` and sums) or a volume that is not a whole
 * number of contracts, 0 or more. Throws on a rejected INSERT; batches
 * already inserted stay.
 */
export async function insertContractVolumes(
  rows: ReadonlyArray<ContractVolumeRow>,
): Promise<number> {
  for (const r of rows) {
    assertCanonical(
      'insertContractVolumes',
      r.product,
      r.tradeDate,
      r.contract,
    );
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
 * 'candles'`. A date that already has a row keeps it. Returns the rows
 * actually inserted. Every row is checked first (a non-canonical contract
 * writes nothing). Throws on a rejected INSERT; batches already inserted
 * stay.
 */
export async function insertFrontMonthRows(
  rows: ReadonlyArray<FrontMonthRow>,
): Promise<number> {
  for (const r of rows) {
    assertCanonical('insertFrontMonthRows', r.product, r.tradeDate, r.contract);
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
