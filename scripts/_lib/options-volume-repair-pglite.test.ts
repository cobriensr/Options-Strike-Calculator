// @vitest-environment node

/**
 * REAL-SQL test for the options-volume repair
 * (scripts/repair-options-volume.ts -> ./options-volume-repair.ts).
 *
 * options-volume-repair.test.ts covers the pure plan. This runs every read and
 * write on pglite (Postgres in WASM): `training_features` is a stub holding the
 * date key, and the 30 columns come from the real migrations #24 (`opt_*`) and
 * #213 (`prev_day_opt_*`), so INTEGER, DECIMAL(14,2) and DECIMAL(6,4) are the
 * production types. One module boundary is replaced: `getDb()` returns a
 * neon-shaped client over pglite, whose `transaction` runs its queries in one
 * pglite transaction, so a rolled-back transaction is really rolled back. No
 * database or network is reached; the plan and backup files go to a temp
 * directory.
 *
 * The source is a small reply, one row a trading day, and each row's call volume
 * names its date (see DAYS). The stored table:
 *
 *   2025-12-30  before the span: untouched
 *   2026-11-09  the span's first date. opt_* is another day's (stuck), and
 *               prev_day_opt_* holds a sentinel: its previous trading day,
 *               Fri 11-06, is before the span, so that group stays
 *   2026-11-10  opt_* right, prev_day_opt_* empty: only that group is written
 *   2026-11-11  the source has no row for it: opt_* becomes NULL; the previous
 *               group is written from 11-10
 *   2026-11-12  opt_* is another day's; its previous day, 11-11, has no row, so
 *               prev_day_opt_* becomes NULL
 *   2026-11-13  both groups already right: no write
 *   2026-11-16  a Monday: its previous group comes from Friday 11-13
 *   2026-11-17  right, except a stored NaN in opt_vol_pcr (a NUMERIC holds one)
 *   2026-11-18  after the span: untouched
 * Six dates are written, one is already right, two are outside.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { applyMigration } from '../../api/__tests__/pglite-migrations.js';

const holder = vi.hoisted(() => ({ sql: null as unknown }));
const { getDbSpy } = vi.hoisted(() => ({ getDbSpy: vi.fn() }));

vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => {
    getDbSpy();
    return holder.sql;
  },
}));

import { databaseOf } from './db-host.js';
import {
  COLUMNS,
  exitCodeOf,
  exitCodeOfUndo,
  formatApplyReport,
  formatReport,
  formatUndoReport,
  runRepair,
  runUndo,
  type RunOptions,
  type Values,
} from './options-volume-repair.js';

const DATABASE_URL = 'postgres://owner:pw-secret@ep-test.neon.tech/neondb';
const DATABASE = 'ep-test.neon.tech/neondb';
const OTHER_DATABASE = 'ep-other.neon.tech/neondb';

/** A query a hook may run: inside the transaction when the statement is in one. */
type Query = (text: string, params?: unknown[]) => Promise<unknown>;
interface LazyQuery {
  text: string;
  params: unknown[];
}

let db: PGlite;
let dir: string;
const env = { ...process.env };
/** Rejects a statement whose SQL text and call number it matches. */
let failWhen: ((text: string, n: number) => Error | null) | null = null;
/** Runs once, just before the first statement its pattern matches. */
let hooks: Array<{ match: RegExp; run: (query: Query) => Promise<void> }> = [];
const statements: string[] = [];
/** The date count of each UPDATE, from its dates array. */
const updateSizes: number[] = [];
/** How many queries each `transaction` call held. */
const transactionSizes: number[] = [];

