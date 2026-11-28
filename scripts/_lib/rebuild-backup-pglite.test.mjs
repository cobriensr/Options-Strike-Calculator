// @vitest-environment node

/**
 * REAL-SQL test of the rebuild backup tool (rebuild-backup.mjs): the backup
 * files, the exact-match rule before a scoped delete or a NULLing, the guards
 * that re-check inside the transaction, and the restore. The statements run in
 * pglite (real Postgres in WASM) on tables built by the real migrations
 * (#9 training_features, #10 day_labels, #179 ws_gamma_setup_fires, #189
 * flow_regime_0dte_daily). day_embeddings needs pgvector, which pglite does not
 * have, so its `::vector` cast is asserted on the SQL text instead.
 *
 * The client handed to the library is a neon-shaped wrapper over pglite that
 * also implements `unsafe` (the pglite helper in api/__tests__ does not), and
 * has one hook, `beforeTransaction`, which runs just before a transaction
 * starts: that is where a race (a fire inserted, a row changed, a journal entry
 * written between the check and the write) is staged. The backup files go to a
 * temp directory per test.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
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

import { applyMigration } from '../../api/__tests__/pglite-migrations';
import {
  BACKUP_TABLES,
  MAX_DATES,
  RESTORE_BATCH_ROWS,
  RebuildRefusal,
  backupRows,
  buildTableInfo,
  chunkRows,
  datesBetween,
  deleteGammaFires,
  nullGammaReturns,
  parseDatesSpec,
  parseRebuildArgs,
  restoreInsertStatement,
  restoreRows,
  runRebuildBackup,
} from './rebuild-backup.mjs';

const GAMMA = 'ws_gamma_setup_fires';

let pg;
let tmp;
let hooks;
let sql;

// ── A neon-shaped client over pglite ───────────────────────

const UNSAFE = Symbol('unsafe');

/** Text and bound params of a tagged template; `unsafe` fragments are spliced in. */
function render(strings, values) {
  let text = strings[0];
  const params = [];
  for (const [i, value] of values.entries()) {
    if (value !== null && typeof value === 'object' && UNSAFE in value) {
      text += value[UNSAFE];
    } else {
      params.push(value);
      text += `$${params.length}`;
    }
    text += strings[i + 1];
  }
  return { text, params };
}

function neonLike(db, hook) {
  const log = { queries: [], transactions: [] };
  const client = (strings, ...values) => {
    const { text, params } = render(strings, values);
    return {
      text,
      params,
      then: (ok, fail) => {
        log.queries.push(text);
        return db
          .query(text, params)
          .then((r) => r.rows)
          .then(ok, fail);
      },
    };
  };
  client.unsafe = (text) => ({ [UNSAFE]: String(text) });
  client.transaction = async (queries) => {
    log.transactions.push(
      queries.map((q) => ({ text: q.text, params: q.params })),
    );
    await hook.beforeTransaction?.(queries);
    return db.transaction(async (tx) => {
      const results = [];
      for (const q of queries)
        results.push((await tx.query(q.text, q.params)).rows);
      return results;
    });
  };
  client.log = log;
  return client;
}

/** A tag that only records, for asserting the SQL text a builder produces. */
function recordingSql() {
  const client = (strings, ...values) => render(strings, values);
  client.unsafe = (text) => ({ [UNSAFE]: String(text) });
  return client;
}

// ── Fixtures ───────────────────────────────────────────────

let nextStrike = 5000;
const FIRE_DEFAULTS = {
  fired_at: '2026-03-26T15:00:00Z',
  signal_type: 'e1_long_call',
  dow_label: 'Thu',
  confidence_tier: 'HIGH',
  spot_at_fire: '5800.25',
  node_gex: '1234567.5',
  bar_open: '5799.5',
  bar_high: '5801',
  bar_low: '5799',
  bar_close: '5800.25',
  bar_range: '2',
  es_basis_change_5m: '0.75',
  prior_5d_ret: '-0.012345',
  prior_iv_rank: '41.5',
  open_gap_pct: '0.31',
  ret_15m: '0.05',
  ret_30m: '0.08',
  ret_60m: '-0.02',
  ret_eod: '0.11',
};

/** Insert one fire; returns its id as text. */
async function addFire(overrides = {}) {
  const row = { ...FIRE_DEFAULTS, node_strike: nextStrike++, ...overrides };
  const names = Object.keys(row);
  const { rows } = await pg.query(
    `INSERT INTO ${GAMMA} (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id::text AS id`,
    Object.values(row),
  );
  return rows[0].id;
}

/** Every row of a table as Postgres writes it, for before/after equality. */
async function dump(table, orderBy) {
  const { rows } = await pg.query(
    `SELECT t::text AS r FROM ${table} t ORDER BY ${orderBy}`,
  );
  return rows.map((r) => r.r);
}
const dumpFires = () => dump(GAMMA, 'id');

async function backupFires(dates = ['2026-03-26']) {
  return backupRows(sql, { table: GAMMA, dates, backupDir: tmp });
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

const manifestFileOf = (file) => file.replace(/\.jsonl$/, '.manifest.json');
const manifestOf = (file) =>
  JSON.parse(readFileSync(manifestFileOf(file), 'utf8'));

/**
 * Rewrite a backup's rows with `edit`, and its manifest to match (checksum and
 * row count), so that only the rows are wrong, not the file's integrity.
 */
function craftBackup(file, edit) {
  const rows = edit(readJsonl(file));
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  writeFileSync(file, text);
  const manifest = manifestOf(file);
  manifest.sha256 = createHash('sha256').update(text).digest('hex');
  manifest.rowCount = rows.length;
  writeFileSync(manifestFileOf(file), JSON.stringify(manifest));
}

/** Stage a race: run `act` once, just before the transaction that deletes. */
function beforeWriteOnce(marker, act) {
  hooks.beforeTransaction = async (queries) => {
    if (!queries.some((q) => q.text.includes(marker))) return;
    hooks.beforeTransaction = undefined;
    await act();
  };
}

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.query('CREATE TABLE analyses (id SERIAL PRIMARY KEY)');
  for (const id of [9, 10, 179, 189]) await applyMigration(pg, id);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  hooks = {};
  sql = neonLike(pg, hooks);
  await pg.query(`SET TimeZone = 'UTC'`);
  await pg.query(
    `TRUNCATE ${GAMMA}, training_features, day_labels, flow_regime_0dte_daily RESTART IDENTITY`,
  );
  tmp = mkdtempSync(path.join(tmpdir(), 'rebuild-backup-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await pg.query(
    `ALTER TABLE ${GAMMA} DROP CONSTRAINT IF EXISTS reject_restore`,
  );
  await pg.query('DROP TABLE IF EXISTS fire_refs');
  rmSync(tmp, { recursive: true, force: true });
});

// ── The allowlist ──────────────────────────────────────────

describe('the table allowlist', () => {
  it('names the five tables and the date column of each', () => {
    expect(BACKUP_TABLES).toEqual({
      training_features: 'date',
      day_labels: 'date',
      ws_gamma_setup_fires: 'fired_at',
      flow_regime_0dte_daily: 'date',
      day_embeddings: 'date',
    });
    expect(Object.isFrozen(BACKUP_TABLES)).toBe(true);
  });

  it.each([
    'users',
    'constructor',
    '__proto__',
    'toString',
    'training_features; DROP TABLE training_features',
    '"training_features"',
    '',
    undefined,
    42,
  ])('refuses a table outside the allowlist: %j', async (table) => {
    await expect(
      backupRows(sql, { table, dates: ['2026-03-26'], backupDir: tmp }),
    ).rejects.toThrow(RebuildRefusal);
    await expect(
      restoreRows(sql, { table, backupPath: path.join(tmp, 'x.jsonl') }),
    ).rejects.toThrow(/not one of the tables/);
    // Refused before any SQL: not a read, not a transaction.
    expect(sql.log.queries).toEqual([]);
    expect(sql.log.transactions).toEqual([]);
    expect(existsSync(path.join(tmp, 'rebuild'))).toBe(false);
  });
});

