// @vitest-environment node

/**
 * REAL-SQL test for the per-session front-month store
 * (`api/_lib/futures-front-month.ts`): the decision for one root and trade
 * date is read from `futures_front_month` and `futures_contract_volume`,
 * made once, and written with ON CONFLICT DO NOTHING, then read back so
 * every writer ends up with the same answer.
 *
 * The tables are built from the real migration #205 on pglite (real
 * Postgres in WASM). `getDb` is the only seam: a tagged template over
 * pglite that can fail a statement or run another writer's statement
 * just before one, and `withDbRetry` is the real one.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

const { pg, mockWarn } = vi.hoisted(() => ({
  pg: {
    db: null as PGlite | null,
    queries: [] as string[],
    /** Reject the next `times` statements whose text matches. */
    fail: null as { match: RegExp; error: Error; times: number } | null,
    /** Run `run` before the statement that matches, after `skip` matches. */
    before: null as {
      match: RegExp;
      skip: number;
      run: () => Promise<unknown>;
    } | null,
  },
  mockWarn: vi.fn(),
}));

vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb:
      () =>
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
        pg.queries.push(text);
        return (async () => {
          const { before } = pg;
          if (before?.match.test(text)) {
            if (before.skip > 0) {
              before.skip -= 1;
            } else {
              pg.before = null;
              await before.run();
            }
          }
          // Read after the hook: it may arm a failure for this statement.
          const { fail } = pg;
          if (fail?.match.test(text) && fail.times > 0) {
            fail.times -= 1;
            throw fail.error;
          }
          return (await pg.db!.query(text, values)).rows;
        })();
      },
    withDbRetry: actual.withDbRetry,
    isRetryableDbError: actual.isRetryableDbError,
    TransientDbError: actual.TransientDbError,
  };
});

vi.mock('../_lib/logger.js', () => ({
  default: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ensureFrontMonth,
  fetchFrontMonthSchedule,
  insertContractVolumes,
  insertFrontMonthRows,
} from '../_lib/futures-front-month.js';

// ── Harness ───────────────────────────────────────────────

/** 2026-11-10 09:00 CST: the current trade date is 2026-11-10. */
const NOW = '2026-11-10T15:00:00.000Z';

/** The statements that read, as the tests tell them apart. */
const STORED_READ =
  /FROM futures_front_month\s+WHERE product = \$1 AND trade_date = \$2::date/;
const INPUTS_READ = /UNION ALL/;
const FRONT_INSERT = /INSERT INTO futures_front_month/;
const VOLUME_INSERT = /INSERT INTO futures_contract_volume/;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyMigration(db, 205);
  pg.db = db;
});