beforeAll(async () => {
  db = await PGlite.create();
  await db.query('CREATE TABLE training_features (date DATE PRIMARY KEY)');
  // #213 bounds its lock wait with SET LOCAL, which needs a transaction.
  await applyMigration(db, 24);
  await db.exec('BEGIN');
  await applyMigration(db, 213);
  await db.exec('COMMIT');
  const check = (text: string): void => {
    statements.push(text);
    const error = failWhen?.(text, statements.length) ?? null;
    if (error) throw error;
  };
  const trigger = async (text: string, query: Query): Promise<void> => {
    const at = hooks.findIndex((h) => h.match.test(text));
    if (at < 0) return;
    const [hook] = hooks.splice(at, 1);
    await hook?.run(query);
  };
  const txn = {
    query: (text: string, params: unknown[] = []): LazyQuery => ({
      text,
      params,
    }),
  };
  holder.sql = {
    query: async (text: string, params: unknown[] = []) => {
      check(text);
      await trigger(text, (t, p) => db.query(t, p));
      return (await db.query(text, params)).rows;
    },
    transaction: (queries: LazyQuery[] | ((t: typeof txn) => LazyQuery[])) => {
      const list = typeof queries === 'function' ? queries(txn) : queries;
      transactionSizes.push(list.length);
      return db.transaction(async (tx) => {
        const results: unknown[][] = [];
        for (const q of list) {
          check(q.text);
          if (/UPDATE training_features/.test(q.text)) {
            updateSizes.push((q.params[0] as unknown[]).length);
          }
          await trigger(q.text, (t, p) => tx.query(t, p));
          results.push((await tx.query(q.text, q.params)).rows);
        }
        return results;
      });
    },
  };
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('TRUNCATE training_features');
  dir = mkdtempSync(join(tmpdir(), 'options-volume-repair-pglite-'));
  process.env.DATABASE_URL = DATABASE_URL;
  failWhen = null;
  hooks = [];
  statements.length = 0;
  updateSizes.length = 0;
  transactionSizes.length = 0;
  getDbSpy.mockClear();
});

afterEach(() => {
  process.env = { ...env };
  rmSync(dir, { recursive: true, force: true });
});

// ── The source and the stored table ─────────────────────────────────────────

/** A reply row: the call volume names the date; other fields are the same. */
function uwRow(date: string, callVolume: number): Record<string, unknown> {
  return {
    date,
    call_volume: callVolume,
    put_volume: callVolume * 2,
    call_volume_ask_side: 80000,
    call_volume_bid_side: 70000,
    put_volume_ask_side: 60000,
    put_volume_bid_side: 90000,
    call_premium: '1500000.5000',
    put_premium: '2000000.2500',
    bullish_premium: '800000.0000',
    bearish_premium: '1200000.0000',
    avg_30_day_call_volume: '110000.4333',
    avg_30_day_put_volume: '220000.8',
    call_open_interest: 4_000_000,
    put_open_interest: 5_000_000,
  };
}

/** The trading days the source has a row for: call volume, and its vs_avg30. */
const DAYS: Record<string, readonly [callVolume: number, vsAvg30: string]> = {
  '2026-11-09': [109_000, '0.9909'],
  '2026-11-10': [110_000, '1.0000'],
  // No row for 2026-11-11.
  '2026-11-12': [112_000, '1.0182'],
  '2026-11-13': [113_000, '1.0273'],
  '2026-11-16': [116_000, '1.0545'],
  '2026-11-17': [117_000, '1.0636'],
};

function writeSource(
  days: Record<string, readonly [number, string]> = DAYS,
  name = 'reply.json',
): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      data: Object.entries(days)
        .map(([date, [callVolume]]) => uwRow(date, callVolume))
        .reverse(),
    }),
  );
  return file;
}

/** The 15 values a day's row gives a group, as the repair writes them. */
function group(prefix: 'opt_' | 'prev_day_opt_', date: string | null): Values {
  const day = date == null ? undefined : DAYS[date];
  const names = COLUMNS.filter((c) => c.prefix === prefix).map((c) => c.name);
  if (day == null) return Object.fromEntries(names.map((n) => [n, null]));
  const [callVolume, vsAvg30] = day;
  const values: Record<string, string> = {
    call_volume: String(callVolume),
    put_volume: String(callVolume * 2),
    call_oi: '4000000',
    put_oi: '5000000',
    call_premium: '1500000.50',
    put_premium: '2000000.25',
    bullish_premium: '800000.00',
    bearish_premium: '1200000.00',
    call_vol_ask: '80000',
    put_vol_bid: '90000',
    vol_pcr: '2.0000',
    oi_pcr: '1.2500',
    premium_ratio: '0.4000',
    call_vol_vs_avg30: vsAvg30,
    put_vol_vs_avg30: vsAvg30,
  };
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [`${prefix}${k}`, v]),
  );
}