// ── backupRows ─────────────────────────────────────────────

describe('backupRows', () => {
  it('backs up only the given dates, as the ET session date of fired_at', async () => {
    // 22:30 EDT on 03-26 is 02:30Z on 03-27: UTC says 03-27, ET says 03-26.
    const inside = await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    const lateInside = await addFire({ fired_at: '2026-03-27T02:30:00Z' });
    // 00:30 EDT on 03-26 is 04:30Z: ET 03-26. 23:30 EDT on 03-25 is 03:30Z 03-26: ET 03-25.
    const earlyInside = await addFire({ fired_at: '2026-03-26T04:30:00Z' });
    await addFire({ fired_at: '2026-03-26T03:30:00Z' });
    await addFire({ fired_at: '2026-03-27T14:00:00Z' });
    await addFire({ fired_at: '2026-03-25T14:00:00Z' });

    const result = await backupFires(['2026-03-26']);

    const lines = readJsonl(result.path);
    expect(lines.map((r) => r.id).sort()).toEqual(
      [inside, lateInside, earlyInside].sort(),
    );
    expect(result.rows).toBe(3);
  });

  it('backs up a DATE-keyed table by its date column, a list of dates', async () => {
    for (const d of ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26']) {
      await pg.query(
        `INSERT INTO training_features (date, vix, spx_open, dow_label)
         VALUES ($1, 18.5, 5700.25, 'Mon')`,
        [d],
      );
    }

    const result = await backupRows(sql, {
      table: 'training_features',
      dates: ['2026-03-26', '2026-03-23'],
      backupDir: tmp,
    });

    const lines = readJsonl(result.path);
    expect(lines.map((r) => r.date)).toEqual(['2026-03-23', '2026-03-26']);
    expect(lines[0]).toMatchObject({
      vix: '18.50',
      spx_open: '5700.25',
      dow_label: 'Mon',
      spx_ncp_t1: null,
    });
  });

  it('writes every column as text, under <dir>/rebuild/, named by table, dates and UTC stamp', async () => {
    const id = await addFire({ trade_notes: 'kept' });

    const result = await backupFires();

    expect(path.dirname(result.path)).toBe(path.join(tmp, 'rebuild'));
    expect(path.basename(result.path)).toMatch(
      /^ws_gamma_setup_fires-2026-03-26\.\.2026-03-26-\d{8}T\d{9}Z\.jsonl$/,
    );
    const [row] = readJsonl(result.path);
    expect(
      Object.values(row).every((v) => v === null || typeof v === 'string'),
    ).toBe(true);
    expect(row).toMatchObject({
      id,
      fired_at: '2026-03-26 15:00:00+00',
      signal_type: 'e1_long_call',
      spot_at_fire: '5800.25',
      pre_day_filter_fires: 'false',
      trade_taken: 'false',
      trade_notes: 'kept',
      trade_pnl_dollars: null,
    });
    // One column per column of the table, in table order.
    const { rows } = await pg.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = '${GAMMA}' ORDER BY ordinal_position`,
    );
    expect(Object.keys(row)).toEqual(rows.map((r) => r.column_name));
  });

  it('writes the rows in key order: numeric for a bigint key, not text order', async () => {
    for (let i = 0; i < 12; i++) await addFire();

    const result = await backupFires();

    const ids = readJsonl(result.path).map((r) => Number(r.id));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('writes the same text whatever the session time zone is', async () => {
    await addFire();
    await pg.query(`SET TimeZone = 'Asia/Tokyo'`);

    const result = await backupFires();

    expect(readJsonl(result.path)[0].fired_at).toBe('2026-03-26 15:00:00+00');
  });

  it('writes a manifest beside the backup: table, key, scope, columns, count and checksum', async () => {
    await addFire();
    await addFire({ fired_at: '2026-03-27T14:00:00Z' });

    const result = await backupFires(['2026-03-27', '2026-03-26']);

    expect(manifestOf(result.path)).toMatchObject({
      version: 1,
      table: GAMMA,
      keyColumn: 'id',
      dateColumn: 'fired_at',
      dates: ['2026-03-26', '2026-03-27'],
      rowCount: 2,
    });
    expect(manifestOf(result.path).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestOf(result.path).columns[0]).toEqual({
      name: 'id',
      type: 'bigint',
    });
    expect(readdirSync(path.join(tmp, 'rebuild')).sort()).toHaveLength(2);
  });

  it.each([
    ['ws_gamma_setup_fires', 'id'],
    ['training_features', 'date'],
    ['day_labels', 'date'],
    ['flow_regime_0dte_daily', 'date'],
  ])('reads the key of %s from the primary key: %s', async (table, key) => {
    const result = await backupRows(sql, {
      table,
      dates: ['2026-03-26'],
      backupDir: tmp,
    });
    expect(manifestOf(result.path).keyColumn).toBe(key);
  });

  it('records an empty scope: an empty file and a manifest that says so', async () => {
    await addFire({ fired_at: '2026-03-27T14:00:00Z' });

    const result = await backupFires(['2026-03-26']);

    expect(result.rows).toBe(0);
    expect(readFileSync(result.path, 'utf8')).toBe('');
    expect(manifestOf(result.path)).toMatchObject({
      rowCount: 0,
      dates: ['2026-03-26'],
    });
  });

  it('never overwrites a backup', async () => {
    await addFire();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-28T20:00:00.000Z'));

    await backupFires();
    await expect(backupFires()).rejects.toThrow(/EEXIST/);
  });

  it('never overwrites a manifest either', async () => {
    await addFire();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-28T20:00:00.000Z'));
    const dir = path.join(tmp, 'rebuild');
    const manifest = path.join(
      dir,
      'ws_gamma_setup_fires-2026-03-26..2026-03-26-20261128T200000000Z.manifest.json',
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(manifest, 'keep me');

    await expect(backupFires()).rejects.toThrow(/EEXIST/);

    expect(readFileSync(manifest, 'utf8')).toBe('keep me');
  });

  it.each([
    ['no dates', []],
    ['not a list', '2026-03-26'],
    ['a malformed date', ['2026-3-26']],
    ['a date that does not exist', ['2026-02-30']],
    [
      'too many dates',
      Array.from({ length: MAX_DATES + 1 }, (_, i) =>
        new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      ),
    ],
  ])('refuses %s', async (_name, dates) => {
    await expect(
      backupRows(sql, { table: GAMMA, dates, backupDir: tmp }),
    ).rejects.toThrow(RebuildRefusal);
    expect(sql.log.queries).toEqual([]);
  });

  it('refuses without a backup directory', async () => {
    await expect(
      backupRows(sql, { table: GAMMA, dates: ['2026-03-26'], backupDir: '' }),
    ).rejects.toThrow(/backup directory/);
  });
});

// ── The table description ──────────────────────────────────

describe('buildTableInfo', () => {
  const col = (
    column_name,
    data_type,
    udt_name = data_type,
    is_generated = 'NEVER',
  ) => ({
    column_name,
    data_type,
    udt_name,
    is_generated,
  });
  const EMBEDDINGS = [
    col('date', 'date'),
    col('symbol', 'text'),
    col('embedding', 'USER-DEFINED', 'vector'),
    col('day_open', 'double precision', 'float8'),
    col('created_at', 'timestamp with time zone', 'timestamptz'),
  ];

  it('refuses a column whose type has no safe cast back from text', () => {
    expect(() =>
      buildTableInfo(
        'training_features',
        [col('date', 'date'), col('span', 'interval')],
        ['date'],
      ),
    ).toThrow(/no safe cast back from text.*span/);
    expect(() =>
      buildTableInfo(
        'training_features',
        [col('date', 'date'), col('tags', 'ARRAY', '_text')],
        ['date'],
      ),
    ).toThrow(RebuildRefusal);
    expect(() =>
      buildTableInfo(
        'training_features',
        [col('date', 'date'), col('mood', 'USER-DEFINED', 'mood')],
        ['date'],
      ),
    ).toThrow(RebuildRefusal);
  });

  it('refuses a table with no table, no date column of a usable type, or no one-column primary key', () => {
    expect(() => buildTableInfo('training_features', [], ['date'])).toThrow(
      /no columns/,
    );
    expect(() =>
      buildTableInfo('training_features', [col('day', 'date')], ['day']),
    ).toThrow(/no date column/);
    expect(() =>
      buildTableInfo('training_features', [col('date', 'text')], ['date']),
    ).toThrow(/date column .* date or timestamp with time zone/);
    expect(() =>
      buildTableInfo(
        'training_features',
        [col('date', 'date'), col('b', 'text')],
        [],
      ),
    ).toThrow(/one-column primary key/);
    expect(() =>
      buildTableInfo(
        'training_features',
        [col('date', 'date'), col('b', 'text')],
        ['date', 'b'],
      ),
    ).toThrow(/one-column primary key/);
  });

  it('quotes every identifier it takes from information_schema', () => {
    const info = buildTableInfo(
      'training_features',
      [col('date', 'date'), col('we"ird', 'text')],
      ['date'],
    );
    expect(info.selectList).toBe(
      '"date"::text AS "date", "we""ird"::text AS "we""ird"',
    );
  });

  it('restore casts a vector column with ::vector (and every other column by its type)', () => {
    const info = buildTableInfo('day_embeddings', EMBEDDINGS, ['date']);
    const rows = [
      {
        date: '2026-07-22',
        symbol: 'SPX',
        embedding: '[0.1,-0.25,3]',
        day_open: '5800.5',
        created_at: '2026-07-22 21:05:00.123456+00',
      },
    ];

    const { text, params } = restoreInsertStatement(recordingSql(), info, rows);

    expect(text).toContain('x."embedding"::vector');
    expect(text).toContain('x."date"::date');
    expect(text).toContain('x."symbol"::text');
    expect(text).toContain('x."day_open"::double precision');
    expect(text).toContain('x."created_at"::timestamp with time zone');
    expect(text).toContain('INSERT INTO "day_embeddings"');
    expect(text).toContain('jsonb_to_recordset($1::jsonb)');
    expect(text).toContain('RETURNING "date"::text AS key');
    // The values are one bound parameter, never part of the text.
    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0])).toEqual(rows);
    expect(text).not.toContain('0.25');
  });

  it('leaves a generated column out of the insert', () => {
    const info = buildTableInfo(
      'training_features',
      [col('date', 'date'), col('score', 'numeric', 'numeric', 'ALWAYS')],
      ['date'],
    );
    const { text, params } = restoreInsertStatement(recordingSql(), info, [
      { date: '2026-03-26', score: '3' },
    ]);
    expect(text).not.toContain('score');
    expect(JSON.parse(params[0])).toEqual([{ date: '2026-03-26' }]);
  });
});

// ── deleteGammaFires ───────────────────────────────────────

/** The delete of the one day most of these tests use, from `backupPath`. */
const deleteOn0326 = (backupPath) =>
  deleteGammaFires(sql, { from: '2026-03-26', to: '2026-03-26', backupPath });

describe('deleteGammaFires', () => {
  it('removes exactly the backed-up rows', async () => {
    const a = await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    const b = await addFire({ fired_at: '2026-03-27T02:30:00Z' }); // ET 03-26
    const outside = await addFire({ fired_at: '2026-03-27T14:00:00Z' });
    const before = await addFire({ fired_at: '2026-03-25T14:00:00Z' });
    const backup = await backupFires();

    const result = await deleteGammaFires(sql, {
      from: '2026-03-26',
      to: '2026-03-26',
      backupPath: backup.path,
    });

    expect(result).toEqual({ deleted: 2 });
    const { rows } = await pg.query(
      `SELECT id::text AS id FROM ${GAMMA} ORDER BY id`,
    );
    expect(rows.map((r) => r.id)).toEqual(
      [outside, before].sort((x, y) => x - y),
    );
    expect(rows.map((r) => r.id)).not.toContain(a);
    expect(rows.map((r) => r.id)).not.toContain(b);
  });

  it('takes a window of several days, both ends included', async () => {
    await addFire({ fired_at: '2026-03-25T14:00:00Z' });
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    await addFire({ fired_at: '2026-03-27T14:00:00Z' });
    await addFire({ fired_at: '2026-03-28T14:00:00Z' });
    const backup = await backupFires([
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
    ]);

    const result = await deleteGammaFires(sql, {
      from: '2026-03-25',
      to: '2026-03-27',
      backupPath: backup.path,
    });

    expect(result).toEqual({ deleted: 3 });
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM ${GAMMA}`);
    expect(rows[0].n).toBe(1);
  });

  it('is not fooled by a different session time zone than the backup was taken in', async () => {
    await addFire();
    await pg.query(`SET TimeZone = 'Asia/Tokyo'`);
    const backup = await backupFires();
    await pg.query(`SET TimeZone = 'America/Los_Angeles'`);

    await expect(
      deleteGammaFires(sql, {
        from: '2026-03-26',
        to: '2026-03-26',
        backupPath: backup.path,
      }),
    ).resolves.toEqual({ deleted: 1 });
  });

  it('does nothing, without a transaction, when the window is empty and the backup is empty', async () => {
    const backup = await backupFires(['2026-03-26']);

    await expect(
      deleteGammaFires(sql, {
        from: '2026-03-26',
        to: '2026-03-26',
        backupPath: backup.path,
      }),
    ).resolves.toEqual({ deleted: 0 });
    // Only the checking read: no DELETE transaction.
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => q.text.includes('DELETE')),
      ),
    ).toBe(false);
  });

  describe('refuses without a matching backup', () => {
    let before;
    beforeEach(async () => {
      await addFire({ fired_at: '2026-03-26T14:00:00Z' });
      await addFire({ fired_at: '2026-03-26T15:00:00Z' });
      before = await dumpFires();
    });
    const run = deleteOn0326;

    afterEach(async () => {
      // Whatever the refusal, no fire was deleted.
      expect(await dumpFires()).toEqual(before);
      expect(
        sql.log.transactions.some((t) =>
          t.some((q) => q.text.includes('DELETE FROM')),
        ),
      ).toBe(false);
    });

    it.each([undefined, null, '', 42])('no path: %j', async (backupPath) => {
      await expect(run(backupPath)).rejects.toThrow(/needs the backup file/);
    });

    it('a path that is not a .jsonl backup', async () => {
      await expect(run(path.join(tmp, 'x.json'))).rejects.toThrow(/\.jsonl/);
    });

    it('a file that does not exist', async () => {
      await expect(run(path.join(tmp, 'gone.jsonl'))).rejects.toThrow(
        /cannot read the backup/,
      );
    });

    it('a backup with no manifest beside it', async () => {
      const backup = await backupFires();
      rmSync(backup.path.replace(/\.jsonl$/, '.manifest.json'));
      await expect(run(backup.path)).rejects.toThrow(/manifest/);
    });

    it('a manifest that is not JSON', async () => {
      const backup = await backupFires();
      writeFileSync(manifestFileOf(backup.path), 'not json');
      await expect(run(backup.path)).rejects.toThrow(/not valid JSON/);
    });

    it('a manifest that is not valid', async () => {
      const backup = await backupFires();
      writeFileSync(
        backup.path.replace(/\.jsonl$/, '.manifest.json'),
        '{"version":1}',
      );
      await expect(run(backup.path)).rejects.toThrow(
        /not a rebuild backup manifest/,
      );
    });

    it('a manifest whose row count is not the file', async () => {
      const backup = await backupFires();
      const manifest = manifestOf(backup.path);
      manifest.rowCount += 1;
      writeFileSync(manifestFileOf(backup.path), JSON.stringify(manifest));
      await expect(run(backup.path)).rejects.toThrow(
        /holds 2 rows, its manifest says 3/,
      );
    });

    it('a backup with a repeated key', async () => {
      const backup = await backupFires();
      craftBackup(backup.path, (rows) => [rows[0], ...rows]);
      await expect(run(backup.path)).rejects.toThrow(/repeated key/);
    });

    it('a backup row that lacks a column', async () => {
      const backup = await backupFires();
      craftBackup(backup.path, (rows) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([name]) => name !== 'ret_15m'),
          ),
        ),
      );
      await expect(run(backup.path)).rejects.toThrow(/malformed/);
    });

    it('a backup row with a column the table does not have (same column count)', async () => {
      const backup = await backupFires();
      craftBackup(backup.path, (rows) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([name, value]) => [
              name === 'ret_15m' ? 'ret_15x' : name,
              value,
            ]),
          ),
        ),
      );
      await expect(run(backup.path)).rejects.toThrow(/malformed/);
    });

    it('a backup of another table', async () => {
      const other = await backupRows(sql, {
        table: 'training_features',
        dates: ['2026-03-26'],
        backupDir: tmp,
      });
      await expect(run(other.path)).rejects.toThrow(
        /backup is of training_features/,
      );
    });

    it('a backup whose key or date column is not the table', async () => {
      const backup = await backupFires();
      const manifest = manifestOf(backup.path);
      manifest.keyColumn = 'fired_at';
      writeFileSync(manifestFileOf(backup.path), JSON.stringify(manifest));
      await expect(run(backup.path)).rejects.toThrow(
        /key or date column differs/,
      );
    });

    it('a backup file edited after it was taken', async () => {
      const backup = await backupFires();
      writeFileSync(
        backup.path,
        readFileSync(backup.path, 'utf8').replace('0.05', '0.06'),
      );
      await expect(run(backup.path)).rejects.toThrow(
        /does not match its manifest/,
      );
    });

    it('a backup taken before a fire was inserted (the live window has one it lacks)', async () => {
      const backup = await backupFires();
      const late = await addFire({ fired_at: '2026-03-26T16:00:00Z' });
      before = await dumpFires();
      await expect(run(backup.path)).rejects.toThrow(
        new RegExp(`1 live fire is not in the backup \\(${late}\\)`),
      );
    });

    it('a backup that lists a fire which is no longer live', async () => {
      const backup = await backupFires();
      await pg.query(
        `DELETE FROM ${GAMMA} WHERE id = (SELECT min(id) FROM ${GAMMA})`,
      );
      before = await dumpFires();
      await expect(run(backup.path)).rejects.toThrow(
        /1 fire in the backup is not live/,
      );
    });

    it('a backup of a wider window than the delete', async () => {
      await addFire({ fired_at: '2026-03-27T14:00:00Z' });
      before = await dumpFires();
      const backup = await backupFires(['2026-03-26', '2026-03-27']);
      await expect(run(backup.path)).rejects.toThrow(
        /1 fire in the backup is not live/,
      );
    });

    it('a backup whose rows have changed since (an outcome was filled in)', async () => {
      const backup = await backupFires();
      await pg.query(
        `UPDATE ${GAMMA} SET ret_15m = 9.99 WHERE id = (SELECT min(id) FROM ${GAMMA})`,
      );
      before = await dumpFires();
      await expect(run(backup.path)).rejects.toThrow(
        /1 fire differs from the backup.*ret_15m/,
      );
    });
  });

  describe('refuses a fire with a journal entry', () => {
    it.each([
      ['trade_taken', 'true'],
      ['trade_premium_cost', '1.25'],
      ['trade_premium_close', '0'],
      ['trade_pnl_dollars', '-40'],
      ['trade_notes', ''],
    ])('%s = %j', async (column, value) => {
      await addFire({ fired_at: '2026-03-26T14:00:00Z' });
      const journaled = await addFire({
        fired_at: '2026-03-26T15:00:00Z',
        [column]: value === 'true' ? true : value,
      });
      const backup = await backupFires();
      const before = await dumpFires();

      await expect(
        deleteGammaFires(sql, {
          from: '2026-03-26',
          to: '2026-03-26',
          backupPath: backup.path,
        }),
      ).rejects.toThrow(
        new RegExp(`1 of the 2 fires carries a journal entry.*${journaled}`),
      );
      expect(await dumpFires()).toEqual(before);
    });
  });

  describe('re-checks inside the transaction', () => {
    let a;
    let before;
    beforeEach(async () => {
      a = await addFire({ fired_at: '2026-03-26T14:00:00Z' });
      await addFire({ fired_at: '2026-03-26T15:00:00Z' });
      before = await dumpFires();
    });
    const run = deleteOn0326;

    it('a fire inserted between the check and the delete makes it refuse, and nothing is deleted', async () => {
      const backup = await backupFires();
      beforeWriteOnce('DELETE FROM', () =>
        addFire({ fired_at: '2026-03-26T16:00:00Z' }),
      );

      await expect(run(backup.path)).rejects.toThrow(RebuildRefusal);
      // Whatever was deleted inside the transaction came back: both original
      // fires and the new one are all still there.
      const { rows } = await pg.query(
        `SELECT count(*)::int AS n FROM ${GAMMA}`,
      );
      expect(rows[0].n).toBe(3);
      expect((await dumpFires()).slice(0, 2)).toEqual(before);
    });

    it('the refusal names what changed', async () => {
      const backup = await backupFires();
      beforeWriteOnce('DELETE FROM', () =>
        addFire({ fired_at: '2026-03-26T16:00:00Z' }),
      );
      await expect(run(backup.path)).rejects.toThrow(
        /changed between the check and the delete.*Nothing was deleted/s,
      );
    });

    it('a fire changed between the check and the delete is not deleted: it refuses', async () => {
      const backup = await backupFires();
      beforeWriteOnce('DELETE FROM', () =>
        pg.query(`UPDATE ${GAMMA} SET ret_eod = 7.77 WHERE id = $1`, [a]),
      );

      await expect(run(backup.path)).rejects.toThrow(
        /changed between the check and the delete/,
      );
      const { rows } = await pg.query(
        `SELECT count(*)::int AS n, bool_or(ret_eod = 7.77) AS kept FROM ${GAMMA}`,
      );
      expect(rows[0]).toEqual({ n: 2, kept: true });
    });

    it.each([
      ['trade_taken', 'true'],
      ['trade_premium_cost', '1.25'],
      ['trade_premium_close', '0'],
      ['trade_pnl_dollars', '-40'],
      ['trade_notes', "''"],
    ])(
      'a journal entry (%s) written between the check and the delete is not deleted: it refuses',
      async (column, literal) => {
        const backup = await backupFires();
        beforeWriteOnce('DELETE FROM', () =>
          pg.query(`UPDATE ${GAMMA} SET ${column} = ${literal} WHERE id = $1`, [
            a,
          ]),
        );

        await expect(run(backup.path)).rejects.toThrow(
          /changed between the check and the delete/,
        );
        const { rows } = await pg.query(
          `SELECT count(*)::int AS n FROM ${GAMMA}`,
        );
        expect(rows[0].n).toBe(2);
      },
    );
  });

  it('refuses a table that is no longer the one it was written for', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    const backup = await backupFires();
    await pg.query(`ALTER TABLE ${GAMMA} ADD COLUMN ret_90m NUMERIC`);
    try {
      await expect(deleteOn0326(backup.path)).rejects.toThrow(
        /not the table this tool was written for.*unknown ret_90m/,
      );
      await expect(
        nullGammaReturns(sql, { date: '2026-03-26', backupPath: backup.path }),
      ).rejects.toThrow(/not the table this tool was written for/);
    } finally {
      await pg.query(`ALTER TABLE ${GAMMA} DROP COLUMN ret_90m`);
    }
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM ${GAMMA}`);
    expect(rows[0].n).toBe(1);
  });

  it('a DB reject at the delete (a row another table points at) rolls back and surfaces by name', async () => {
    const a = await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    await addFire({ fired_at: '2026-03-26T15:00:00Z' });
    await pg.query(
      `CREATE TABLE fire_refs (fire_id BIGINT CONSTRAINT fire_refs_fire_fk REFERENCES ${GAMMA}(id))`,
    );
    await pg.query(`INSERT INTO fire_refs VALUES ($1)`, [a]);
    const backup = await backupFires();
    const before = await dumpFires();

    await expect(
      deleteGammaFires(sql, {
        from: '2026-03-26',
        to: '2026-03-26',
        backupPath: backup.path,
      }),
    ).rejects.toThrow(/fire_refs_fire_fk/);
    expect(await dumpFires()).toEqual(before);
  });

  it('a dry run writes nothing', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    await addFire({ fired_at: '2026-03-26T15:00:00Z' });
    const backup = await backupFires();
    const before = await dumpFires();

    const result = await deleteGammaFires(sql, {
      from: '2026-03-26',
      to: '2026-03-26',
      backupPath: backup.path,
      dryRun: true,
    });

    expect(result).toEqual({ deleted: 0, wouldDelete: 2, dryRun: true });
    expect(await dumpFires()).toEqual(before);
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => /DELETE|UPDATE|INSERT/.test(q.text)),
      ),
    ).toBe(false);
  });

  it('checks a dry run as hard as the real run', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z', trade_taken: true });
    const backup = await backupFires();

    await expect(
      deleteGammaFires(sql, {
        from: '2026-03-26',
        to: '2026-03-26',
        backupPath: backup.path,
        dryRun: true,
      }),
    ).rejects.toThrow(/journal entry/);
  });

  it.each([
    ['a start that is not a date', { from: '2026-3-26', to: '2026-03-27' }],
    ['an end that is not a date', { from: '2026-03-26', to: 'soon' }],
    ['an end before the start', { from: '2026-03-27', to: '2026-03-26' }],
    ['a window past the cap', { from: '2025-01-01', to: '2026-03-26' }],
  ])('refuses %s', async (_name, window) => {
    await expect(
      deleteGammaFires(sql, {
        ...window,
        backupPath: path.join(tmp, 'x.jsonl'),
      }),
    ).rejects.toThrow(RebuildRefusal);
    expect(sql.log.queries).toEqual([]);
  });
});

// ── nullGammaReturns ───────────────────────────────────────

describe('nullGammaReturns', () => {
  const onlyReturnsDiffer = async () => {
    const { rows } = await pg.query(
      `SELECT id::text AS id,
              to_jsonb(t) - 'ret_15m' - 'ret_30m' - 'ret_60m' - 'ret_eod' AS rest,
              to_jsonb(t) ->> 'ret_15m' AS r15, to_jsonb(t) ->> 'ret_eod' AS reod
       FROM ${GAMMA} t ORDER BY id`,
    );
    return rows;
  };

  it('touches only ret_* on that date', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    await addFire({ fired_at: '2026-09-21T15:00:00Z', ret_15m: null });
    await addFire({ fired_at: '2026-09-22T14:00:00Z' });
    await addFire({ fired_at: '2026-09-20T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);
    const before = await onlyReturnsDiffer();

    const result = await nullGammaReturns(sql, {
      date: '2026-09-21',
      backupPath: backup.path,
    });

    expect(result).toEqual({ updated: 2 });
    const after = await onlyReturnsDiffer();
    // Every other column of every row is as it was.
    expect(after.map((r) => r.rest)).toEqual(before.map((r) => r.rest));
    // The two fires on 09-21 lost their returns; the others kept theirs.
    expect(after.map((r) => [r.r15, r.reod])).toEqual([
      [null, null],
      [null, null],
      ['0.05', '0.11'],
      ['0.05', '0.11'],
    ]);
    const { rows } = await pg.query(
      `SELECT count(*)::int AS n FROM ${GAMMA}
       WHERE ret_15m IS NULL AND ret_30m IS NULL AND ret_60m IS NULL AND ret_eod IS NULL`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('refuses without a matching backup, and changes nothing', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);
    await addFire({ fired_at: '2026-09-21T15:00:00Z' });
    const before = await dumpFires();

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).rejects.toThrow(/1 live fire is not in the backup/);
    await expect(
      nullGammaReturns(sql, {
        date: '2026-09-21',
        backupPath: path.join(tmp, 'gone.jsonl'),
      }),
    ).rejects.toThrow(/cannot read the backup/);
    await expect(nullGammaReturns(sql, { date: '2026-09-21' })).rejects.toThrow(
      /needs the backup file/,
    );
    expect(await dumpFires()).toEqual(before);
  });

  it('refuses a stale backup: the returns it holds are not the live ones', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);
    await pg.query(`UPDATE ${GAMMA} SET ret_60m = 1.5`);
    const before = await dumpFires();

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).rejects.toThrow(/1 fire differs from the backup.*ret_60m/);
    expect(await dumpFires()).toEqual(before);
  });

  it('re-checks inside the transaction: a return filled in between the check and the update refuses', async () => {
    const a = await addFire({
      fired_at: '2026-09-21T14:00:00Z',
      ret_15m: null,
    });
    const backup = await backupFires(['2026-09-21']);
    beforeWriteOnce('UPDATE', () =>
      pg.query(`UPDATE ${GAMMA} SET ret_15m = 3.21 WHERE id = $1`, [a]),
    );

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).rejects.toThrow(
      /changed between the check and the update.*Nothing was changed/s,
    );
    const { rows } = await pg.query(`SELECT ret_15m::text AS r FROM ${GAMMA}`);
    expect(rows[0].r).toBe('3.21');
  });

  it('re-checks inside the transaction: a fire inserted between the check and the update refuses', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);
    // A fire with no returns at all, so only the fire count can give it away.
    beforeWriteOnce('UPDATE', () =>
      addFire({
        fired_at: '2026-09-21T16:00:00Z',
        ret_15m: null,
        ret_30m: null,
        ret_60m: null,
        ret_eod: null,
      }),
    );

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).rejects.toThrow(/changed between the check and the update/);
    const { rows } = await pg.query(
      `SELECT count(*)::int AS n FROM ${GAMMA} WHERE ret_15m IS NOT NULL`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('does nothing, without a transaction, when the date has no fires and the backup is empty', async () => {
    await addFire({ fired_at: '2026-09-22T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).resolves.toEqual({ updated: 0 });
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => q.text.includes('UPDATE')),
      ),
    ).toBe(false);
  });

  it('is not fooled by a different session time zone than the backup was taken in', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    await pg.query(`SET TimeZone = 'Asia/Tokyo'`);
    const backup = await backupFires(['2026-09-21']);
    await pg.query(`SET TimeZone = 'America/Los_Angeles'`);

    await expect(
      nullGammaReturns(sql, { date: '2026-09-21', backupPath: backup.path }),
    ).resolves.toEqual({ updated: 1 });
  });

  it('a dry run writes nothing', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);
    const before = await dumpFires();

    const result = await nullGammaReturns(sql, {
      date: '2026-09-21',
      backupPath: backup.path,
      dryRun: true,
    });

    expect(result).toEqual({ updated: 0, wouldUpdate: 1, dryRun: true });
    expect(await dumpFires()).toEqual(before);
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => /DELETE|UPDATE|INSERT/.test(q.text)),
      ),
    ).toBe(false);
  });

  it('refuses a date that is not a date', async () => {
    await expect(
      nullGammaReturns(sql, {
        date: '2026-09-31',
        backupPath: path.join(tmp, 'x.jsonl'),
      }),
    ).rejects.toThrow(RebuildRefusal);
  });
});

// ── restoreRows ────────────────────────────────────────────

describe('restoreRows', () => {
  it('brings back the exact rows: the rebuilt ones go, the backed-up ones return with their own ids', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    await addFire({ fired_at: '2026-03-27T02:30:00Z', ret_15m: null }); // ET 03-26
    await addFire({ fired_at: '2026-03-27T14:00:00Z' }); // outside the backup
    const before = await dumpFires();
    const backup = await backupFires();

    // The rebuild: the scope's fires go, others (new ids) take their place.
    await pg.query(
      `DELETE FROM ${GAMMA} WHERE (fired_at AT TIME ZONE 'America/New_York')::date = '2026-03-26'`,
    );
    await addFire({ fired_at: '2026-03-26T14:00:00Z', node_strike: 9001 });
    await addFire({ fired_at: '2026-03-26T14:05:00Z', node_strike: 9002 });
    await addFire({ fired_at: '2026-03-26T14:10:00Z', node_strike: 9003 });
    await pg.query(`UPDATE ${GAMMA} SET ret_eod = 99 WHERE node_strike = 9001`);

    const result = await restoreRows(sql, {
      table: GAMMA,
      backupPath: backup.path,
    });

    expect(result).toEqual({ restored: 2, deleted: 3 });
    expect(await dumpFires()).toEqual(before);
  });

  it('restores a DATE-keyed table: rows the rebuild rewrote, and rows it created in the scope', async () => {
    await pg.query(
      `INSERT INTO training_features (date, vix, spx_open, dow_label, feature_completeness)
       VALUES ('2026-03-23', 18.5, 5700.25, 'Mon', 0.9), ('2026-03-24', 19, 5710, 'Tue', 0.8)`,
    );
    const before = await dump('training_features', 'date');
    const backup = await backupRows(sql, {
      table: 'training_features',
      dates: ['2026-03-23', '2026-03-24', '2026-03-25'],
      backupDir: tmp,
    });
    // The rebuild rewrites 03-23, blanks the completeness of 03-24 and creates 03-25.
    await pg.query(
      `UPDATE training_features SET vix = 99, spx_open = NULL WHERE date = '2026-03-23'`,
    );
    await pg.query(
      `UPDATE training_features SET feature_completeness = 0 WHERE date = '2026-03-24'`,
    );
    await pg.query(
      `INSERT INTO training_features (date, vix) VALUES ('2026-03-25', 20)`,
    );

    const result = await restoreRows(sql, {
      table: 'training_features',
      backupPath: backup.path,
    });

    expect(result).toEqual({ restored: 2, deleted: 3 });
    expect(await dump('training_features', 'date')).toEqual(before);
  });

  it('restores flow_regime_0dte_daily', async () => {
    await pg.query(
      `INSERT INTO flow_regime_0dte_daily (date, gate, gex_open, mostly_red, mostly_red_at, big_down)
       VALUES ('2026-09-21', 'neg_gamma', -123456.5, true, '09:40', false)`,
    );
    const before = await dump('flow_regime_0dte_daily', 'date');
    const backup = await backupRows(sql, {
      table: 'flow_regime_0dte_daily',
      dates: ['2026-09-21'],
      backupDir: tmp,
    });
    await pg.query(
      `UPDATE flow_regime_0dte_daily SET gate = 'pos_gamma', mostly_red = false`,
    );

    await restoreRows(sql, {
      table: 'flow_regime_0dte_daily',
      backupPath: backup.path,
    });

    expect(await dump('flow_regime_0dte_daily', 'date')).toEqual(before);
  });

  it('restores an empty scope by removing what the rebuild created there', async () => {
    const backup = await backupRows(sql, {
      table: 'flow_regime_0dte_daily',
      dates: ['2026-07-22'],
      backupDir: tmp,
    });
    await pg.query(
      `INSERT INTO flow_regime_0dte_daily (date, gate) VALUES ('2026-07-22', 'neg_gamma'), ('2026-07-23', 'pos_gamma')`,
    );

    const result = await restoreRows(sql, {
      table: 'flow_regime_0dte_daily',
      backupPath: backup.path,
    });

    expect(result).toEqual({ restored: 0, deleted: 1 });
    const { rows } = await pg.query(
      `SELECT date::text AS d FROM flow_regime_0dte_daily`,
    );
    expect(rows).toEqual([{ d: '2026-07-23' }]);
  });

  it('restores in batches of at most 500 rows, each statement one parameter', async () => {
    const total = RESTORE_BATCH_ROWS * 2 + 100;
    await pg.query(
      `INSERT INTO ${GAMMA} (fired_at, signal_type, dow_label, confidence_tier, spot_at_fire,
         node_strike, node_gex, bar_open, bar_high, bar_low, bar_close, bar_range)
       SELECT '2026-03-26T14:00:00Z'::timestamptz + (g || ' seconds')::interval, 'e1_long_call', 'Thu',
              'HIGH', 5800, g, 1, 1, 1, 1, 1, 1
       FROM generate_series(1, ${total}) AS g`,
    );
    const before = await dumpFires();
    const backup = await backupFires();
    await pg.query(`DELETE FROM ${GAMMA}`);

    const result = await restoreRows(sql, {
      table: GAMMA,
      backupPath: backup.path,
    });

    expect(result).toEqual({ restored: total, deleted: 0 });
    expect(await dumpFires()).toEqual(before);
    const restoreTx = sql.log.transactions.at(-1);
    const inserts = restoreTx.filter((q) => q.text.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((q) => JSON.parse(q.params[0]).length)).toEqual([
      500, 500, 100,
    ]);
  });

  it('a DB reject mid-transaction rolls back: the rows the delete removed come back', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    await addFire({ fired_at: '2026-03-26T15:00:00Z' });
    const backup = await backupFires();
    // The rebuilt state the restore starts from.
    await pg.query(`DELETE FROM ${GAMMA}`);
    await addFire({ fired_at: '2026-03-26T14:00:00Z', node_strike: 9001 });
    const rebuilt = await dumpFires();
    // A rule the backed-up rows break, so the insert fails after the delete ran.
    await pg.query(
      `ALTER TABLE ${GAMMA} ADD CONSTRAINT reject_restore CHECK (spot_at_fire < 0) NOT VALID`,
    );

    await expect(
      restoreRows(sql, { table: GAMMA, backupPath: backup.path }),
    ).rejects.toThrow(/reject_restore/);
    expect(await dumpFires()).toEqual(rebuilt);
  });

  it('refuses when a column was added or retyped since the backup', async () => {
    await addFire();
    const backup = await backupFires();
    await pg.query(`ALTER TABLE ${GAMMA} ADD COLUMN extra_note TEXT`);
    try {
      await expect(
        restoreRows(sql, { table: GAMMA, backupPath: backup.path }),
      ).rejects.toThrow(
        /columns of ws_gamma_setup_fires have changed since the backup.*extra_note/s,
      );
    } finally {
      await pg.query(`ALTER TABLE ${GAMMA} DROP COLUMN extra_note`);
    }
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => q.text.includes('INSERT')),
      ),
    ).toBe(false);
  });

  it('a row appearing in the scope while the restore runs makes it refuse, and rolls back', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    const backup = await backupFires();
    const before = await dumpFires();
    // A stray fire appears for every row the restore inserts: a concurrent
    // insert, as far as the restore can tell.
    await pg.query(`
      CREATE FUNCTION add_stray() RETURNS trigger AS $$
      BEGIN
        IF NEW.node_strike < 9000 THEN
          INSERT INTO ${GAMMA} (fired_at, signal_type, dow_label, confidence_tier,
            spot_at_fire, node_strike, node_gex, bar_open, bar_high, bar_low,
            bar_close, bar_range)
          VALUES (NEW.fired_at, NEW.signal_type, 'Thu', 'HIGH', 1, 99999, 1, 1, 1, 1, 1, 1);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pg.query(
      `CREATE TRIGGER stray AFTER INSERT ON ${GAMMA} FOR EACH ROW EXECUTE FUNCTION add_stray()`,
    );
    try {
      await expect(
        restoreRows(sql, { table: GAMMA, backupPath: backup.path }),
      ).rejects.toThrow(/changed during the restore.*Nothing was changed/s);
    } finally {
      await pg.query(`DROP TRIGGER IF EXISTS stray ON ${GAMMA}`);
      await pg.query('DROP FUNCTION IF EXISTS add_stray()');
    }
    expect(await dumpFires()).toEqual(before);
  });

  it('refuses a backup of another table, or an edited one', async () => {
    await addFire();
    const gamma = await backupFires();
    await expect(
      restoreRows(sql, { table: 'training_features', backupPath: gamma.path }),
    ).rejects.toThrow(
      /backup is of ws_gamma_setup_fires, not training_features/,
    );
    writeFileSync(
      gamma.path,
      readFileSync(gamma.path, 'utf8').replace('e1_long_call', 'e5_long_put'),
    );
    await expect(
      restoreRows(sql, { table: GAMMA, backupPath: gamma.path }),
    ).rejects.toThrow(/does not match its manifest/);
  });

  it('a dry run writes nothing, and says what it would do', async () => {
    await addFire({ fired_at: '2026-03-26T14:00:00Z' });
    const backup = await backupFires();
    await addFire({ fired_at: '2026-03-26T15:00:00Z' });
    const before = await dumpFires();

    const result = await restoreRows(sql, {
      table: GAMMA,
      backupPath: backup.path,
      dryRun: true,
    });

    expect(result).toEqual({
      restored: 0,
      wouldRestore: 1,
      wouldDelete: 2,
      notInBackup: 1,
      dryRun: true,
    });
    expect(await dumpFires()).toEqual(before);
    expect(
      sql.log.transactions.some((t) =>
        t.some((q) => /DELETE|UPDATE|INSERT/.test(q.text)),
      ),
    ).toBe(false);
  });
});