afterAll(async () => {
  pg.db = null;
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE futures_contract_volume, futures_front_month');
  pg.queries = [];
  pg.fail = null;
  pg.before = null;
  mockWarn.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

async function putFront(
  product: string,
  tradeDate: string,
  contract: string,
  source = 'live',
) {
  await db.query(
    `INSERT INTO futures_front_month (product, trade_date, contract, source)
     VALUES ($1, $2, $3, $4)`,
    [product, tradeDate, contract, source],
  );
}

async function putVolumes(
  product: string,
  tradeDate: string,
  volumes: Record<string, number>,
) {
  for (const [contract, volume] of Object.entries(volumes)) {
    await db.query(
      `INSERT INTO futures_contract_volume
         (product, trade_date, contract, volume, source)
       VALUES ($1, $2, $3, $4, 'live')`,
      [product, tradeDate, contract, volume],
    );
  }
}

async function frontRows() {
  const { rows } = await db.query<{
    product: string;
    trade_date: string;
    contract: string;
    source: string;
  }>(
    `SELECT product, trade_date::text AS trade_date, contract, source
       FROM futures_front_month ORDER BY product, trade_date`,
  );
  return rows;
}

async function volumeRows() {
  const { rows } = await db.query<{
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
  return rows;
}

const count = (re: RegExp) => pg.queries.filter((q) => re.test(q)).length;

// ── ensureFrontMonth ──────────────────────────────────────

describe('ensureFrontMonth', () => {
  it('decides from the previous decision and the previous date’s volumes, stores the row under the writer’s source, and returns it', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 500, ESH7: 900 });

    await expect(ensureFrontMonth('ES', '2026-11-06', 'cron')).resolves.toBe(
      'ESH7',
    );

    expect(await frontRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        source: 'live',
      },
      {
        product: 'ES',
        trade_date: '2026-11-06',
        contract: 'ESH7',
        source: 'cron',
      },
    ]);
  });

  it('records the script source too', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');

    await ensureFrontMonth('ES', '2026-11-06', 'script');

    expect((await frontRows()).at(-1)).toMatchObject({ source: 'script' });
  });

  it('keeps the incumbent when it out-traded, and a tie', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 700, ESH7: 700 });

    await expect(ensureFrontMonth('ES', '2026-11-06', 'cron')).resolves.toBe(
      'ESZ6',
    );
  });

  it('writes once: a second call returns the stored row, even after the volumes change, and costs one read', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 500, ESH7: 900 });
    await ensureFrontMonth('ES', '2026-11-06', 'cron');

    await db.query(
      `UPDATE futures_contract_volume SET volume = CASE contract
         WHEN 'ESZ6' THEN 99999 ELSE 1 END`,
    );
    pg.queries = [];
    await expect(ensureFrontMonth('ES', '2026-11-06', 'script')).resolves.toBe(
      'ESH7',
    );

    expect(pg.queries).toHaveLength(1);
    const rows = await frontRows();
    expect(rows.filter((r) => r.trade_date === '2026-11-06')).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-06',
        contract: 'ESH7',
        source: 'cron',
      },
    ]);
  });

  it('takes the incumbent from the latest decision before the date: not the oldest, not a later one', async () => {
    await putFront('ES', '2026-11-04', 'ESU6');
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putFront('ES', '2026-11-10', 'ESM7');
    // From ESZ6, ESH7 (200) out-trades it (100) and rolls. From ESU6 the
    // best later month is ESH7 at 200, which does not beat ESU6's 500.
    await putVolumes('ES', '2026-11-06', { ESU6: 500, ESZ6: 100, ESH7: 200 });

    await expect(ensureFrontMonth('ES', '2026-11-09', 'cron')).resolves.toBe(
      'ESH7',
    );
  });

  it('reads volume from the latest earlier trade date that has any, across a weekend, never the date itself or a later one', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 900, ESH7: 100 });
    await putVolumes('ES', '2026-11-06', { ESZ6: 100, ESH7: 900 });
    await putVolumes('ES', '2026-11-09', { ESZ6: 5000, ESH7: 1 });
    await putVolumes('ES', '2026-11-10', { ESZ6: 5000, ESH7: 1 });

    // Friday's rows decide Monday: ESH7 out-traded ESZ6.
    await expect(ensureFrontMonth('ES', '2026-11-09', 'cron')).resolves.toBe(
      'ESH7',
    );
  });

  it('only reads its own product', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putVolumes('ES', '2026-11-05', { ESZ6: 100, ESH7: 900 });
    // Newer rows of another product must not become ES's input.
    await putFront('NQ', '2026-11-06', 'NQH7');
    await putVolumes('NQ', '2026-11-06', { NQZ6: 9999 });

    await expect(ensureFrontMonth('ES', '2026-11-09', 'cron')).resolves.toBe(
      'ESH7',
    );
  });

  it('with no rows at all returns the cycle seed, stores it, and warns once, naming the root and the date', async () => {
    await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).resolves.toBe(
      'ESZ6',
    );

    expect(await frontRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        source: 'cron',
      },
    ]);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'ES', tradeDate: '2026-11-05' }),
      expect.any(String),
    );
  });

  it('does not warn when an incumbent decides with no volume, or volume decides with no incumbent', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    await expect(ensureFrontMonth('ES', '2026-11-06', 'cron')).resolves.toBe(
      'ESZ6',
    );

    await putVolumes('NQ', '2026-11-05', { NQH7: 900, NQZ6: 100 });
    await expect(ensureFrontMonth('NQ', '2026-11-06', 'cron')).resolves.toBe(
      'NQH7',
    );

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('refuses a trade date after the current one, naming the product and both dates, before any query', async () => {
    await expect(ensureFrontMonth('ES', '2026-11-11', 'cron')).rejects.toThrow(
      /ES.*2026-11-11.*2026-11-10/,
    );

    expect(pg.queries).toEqual([]);
    expect(await frontRows()).toEqual([]);
  });

  it('allows the current trade date, which follows the 17:00 CT open and not the UTC date', async () => {
    // 22:59Z is 16:59 CST: still trade date 2026-11-10.
    vi.setSystemTime(new Date('2026-11-10T22:59:00.000Z'));
    await expect(ensureFrontMonth('ES', '2026-11-11', 'cron')).rejects.toThrow(
      /after the current trade date 2026-11-10/,
    );

    // 23:00Z is the open: the current trade date is 2026-11-11, though the
    // UTC date is still 2026-11-10.
    vi.setSystemTime(new Date('2026-11-10T23:00:00.000Z'));
    await expect(ensureFrontMonth('ES', '2026-11-11', 'cron')).resolves.toBe(
      'ESZ6',
    );
    await expect(ensureFrontMonth('ES', '2026-11-12', 'cron')).rejects.toThrow(
      /2026-11-12.*2026-11-11/,
    );
  });

  it.each(['2026-11-5', '', '2026-13-01', '2026-02-30', 'tomorrow'])(
    'rejects the malformed trade date %j before any query',
    async (tradeDate) => {
      await expect(ensureFrontMonth('ES', tradeDate, 'cron')).rejects.toThrow(
        /trade date/,
      );

      expect(pg.queries).toEqual([]);
    },
  );

  it('throws on a stored incumbent that is not an outright of the root, and writes nothing', async () => {
    await putFront('ES', '2026-11-05', 'NQZ6');

    await expect(ensureFrontMonth('ES', '2026-11-06', 'cron')).rejects.toThrow(
      /incumbent.*NQZ6/,
    );

    expect(count(FRONT_INSERT)).toBe(0);
  });
});

