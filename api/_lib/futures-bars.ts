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
