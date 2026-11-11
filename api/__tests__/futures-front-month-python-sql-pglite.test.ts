// @vitest-environment node

/**
 * REAL-SQL test for the statements the uw-stream futures_trades handler runs
 * against the front-month tables (`uw-stream/src/futures_front_month.py`).
 *
 * pytest cannot run them: no test in uw-stream may touch a database, so its
 * tests see only the SQL text and the arguments. This file reads the shipped
 * statements out of the Python source and runs them on pglite (real Postgres
 * in WASM) against the tables built from migration #205. asyncpg's `$n`
 * placeholders are Postgres' own, so they are bound as they are: the dates
 * and arrays the Python sends are strings and arrays here.
 *
 * What it pins, from the Python side of `api/_lib/futures-front-month.ts`:
 *  - the four-arm inputs read (incumbent, ceiling, the previous date's volume,
 *    the undecided dates) answers what `readInputs` answers;
 *  - the decision insert is DO NOTHING, written with source `live`, and the
 *    stored read sees the winner;
 *  - the tally upsert only raises a volume, writes `live`, and never writes a
 *    (product, trade date) that already has `candles` rows, whatever the
 *    contract (Phase 5a's one source per session, from the live side).
 *
 * A statement that cannot be found fails the file; it never skips.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

const PY_SOURCE = resolve(
  process.cwd(),
  'uw-stream/src/futures_front_month.py',
);

function loadSql(name: string): string {
  const match = new RegExp(`${name} = """([\\s\\S]*?)"""`).exec(
    readFileSync(PY_SOURCE, 'utf8'),
  );
  if (!match?.[1]) throw new Error(`${name} not found in ${PY_SOURCE}`);
  return match[1];
}

const SQL = {
  stored: loadSql('_STORED_SQL'),
  inputs: loadSql('_INPUTS_SQL'),
  insert: loadSql('_INSERT_DECISION_SQL'),
  load: loadSql('_LOAD_TALLY_SQL'),
  save: loadSql('_SAVE_TALLY_SQL'),
};

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await applyMigration(pg, 205);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('TRUNCATE futures_contract_volume, futures_front_month');
});

// ── Harness ───────────────────────────────────────────────

type Source = 'live' | 'candles';

async function putFront(product: string, day: string, contract: string) {
  await pg.query(
    `INSERT INTO futures_front_month (product, trade_date, contract, source)
     VALUES ($1, $2, $3, 'live')`,
    [product, day, contract],
  );
}

async function putVolumes(
  product: string,
  day: string,
  volumes: Record<string, number>,
  source: Source = 'live',
) {
  for (const [contract, volume] of Object.entries(volumes)) {
    await pg.query(
      `INSERT INTO futures_contract_volume
         (product, trade_date, contract, volume, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [product, day, contract, volume, source],
    );
  }
}

interface Inputs {
  incumbent: string | null;
  ceiling: string | null;
  volumes: Record<string, number>;
  undecided: string[];
}

/** The inputs statement, parsed the way `_read_inputs` parses its rows. */
async function readInputs(product: string, day: string): Promise<Inputs> {
  const { rows } = await pg.query<{
    kind: string;
    contract: string | null;
    volume: number | bigint | null;
    day: Date | null;
  }>(SQL.inputs, [product, day]);
  const inputs: Inputs = {
    incumbent: null,
    ceiling: null,
    volumes: {},
    undecided: [],
  };
  for (const r of rows) {
    if (r.kind === 'incumbent') inputs.incumbent = r.contract;
    else if (r.kind === 'ceiling') inputs.ceiling = r.contract;
    else if (r.kind === 'volume' && r.contract != null) {
      inputs.volumes[r.contract] = Number(r.volume);
    } else if (r.kind === 'undecided' && r.day != null) {
      inputs.undecided.push(r.day.toISOString().slice(0, 10));
    }
  }
  inputs.undecided.sort();
  return inputs;
}

async function stored(product: string, day: string): Promise<string | null> {
  const { rows } = await pg.query<{ contract: string }>(SQL.stored, [
    product,
    day,
  ]);
  return rows[0]?.contract ?? null;
}