describe('ensureFrontMonth: when the database fails', () => {
  const boom = new Error('connection lost');

  it.each([
    ['the stored-row read', STORED_READ, 1],
    ['the inputs read', INPUTS_READ, 2],
    ['the insert', FRONT_INSERT, 3],
  ] as const)(
    'rejects with the database error when %s fails, and stores nothing',
    async (_what, match, queriesBefore) => {
      pg.fail = { match, error: boom, times: 1 };

      await expect(
        ensureFrontMonth('ES', '2026-11-05', 'cron'),
      ).rejects.toThrow('connection lost');

      // It stopped at the failing statement: no retry of a genuine error and
      // no statement after it.
      expect(pg.queries).toHaveLength(queriesBefore);
      expect(await frontRows()).toEqual([]);
    },
  );

  it('rejects with the database error when the re-read after the insert fails; the row is stored', async () => {
    pg.before = {
      match: STORED_READ,
      skip: 1,
      run: async () => {
        pg.fail = { match: STORED_READ, error: boom, times: 1 };
      },
    };

    await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).rejects.toThrow(
      'connection lost',
    );

    expect(await frontRows()).toHaveLength(1);
  });

  it.each([
    // The stored-row statement runs twice anyway: before and after the insert.
    ['the stored-row read', STORED_READ, 3],
    ['the inputs read', INPUTS_READ, 2],
    ['the insert', FRONT_INSERT, 2],
  ] as const)(
    'retries a transient failure of %s once and still decides',
    async (_what, match, runs) => {
      pg.fail = { match, error: new Error('fetch failed'), times: 1 };

      await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).resolves.toBe(
        'ESZ6',
      );

      expect(count(match)).toBe(runs);
      expect(await frontRows()).toHaveLength(1);
    },
  );

  it('lets the row that is stored win a race: another writer inserts after the inputs are read, and every caller gets its answer', async () => {
    // This writer would decide the seed, ESZ6. The other one, a uw-stream
    // that saw a different tally, wins with ESH7.
    pg.before = {
      match: FRONT_INSERT,
      skip: 0,
      run: () => putFront('ES', '2026-11-05', 'ESH7', 'live'),
    };

    await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).resolves.toBe(
      'ESH7',
    );

    expect(await frontRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESH7',
        source: 'live',
      },
    ]);
  });

  it('throws, naming the product and the date, when the row is gone at the re-read', async () => {
    pg.before = {
      match: STORED_READ,
      skip: 1,
      run: () => db.exec('DELETE FROM futures_front_month'),
    };

    await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).rejects.toThrow(
      /ES.*2026-11-05.*missing/,
    );
  });
});

// ── fetchFrontMonthSchedule ───────────────────────────────