// ── Dates, batches and flags ───────────────────────────────

describe('dates', () => {
  it('datesBetween lists calendar days, both ends included', () => {
    expect(datesBetween('2026-03-07', '2026-03-10')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
    expect(datesBetween('2026-02-28', '2026-03-01')).toEqual([
      '2026-02-28',
      '2026-03-01',
    ]);
    expect(datesBetween('2026-03-26', '2026-03-26')).toEqual(['2026-03-26']);
    expect(datesBetween('2025-01-01', '2025-12-31')).toHaveLength(365);
  });

  it.each([
    ['2026-03-27', '2026-03-26', /after/],
    ['2026-02-30', '2026-03-26', /YYYY-MM-DD/],
    ['2025-01-01', '2026-03-26', new RegExp(`more than ${MAX_DATES}`)],
  ])('datesBetween(%s, %s) refuses', (from, to, message) => {
    expect(() => datesBetween(from, to)).toThrow(message);
  });

  it('parseDatesSpec reads a list, a range, or both, sorted and without repeats', () => {
    expect(parseDatesSpec('2026-03-26')).toEqual(['2026-03-26']);
    expect(parseDatesSpec('2026-03-27,2026-03-25,2026-03-27')).toEqual([
      '2026-03-25',
      '2026-03-27',
    ]);
    expect(parseDatesSpec('2026-03-24..2026-03-26')).toEqual([
      '2026-03-24',
      '2026-03-25',
      '2026-03-26',
    ]);
    expect(parseDatesSpec('2026-09-21,2026-03-25..2026-03-26')).toEqual([
      '2026-03-25',
      '2026-03-26',
      '2026-09-21',
    ]);
  });

  it.each([
    '',
    ',',
    '2026-03-26,',
    'x',
    '2026-03-26..',
    '..2026-03-26',
    '2026-03-26..2026-03-27..2026-03-28',
  ])('parseDatesSpec refuses %j', (spec) => {
    expect(() => parseDatesSpec(spec)).toThrow(RebuildRefusal);
  });
});

describe('chunkRows', () => {
  it('splits by row count and by bytes, keeping order and every row', () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({ v: String(i) }));
    const parts = chunkRows(rows);
    expect(parts.map((p) => p.length)).toEqual([500, 500, 100]);
    expect(parts.flat()).toEqual(rows);

    const big = Array.from({ length: 5 }, () => ({ v: 'x'.repeat(2_000_000) }));
    expect(chunkRows(big).map((p) => p.length)).toEqual([2, 2, 1]);
    expect(chunkRows([])).toEqual([]);
  });
});