type TallyRow = [
  product: string,
  day: string,
  contract: string,
  volume: number,
];

/** `save_tally`'s statement: the four columns as parallel arrays. */
async function save(rows: TallyRow[]) {
  await pg.query(SQL.save, [
    rows.map((r) => r[0]),
    rows.map((r) => r[1]),
    rows.map((r) => r[2]),
    rows.map((r) => r[3]),
  ]);
}

async function volumeRows() {
  const { rows } = await pg.query<{
    product: string;
    trade_date: string;
    contract: string;
    volume: string;
    source: string;
  }>(
    `SELECT product, trade_date::text AS trade_date, contract,
            volume::text AS volume, source
       FROM futures_contract_volume ORDER BY product, trade_date, contract`,
  );
  return rows.map(
    (r) =>
      [
        r.product,
        r.trade_date,
        r.contract,
        Number(r.volume),
        r.source,
      ] as const,
  );
}

// ── The inputs read ───────────────────────────────────────

describe('_INPUTS_SQL', () => {
  it('answers nothing on an empty database', async () => {
    expect(await readInputs('ES', '2026-11-06')).toEqual({
      incumbent: null,
      ceiling: null,
      volumes: {},
      undecided: [],
    });
  });

  it('takes the incumbent from the latest decision before the date: not the oldest, not a later one, not its own date', async () => {
    await putFront('ES', '2026-11-02', 'ESZ6');
    await putFront('ES', '2026-11-04', 'ESH7');
    await putFront('ES', '2026-11-06', 'ESM7');
    await putFront('ES', '2026-11-09', 'ESU7');

    expect((await readInputs('ES', '2026-11-06')).incumbent).toBe('ESH7');
    expect((await readInputs('ES', '2026-11-05')).incumbent).toBe('ESH7');
    expect((await readInputs('ES', '2026-11-02')).incumbent).toBeNull();
  });

  it('takes the ceiling from the earliest decision after the date', async () => {
    await putFront('ES', '2026-11-04', 'ESZ6');
    await putFront('ES', '2026-11-09', 'ESH7');
    await putFront('ES', '2026-11-10', 'ESM7');

    expect((await readInputs('ES', '2026-11-05')).ceiling).toBe('ESH7');
    expect((await readInputs('ES', '2026-11-09')).ceiling).toBe('ESM7');
    expect((await readInputs('ES', '2026-11-10')).ceiling).toBeNull();
  });

  it('reads the volume of the latest earlier date that has any, across a weekend, never the date itself or a later one', async () => {
    await putVolumes('ES', '2026-11-05', { ESZ6: 100 });
    await putVolumes('ES', '2026-11-06', { ESZ6: 500, ESH7: 900 });
    await putVolumes('ES', '2026-11-09', { ESZ6: 1, ESH7: 2 });
    await putVolumes('ES', '2026-11-10', { ESZ6: 7 });

    // 11-09 is a Monday: 11-07 and 11-08 have nothing, 11-06 is the latest.
    expect((await readInputs('ES', '2026-11-09')).volumes).toEqual({
      ESZ6: 500,
      ESH7: 900,
    });
    expect((await readInputs('ES', '2026-11-10')).volumes).toEqual({
      ESZ6: 1,
      ESH7: 2,
    });
    expect((await readInputs('ES', '2026-11-05')).volumes).toEqual({});
  });

  it('lists the dates with volume rows after the incumbent and before the date, and not the incumbent’s own', async () => {
    await putFront('ES', '2026-11-03', 'ESZ6');
    await putVolumes('ES', '2026-11-03', { ESZ6: 100 });
    // Written out of date order on purpose.
    await putVolumes('ES', '2026-11-06', { ESZ6: 1 });
    await putVolumes('ES', '2026-11-04', { ESZ6: 1, ESH7: 2 });
    await putVolumes('ES', '2026-11-05', { ESZ6: 1 });
    await putVolumes('ES', '2026-11-12', { ESZ6: 1 });

    expect((await readInputs('ES', '2026-11-09')).undecided).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect((await readInputs('ES', '2026-11-04')).undecided).toEqual([]);
  });

  it('lists no undecided date with no incumbent, however much volume history there is', async () => {
    await putVolumes('ES', '2026-11-03', { ESZ6: 1 });
    await putVolumes('ES', '2026-11-04', { ESZ6: 1 });

    const inputs = await readInputs('ES', '2026-11-06');
    expect(inputs.undecided).toEqual([]);
    expect(inputs.volumes).toEqual({ ESZ6: 1 });
  });

  it('reads only its own product', async () => {
    await putFront('NQ', '2026-11-04', 'NQZ6');
    await putVolumes('NQ', '2026-11-05', { NQH7: 5 });
    await putFront('ES', '2026-11-04', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 9 });

    expect(await readInputs('ES', '2026-11-06')).toEqual({
      incumbent: 'ESZ6',
      ceiling: null,
      volumes: { ESZ6: 9 },
      undecided: ['2026-11-05'],
    });
  });

  it('reads volume rows of either source', async () => {
    await putVolumes('ES', '2026-11-05', { ESZ6: 3 }, 'candles');
    await putVolumes('ES', '2026-11-06', { ESZ6: 4 }, 'live');

    expect((await readInputs('ES', '2026-11-06')).volumes).toEqual({ ESZ6: 3 });
    expect((await readInputs('ES', '2026-11-07')).volumes).toEqual({ ESZ6: 4 });
  });

  it('reads a volume above 2^31 as the exact number', async () => {
    await putVolumes('ES', '2026-11-05', { ESZ6: 5_000_000_000 });
    expect((await readInputs('ES', '2026-11-06')).volumes).toEqual({
      ESZ6: 5_000_000_000,
    });
  });

  it('agrees with a plain reference model on 150 seeded random states', async () => {
    // mulberry32: a fixed seed, so a failure is the same failure every run.
    let seed = 20261111;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const day = (n: number) =>
      new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
    const contracts = ['ESZ6', 'ESH7', 'ESM7', 'ESU7'] as const;

    for (let i = 0; i < 150; i++) {
      await pg.exec('TRUNCATE futures_contract_volume, futures_front_month');
      const front: Array<[string, string, string]> = [];
      const volumes: Array<[string, string, string, number]> = [];
      for (const product of ['ES', 'NQ']) {
        for (let n = 0; n < 12; n++) {
          if (rand() < 0.35) {
            front.push([
              product,
              day(n),
              product === 'ES' ? pick(contracts) : 'NQZ6',
            ]);
          }
          if (rand() < 0.5) {
            const count = 1 + Math.floor(rand() * 3);
            for (const c of [...contracts]
              .sort(() => rand() - 0.5)
              .slice(0, count)) {
              volumes.push([
                product,
                day(n),
                c,
                Math.floor(rand() * 1_000_000),
              ]);
            }
          }
        }
      }
      for (const [p, d, c] of front) await putFront(p, d, c);
      for (const [p, d, c, v] of volumes) await putVolumes(p, d, { [c]: v });

      const asked = day(Math.floor(rand() * 14));
      const mine = front.filter(([p]) => p === 'ES');
      const before = mine
        .filter(([, d]) => d < asked)
        .sort((a, b) => a[1].localeCompare(b[1]));
      const after = mine
        .filter(([, d]) => d > asked)
        .sort((a, b) => a[1].localeCompare(b[1]));
      const volDays = [
        ...new Set(
          volumes.filter(([p, d]) => p === 'ES' && d < asked).map(([, d]) => d),
        ),
      ].sort();
      const latestVolDay = volDays.at(-1);
      const expected: Inputs = {
        incumbent: before.at(-1)?.[2] ?? null,
        ceiling: after[0]?.[2] ?? null,
        volumes: Object.fromEntries(
          volumes
            .filter(([p, d]) => p === 'ES' && d === latestVolDay)
            .map(([, , c, v]) => [c, v]),
        ),
        undecided: before.length
          ? volDays.filter((d) => d > before.at(-1)![1])
          : [],
      };

      expect(
        await readInputs('ES', asked),
        `state ${i}, asked ${asked}`,
      ).toEqual(expected);
    }
  });
});