describe('fetchFrontMonthSchedule', () => {
  it('decides each asked date in turn, answers only those dates, and lists the contracts in date order', async () => {
    await putFront('ES', '2026-11-03', 'ESZ6');
    await putVolumes('ES', '2026-11-03', { ESZ6: 100, ESH7: 50 });
    await putVolumes('ES', '2026-11-04', { ESZ6: 100, ESH7: 900 });

    const schedule = await fetchFrontMonthSchedule(
      'ES',
      ['2026-11-04', '2026-11-05', '2026-11-06'],
      'cron',
    );

    // The tally of 11-03 keeps ESZ6 for 11-04; that of 11-04 rolls 11-05.
    expect(schedule.contractFor('2026-11-04')).toBe('ESZ6');
    expect(schedule.contractFor('2026-11-05')).toBe('ESH7');
    expect(schedule.contractFor('2026-11-06')).toBe('ESH7');
    expect(schedule.contractFor('2026-11-07')).toBeUndefined();
    expect(schedule.contracts).toEqual(['ESZ6', 'ESH7']);
    expect((await frontRows()).map((r) => [r.trade_date, r.contract])).toEqual([
      ['2026-11-03', 'ESZ6'],
      ['2026-11-04', 'ESZ6'],
      ['2026-11-05', 'ESH7'],
      ['2026-11-06', 'ESH7'],
    ]);
  });

  it('decides in date order whatever order the dates come in, so the series never steps back', async () => {
    await putFront('ES', '2026-11-04', 'ESZ6');
    await putVolumes('ES', '2026-11-04', { ESZ6: 100, ESH7: 900 });
    await putVolumes('ES', '2026-11-05', { ESZ6: 900, ESH7: 100 });

    // Newest first: decided that way, 11-09 would see only 11-04's front
    // and 11-05's tally and fall back to ESZ6 after 11-05 rolled.
    const schedule = await fetchFrontMonthSchedule(
      'ES',
      ['2026-11-09', '2026-11-06', '2026-11-05'],
      'cron',
    );

    expect(
      ['2026-11-05', '2026-11-06', '2026-11-09'].map(schedule.contractFor),
    ).toEqual(['ESH7', 'ESH7', 'ESH7']);
    expect(schedule.contracts).toEqual(['ESH7']);
  });

  it('reads the dates already decided in one query, and decides only the missing ones', async () => {
    await putFront('ES', '2026-11-04', 'ESZ6');
    await putFront('ES', '2026-11-05', 'ESZ6');
    await putFront('ES', '2026-11-06', 'ESZ6');

    const schedule = await fetchFrontMonthSchedule(
      'ES',
      ['2026-11-04', '2026-11-05', '2026-11-06'],
      'cron',
    );

    expect(schedule.contracts).toEqual(['ESZ6']);
    expect(pg.queries).toHaveLength(1);

    pg.queries = [];
    await fetchFrontMonthSchedule(
      'ES',
      ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'],
      'cron',
    );
    // The batched read, then the one new date: its stored-row read, the
    // inputs, the insert and the re-read.
    expect(pg.queries).toHaveLength(5);
    expect(count(FRONT_INSERT)).toBe(1);
  });

  it('asks once for a date that is listed twice', async () => {
    await fetchFrontMonthSchedule('ES', ['2026-11-05', '2026-11-05'], 'cron');

    expect(count(FRONT_INSERT)).toBe(1);
    expect(await frontRows()).toHaveLength(1);
  });

  it('answers undefined, and runs no query, for no dates', async () => {
    const schedule = await fetchFrontMonthSchedule('ES', [], 'cron');

    expect(schedule.contractFor('2026-11-05')).toBeUndefined();
    expect(schedule.contracts).toEqual([]);
    expect(pg.queries).toEqual([]);
  });

  it('refuses the whole call, before any query, when one date is after the current trade date', async () => {
    await expect(
      fetchFrontMonthSchedule('ES', ['2026-11-05', '2026-11-11'], 'cron'),
    ).rejects.toThrow(/ES.*2026-11-11.*2026-11-10/);

    expect(pg.queries).toEqual([]);
  });

  it('rejects with the database error from the batched read', async () => {
    pg.fail = {
      match: /ANY/,
      error: new Error('connection lost'),
      times: 1,
    };

    await expect(
      fetchFrontMonthSchedule('ES', ['2026-11-05'], 'cron'),
    ).rejects.toThrow('connection lost');

    expect(pg.queries).toHaveLength(1);
  });

  it('retries a transient failure of the batched read once and still answers', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6');
    pg.fail = { match: /ANY/, error: new Error('fetch failed'), times: 1 };

    const schedule = await fetchFrontMonthSchedule(
      'ES',
      ['2026-11-05'],
      'cron',
    );

    expect(schedule.contractFor('2026-11-05')).toBe('ESZ6');
    expect(count(/ANY/)).toBe(2);
  });

  it('rejects with the database error when deciding a date fails, and decides nothing after it', async () => {
    pg.fail = {
      match: INPUTS_READ,
      error: new Error('connection lost'),
      times: 1,
    };

    await expect(
      fetchFrontMonthSchedule('ES', ['2026-11-05', '2026-11-06'], 'cron'),
    ).rejects.toThrow('connection lost');

    expect(count(FRONT_INSERT)).toBe(0);
    expect(await frontRows()).toEqual([]);
  });
});

