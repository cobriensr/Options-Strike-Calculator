// @vitest-environment node

/**
 * REAL-SQL test for the shared `futures_bars` writer and reader.
 *
 * futures_bars comes from the REAL migrations on pglite (real Postgres in
 * WASM): #42 creates it (its es_bars copy is left out: that table no
 * longer exists) and #193 adds the order-flow columns. It checks what a
 * mocked tag can't see: ON CONFLICT DO NOTHING leaves a stored bar alone,
 * the NUMERIC(12,4) column rounds UW's 9-decimal strings, NULL flow
 * arrays reach the columns as NULL, and a bad value rejects the insert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS, type Migration } from '../_lib/db-migrations.js';

const { pg } = vi.hoisted(() => ({
  pg: { db: null as PGlite | null, queries: [] as string[] },
}));

vi.mock('../_lib/db.js', () => ({
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
      pg.queries.push(text);
      return pg.db!.query(text, values).then((r) => r.rows);
    },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  fetchFuturesBars,
  insertFuturesBars,
  type FuturesBarRow,
} from '../_lib/futures-bars.js';

type NeonSql = Parameters<NonNullable<Migration['statements']>>[0];

interface PgQuery extends PromiseLike<unknown[]> {
  readonly text: string;
  readonly params: unknown[];
}

/** Lazy neon-shaped tag over pglite, enough for `statements` migrations. */
function migrationSql(db: PGlite) {
  return (strings: TemplateStringsArray, ...params: unknown[]): PgQuery => {
    const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
    return {
      text,
      params,
      then: (onFulfilled, onRejected) =>
        db
          .query(text, params)
          .then((r) => r.rows)
          .then(onFulfilled, onRejected),
    };
  };
}

/** Migration `id`'s statements in one transaction, as migrateDb runs them. */
async function applyStatements(
  db: PGlite,
  id: number,
  keep: (text: string) => boolean = () => true,
): Promise<void> {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (!m?.statements) throw new Error(`migration #${id} has no statements`);
  const queries = m.statements(
    migrationSql(db) as unknown as NeonSql,
  ) as unknown as PgQuery[];
  await db.transaction(async (tx) => {
    for (const q of queries.filter((x) => keep(x.text))) {
      await tx.query(q.text, q.params);
    }
  });
}

interface StoredRow {
  symbol: string;
  ts: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  buy_volume: string | null;
  sell_volume: string | null;
  buy_prints: number | null;
  sell_prints: number | null;
}

async function rows(symbol = 'ES'): Promise<StoredRow[]> {
  const { rows: out } = await pg.db!.query<StoredRow>(
    `SELECT symbol, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
            open::text, high::text, low::text, close::text, volume::text,
            buy_volume::text, sell_volume::text, buy_prints, sell_prints
       FROM futures_bars WHERE symbol = $1 ORDER BY ts`,
    [symbol],
  );
  return out;
}

function bar(i: number, over: Partial<FuturesBarRow> = {}): FuturesBarRow {
  return {
    ts: new Date(Date.UTC(2026, 8, 4, 0, i)).toISOString(),
    open: 7700,
    high: 7701,
    low: 7699,
    close: 7700.5,
    volume: 10,
    ...over,
  };
}

const T0 = '2026-09-04T00:00:00.000Z';
const T1 = '2026-09-04T00:01:00.000Z';
const T2 = '2026-09-04T00:02:00.000Z';

