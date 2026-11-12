/**
 * Shared `futures_bars` writer and reader.
 *
 * `insertFuturesBars` is the one insert for bars rebuilt after the fact:
 * the nightly gap repair (`api/cron/backfill-futures-gaps.ts`, OHLC from
 * UW candles, no flow) and the September history backfill
 * (`scripts/backfill-futures-bars.ts`, OHLC and aggressor flow from UW
 * REST prints). The live bars come from the uw-stream handler, which has
 * its own writer.
 *
 * Flow follows the table's NULL-vs-0 rule: a flow field left out, or
 * null, is written as NULL (unknown), and a 0 is a known zero.
 *
 * `contract` is the dated outright the bar was built from, such as
 * `ESZ6` (column added by migration #204). Left out, or null, it is
 * written as NULL (unknown), which is also what every bar from before the
 * migration holds. The gap cron passes it (its scheduled contract); the
 * history backfill doesn't yet (Phase 4b changes it to, in
 * `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`).
 * The column's CHECK rejects anything but the row's own root, a CME month
 * code and a one- or two-digit year.
 *
 * The history repair (`scripts/backfill-futures-bars.ts --repair`) changes
 * stored bars with three guarded writes: `updateFuturesBars` rewrites a
 * bar, `tagFuturesBars` sets a NULL contract and `deleteFuturesBars`
 * removes one. Each takes the open and close the caller read and touches a
 * row only while both still hold, so a bar changed since the read is
 * skipped and left for the next run, and a re-run applies nothing that
 * already holds.
 */

import { getDb, withDbRetry } from './db.js';

const INSERT_CHUNK = 500;

/**
 * One bar to insert. Prices are `number | string` because the candle
 * repair passes numbers and the print backfill passes UW's decimal
 * strings; NUMERIC(12,4) rounds either to 4 dp on insert.
 */
export interface FuturesBarRow {
  /** The minute, `toISOString()` form (UTC). */
  ts: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number;
  buyVolume?: number | null;
  sellVolume?: number | null;
  buyPrints?: number | null;
  sellPrints?: number | null;
  /** The dated outright the bar came from, e.g. `ESZ6`; absent = unknown. */
  contract?: string | null;
}

/**
 * Batched `INSERT … SELECT FROM unnest(…) ON CONFLICT (symbol, ts) DO
 * NOTHING` of `symbol`'s bars, 500 rows a statement. DO NOTHING never
 * revises a bar the live handler wrote, so a re-run is a no-op and a
 * stored `contract` (or its NULL) is kept. Returns the rows actually
 * inserted. Throws on a rejected INSERT, a `contract` that fails the
 * column's CHECK included; batches already inserted stay.
 */