// ── The two seed inserts ──────────────────────────────────

describe('insertContractVolumes', () => {
  const row = (
    over: Partial<Parameters<typeof insertContractVolumes>[0][number]> = {},
  ) => ({
    product: 'ES' as const,
    tradeDate: '2026-11-05',
    contract: 'ESZ6',
    volume: 1000,
    ...over,
  });

  it('stores each row with the candles source and returns how many were new', async () => {
    const n = await insertContractVolumes([
      row(),
      row({ contract: 'ESH7', volume: 0 }),
      row({ product: 'NQ', contract: 'NQZ6', volume: 5_000_000_000 }),
    ]);

    expect(n).toBe(3);
    expect(await volumeRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESH7',
        volume: '0',
        source: 'candles',
      },
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        volume: '1000',
        source: 'candles',
      },
      {
        product: 'NQ',
        trade_date: '2026-11-05',
        contract: 'NQZ6',
        volume: '5000000000',
        source: 'candles',
      },
    ]);
  });

  it('ON CONFLICT DO NOTHING: a stored row, whatever its source, is left alone and not counted', async () => {
    await putVolumes('ES', '2026-11-05', { ESZ6: 777 });

    const n = await insertContractVolumes([
      row({ volume: 1 }),
      row({ contract: 'ESH7', volume: 2 }),
    ]);

    expect(n).toBe(1);
    expect(await volumeRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESH7',
        volume: '2',
        source: 'candles',
      },
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        volume: '777',
        source: 'live',
      },
    ]);
    await expect(
      insertContractVolumes([row({ contract: 'ESH7' })]),
    ).resolves.toBe(0);
  });

  it('inserts in 500-row statements', async () => {
    const day = (i: number) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const rows = Array.from({ length: 1201 }, (_, i) =>
      row({ tradeDate: day(i), volume: i }),
    );

    await expect(insertContractVolumes(rows)).resolves.toBe(1201);

    expect(count(VOLUME_INSERT)).toBe(3);
    expect(await volumeRows()).toHaveLength(1201);
  });

  it('does nothing, with no query, for no rows', async () => {
    await expect(insertContractVolumes([])).resolves.toBe(0);

    expect(pg.queries).toEqual([]);
  });

  it.each([
    ['a two-digit spelling', 'ESZ26'],
    ['a spread', 'ESZ6-ESH7'],
    ['a contract of another root', 'NQZ6'],
    ['a bare root', 'ES'],
    ['a two-digit year outside the window', 'ESZ36'],
  ])(
    'rejects %s, naming the contract, and writes none of the rows',
    async (_what, contract) => {
      await expect(
        insertContractVolumes([row({ contract: 'ESH7' }), row({ contract })]),
      ).rejects.toThrow(new RegExp(`canonical.*${contract}`));

      expect(pg.queries).toEqual([]);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects the volume %s, and writes none of the rows',
    async (volume) => {
      await expect(
        insertContractVolumes([row({ contract: 'ESH7' }), row({ volume })]),
      ).rejects.toThrow(/volume/);

      expect(pg.queries).toEqual([]);
    },
  );

  it('rejects with the database error, and a later batch is not attempted', async () => {
    const day = (i: number) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({ tradeDate: day(i) }),
    );
    pg.fail = {
      match: VOLUME_INSERT,
      error: new Error('connection lost'),
      times: 1,
    };

    await expect(insertContractVolumes(rows)).rejects.toThrow(
      'connection lost',
    );

    expect(count(VOLUME_INSERT)).toBe(1);
    expect(await volumeRows()).toEqual([]);
  });

  it('retries a transient failure once and still inserts', async () => {
    pg.fail = {
      match: VOLUME_INSERT,
      error: new Error('fetch failed'),
      times: 1,
    };

    await expect(insertContractVolumes([row()])).resolves.toBe(1);

    expect(count(VOLUME_INSERT)).toBe(2);
  });
});