describe('parseRebuildArgs', () => {
  const FILE = 'C:/x/rebuild/ws_gamma_setup_fires-a..b-s.jsonl';

  it('reads each mode, with dry run as the default', () => {
    expect(
      parseRebuildArgs([
        '--backup',
        'training_features',
        '--dates',
        '2026-03-23..2026-03-25',
      ]),
    ).toEqual({
      mode: 'backup',
      table: 'training_features',
      dates: ['2026-03-23', '2026-03-24', '2026-03-25'],
    });
    expect(
      parseRebuildArgs([
        '--delete-gamma-fires',
        '--from',
        '2026-02-26',
        '--to',
        '2026-04-17',
        '--backup-file',
        FILE,
      ]),
    ).toEqual({
      mode: 'delete-gamma-fires',
      from: '2026-02-26',
      to: '2026-04-17',
      backupFile: FILE,
      apply: false,
    });
    expect(
      parseRebuildArgs([
        '--null-gamma-returns',
        '--date',
        '2026-09-21',
        '--backup-file',
        FILE,
        '--apply',
      ]),
    ).toEqual({
      mode: 'null-gamma-returns',
      date: '2026-09-21',
      backupFile: FILE,
      apply: true,
    });
    expect(
      parseRebuildArgs(['--restore', 'day_embeddings', '--backup-file', FILE]),
    ).toEqual({
      mode: 'restore',
      table: 'day_embeddings',
      backupFile: FILE,
      apply: false,
    });
  });

  it.each([
    [[], /give exactly one of/],
    [['--apply'], /give exactly one of/],
    [
      ['--backup', 'training_features', '--restore', 'day_labels'],
      /give exactly one of/,
    ],
    [['--backup', 'users', '--dates', '2026-03-26'], /not one of the tables/],
    [['--backup', 'training_features'], /--backup needs --dates/],
    [
      ['--backup', 'training_features', '--dates', '2026-03-26', '--apply'],
      /--backup writes only its file/,
    ],
    [['--backup', 'training_features', '--dates', 'soon'], /YYYY-MM-DD/],
    [
      [
        '--backup',
        'training_features',
        '--dates',
        '2026-03-26',
        '--from',
        '2026-03-26',
      ],
      /--from does not go with --backup/,
    ],
    [
      ['--delete-gamma-fires', '--from', '2026-02-26', '--backup-file', FILE],
      /--delete-gamma-fires needs --to/,
    ],
    [
      ['--delete-gamma-fires', '--from', '2026-02-26', '--to', '2026-04-17'],
      /--delete-gamma-fires needs --backup-file/,
    ],
    [
      [
        '--delete-gamma-fires',
        '--from',
        '2026-04-17',
        '--to',
        '2026-02-26',
        '--backup-file',
        FILE,
      ],
      /after/,
    ],
    [
      [
        '--delete-gamma-fires',
        '--from',
        '2026-02-26',
        '--to',
        '2026-04-17',
        '--backup-file',
        FILE,
        '--dates',
        '2026-03-26',
      ],
      /--dates does not go with --delete-gamma-fires/,
    ],
    [
      ['--null-gamma-returns', '--date', '2026-02-30', '--backup-file', FILE],
      /--date needs a YYYY-MM-DD/,
    ],
    [
      ['--null-gamma-returns', '--backup-file', FILE],
      /--null-gamma-returns needs --date/,
    ],
    [['--restore', 'training_features'], /--restore needs --backup-file/],
    [['--restore', 'nope', '--backup-file', FILE], /not one of the tables/],
    [
      [
        '--restore',
        'training_features',
        '--backup-file',
        FILE,
        '--backup-file',
        FILE,
      ],
      /given twice/,
    ],
    [['--restore', '--backup-file', FILE], /--restore needs a table/],
    [
      ['--restore', 'training_features', '--backup-file'],
      /--backup-file needs a path/,
    ],
    [['--wipe'], /Unknown argument: --wipe/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseRebuildArgs(argv)).toThrow(message);
  });
});

