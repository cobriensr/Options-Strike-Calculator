// @vitest-environment node

/**
 * REAL-SQL test for the shared `futures_bars` writer and reader.
 *
 * futures_bars comes from the REAL migrations on pglite (real Postgres in
 * WASM): #42 creates it (its es_bars copy is left out: that table no
 * longer exists), #193 adds the order-flow columns and #204 adds the
 * contract column and its CHECK. It checks what a mocked tag can't see:
 * ON CONFLICT DO NOTHING leaves a stored bar (and its contract) alone,
 * the NUMERIC(12,4) column rounds UW's 9-decimal strings, NULL flow and
 * contract arrays reach the columns as NULL, a bad value rejects the
 * insert, and the real `withDbRetry` does not retry a CHECK violation.
 *
 * The history repair's three guarded writes (`updateFuturesBars`,
 * `tagFuturesBars`, `deleteFuturesBars`) are checked here too: each
 * touches a row only while its open and close are what the caller read,
 * compares them as numbers, returns the minutes it changed, and runs in
 * 500-row statements.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS, type Migration } from '../_lib/db-migrations.js';

const { pg } = vi.hoisted(() => ({
  pg: { db: null as PGlite | null, queries: [] as string[] },
}));

// `withDbRetry` and its classifier are the real ones: the CHECK-violation
// test needs to see that a constraint error is not retried.
vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb:
      () =>
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
        pg.queries.push(text);
        return pg.db!.query(text, values).then((r) => r.rows);
      },
    withDbRetry: actual.withDbRetry,
    isRetryableDbError: actual.isRetryableDbError,
    TransientDbError: actual.TransientDbError,
  };
});

import { isRetryableDbError, TransientDbError } from '../_lib/db.js';
import {
  deleteFuturesBars,
  fetchFuturesBars,
  insertFuturesBars,
  tagFuturesBars,
  updateFuturesBars,
  type BarGuard,
  type FuturesBarRow,
  type StoredFuturesBar,
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
  contract: string | null;
}

async function rows(symbol = 'ES'): Promise<StoredRow[]> {
  const { rows: out } = await pg.db!.query<StoredRow>(
    `SELECT symbol, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts,
            open::text, high::text, low::text, close::text, volume::text,
            buy_volume::text, sell_volume::text, buy_prints, sell_prints,
            contract
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
    await applyStatements(pg.db, 204);
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
          contract: null,
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

    it('inserts in 500-row batches, one statement each, each row keeping its own contract across the chunk boundaries', async () => {
      const cycle = ['ESZ6', 'ESH7', null] as const;
      const want = (i: number) => cycle[i % cycle.length]!;
      const all = Array.from({ length: 1201 }, (_, i) =>
        bar(i, { contract: want(i) }),
      );

      const n = await insertFuturesBars('ES', all);

      expect(n).toBe(1201);
      expect(pg.queries.filter((q) => q.includes('INSERT INTO'))).toHaveLength(
        3,
      );
      const stored = await rows();
      expect(stored).toHaveLength(1201);
      expect(stored.map((r) => r.contract)).toEqual(all.map((_, i) => want(i)));
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

    describe('contract', () => {
      it('stores the contract a bar came from and fetchFuturesBars returns it', async () => {
        await insertFuturesBars('ES', [bar(0, { contract: 'ESZ6' })]);

        expect((await rows()).map((r) => r.contract)).toEqual(['ESZ6']);
        const got = await fetchFuturesBars('ES', T0, T1);
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ ts: T0, contract: 'ESZ6' });
      });

      it('a bar with no contract, or a null one, stores NULL and reads back null, mixed with tagged bars in one chunk', async () => {
        await insertFuturesBars('ES', [
          bar(0, { contract: 'ESZ6' }),
          bar(1),
          bar(2, { contract: null }),
          bar(3, { contract: 'ESH7' }),
        ]);

        const want = ['ESZ6', null, null, 'ESH7'];
        expect((await rows()).map((r) => r.contract)).toEqual(want);
        const got = await fetchFuturesBars(
          'ES',
          T0,
          '2026-09-04T00:04:00.000Z',
        );
        expect(got.map((b) => b.contract)).toEqual(want);
      });

      it('ON CONFLICT DO NOTHING keeps the contract already stored, and a stored NULL stays NULL', async () => {
        await insertFuturesBars('ES', [bar(0, { contract: 'ESZ6' }), bar(1)]);

        const n = await insertFuturesBars('ES', [
          bar(0, { contract: 'ESH7' }),
          bar(1, { contract: 'ESZ6' }),
        ]);

        expect(n).toBe(0);
        expect((await rows()).map((r) => r.contract)).toEqual(['ESZ6', null]);
      });

      it('a malformed contract at a minute that is already stored still throws, because the CHECK runs before the conflict arbiter, and the stored row is unchanged', async () => {
        await insertFuturesBars('ES', [bar(0, { contract: 'ESZ6' })]);

        await expect(
          insertFuturesBars('ES', [bar(0, { contract: 'NQZ6' })]),
        ).rejects.toThrow(/futures_bars_contract_chk/);

        expect((await rows()).map((r) => [r.ts, r.open, r.contract])).toEqual([
          ['2026-09-04T00:00:00Z', '7700.0000', 'ESZ6'],
        ]);
      });

      it.each([
        ['another root’s contract', 'NQZ6'],
        ['the micro root’s contract', 'MESZ6'],
        ['a bare root', 'ES'],
        ['a spread', 'ESZ6-ESH7'],
        ['a four-digit year', 'ESZ2026'],
        ['a letter that is not a CME month code', 'ESA6'],
        ['a month with no year', 'ESZ'],
        ['lower case', 'esz6'],
        ['a trailing newline', 'ESZ6\n'],
      ])(
        'the CHECK rejects %s (%j) and the whole chunk stores nothing',
        async (_what, contract) => {
          await expect(
            insertFuturesBars('ES', [bar(0), bar(1, { contract })]),
          ).rejects.toThrow(/futures_bars_contract_chk/);

          expect(await rows()).toEqual([]);
        },
      );

      it.each([
        ['ES', 'ESZ6'],
        ['ES', 'ESZ26'],
        ['RTY', 'RTYU6'],
      ])('the CHECK accepts %s contract %s', async (symbol, contract) => {
        await expect(
          insertFuturesBars(symbol, [bar(0, { contract })]),
        ).resolves.toBe(1);

        expect((await rows(symbol)).map((r) => r.contract)).toEqual([contract]);
      });

      it('a CHECK violation surfaces at once: withDbRetry does not call it transient, so the INSERT runs once', async () => {
        const err = await insertFuturesBars('ES', [
          bar(0, { contract: 'NQZ6' }),
        ]).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(TransientDbError);
        expect((err as Error).message).toMatch(
          /violates check constraint "futures_bars_contract_chk"/,
        );
        expect(isRetryableDbError(err)).toBe(false);
        expect(
          pg.queries.filter((q) => q.includes('INSERT INTO')),
        ).toHaveLength(1);
      });
    });
  });

  describe('migration #204', () => {
    it('re-runs cleanly: a row from before the column keeps a NULL contract, and the CHECK stays NOT VALID and still binds new writes', async () => {
      // A table as it stood before #204, with one bar already in it.
      await pg.db!.close();
      pg.db = new PGlite();
      await applyStatements(pg.db, 42, (text) => !/\bes_bars\b/.test(text));
      await applyStatements(pg.db, 193);
      await pg.db.query(
        `INSERT INTO futures_bars (symbol, ts, open, high, low, close, volume)
         VALUES ('ES', $1, 1, 1, 1, 1, 5)`,
        [T0],
      );

      await applyStatements(pg.db, 204);
      await applyStatements(pg.db, 204);

      expect((await rows()).map((r) => [r.ts, r.contract])).toEqual([
        ['2026-09-04T00:00:00Z', null],
      ]);
      const { rows: chk } = await pg.db.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint
          WHERE conname = 'futures_bars_contract_chk'`,
      );
      expect(chk).toEqual([{ convalidated: false }]);
      await expect(
        insertFuturesBars('ES', [bar(1, { contract: 'NQZ6' })]),
      ).rejects.toThrow(/futures_bars_contract_chk/);
      await expect(
        insertFuturesBars('ES', [bar(1, { contract: 'ESZ6' })]),
      ).resolves.toBe(1);
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
          contract: null,
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

  // ── The history repair's guarded writes ──────────────────

  /** The open/close a caller holds after reading `symbol`'s bars. */
  async function guards(symbol = 'ES'): Promise<BarGuard[]> {
    const read: StoredFuturesBar[] = await fetchFuturesBars(
      symbol,
      T0,
      '2026-09-05T00:00:00.000Z',
    );
    return read.map((b) => ({ ts: b.ts, wasOpen: b.open, wasClose: b.close }));
  }

  /** Changes a stored bar behind the caller's back, as a concurrent writer would. */
  async function changeBehindBack(
    column: 'open' | 'close',
    ts: string,
  ): Promise<void> {
    await pg.db!.query(
      `UPDATE futures_bars SET ${column} = ${column} + 1
        WHERE symbol = 'ES' AND ts = $1`,
      [ts],
    );
  }

  describe('updateFuturesBars', () => {
    it('rewrites the prices, volume, all four flow columns and the contract of the guarded minute, and returns its ts; other minutes and symbols stay', async () => {
      const wrong = {
        open: 6767.25,
        high: 6768,
        low: 6767,
        close: 6767.5,
        volume: 5,
        buyVolume: 5,
        sellVolume: 0,
        buyPrints: 1,
        sellPrints: 0,
        contract: 'ESZ6',
      };
      await insertFuturesBars('ES', [bar(0, wrong), bar(1, wrong)]);
      await insertFuturesBars('NQ', [bar(0, { ...wrong, contract: 'NQZ6' })]);
      const [g0] = await guards();

      const done = await updateFuturesBars('ES', [
        {
          ...bar(0, {
            open: '6700.250000000',
            high: '6702.500000000',
            low: '6700.250000000',
            close: '6702.500000000',
            volume: 9,
            buyVolume: 4,
            sellVolume: 5,
            buyPrints: 2,
            sellPrints: 3,
            contract: 'ESU6',
          }),
          ...g0!,
        },
      ]);

      expect(done).toEqual([T0]);
      const [first, second] = await rows();
      expect(first).toEqual({
        symbol: 'ES',
        ts: '2026-09-04T00:00:00Z',
        open: '6700.2500',
        high: '6702.5000',
        low: '6700.2500',
        close: '6702.5000',
        volume: '9',
        buy_volume: '4',
        sell_volume: '5',
        buy_prints: 2,
        sell_prints: 3,
        contract: 'ESU6',
      });
      expect(second).toMatchObject({ open: '6767.2500', contract: 'ESZ6' });
      expect((await rows('NQ'))[0]).toMatchObject({
        open: '6767.2500',
        contract: 'NQZ6',
      });
    });

    it('NULL flow and a NULL contract overwrite what was stored (unknown replaces a wrong known)', async () => {
      await insertFuturesBars('ES', [
        bar(0, {
          buyVolume: 5,
          sellVolume: 0,
          buyPrints: 1,
          sellPrints: 0,
          contract: 'ESZ6',
        }),
      ]);
      const [g0] = await guards();

      await updateFuturesBars('ES', [
        { ...bar(0, { open: 7000, contract: null }), ...g0! },
      ]);

      expect((await rows())[0]).toMatchObject({
        open: '7000.0000',
        buy_volume: null,
        sell_volume: null,
        buy_prints: null,
        sell_prints: null,
        contract: null,
      });
    });

    it.each(['open', 'close'] as const)(
      'skips a minute whose %s changed since the read, leaving it as the other writer left it, and returns only the minutes it changed',
      async (column) => {
        await insertFuturesBars('ES', [bar(0), bar(1)]);
        const [g0, g1] = await guards();
        await changeBehindBack(column, T0);
        const before = await rows();

        const done = await updateFuturesBars('ES', [
          { ...bar(0, { open: 1, high: 1, low: 1, close: 1 }), ...g0! },
          { ...bar(1, { open: 2, high: 2, low: 2, close: 2 }), ...g1! },
        ]);

        expect(done).toEqual([T1]);
        const after = await rows();
        expect(after[0]).toEqual(before[0]);
        expect(after[1]).toMatchObject({ open: '2.0000', close: '2.0000' });
      },
    );

    it('compares the guard as a number: 6700.25, "6700.25" and "6700.2500" all match the stored 6700.2500', async () => {
      await insertFuturesBars('ES', [
        bar(0, { open: 6700.25, close: 6700.25 }),
        bar(1, { open: 6700.25, close: 6700.25 }),
        bar(2, { open: 6700.25, close: 6700.25 }),
      ]);
      const same = { open: 5, high: 5, low: 5, close: 5 };

      const done = await updateFuturesBars('ES', [
        { ...bar(0, same), wasOpen: 6700.25, wasClose: 6700.25 },
        { ...bar(1, same), wasOpen: '6700.25', wasClose: '6700.25' },
        { ...bar(2, same), wasOpen: '6700.2500', wasClose: '6700.2500' },
      ]);

      expect(done).toEqual([
        '2026-09-04T00:00:00.000Z',
        '2026-09-04T00:01:00.000Z',
        '2026-09-04T00:02:00.000Z',
      ]);
    });

    it('updates in 500-row statements and returns every changed minute in order', async () => {
      await insertFuturesBars(
        'ES',
        Array.from({ length: 1201 }, (_, i) => bar(i)),
      );
      const g = await guards();

      const done = await updateFuturesBars(
        'ES',
        g.map((x, i) => ({
          ...bar(i, { open: 1, high: 1, low: 1, close: 1 }),
          ...x,
        })),
      );

      expect(done).toHaveLength(1201);
      expect(done[1200]).toBe('2026-09-04T20:00:00.000Z');
      expect(
        pg.queries.filter((q) => q.includes('UPDATE futures_bars')),
      ).toHaveLength(3);
      expect((await rows()).every((r) => r.open === '1.0000')).toBe(true);
    });

    it('nothing to update → no query', async () => {
      await expect(updateFuturesBars('ES', [])).resolves.toEqual([]);
      expect(pg.queries).toHaveLength(0);
    });

    it('a value the column cannot hold rejects the statement and changes nothing in it', async () => {
      await insertFuturesBars('ES', [bar(0), bar(1)]);
      const [g0, g1] = await guards();
      const before = await rows();

      await expect(
        updateFuturesBars('ES', [
          { ...bar(0, { open: 1 }), ...g0! },
          { ...bar(1, { high: '1000000000' }), ...g1! },
        ]),
      ).rejects.toThrow(/numeric field overflow/);

      expect(await rows()).toEqual(before);
    });

    it('a contract that fails the CHECK rejects at once (no retry) and changes nothing', async () => {
      await insertFuturesBars('ES', [bar(0)]);
      const [g0] = await guards();
      const before = await rows();

      const err = await updateFuturesBars('ES', [
        { ...bar(0, { contract: 'NQZ6' }), ...g0! },
      ]).catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/futures_bars_contract_chk/);
      expect(isRetryableDbError(err)).toBe(false);
      expect(
        pg.queries.filter((q) => q.includes('UPDATE futures_bars')),
      ).toHaveLength(1);
      expect(await rows()).toEqual(before);
    });
  });

  describe('tagFuturesBars', () => {
    it('sets the contract only where it is NULL: a tagged minute keeps its contract and is not returned', async () => {
      await insertFuturesBars('ES', [
        bar(0),
        bar(1, { contract: 'ESZ6' }),
        bar(2),
      ]);
      const [g0, g1, g2] = await guards();

      const done = await tagFuturesBars('ES', [
        { ...g0!, contract: 'ESU6' },
        { ...g1!, contract: 'ESU6' },
        { ...g2!, contract: 'ESU6' },
      ]);

      expect(done).toEqual([T0, T2]);
      expect((await rows()).map((r) => r.contract)).toEqual([
        'ESU6',
        'ESZ6',
        'ESU6',
      ]);
    });

    it('changes only the contract: prices, volume and flow are left as stored', async () => {
      await insertFuturesBars('ES', [
        bar(0, { buyVolume: 6, sellVolume: 4, buyPrints: 3, sellPrints: 2 }),
      ]);
      const [g0] = await guards();
      const before = (await rows())[0];

      await tagFuturesBars('ES', [{ ...g0!, contract: 'ESU6' }]);

      expect((await rows())[0]).toEqual({ ...before, contract: 'ESU6' });
    });

    it.each(['open', 'close'] as const)(
      'skips a minute whose %s changed since the read',
      async (column) => {
        await insertFuturesBars('ES', [bar(0), bar(1)]);
        const [g0, g1] = await guards();
        await changeBehindBack(column, T0);

        const done = await tagFuturesBars('ES', [
          { ...g0!, contract: 'ESU6' },
          { ...g1!, contract: 'ESU6' },
        ]);

        expect(done).toEqual([T1]);
        expect((await rows()).map((r) => r.contract)).toEqual([null, 'ESU6']);
      },
    );

    it('tags in 500-row statements', async () => {
      await insertFuturesBars(
        'ES',
        Array.from({ length: 501 }, (_, i) => bar(i)),
      );
      const g = await guards();

      const done = await tagFuturesBars(
        'ES',
        g.map((x) => ({ ...x, contract: 'ESU6' })),
      );

      expect(done).toHaveLength(501);
      expect(
        pg.queries.filter((q) => q.includes('UPDATE futures_bars')),
      ).toHaveLength(2);
    });

    it('nothing to tag → no query', async () => {
      await expect(tagFuturesBars('ES', [])).resolves.toEqual([]);
      expect(pg.queries).toHaveLength(0);
    });

    it('a contract that fails the CHECK rejects the statement and tags nothing in it', async () => {
      await insertFuturesBars('ES', [bar(0), bar(1)]);
      const [g0, g1] = await guards();

      await expect(
        tagFuturesBars('ES', [
          { ...g0!, contract: 'ESU6' },
          { ...g1!, contract: 'NQU6' },
        ]),
      ).rejects.toThrow(/futures_bars_contract_chk/);

      expect((await rows()).map((r) => r.contract)).toEqual([null, null]);
    });
  });

  describe('deleteFuturesBars', () => {
    it('deletes the guarded minutes of the symbol and returns their ts; other minutes and symbols stay', async () => {
      await insertFuturesBars('ES', [bar(0), bar(1), bar(2)]);
      await insertFuturesBars('NQ', [bar(0)]);
      const [g0, , g2] = await guards();

      const done = await deleteFuturesBars('ES', [g0!, g2!]);

      expect(done).toEqual([T0, T2]);
      expect((await rows()).map((r) => r.ts)).toEqual(['2026-09-04T00:01:00Z']);
      expect(await rows('NQ')).toHaveLength(1);
    });

    it.each(['open', 'close'] as const)(
      'skips a minute whose %s changed since the read: the row stays and is not returned',
      async (column) => {
        await insertFuturesBars('ES', [bar(0), bar(1)]);
        const [g0, g1] = await guards();
        await changeBehindBack(column, T0);

        const done = await deleteFuturesBars('ES', [g0!, g1!]);

        expect(done).toEqual([T1]);
        expect((await rows()).map((r) => r.ts)).toEqual([
          '2026-09-04T00:00:00Z',
        ]);
      },
    );

    it('a minute with no row (already deleted, or never there) is not an error and is not returned', async () => {
      await insertFuturesBars('ES', [bar(0)]);
      const [g0] = await guards();

      await expect(deleteFuturesBars('ES', [g0!])).resolves.toEqual([T0]);
      await expect(deleteFuturesBars('ES', [g0!])).resolves.toEqual([]);
    });

    it('deletes in 500-row statements', async () => {
      await insertFuturesBars(
        'ES',
        Array.from({ length: 1001 }, (_, i) => bar(i)),
      );
      const g = await guards();

      const done = await deleteFuturesBars('ES', g);

      expect(done).toHaveLength(1001);
      expect(
        pg.queries.filter((q) => q.includes('DELETE FROM futures_bars')),
      ).toHaveLength(3);
      expect(await rows()).toEqual([]);
    });

    it('nothing to delete → no query', async () => {
      await expect(deleteFuturesBars('ES', [])).resolves.toEqual([]);
      expect(pg.queries).toHaveLength(0);
    });

    it('a rejected DELETE propagates', async () => {
      await insertFuturesBars('ES', [bar(0)]);
      const [g0] = await guards();
      await pg.db!.query('DROP TABLE futures_bars');

      await expect(deleteFuturesBars('ES', [g0!])).rejects.toThrow(
        /futures_bars/,
      );
    });
  });

  describe('fill (insertFuturesBars) in the repair', () => {
    it('never overwrites: a fill for a minute that gained a bar since the read leaves its prices, flow and NULL contract as stored', async () => {
      await insertFuturesBars('ES', [
        bar(0, { open: 1111, buyVolume: 9, sellVolume: 9 }),
      ]);

      const n = await insertFuturesBars('ES', [
        bar(0, {
          open: 2222,
          volume: 99,
          buyVolume: 1,
          sellVolume: 1,
          contract: 'ESU6',
        }),
      ]);

      expect(n).toBe(0);
      expect((await rows())[0]).toMatchObject({
        open: '1111.0000',
        volume: '10',
        buy_volume: '9',
        contract: null,
      });
    });
  });
});
