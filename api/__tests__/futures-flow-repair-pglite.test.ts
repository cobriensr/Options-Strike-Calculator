// @vitest-environment node

/**
 * REAL-SQL test for the order-flow repair's two queries.
 *
 * futures-flow-repair.test.ts mocks the DB and only sees SQL text. Here
 * futures_bars comes from the REAL migrations on pglite (real Postgres in
 * WASM): #42 creates it (its es_bars copy is left out: that table no
 * longer exists) and #193 adds the order-flow columns. It checks what the
 * mocks can't: the conditional UPDATE writes only bars whose buy_volume is
 * still NULL, so websocket flow is never overwritten and a re-run is a
 * no-op, and the detection query's LAG flags where each NULL run starts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATIONS, type Migration } from '../_lib/db-migrations.js';

const { pg } = vi.hoisted(() => ({ pg: { db: null as PGlite | null } }));

vi.mock('../_lib/db.js', () => ({
  getDb:
    () =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
      return pg.db!.query(text, values).then((r) => r.rows);
    },
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: vi.fn(),
  withRetry: vi.fn(),
}));

import {
  fetchNullFlowBars,
  groupFlowRanges,
  writeFlowMinutes,
  type FlowMinute,
} from '../_lib/futures-flow-repair.js';

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

async function bar(
  symbol: string,
  ts: string,
  volume: number,
  flowCols: [number, number, number, number] | null = null,
): Promise<void> {
  await pg.db!.query(
    `INSERT INTO futures_bars
       (symbol, ts, open, high, low, close, volume,
        buy_volume, sell_volume, buy_prints, sell_prints)
     VALUES ($1, $2, 7700, 7701, 7699, 7700.5, $3, $4, $5, $6, $7)`,
    [symbol, ts, volume, ...(flowCols ?? [null, null, null, null])],
  );
}

async function flowOf(symbol: string, ts: string) {
  const { rows } = await pg.db!.query<{
    buy_volume: string | null;
    sell_volume: string | null;
    buy_prints: number | null;
    sell_prints: number | null;
  }>(
    `SELECT buy_volume::text, sell_volume::text, buy_prints, sell_prints
       FROM futures_bars WHERE symbol = $1 AND ts = $2`,
    [symbol, ts],
  );
  return rows[0];
}

function flow(ts: string, buy: number, sell: number, bp: number, sp: number) {
  return {
    ts,
    volume: buy + sell,
    buyVolume: buy,
    sellVolume: sell,
    buyPrints: bp,
    sellPrints: sp,
  } satisfies FlowMinute;
}

const T0 = '2026-10-28T14:00:00.000Z';
const T1 = '2026-10-28T14:01:00.000Z';
const T2 = '2026-10-28T14:02:00.000Z';
const T3 = '2026-10-28T14:03:00.000Z';

describe('futures-flow-repair SQL (pglite)', () => {
  beforeEach(async () => {
    pg.db = new PGlite();
    await applyStatements(pg.db, 42, (text) => !/\bes_bars\b/.test(text));
    await applyStatements(pg.db, 193);
  });

  afterEach(async () => {
    await pg.db?.close();
    pg.db = null;
  });

  it('writes flow only onto NULL-flow bars of the symbol, never over websocket flow, and a re-run is a no-op', async () => {
    await bar('ES', T0, 100);
    await bar('ES', T1, 50, [30, 20, 3, 2]); // websocket-written
    await bar('ES', T2, 80);
    await bar('NQ', T0, 40);

    const minutes = [
      flow(T0, 60, 40, 6, 4),
      flow(T1, 1, 1, 1, 1), // must not replace the websocket's 30/20
      flow(T2, 50, 30, 5, 3),
      flow(T3, 9, 9, 9, 9), // no bar: nothing to update
    ];

    await expect(writeFlowMinutes('ES', minutes)).resolves.toBe(2);

    expect(await flowOf('ES', T0)).toEqual({
      buy_volume: '60',
      sell_volume: '40',
      buy_prints: 6,
      sell_prints: 4,
    });
    expect(await flowOf('ES', T1)).toEqual({
      buy_volume: '30',
      sell_volume: '20',
      buy_prints: 3,
      sell_prints: 2,
    });
    expect(await flowOf('ES', T2)).toMatchObject({ buy_volume: '50' });
    // Another symbol at the same minute is untouched.
    expect(await flowOf('NQ', T0)).toMatchObject({ buy_volume: null });

    await expect(writeFlowMinutes('ES', minutes)).resolves.toBe(0);
  });

  it('finds NULL-flow bars and starts a new range after any bar that already has flow', async () => {
    await bar('ES', T0, 100);
    await bar('ES', T1, 50, [30, 20, 3, 2]);
    await bar('ES', T2, 80);
    await bar('ES', T3, 70);
    await bar('NQ', T1, 40);
    // Outside the window.
    await bar('ES', '2026-10-29T00:00:00.000Z', 5);

    const rows = await fetchNullFlowBars(
      ['ES', 'NQ'],
      '2026-10-28T00:00:00.000Z',
      '2026-10-29T00:00:00.000Z',
    );

    expect(rows).toEqual([
      { symbol: 'ES', ts: T0, volume: 100, startsRange: true },
      { symbol: 'ES', ts: T2, volume: 80, startsRange: true },
      { symbol: 'ES', ts: T3, volume: 70, startsRange: false },
      { symbol: 'NQ', ts: T1, volume: 40, startsRange: true },
    ]);
    expect(groupFlowRanges(rows).map((r) => r.bars.length)).toEqual([1, 2, 1]);
  });
});