// ── The command ────────────────────────────────────────────

describe('runRebuildBackup', () => {
  const plan = (backupFile, extra = {}) => ({
    mode: 'delete-gamma-fires',
    from: '2026-03-26',
    to: '2026-03-26',
    backupFile,
    apply: false,
    ...extra,
  });

  it('backs up, prints where, and exits 0', async () => {
    await addFire();
    const out = await runRebuildBackup(
      sql,
      { mode: 'backup', table: GAMMA, dates: ['2026-03-26'] },
      { backupDir: tmp },
    );
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toMatch(
      /Backed up 1 row of ws_gamma_setup_fires/,
    );
    expect(out.lines.join('\n')).toContain(path.join(tmp, 'rebuild'));
  });

  it('is a dry run unless --apply comes with it: nothing is written', async () => {
    await addFire();
    const backup = await backupFires();
    const before = await dumpFires();

    const out = await runRebuildBackup(sql, plan(backup.path), {
      backupDir: tmp,
    });

    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toMatch(/DRY RUN: nothing written/);
    expect(out.lines.join('\n')).toMatch(/would delete 1 fire/);
    expect(await dumpFires()).toEqual(before);
  });

  it('a plan with no apply at all is a dry run', async () => {
    await addFire();
    const backup = await backupFires();
    const before = await dumpFires();

    const out = await runRebuildBackup(
      sql,
      {
        mode: 'delete-gamma-fires',
        from: '2026-03-26',
        to: '2026-03-26',
        backupFile: backup.path,
      },
      { backupDir: tmp },
    );

    expect(out.lines.join('\n')).toMatch(/DRY RUN/);
    expect(await dumpFires()).toEqual(before);
  });

  it('writes with --apply', async () => {
    await addFire();
    const backup = await backupFires();

    const out = await runRebuildBackup(
      sql,
      plan(backup.path, { apply: true }),
      { backupDir: tmp },
    );

    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toMatch(/Deleted 1 fire/);
    expect(await dumpFires()).toEqual([]);
  });

  it('reports a refusal as REFUSED with exit 1, and a DB failure propagates', async () => {
    await addFire({ trade_taken: true });
    const backup = await backupFires();

    const refused = await runRebuildBackup(
      sql,
      plan(backup.path, { apply: true }),
      { backupDir: tmp },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join('\n')).toMatch(/^REFUSED: .*journal entry/m);

    const failing = neonLike(pg, {});
    failing.transaction = () => Promise.reject(new Error('connection lost'));
    await pg.query(`UPDATE ${GAMMA} SET trade_taken = false`);
    const fresh = await backupFires();
    await expect(
      runRebuildBackup(failing, plan(fresh.path, { apply: true }), {
        backupDir: tmp,
      }),
    ).rejects.toThrow('connection lost');
  });

  it('runs the null-returns and restore modes the same way', async () => {
    await addFire({ fired_at: '2026-09-21T14:00:00Z' });
    const backup = await backupFires(['2026-09-21']);

    const dry = await runRebuildBackup(
      sql,
      {
        mode: 'null-gamma-returns',
        date: '2026-09-21',
        backupFile: backup.path,
        apply: false,
      },
      { backupDir: tmp },
    );
    expect(dry.lines.join('\n')).toMatch(/would null the returns of 1 fire/);
    const applied = await runRebuildBackup(
      sql,
      {
        mode: 'null-gamma-returns',
        date: '2026-09-21',
        backupFile: backup.path,
        apply: true,
      },
      { backupDir: tmp },
    );
    expect(applied.lines.join('\n')).toMatch(/Nulled the returns of 1 fire/);

    const restoreDry = await runRebuildBackup(
      sql,
      { mode: 'restore', table: GAMMA, backupFile: backup.path, apply: false },
      { backupDir: tmp },
    );
    expect(restoreDry.lines.join('\n')).toMatch(
      /would delete 1 row .* re-insert 1 row/,
    );
    const restored = await runRebuildBackup(
      sql,
      { mode: 'restore', table: GAMMA, backupFile: backup.path, apply: true },
      { backupDir: tmp },
    );
    expect(restored.lines.join('\n')).toMatch(
      /Restored 1 row of ws_gamma_setup_fires/,
    );
    const { rows } = await pg.query(`SELECT ret_15m::text AS r FROM ${GAMMA}`);
    expect(rows[0].r).toBe('0.05');
  });

  it('refuses a backup mode with no backup directory', async () => {
    await expect(
      runRebuildBackup(
        sql,
        { mode: 'backup', table: GAMMA, dates: ['2026-03-26'] },
        {},
      ),
    ).rejects.toThrow(/backup directory/);
  });
});