const SENTINEL: Values = {
  prev_day_opt_call_volume: '777',
  prev_day_opt_vol_pcr: '7.7000',
};

async function insertRow(date: string, values: Values): Promise<void> {
  const names = Object.keys(values);
  const placeholders = names.map((_, i) => '$' + String(i + 2)).join(', ');
  await db.query(
    `INSERT INTO training_features (date, ${names.join(', ')})
     VALUES ($1::date, ${placeholders})`,
    [date, ...names.map((n) => values[n])],
  );
}

/** The stored table: date -> the 30 columns as text. */
async function table(): Promise<Record<string, Values>> {
  const casts = COLUMNS.map((c) => c.name + '::text AS ' + c.name).join(', ');
  const { rows } = await db.query<Record<string, string | null>>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, ${casts}
       FROM training_features ORDER BY date`,
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.date as string,
      Object.fromEntries(COLUMNS.map((c) => [c.name, r[c.name] ?? null])),
    ]),
  );
}

/** The seed in the header comment. */
async function seed(): Promise<void> {
  const stuck = group('opt_', '2026-11-17');
  await insertRow('2025-12-30', { opt_call_volume: '999' });
  await insertRow('2026-11-09', { ...stuck, ...SENTINEL });
  await insertRow('2026-11-10', group('opt_', '2026-11-10'));
  await insertRow('2026-11-11', stuck);
  await insertRow('2026-11-12', {
    ...stuck,
    ...group('prev_day_opt_', '2026-11-17'),
  });
  await insertRow('2026-11-13', {
    ...group('opt_', '2026-11-13'),
    ...group('prev_day_opt_', '2026-11-12'),
  });
  await insertRow('2026-11-16', stuck);
  await insertRow('2026-11-17', {
    ...group('opt_', '2026-11-17'),
    opt_vol_pcr: 'NaN',
    ...group('prev_day_opt_', '2026-11-16'),
  });
  await insertRow('2026-11-18', { opt_call_volume: '888' });
}

/** What the table holds once the repair has written everything. */
function repaired(): Record<string, Values> {
  const nulls = { ...group('opt_', null), ...group('prev_day_opt_', null) };
  const row = (opt: string | null, prev: string | null): Values => ({
    ...nulls,
    ...group('opt_', opt),
    ...group('prev_day_opt_', prev),
  });
  return {
    '2025-12-30': { ...nulls, opt_call_volume: '999' },
    '2026-11-09': { ...row('2026-11-09', null), ...SENTINEL },
    '2026-11-10': row('2026-11-10', '2026-11-09'),
    '2026-11-11': row(null, '2026-11-10'),
    '2026-11-12': row('2026-11-12', null),
    '2026-11-13': row('2026-11-13', '2026-11-12'),
    '2026-11-16': row('2026-11-16', '2026-11-13'),
    '2026-11-17': row('2026-11-17', '2026-11-16'),
    '2026-11-18': { ...nulls, opt_call_volume: '888' },
  };
}

const WRITTEN = [
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-16',
  '2026-11-17',
];

function options(over: Partial<RunOptions> = {}): RunOptions {
  return {
    source: writeSource(),
    date: null,
    since: null,
    until: null,
    apply: false,
    planFile: null,
    all: false,
    backupDir: dir,
    ...over,
  };
}

/** A dry run: its plan file, and the result. */
async function dryRun(over: Partial<RunOptions> = {}) {
  const result = await runRepair(options(over));
  return { result, planFile: result.planFile as string };
}

const files = (prefix: string): string[] =>
  readdirSync(dir).filter((f) => f.startsWith(prefix));

// ── The dry run ─────────────────────────────────────────────────────────────

describe('a dry run', () => {
  it('plans the six dates, lists the two outside the span, and writes only the plan file', async () => {
    await seed();
    const before = await table();

    const { result, planFile } = await dryRun();

    expect(await table()).toEqual(before);
    expect(result.apply).toBe(false);
    expect(result.database).toBe(DATABASE);
    const written = result.plan.dates
      .filter((d) => d.changed.length > 0)
      .map((d) => d.date);
    expect(written).toEqual(WRITTEN);
    expect(result.plan.dates.map((d) => d.date)).toEqual([
      ...WRITTEN.slice(0, 4),
      '2026-11-13',
      '2026-11-16',
      '2026-11-17',
    ]);
    expect(result.plan.outsideSpan).toEqual(['2025-12-30', '2026-11-18']);
    expect(readdirSync(dir).sort()).toEqual(
      ['reply.json', planFile.split(/[\\/]/).at(-1)].sort(),
    );
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    expect(plan.database).toBe(DATABASE);
    expect(plan.scope).toEqual({ date: null, since: null, until: null });
    expect(plan.source).toMatchObject({
      rows: 6,
      first: '2026-11-09',
      last: '2026-11-17',
    });
    expect(plan.rows.map((r: { date: string }) => r.date)).toEqual(WRITTEN);
    expect(statements.every((s) => /^\s*SELECT/.test(s))).toBe(true);
  });

  it('prints a report with the counts, the sources of each date and the changed values', async () => {
    await seed();

    const { result } = await dryRun();

    const text = formatReport(result);
    expect(text).toContain(
      'training_features dates read: 9 (7 inside the span, 2 outside it)',
    );
    expect(text).toContain('Planned: 6 dates to write');
    expect(text).toMatch(
      /2026-11-16 {2}change \d+ columns {2}\[opt_: row 2026-11-16; prev_day_opt_: row 2026-11-13\]/,
    );
    expect(text).toContain('    opt_call_volume: 117000 -> 109000');
    expect(text).toContain('    opt_vol_pcr: NaN -> 2.0000');
    expect(text).toContain(
      'Outside the span, left untouched (2): 2025-12-30, 2026-11-18',
    );
    expect(text).toContain(
      'No source row for the date, opt_* set to NULL (1): 2026-11-11',
    );
    expect(text).toContain(
      'No source row for the previous trading day, prev_day_opt_* set to NULL (1): 2026-11-12',
    );
    expect(text).toContain(
      'Previous trading day outside the span, prev_day_opt_* left untouched (1): 2026-11-09',
    );
  });

  it('narrows to one date with --date, and takes a Monday’s previous group from the Friday', async () => {
    await seed();

    const { result, planFile } = await dryRun({ date: '2026-11-16' });

    expect(result.plan.dates.map((d) => d.date)).toEqual(['2026-11-16']);
    expect(planFile).toContain('dry-run-2026-11-16-');
    expect(result.plan.dates[0]?.after.prev_day_opt_call_volume).toBe('113000');
  });

  it('says so, and reads nothing else, when there is no training_features row in the range', async () => {
    await seed();

    await expect(dryRun({ date: '2026-11-19' })).rejects.toThrow(
      /no training_features rows in that range/,
    );
    expect(files('dry-run')).toEqual([]);
  });
});

// ── Applying ────────────────────────────────────────────────────────────────

describe('an apply', () => {
  it('refuses a plan of every date without --all, before it reads the database', async () => {
    await seed();
    const { planFile } = await dryRun();
    getDbSpy.mockClear();
    const before = await table();

    await expect(runRepair(options({ apply: true, planFile }))).rejects.toThrow(
      /covers more than one date \(all\)\. Apply one date first/,
    );

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(await table()).toEqual(before);
    expect(files('backup')).toEqual([]);
  });

  it('writes one date without --all, only that date, with a backup', async () => {
    await seed();
    const before = await table();
    const { planFile } = await dryRun({ date: '2026-11-16' });

    const result = await runRepair(options({ apply: true, planFile }));

    expect(result.applied).toMatchObject({
      planned: 1,
      written: 1,
      changedSinceRead: [],
    });
    expect(exitCodeOf(result)).toBe(0);
    const after = await table();
    expect(after['2026-11-16']).toEqual(repaired()['2026-11-16']);
    expect({ ...after, '2026-11-16': before['2026-11-16'] }).toEqual(before);
    expect(files('backup-2026-11-16')).toHaveLength(1);
  });

  it('takes --since and --until naming one date as one date: no --all needed, and a range of two dates still needs it', async () => {
    await seed();
    const one = await dryRun({ since: '2026-11-16', until: '2026-11-16' });
    const two = await dryRun({ since: '2026-11-16', until: '2026-11-17' });

    expect(one.planFile).toContain('dry-run-2026-11-16..2026-11-16-');
    await expect(
      runRepair(options({ apply: true, planFile: two.planFile })),
    ).rejects.toThrow(/covers more than one date \(2026-11-16\.\.2026-11-17\)/);
    const result = await runRepair(
      options({ apply: true, planFile: one.planFile }),
    );

    expect(result.applied).toMatchObject({ planned: 1, written: 1 });
    expect((await table())['2026-11-16']).toEqual(repaired()['2026-11-16']);
  });

  it('writes every planned date exactly, leaves the rest, and records the backup', async () => {
    await seed();
    const before = await table();
    const { planFile } = await dryRun();

    const result = await runRepair(
      options({ apply: true, planFile, all: true }),
    );

    expect(result.applied).toMatchObject({
      planned: 6,
      written: 6,
      changedSinceRead: [],
    });
    expect(exitCodeOf(result)).toBe(0);
    expect(await table()).toEqual(repaired());
    const [backup] = files('backup-all');
    expect(backup).toBeDefined();
    const saved = JSON.parse(readFileSync(join(dir, backup as string), 'utf8'));
    expect(saved.database).toBe(DATABASE);
    expect(saved.rows.map((r: { date: string }) => r.date)).toEqual(WRITTEN);
    expect(saved.rows[0].before).toEqual(before['2026-11-09']);
    expect(saved.rows[0].after).toEqual(repaired()['2026-11-09']);
    expect(formatApplyReport(result.applied!)).toContain(
      'Wrote 6 of 6 planned dates.',
    );
    expect(updateSizes).toEqual([6]);
    expect(transactionSizes).toEqual([1]);
  });

  it('writes nothing the second time: the same plan, and a fresh dry run, both plan 0', async () => {
    await seed();
    const { planFile } = await dryRun();
    await runRepair(options({ apply: true, planFile, all: true }));
    const written = await table();
    const backups = files('backup').length;

    // The reviewed plan again: every date it lists already holds its new values.
    const again = await runRepair(
      options({ apply: true, planFile, all: true }),
    );
    expect(again.applied).toEqual({
      backupFile: null,
      planned: 0,
      written: 0,
      changedSinceRead: [],
    });
    expect(exitCodeOf(again)).toBe(0);
    expect(formatApplyReport(again.applied!)).toBe(
      'Nothing to write: every date is already right.',
    );

    // A fresh dry run.
    const fresh = await dryRun();
    expect(fresh.result.plan.dates.every((d) => d.changed.length === 0)).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(fresh.planFile, 'utf8')).rows).toEqual([]);
    expect(await table()).toEqual(written);
    expect(files('backup')).toHaveLength(backups);
  });

  it('only checks the plan without --apply, and writes nothing', async () => {
    await seed();
    const { planFile } = await dryRun();
    const before = await table();

    const checked = await runRepair(options({ planFile }));

    expect(checked.apply).toBe(false);
    expect(checked.applied).toBeNull();
    expect(await table()).toEqual(before);
  });

  it('writes in statements of 500 dates, all in one transaction', async () => {
    await seedMany(501);
    const source = writeManySource(501);
    const { planFile } = await dryRun({ source });

    const result = await runRepair(
      options({ source, apply: true, planFile, all: true }),
    );

    expect(result.applied).toMatchObject({
      planned: 501,
      written: 501,
    });
    expect(updateSizes).toEqual([500, 1]);
    expect(transactionSizes).toEqual([2]);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM training_features WHERE opt_call_volume IS NOT NULL',
    );
    expect(rows[0]?.n).toBe(501);
  });
});

/** `count` consecutive calendar dates from 2025-03-03, with rows for them all. */
function manyDates(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2025, 2, 3 + i)).toISOString().slice(0, 10),
  );
}

async function seedMany(count: number): Promise<void> {
  await db.query(
    `INSERT INTO training_features (date)
     SELECT d::date FROM unnest($1::text[]) AS d`,
    [manyDates(count)],
  );
}

function writeManySource(count: number): string {
  const file = join(dir, 'many.json');
  writeFileSync(
    file,
    JSON.stringify({
      data: manyDates(count).map((date, i) => uwRow(date, 100_000 + i)),
    }),
  );
  return file;
}

// ── The guards ──────────────────────────────────────────────────────────────

describe('what an apply refuses, and what it leaves alone', () => {
  it('refuses a plan when a stored date has changed since the dry run, and writes nothing', async () => {
    await seed();
    const { planFile } = await dryRun();
    await db.query(
      `UPDATE training_features SET opt_call_volume = 42 WHERE date = '2026-11-12'`,
    );
    const before = await table();

    await expect(
      runRepair(options({ apply: true, planFile, all: true })),
    ).rejects.toThrow(
      /A fresh plan is not the plan in .*\n {2}2026-11-12: the stored values changed since the dry run \(opt_call_volume 117000 then, 42 now\)/,
    );

    expect(await table()).toEqual(before);
    expect(files('backup')).toEqual([]);
  });

  it('writes no date that changes between the read and the write, and says so', async () => {
    await seed();
    const { planFile } = await dryRun();
    hooks.push({
      match: /UPDATE training_features/,
      run: async (query) => {
        await query(
          `UPDATE training_features SET opt_call_volume = 42 WHERE date = '2026-11-12'`,
        );
      },
    });

    const result = await runRepair(
      options({ apply: true, planFile, all: true }),
    );

    expect(result.applied).toMatchObject({
      planned: 6,
      written: 5,
      changedSinceRead: ['2026-11-12'],
    });
    expect(exitCodeOf(result)).toBe(1);
    expect(formatApplyReport(result.applied!)).toContain(
      'Changed since the read, not written (1): 2026-11-12',
    );
    const after = await table();
    expect(after['2026-11-12']?.opt_call_volume).toBe('42');
    expect(after['2026-11-12']?.prev_day_opt_call_volume).not.toBeNull();
    expect(after['2026-11-16']).toEqual(repaired()['2026-11-16']);
  });

  it('refuses a source that is not the one the plan was made from, before it reads the database', async () => {
    await seed();
    const { planFile } = await dryRun();
    const other = writeSource(
      { ...DAYS, '2026-11-12': [999_999, '9.0909'] },
      'other.json',
    );
    getDbSpy.mockClear();
    const before = await table();

    await expect(
      runRepair(options({ source: other, apply: true, planFile, all: true })),
    ).rejects.toThrow(
      /is not the source .* was made from \(sha256 [0-9a-f]{12} now, [0-9a-f]{12} then\)\. Nothing was written/,
    );

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(await table()).toEqual(before);
  });

  it('refuses a plan written for another database, naming only the one the file recorded', async () => {
    await seed();
    const { planFile } = await dryRun();
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    writeFileSync(
      planFile,
      JSON.stringify({ ...plan, database: OTHER_DATABASE }),
    );
    getDbSpy.mockClear();

    const attempt = runRepair(options({ apply: true, planFile, all: true }));

    await expect(attempt).rejects.toThrow(
      `was written for the database ${OTHER_DATABASE}, and DATABASE_URL names a different database`,
    );
    await expect(attempt).rejects.not.toThrow(/ep-test|pw-secret|owner/);
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('refuses a plan that records no usable database, and a dry run when DATABASE_URL names none', async () => {
    await seed();
    const { planFile } = await dryRun();
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    writeFileSync(
      planFile,
      JSON.stringify({
        ...plan,
        database: '(DATABASE_URL missing or not a URL)',
      }),
    );
    getDbSpy.mockClear();

    await expect(
      runRepair(options({ apply: true, planFile, all: true })),
    ).rejects.toThrow(/records no usable database name/);

    delete process.env.DATABASE_URL;
    await expect(dryRun()).rejects.toThrow(
      'DATABASE_URL is missing or is not a usable database URL. Nothing was read or written.',
    );
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('refuses to apply without a plan, and a plan file that is not one', async () => {
    await expect(runRepair(options({ apply: true }))).rejects.toThrow(
      /Refusing to apply without --plan/,
    );
    const bogus = join(dir, 'bogus.json');
    writeFileSync(bogus, '{"rows":[]}');

    await expect(runRepair(options({ planFile: bogus }))).rejects.toThrow(
      /is not a dry-run plan this script wrote/,
    );
  });

  it('refuses to write over an existing backup, before it writes to the database', async () => {
    await seed();
    const { planFile } = await dryRun({ date: '2026-11-16' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    try {
      writeFileSync(
        join(dir, 'backup-2026-11-16-2026-11-26T12-00-00.000Z.json'),
        'earlier run',
      );
      const before = await table();

      await expect(
        runRepair(options({ apply: true, planFile })),
      ).rejects.toThrow(
        /Refusing to overwrite .*backup-2026-11-16-.*Nothing was written to the database/,
      );

      expect(await table()).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the source', () => {
  it.each([
    ['text that is not JSON', '{nope', /is not JSON/],
    ['a reply with no data array', '{"rows":[]}', /no `data` array/],
    [
      'a date that appears twice',
      JSON.stringify({
        data: [uwRow('2026-11-10', 1), uwRow('2026-11-10', 2)],
      }),
      /the date 2026-11-10 appears twice/,
    ],
    [
      'a row missing a field',
      JSON.stringify({ data: [{ date: '2026-11-10', call_volume: 1 }] }),
      /no number in put_volume/,
    ],
  ])('refuses %s before the database is touched', async (_label, text, why) => {
    await seed();
    const source = join(dir, 'bad.json');
    writeFileSync(source, text);
    const before = await table();

    await expect(dryRun({ source })).rejects.toThrow(why);

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
    expect(await table()).toEqual(before);
    expect(files('dry-run')).toEqual([]);
  });

  it('stops before anything is written when a value does not fit its column', async () => {
    await seed();
    const source = join(dir, 'huge.json');
    writeFileSync(
      source,
      JSON.stringify({
        data: [
          uwRow('2026-11-09', 109_000),
          { ...uwRow('2026-11-10', 110_000), call_premium: '1000000000000' },
        ],
      }),
    );
    const before = await table();

    await expect(dryRun({ source })).rejects.toThrow(
      /2026-11-10: opt_call_premium: 1000000000000 does not fit DECIMAL\(14,2\)\. Nothing was written/,
    );

    expect(await table()).toEqual(before);
    expect(files('dry-run')).toEqual([]);
  });

  it('never calls UW, whatever the environment holds', async () => {
    process.env.UW_API_KEY = 'uw-key-that-must-not-be-used';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await seed();
    try {
      const { planFile, result } = await dryRun();
      const applied = await runRepair(
        options({ apply: true, planFile, all: true }),
      );
      const undone = await runUndo({
        file: applied.backupFile as string,
        apply: true,
      });
      const printed = [
        formatReport(result),
        formatApplyReport(applied.applied!),
        formatUndoReport(undone),
      ].join('\n');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(printed).not.toContain('uw-key-that-must-not-be-used');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── A failure ───────────────────────────────────────────────────────────────

describe('a database error while writing', () => {
  it('rolls every chunk back, writes nothing, and names the backup and the undo command', async () => {
    await seedMany(501);
    const source = writeManySource(501);
    const { planFile } = await dryRun({ source });
    // The first chunk's UPDATE runs; the second is rejected.
    let updates = 0;
    failWhen = (text) => {
      if (!/UPDATE training_features/.test(text)) return null;
      updates += 1;
      return updates === 2 ? new Error('connection reset by peer') : null;
    };

    const attempt = runRepair(
      options({ source, apply: true, planFile, all: true }),
    );

    await expect(attempt).rejects.toThrow(
      /connection reset by peer\. The apply did not complete: the 501 planned dates are written in one transaction, so none of them was written by it\. Backup: .*backup-all-.*\.json\. .*--undo-file .*backup-all-/,
    );
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM training_features WHERE opt_call_volume IS NOT NULL',
    );
    expect(rows[0]?.n).toBe(0);
    expect(files('backup-all')).toHaveLength(1);
  });

  it('reports a failure in a read as it is, and writes nothing', async () => {
    await seed();
    const before = await table();
    failWhen = (text) =>
      /^\s*SELECT/.test(text)
        ? new Error('permission denied for table training_features')
        : null;

    await expect(dryRun()).rejects.toThrow(
      'permission denied for table training_features',
    );

    expect(await table()).toEqual(before);
    expect(files('dry-run')).toEqual([]);
  });

  it('says an undo did not complete, and restores nothing, when its write is rejected', async () => {
    await seed();
    const { planFile } = await dryRun();
    const applied = await runRepair(
      options({ apply: true, planFile, all: true }),
    );
    const written = await table();
    failWhen = (text) =>
      /UPDATE training_features/.test(text)
        ? new Error('connection reset by peer')
        : null;

    await expect(
      runUndo({ file: applied.backupFile as string, apply: true }),
    ).rejects.toThrow(
      /connection reset by peer\. The undo did not complete: the dates are restored in one transaction, so none of them was restored by it\. Run the same command again\./,
    );

    expect(await table()).toEqual(written);
  });
});

// ── Undo ────────────────────────────────────────────────────────────────────

describe('an undo', () => {
  it('counts what the backup holds without --apply, and writes nothing', async () => {
    await seed();
    const { planFile } = await dryRun();
    const applied = await runRepair(
      options({ apply: true, planFile, all: true }),
    );
    const written = await table();

    const counted = await runUndo({
      file: applied.backupFile as string,
      apply: false,
    });

    expect(counted).toMatchObject({ apply: false, rows: 6, restored: 0 });
    expect(formatUndoReport(counted)).toMatch(/The backup holds 6 dates/);
    expect(await table()).toEqual(written);
  });

  it('restores every date to what it held, and a second undo restores nothing', async () => {
    await seed();
    const before = await table();
    const { planFile } = await dryRun();
    const applied = await runRepair(
      options({ apply: true, planFile, all: true }),
    );

    const undone = await runUndo({
      file: applied.backupFile as string,
      apply: true,
    });

    expect(undone).toMatchObject({
      rows: 6,
      restored: 6,
      changedSince: [],
      database: DATABASE,
    });
    expect(exitCodeOfUndo(undone)).toBe(0);
    expect(await table()).toEqual(before);
    expect(formatUndoReport(undone)).toBe('Restored 6 of 6 dates.');

    const twice = await runUndo({
      file: applied.backupFile as string,
      apply: true,
    });
    expect(twice.restored).toBe(0);
    expect(twice.changedSince).toEqual(WRITTEN);
    expect(exitCodeOfUndo(twice)).toBe(1);
    expect(await table()).toEqual(before);
  });

  it('restores no date that changed since the repair', async () => {
    await seed();
    const { planFile } = await dryRun();
    const applied = await runRepair(
      options({ apply: true, planFile, all: true }),
    );
    await db.query(
      `UPDATE training_features SET opt_put_volume = 1 WHERE date = '2026-11-10'`,
    );

    const undone = await runUndo({
      file: applied.backupFile as string,
      apply: true,
    });

    expect(undone).toMatchObject({ restored: 5, changedSince: ['2026-11-10'] });
    expect(exitCodeOfUndo(undone)).toBe(1);
    const after = await table();
    expect(after['2026-11-10']?.opt_put_volume).toBe('1');
    expect(after['2026-11-09']?.opt_call_volume).toBe('117000');
  });

  it('refuses a backup written for another database, before it connects', async () => {
    await seed();
    const { planFile } = await dryRun();
    const applied = await runRepair(
      options({ apply: true, planFile, all: true }),
    );
    const backup = JSON.parse(
      readFileSync(applied.backupFile as string, 'utf8'),
    );
    writeFileSync(
      applied.backupFile as string,
      JSON.stringify({ ...backup, database: OTHER_DATABASE }),
    );
    getDbSpy.mockClear();

    await expect(
      runUndo({ file: applied.backupFile as string, apply: true }),
    ).rejects.toThrow(`was written for the database ${OTHER_DATABASE}`);

    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a backup', async () => {
    const bogus = join(dir, 'bogus.json');
    writeFileSync(bogus, '{"rows":[]}');

    await expect(runUndo({ file: bogus, apply: true })).rejects.toThrow(
      /is not a backup this script wrote/,
    );
  });
});

describe('the database name', () => {
  it('is the one DATABASE_URL names, without its credentials', async () => {
    await seed();

    const { result } = await dryRun();

    expect(result.database).toBe(databaseOf(DATABASE_URL));
    expect(result.database).not.toContain('pw-secret');
  });

  it('is named by no run whose read failed: its error is the driver’s, with nothing added', async () => {
    await seed();
    failWhen = (text) =>
      /^\s*SELECT/.test(text) ? new Error('connection refused') : null;

    const failure = await dryRun().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('connection refused');
    expect(String(failure)).not.toMatch(/ep-test|neondb|pw-secret|owner/);
  });
});