// ── The decision insert and the stored read ───────────────

describe('_INSERT_DECISION_SQL and _STORED_SQL', () => {
  it('reads nothing, then the row that was inserted, written with the live source', async () => {
    expect(await stored('ES', '2026-11-06')).toBeNull();

    await pg.query(SQL.insert, ['ES', '2026-11-06', 'ESH7']);

    expect(await stored('ES', '2026-11-06')).toBe('ESH7');
    const { rows } = await pg.query<{ source: string; decided_at: Date }>(
      'SELECT source, decided_at FROM futures_front_month',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('live');
    expect(rows[0]!.decided_at).toBeInstanceOf(Date);
  });

  it('is ON CONFLICT DO NOTHING: the first writer wins, the second changes nothing and the re-read sees the winner', async () => {
    await pg.query(SQL.insert, ['ES', '2026-11-06', 'ESH7']);
    await pg.query(SQL.insert, ['ES', '2026-11-06', 'ESZ6']);

    expect(await stored('ES', '2026-11-06')).toBe('ESH7');
    const { rows } = await pg.query('SELECT 1 FROM futures_front_month');
    expect(rows).toHaveLength(1);
  });

  it('does not touch the row of another date or product, and a row written by another source keeps its source', async () => {
    await pg.query(
      `INSERT INTO futures_front_month (product, trade_date, contract, source)
       VALUES ('ES', '2026-11-06', 'ESZ6', 'cron')`,
    );
    await pg.query(SQL.insert, ['ES', '2026-11-06', 'ESH7']);
    await pg.query(SQL.insert, ['NQ', '2026-11-06', 'NQZ6']);
    await pg.query(SQL.insert, ['ES', '2026-11-09', 'ESH7']);

    const { rows } = await pg.query<{
      product: string;
      d: string;
      contract: string;
      source: string;
    }>(
      `SELECT product, trade_date::text AS d, contract, source
         FROM futures_front_month ORDER BY product, trade_date`,
    );
    expect(rows.map((r) => [r.product, r.d, r.contract, r.source])).toEqual([
      ['ES', '2026-11-06', 'ESZ6', 'cron'],
      ['ES', '2026-11-09', 'ESH7', 'live'],
      ['NQ', '2026-11-06', 'NQZ6', 'live'],
    ]);
  });
});

// ── The tally ─────────────────────────────────────────────

describe('_SAVE_TALLY_SQL', () => {
  const D = '2026-11-06';

  it('writes every row of several roots, dates and contracts in one statement, as live', async () => {
    await save([
      ['ES', D, 'ESZ6', 500],
      ['ES', D, 'ESH7', 90],
      ['NQ', D, 'NQZ6', 40],
      ['ES', '2026-11-09', 'ESH7', 7],
    ]);

    expect(await volumeRows()).toEqual([
      ['ES', D, 'ESH7', 90, 'live'],
      ['ES', D, 'ESZ6', 500, 'live'],
      ['ES', '2026-11-09', 'ESH7', 7, 'live'],
      ['NQ', D, 'NQZ6', 40, 'live'],
    ]);
  });

  it('only raises a volume: a lower count leaves the stored one, a higher one replaces it', async () => {
    await save([
      ['ES', D, 'ESZ6', 500],
      ['ES', D, 'ESH7', 90],
    ]);
    await save([
      ['ES', D, 'ESZ6', 300], // a restart recounting from a lower number
      ['ES', D, 'ESH7', 120],
    ]);

    expect(await volumeRows()).toEqual([
      ['ES', D, 'ESH7', 120, 'live'],
      ['ES', D, 'ESZ6', 500, 'live'],
    ]);
  });

  it('stamps updated_at when it raises a volume', async () => {
    await save([['ES', D, 'ESZ6', 10]]);
    await pg.query(
      `UPDATE futures_contract_volume SET updated_at = '2020-01-01T00:00:00Z'`,
    );
    await save([['ES', D, 'ESZ6', 11]]);

    const { rows } = await pg.query<{ fresh: boolean }>(
      `SELECT updated_at > '2020-01-02T00:00:00Z' AS fresh FROM futures_contract_volume`,
    );
    expect(rows).toEqual([{ fresh: true }]);
  });

  it('keeps a volume above 2^31 exact', async () => {
    await save([['ES', D, 'ESZ6', 5_000_000_000]]);
    expect(await volumeRows()).toEqual([
      ['ES', D, 'ESZ6', 5_000_000_000, 'live'],
    ]);
  });

  describe('one source per session, from the live side', () => {
    it('writes no live row into a session that has candle rows, not even for a contract the candles never listed', async () => {
      await putVolumes('ES', D, { ESZ6: 900 }, 'candles');

      await save([
        ['ES', D, 'ESZ6', 99_999],
        ['ES', D, 'ESH7', 5],
      ]);

      expect(await volumeRows()).toEqual([['ES', D, 'ESZ6', 900, 'candles']]);
    });

    it('is decided per (product, trade date): another date, or another root, of the same batch still lands', async () => {
      await putVolumes('ES', '2026-11-05', { ESZ6: 900 }, 'candles');

      await save([
        ['ES', '2026-11-05', 'ESH7', 5], // the candle session: skipped
        ['ES', D, 'ESZ6', 7], // the next session: written
        ['NQ', '2026-11-05', 'NQZ6', 3], // another root, same date: written
      ]);

      expect(await volumeRows()).toEqual([
        ['ES', '2026-11-05', 'ESZ6', 900, 'candles'],
        ['ES', D, 'ESZ6', 7, 'live'],
        ['NQ', '2026-11-05', 'NQZ6', 3, 'live'],
      ]);
    });

    it('keeps writing to a session that has only live rows', async () => {
      await save([['ES', D, 'ESZ6', 5]]);
      await save([
        ['ES', D, 'ESZ6', 8],
        ['ES', D, 'ESH7', 2],
      ]);

      expect(await volumeRows()).toEqual([
        ['ES', D, 'ESH7', 2, 'live'],
        ['ES', D, 'ESZ6', 8, 'live'],
      ]);
    });

    it('never lets a candle row it skipped change', async () => {
      await putVolumes('ES', D, { ESZ6: 900 }, 'candles');
      await pg.query(
        `UPDATE futures_contract_volume SET updated_at = '2020-01-01T00:00:00Z'`,
      );

      await save([['ES', D, 'ESZ6', 99_999]]);

      const { rows } = await pg.query<{ volume: string; stale: boolean }>(
        `SELECT volume::text AS volume, updated_at < '2020-01-02T00:00:00Z' AS stale
           FROM futures_contract_volume`,
      );
      expect(rows).toEqual([{ volume: '900', stale: true }]);
    });
  });

  it('rejects one statement that names a row twice, which is why save_tally collapses repeated keys first', async () => {
    await expect(
      save([
        ['ES', D, 'ESZ6', 5],
        ['ES', D, 'ESZ6', 9],
      ]),
    ).rejects.toThrow(/second time/);
    expect(await volumeRows()).toEqual([]);
  });
});

describe('_LOAD_TALLY_SQL', () => {
  it('reads the rows of one root and trade date, whatever their source', async () => {
    await putVolumes('ES', '2026-11-06', { ESZ6: 500 }, 'live');
    await putVolumes('ES', '2026-11-06', { ESH7: 90 }, 'candles');
    await putVolumes('ES', '2026-11-05', { ESZ6: 1 });
    await putVolumes('NQ', '2026-11-06', { NQZ6: 2 });

    const { rows } = await pg.query<{
      contract: string;
      volume: string | number;
    }>(SQL.load, ['ES', '2026-11-06']);

    expect(rows.map((r) => [r.contract, Number(r.volume)]).sort()).toEqual([
      ['ESH7', 90],
      ['ESZ6', 500],
    ]);
  });

  it('reads back what save wrote', async () => {
    await save([
      ['ES', '2026-11-06', 'ESZ6', 500],
      ['ES', '2026-11-06', 'ESH7', 90],
    ]);
    const { rows } = await pg.query<{
      contract: string;
      volume: string | number;
    }>(SQL.load, ['ES', '2026-11-06']);
    expect(
      Object.fromEntries(rows.map((r) => [r.contract, Number(r.volume)])),
    ).toEqual({
      ESZ6: 500,
      ESH7: 90,
    });
  });
});