describe('insertFrontMonthRows', () => {
  const row = (
    over: Partial<Parameters<typeof insertFrontMonthRows>[0][number]> = {},
  ) => ({
    product: 'ES' as const,
    tradeDate: '2026-11-05',
    contract: 'ESZ6',
    ...over,
  });

  it('stores each row with the candles source and returns how many were new', async () => {
    const n = await insertFrontMonthRows([
      row(),
      row({ tradeDate: '2026-11-06', contract: 'ESH7' }),
      row({ product: 'CL', contract: 'CLZ6' }),
    ]);

    expect(n).toBe(3);
    expect(await frontRows()).toEqual([
      {
        product: 'CL',
        trade_date: '2026-11-05',
        contract: 'CLZ6',
        source: 'candles',
      },
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        source: 'candles',
      },
      {
        product: 'ES',
        trade_date: '2026-11-06',
        contract: 'ESH7',
        source: 'candles',
      },
    ]);
  });

  it('ON CONFLICT DO NOTHING: the row that is stored wins, and is not counted', async () => {
    await putFront('ES', '2026-11-05', 'ESZ6', 'live');

    const n = await insertFrontMonthRows([
      row({ contract: 'ESH7' }),
      row({ tradeDate: '2026-11-06', contract: 'ESH7' }),
    ]);

    expect(n).toBe(1);
    expect(await frontRows()).toEqual([
      {
        product: 'ES',
        trade_date: '2026-11-05',
        contract: 'ESZ6',
        source: 'live',
      },
      {
        product: 'ES',
        trade_date: '2026-11-06',
        contract: 'ESH7',
        source: 'candles',
      },
    ]);
  });

  it('is what ensureFrontMonth then reads: a seeded row is returned as it is and is the next date’s incumbent', async () => {
    await insertFrontMonthRows([row({ contract: 'ESH7' })]);
    await putVolumes('ES', '2026-11-05', { ESZ6: 9000, ESH7: 1 });

    await expect(ensureFrontMonth('ES', '2026-11-05', 'cron')).resolves.toBe(
      'ESH7',
    );
    // ESZ6 expires before the seeded incumbent: no way back.
    await expect(ensureFrontMonth('ES', '2026-11-06', 'cron')).resolves.toBe(
      'ESH7',
    );
  });

  it('inserts in 500-row statements', async () => {
    const day = (i: number) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const rows = Array.from({ length: 1201 }, (_, i) =>
      row({ tradeDate: day(i) }),
    );

    await expect(insertFrontMonthRows(rows)).resolves.toBe(1201);

    expect(count(FRONT_INSERT)).toBe(3);
    expect(await frontRows()).toHaveLength(1201);
  });

  it('does nothing, with no query, for no rows', async () => {
    await expect(insertFrontMonthRows([])).resolves.toBe(0);

    expect(pg.queries).toEqual([]);
  });

  it.each([
    ['a two-digit spelling', 'ESZ26'],
    ['a spread', 'ESZ6-ESH7'],
    ['a contract of another root', 'NQZ6'],
    ['a bare root', 'ES'],
    ['a two-digit year outside the window', 'ESZ36'],
  ])(
    'rejects %s, naming the contract, and writes none of the rows',
    async (_what, contract) => {
      await expect(
        insertFrontMonthRows([
          row({ contract: 'ESH7', tradeDate: '2026-11-06' }),
          row({ contract }),
        ]),
      ).rejects.toThrow(new RegExp(`canonical.*${contract}`));

      expect(pg.queries).toEqual([]);
    },
  );

  it('rejects with the database error, and a later batch is not attempted', async () => {
    const day = (i: number) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const rows = Array.from({ length: 600 }, (_, i) =>
      row({ tradeDate: day(i) }),
    );
    pg.fail = {
      match: FRONT_INSERT,
      error: new Error('connection lost'),
      times: 1,
    };

    await expect(insertFrontMonthRows(rows)).rejects.toThrow('connection lost');

    expect(count(FRONT_INSERT)).toBe(1);
    expect(await frontRows()).toEqual([]);
  });

  it('retries a transient failure once and still inserts', async () => {
    pg.fail = {
      match: FRONT_INSERT,
      error: new Error('fetch failed'),
      times: 1,
    };

    await expect(insertFrontMonthRows([row()])).resolves.toBe(1);

    expect(count(FRONT_INSERT)).toBe(2);
  });
});