export async function insertFuturesBars(
  symbol: string,
  bars: readonly FuturesBarRow[],
): Promise<number> {
  const sql = getDb();
  let inserted = 0;
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        INSERT INTO futures_bars
          (symbol, ts, open, high, low, close, volume,
           buy_volume, sell_volume, buy_prints, sell_prints, contract)
        SELECT ${symbol}, t.ts, t.open, t.high, t.low, t.close, t.volume,
               t.buy_volume, t.sell_volume, t.buy_prints, t.sell_prints,
               t.contract
        FROM unnest(
          ${chunk.map((b) => b.ts)}::timestamptz[],
          ${chunk.map((b) => b.open)}::numeric[],
          ${chunk.map((b) => b.high)}::numeric[],
          ${chunk.map((b) => b.low)}::numeric[],
          ${chunk.map((b) => b.close)}::numeric[],
          ${chunk.map((b) => b.volume)}::bigint[],
          ${chunk.map((b) => b.buyVolume ?? null)}::bigint[],
          ${chunk.map((b) => b.sellVolume ?? null)}::bigint[],
          ${chunk.map((b) => b.buyPrints ?? null)}::int[],
          ${chunk.map((b) => b.sellPrints ?? null)}::int[],
          ${chunk.map((b) => b.contract ?? null)}::text[]
        ) AS t(ts, open, high, low, close, volume,
               buy_volume, sell_volume, buy_prints, sell_prints, contract)
        ON CONFLICT (symbol, ts) DO NOTHING
        RETURNING ts
      `,
      2,
      10_000,
    )) as unknown[];
    inserted += rows.length;
  }
  return inserted;
}

/**
 * A stored bar's minute and the open and close the caller read for it. A
 * guarded write applies only while the stored open and close still equal
 * these, compared as numbers (`6700.25` matches the stored `6700.2500`).
 */
export interface BarGuard {
  /** The minute, `toISOString()` form (UTC). */
  ts: string;
  wasOpen: number | string;
  wasClose: number | string;
}

/** A bar to write over the stored one it was read from. */
export type FuturesBarRewrite = FuturesBarRow & BarGuard;

/** A contract to set on a stored bar whose contract is NULL. */
export type FuturesBarTag = BarGuard & { contract: string };

/** `RETURNING ts` rows as ISO strings, whichever way the driver types them. */
function isoTimes(rows: unknown[]): string[] {
  return (rows as Array<{ ts: Date | string }>).map((r) =>
    new Date(r.ts).toISOString(),
  );
}

/**
 * Batched `UPDATE … FROM unnest(…)` of `symbol`'s bars, 500 rows a
 * statement: replaces prices, volume, the four flow columns and the
 * contract with the given values (a NULL flow or contract field overwrites,
 * since unknown is what the caller means), only where the stored open and
 * close still equal the guard. Returns the minutes actually rewritten,
 * oldest first. Throws on a rejected UPDATE, a `contract` that fails the
 * column's CHECK included; batches already applied stay.
 */
export async function updateFuturesBars(
  symbol: string,
  bars: readonly FuturesBarRewrite[],
): Promise<string[]> {
  const sql = getDb();
  const changed: string[] = [];
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        UPDATE futures_bars AS b
        SET open = t.open, high = t.high, low = t.low, close = t.close,
            volume = t.volume,
            buy_volume = t.buy_volume, sell_volume = t.sell_volume,
            buy_prints = t.buy_prints, sell_prints = t.sell_prints,
            contract = t.contract
        FROM unnest(
          ${chunk.map((b) => b.ts)}::timestamptz[],
          ${chunk.map((b) => b.open)}::numeric[],
          ${chunk.map((b) => b.high)}::numeric[],
          ${chunk.map((b) => b.low)}::numeric[],
          ${chunk.map((b) => b.close)}::numeric[],
          ${chunk.map((b) => b.volume)}::bigint[],
          ${chunk.map((b) => b.buyVolume ?? null)}::bigint[],
          ${chunk.map((b) => b.sellVolume ?? null)}::bigint[],
          ${chunk.map((b) => b.buyPrints ?? null)}::int[],
          ${chunk.map((b) => b.sellPrints ?? null)}::int[],
          ${chunk.map((b) => b.contract ?? null)}::text[],
          ${chunk.map((b) => b.wasOpen)}::numeric[],
          ${chunk.map((b) => b.wasClose)}::numeric[]
        ) AS t(ts, open, high, low, close, volume,
               buy_volume, sell_volume, buy_prints, sell_prints, contract,
               was_open, was_close)
        WHERE b.symbol = ${symbol}
          AND b.ts = t.ts
          AND b.open = t.was_open
          AND b.close = t.was_close
        RETURNING b.ts
      `,
      2,
      10_000,
    )) as unknown[];
    changed.push(...isoTimes(rows));
  }
  return changed.sort();
}

/**
 * Batched `UPDATE … SET contract` of `symbol`'s bars, 500 rows a statement,
 * only where the stored contract is still NULL and the stored open and
 * close still equal the guard. Nothing but `contract` changes. Returns the
 * minutes actually tagged, oldest first. Throws on a rejected UPDATE, a
 * `contract` that fails the column's CHECK included.
 */