describe('futures-bars SQL (pglite)', () => {
  beforeEach(async () => {
    pg.db = new PGlite();
    pg.queries = [];
    await applyStatements(pg.db, 42, (text) => !/\bes_bars\b/.test(text));
    await applyStatements(pg.db, 193);
  });

  afterEach(async () => {
    await pg.db?.close();
    pg.db = null;
  });

  describe('insertFuturesBars', () => {
    it('a bar with no flow fields stores NULL flow (the OHLC repair’s shape)', async () => {
      const n = await insertFuturesBars('ES', [bar(0), bar(1, { volume: 3 })]);

      expect(n).toBe(2);
      expect(await rows()).toEqual([
        {
          symbol: 'ES',
          ts: '2026-09-04T00:00:00Z',
          open: '7700.0000',
          high: '7701.0000',
          low: '7699.0000',
          close: '7700.5000',
          volume: '10',
          buy_volume: null,
          sell_volume: null,
          buy_prints: null,
          sell_prints: null,
        },
        expect.objectContaining({ volume: '3', buy_volume: null }),
      ]);
    });

    it('writes the four flow columns when given, and NULL for any field left out', async () => {
      await insertFuturesBars('ES', [
        bar(0, { buyVolume: 6, sellVolume: 4, buyPrints: 3, sellPrints: 2 }),
        // A known zero is not NULL.
        bar(1, { buyVolume: 0, sellVolume: 0, buyPrints: 0, sellPrints: 0 }),
        // Unknown flow, explicitly.
        bar(2, {
          buyVolume: null,
          sellVolume: null,
          buyPrints: null,
          sellPrints: null,
        }),
        // Only one field present: the others stay NULL.
        bar(3, { buyVolume: 5 }),
      ]);

      const flow = (await rows()).map((r) => [
        r.buy_volume,
        r.sell_volume,
        r.buy_prints,
        r.sell_prints,
      ]);
      expect(flow).toEqual([
        ['6', '4', 3, 2],
        ['0', '0', 0, 0],
        [null, null, null, null],
        ['5', null, null, null],
      ]);
    });

    it('rounds UW’s 9-decimal price strings and plain numbers to the column’s 4 dp, half away from zero', async () => {
      await insertFuturesBars('ZN', [
        bar(0, {
          open: '107.203125000', // 1/64ths: 107.2031|25
          high: '107.234375000', // 107.2343|75 → 107.2344
          low: '107.031250000', // exactly half at 4 dp → 107.0313
          close: '7659.000000000',
        }),
        bar(1, { open: 7700.12345, high: 7700.99994, low: 1, close: 2.5 }),
      ]);

      expect(
        (await rows('ZN')).map((r) => [r.open, r.high, r.low, r.close]),
      ).toEqual([
        ['107.2031', '107.2344', '107.0313', '7659.0000'],
        ['7700.1235', '7700.9999', '1.0000', '2.5000'],
      ]);
    });

    it('ON CONFLICT DO NOTHING: a stored bar is left untouched and only new rows are counted', async () => {
      await insertFuturesBars('ES', [
        bar(0, { open: 1111, buyVolume: 9, sellVolume: 9 }),
      ]);

      const n = await insertFuturesBars('ES', [
        bar(0, { open: 2222, volume: 99, buyVolume: 1, sellVolume: 1 }),
        bar(1),
      ]);

      expect(n).toBe(1);
      const stored = await rows();
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({
        ts: '2026-09-04T00:00:00Z',
        open: '1111.0000',
        volume: '10',
        buy_volume: '9',
      });
      // A re-run is a no-op.
      await expect(insertFuturesBars('ES', [bar(0), bar(1)])).resolves.toBe(0);
    });

    it('conflicts only on the same symbol and minute', async () => {
      await insertFuturesBars('ES', [bar(0)]);

      await expect(insertFuturesBars('NQ', [bar(0)])).resolves.toBe(1);
      await expect(insertFuturesBars('ES', [bar(1)])).resolves.toBe(1);
    });

    it('inserts in 500-row batches, one statement each', async () => {
      const all = Array.from({ length: 1201 }, (_, i) => bar(i));

      const n = await insertFuturesBars('ES', all);

      expect(n).toBe(1201);
      expect(pg.queries.filter((q) => q.includes('INSERT INTO'))).toHaveLength(
        3,
      );
      expect(await rows()).toHaveLength(1201);
    });

    it('nothing to insert → no query', async () => {
      await expect(insertFuturesBars('ES', [])).resolves.toBe(0);
      expect(pg.queries).toHaveLength(0);
    });

    it('a value the column cannot hold rejects the insert (nothing is written for that batch)', async () => {
      await expect(
        insertFuturesBars('ES', [bar(0), bar(1, { high: '1000000000' })]),
      ).rejects.toThrow(/numeric field overflow/);

      expect(await rows()).toEqual([]);
    });
  });

  describe('fetchFuturesBars', () => {
    it('returns one symbol’s bars in [start, end) in time order, prices as the column prints them and flow as numbers or null', async () => {
      await insertFuturesBars('ES', [
        bar(2, { buyVolume: 6, sellVolume: 4, buyPrints: 3, sellPrints: 2 }),
        bar(0, { open: '7700.123456789' }),
        bar(1, { buyVolume: 0, sellVolume: 0, buyPrints: 0, sellPrints: 0 }),
        bar(3),
      ]);
      await insertFuturesBars('NQ', [bar(0)]);

      const got = await fetchFuturesBars('ES', T0, '2026-09-04T00:03:00.000Z');

      expect(got).toEqual([
        {
          ts: T0,
          open: '7700.1235',
          high: '7701.0000',
          low: '7699.0000',
          close: '7700.5000',
          volume: 10,
          buyVolume: null,
          sellVolume: null,
          buyPrints: null,
          sellPrints: null,
        },
        expect.objectContaining({
          ts: T1,
          buyVolume: 0,
          sellVolume: 0,
          buyPrints: 0,
          sellPrints: 0,
        }),
        expect.objectContaining({
          ts: T2,
          buyVolume: 6,
          sellVolume: 4,
          buyPrints: 3,
          sellPrints: 2,
        }),
      ]);
      expect(got.every((b) => typeof b.volume === 'number')).toBe(true);
    });

    it('a window with no bars is empty', async () => {
      await expect(fetchFuturesBars('ES', T0, T2)).resolves.toEqual([]);
    });

    it('a rejected SELECT propagates', async () => {
      await pg.db!.query('DROP TABLE futures_bars');

      await expect(fetchFuturesBars('ES', T0, T2)).rejects.toThrow(
        /futures_bars/,
      );
    });
  });
});