export async function tagFuturesBars(
  symbol: string,
  tags: readonly FuturesBarTag[],
): Promise<string[]> {
  const sql = getDb();
  const changed: string[] = [];
  for (let i = 0; i < tags.length; i += INSERT_CHUNK) {
    const chunk = tags.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        UPDATE futures_bars AS b
        SET contract = t.contract
        FROM unnest(
          ${chunk.map((b) => b.ts)}::timestamptz[],
          ${chunk.map((b) => b.contract)}::text[],
          ${chunk.map((b) => b.wasOpen)}::numeric[],
          ${chunk.map((b) => b.wasClose)}::numeric[]
        ) AS t(ts, contract, was_open, was_close)
        WHERE b.symbol = ${symbol}
          AND b.ts = t.ts
          AND b.contract IS NULL
          AND b.open = t.was_open
          AND b.close = t.was_close
        RETURNING b.ts
      `,
      2,
      10_000,
    )) as unknown[];
    changed.push(...isoTimes(rows));
  }
  return changed.sort();
}

/**
 * Batched `DELETE … USING unnest(…)` of `symbol`'s bars, 500 rows a
 * statement, only where the stored open and close still equal the guard.
 * Returns the minutes actually deleted, oldest first: a minute with no row,
 * or one changed since the read, is skipped without an error.
 */
export async function deleteFuturesBars(
  symbol: string,
  guards: readonly BarGuard[],
): Promise<string[]> {
  const sql = getDb();
  const deleted: string[] = [];
  for (let i = 0; i < guards.length; i += INSERT_CHUNK) {
    const chunk = guards.slice(i, i + INSERT_CHUNK);
    const rows = (await withDbRetry(
      () => sql`
        DELETE FROM futures_bars AS b
        USING unnest(
          ${chunk.map((g) => g.ts)}::timestamptz[],
          ${chunk.map((g) => g.wasOpen)}::numeric[],
          ${chunk.map((g) => g.wasClose)}::numeric[]
        ) AS t(ts, was_open, was_close)
        WHERE b.symbol = ${symbol}
          AND b.ts = t.ts
          AND b.open = t.was_open
          AND b.close = t.was_close
        RETURNING b.ts
      `,
      2,
      10_000,
    )) as unknown[];
    deleted.push(...isoTimes(rows));
  }
  return deleted.sort();
}

/** A stored bar. Prices are the NUMERIC(12,4) text, e.g. `"7659.0000"`. */
export interface StoredFuturesBar {
  ts: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  buyVolume: number | null;
  sellVolume: number | null;
  buyPrints: number | null;
  sellPrints: number | null;
  /** The dated outright the bar came from; null = unknown. */
  contract: string | null;
}

interface StoredRow {
  ts: Date | string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  buy_volume: number | null;
  sell_volume: number | null;
  buy_prints: number | null;
  sell_prints: number | null;
  contract: string | null;
}

/**
 * `symbol`'s bars in [startIso, endIso), oldest first. The caller bounds
 * the window (the backfill reads one UTC day, at most 1,440 rows), so it
 * is not paged. Volumes are cast to float8 (exact below 2^53) because
 * the driver returns BIGINT as a string.
 */
export async function fetchFuturesBars(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<StoredFuturesBar[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT ts, open::text AS open, high::text AS high, low::text AS low,
             close::text AS close, volume::float8 AS volume,
             buy_volume::float8 AS buy_volume,
             sell_volume::float8 AS sell_volume,
             buy_prints, sell_prints, contract
      FROM futures_bars
      WHERE symbol = ${symbol}
        AND ts >= ${startIso}::timestamptz
        AND ts < ${endIso}::timestamptz
      ORDER BY ts
    `,
    2,
    10_000,
  )) as StoredRow[];
  return rows.map((r) => ({
    ts: new Date(r.ts).toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    buyVolume: r.buy_volume,
    sellVolume: r.sell_volume,
    buyPrints: r.buy_prints,
    sellPrints: r.sell_prints,
    contract: r.contract,
  }));
}
