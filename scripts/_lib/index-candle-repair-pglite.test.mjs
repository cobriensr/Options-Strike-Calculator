// @vitest-environment node

/**
 * REAL-SQL test of the placeholder candle repair (index-candle-repair.mjs):
 * the delete predicate, the one-transaction replace, the backup and manifest
 * files, the undo, and the day check that runs before any write. The statements
 * run in pglite (real Postgres in WASM) on index_candles_1m built by the real
 * migrations #52, #54 and #112-#114, plus a stub of `outcomes` (the one column
 * the check reads, typed as in db.ts).
 *
 * Mocked at the module boundary: the UW fetch (fetchUwCandles). The Schwab
 * closes are plain Maps in the shape loadSchwabCloses returns, so ratioFor and
 * toIndexRows run for real. The backup and manifest files go to a temp
 * directory per test (a real filesystem: "a failed backup write" is a real
 * failed write).
 */

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

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';
import {
  DayFailure,
  formatRunSummary,
  marketHoursRefusal,
  summarizeRun,
} from './backfill-cli.mjs';
import { schwabCronsBusyRefusal } from './schwab-local.mjs';

const mocks = vi.hoisted(() => ({
  fetchUwCandles: vi.fn(),
  // The nth write of a *.manifest.json that fails (0: none fails), and how many
  // such writes the test has seen. The lib writes the manifest twice per run:
  // before the transaction, and again after the commit.
  failManifestWrite: 0,
  manifestWrites: 0,
}));

vi.mock('./candles-backfill.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchUwCandles: mocks.fetchUwCandles,
}));

// Real writes, except the one a test asks to fail: the only way to make the
// write after a real commit fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: (file, ...rest) => {
      if (String(file).endsWith('.manifest.json')) {
        mocks.manifestWrites += 1;
        if (mocks.manifestWrites === mocks.failManifestWrite) {
          return Promise.reject(
            Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
            }),
          );
        }
      }
      return actual.writeFile(file, ...rest);
    },
  };
});

import { toIndexRows } from './candles-backfill.mjs';
import {
  LIST_SYMBOLS,
  REPAIR_LISTS,
  checkMappedDay,
  checkRefitDay,
  defaultBackupDir,
  deleteSelection,
  describeUndo,
  findRefitManifest,
  mainCheckoutDir,
  parseRepairArgs,
  prepareDay,
  prepareRefitDay,
  processCheckDay,
  processRefitDay,
  processRepairDay,
  refitDay,
  repairDay,
  repairGuardRefusal,
  undoRepair,
} from './index-candle-repair.mjs';

let pg;
let tmp;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const id of [52, 54, 112, 113, 114]) await applyMigration(pg, id);
  // The real column types (api/_lib/db.ts initDb), the one column read.
  await pg.query(
    `CREATE TABLE outcomes (
       date       DATE NOT NULL UNIQUE,
       settlement DECIMAL(10,2)
     )`,
  );
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  mocks.fetchUwCandles.mockReset();
  mocks.failManifestWrite = 0;
  mocks.manifestWrites = 0;
  await pg.query(`SET TimeZone = 'UTC'`);
  await pg.query('TRUNCATE index_candles_1m RESTART IDENTITY');
  await pg.query('TRUNCATE outcomes');
  tmp = mkdtempSync(path.join(tmpdir(), 'index-candle-repair-'));
});

afterEach(async () => {
  await pg.query(
    'ALTER TABLE index_candles_1m DROP CONSTRAINT IF EXISTS reject_volume',
  );
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────

const SPX_DATE = '2026-03-26'; // EDT: the regular session is 13:30Z-19:59Z
const PLACEHOLDER_CREATED = '2026-04-09T05:13:00.654321Z';
const SPX_CUT = '2026-04-10T17:11:00.000Z';

/** The neon-shaped handle over pglite, with `transaction` spied. */
function makeSql() {
  const client = neonOverPglite(pg);
  vi.spyOn(client, 'transaction');
  return client;
}

function backupDirOf() {
  return path.join(tmp, 'backups');
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Insert one stored row; returns its id. Prices are text, so they are exact. */
async function seed({
  symbol = 'SPX',
  date = SPX_DATE,
  at,
  close = '6471.2',
  created = PLACEHOLDER_CREATED,
  marketTime = 'r',
  volume = 100,
}) {
  const { rows } = await pg.query(
    `INSERT INTO index_candles_1m
       (symbol, date, timestamp, open, high, low, close, volume, market_time,
        created_at)
     VALUES ($1, $2::date, $3::timestamptz, $4::numeric, $4::numeric,
             $4::numeric, $4::numeric, $5, $6, $7::timestamptz)
     RETURNING id`,
    [symbol, date, at, close, volume, marketTime, created],
  );
  return rows[0].id;
}

/** Every column of every row as text, in a fixed order: what "exact" means. */
async function snapshot() {
  const { rows } = await pg.query(
    `SELECT id::text AS id, symbol, date::text AS date,
            timestamp::text AS timestamp, open::text AS open,
            high::text AS high, low::text AS low, close::text AS close,
            volume::text AS volume, market_time,
            spx_schwab_price::text AS spx_schwab_price,
            ndx_schwab_price::text AS ndx_schwab_price,
            created_at::text AS created_at
     FROM index_candles_1m ORDER BY index_candles_1m.id`,
  );
  return rows;
}

/** A mapped row, as toIndexRows returns it. */
function newRow(
  symbol,
  date,
  timestamp,
  close,
  marketTime = 'r',
  volume = 100,
) {
  return {
    symbol,
    date,
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    market_time: marketTime,
    spx_schwab_price: null,
    ndx_schwab_price: null,
  };
}

/** The placeholder day: 4 stored SPX rows on 03-26, all in the batch. */
async function seedPlaceholderDay() {
  await seed({ at: '2026-03-26T12:00:00Z', marketTime: 'pr' });
  await seed({ at: '2026-03-26T13:30:00Z' });
  await seed({ at: '2026-03-26T13:31:00Z', close: '6472.3' });
  await seed({ at: '2026-03-26T20:05:00Z', marketTime: 'po' });
}

/** The 5 rows that replace it (one minute more than the placeholder had). */
function replacementRows() {
  return [
    newRow('SPX', SPX_DATE, '2026-03-26T12:00:00.000Z', 6500.111, 'pr'),
    newRow('SPX', SPX_DATE, '2026-03-26T13:30:00.000Z', 6500.222),
    newRow('SPX', SPX_DATE, '2026-03-26T13:31:00.000Z', 6500.333),
    newRow('SPX', SPX_DATE, '2026-03-26T13:32:00.000Z', 6500.444),
    newRow('SPX', SPX_DATE, '2026-03-26T20:05:00.000Z', 6500.555, 'po'),
  ];
}

function repairArgs(over = {}) {
  return {
    symbol: 'SPX',
    date: SPX_DATE,
    list: 'spx-repair',
    rows: replacementRows(),
    ratio: 10.040707123,
    backupDir: backupDirOf(),
    apply: true,
    ...over,
  };
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

// ── The lists ──────────────────────────────────────────────

/** Weekdays from..to, computed without the module under test. */
function weekdays(from, to) {
  const days = [];
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let ms = Date.parse(`${from}T12:00:00Z`); ms <= end; ms += 86_400_000) {
    const d = new Date(ms);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) {
      days.push(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

describe('the lists', () => {
  it('lists hold the exact trading days', () => {
    const goodFriday = '2026-04-03';
    const spx = weekdays('2026-02-25', '2026-04-10').filter(
      (d) => d !== goodFriday,
    );
    expect(spx).toHaveLength(32);
    expect(REPAIR_LISTS['spx-repair']).toEqual(spx);
    expect(REPAIR_LISTS['spx-repair'].at(0)).toBe('2026-02-25');
    expect(REPAIR_LISTS['spx-repair'].at(-1)).toBe('2026-04-10');
    expect(REPAIR_LISTS['spx-repair']).not.toContain(goodFriday);

    expect(REPAIR_LISTS['ndx-repair']).toEqual(
      weekdays('2026-03-23', '2026-05-01').filter((d) => d !== goodFriday),
    );
    expect(REPAIR_LISTS['ndx-repair']).toHaveLength(29);
    expect(REPAIR_LISTS['ndx-fill']).toEqual(
      weekdays('2026-02-25', '2026-03-20'),
    );
    expect(REPAIR_LISTS['ndx-fill']).toHaveLength(18);

    expect(REPAIR_LISTS.gap).toEqual([
      ...weekdays('2026-09-21', '2026-09-30'),
      ...weekdays('2026-10-08', '2026-10-15'),
    ]);
    expect(REPAIR_LISTS.gap).toHaveLength(14);
    expect(
      REPAIR_LISTS.gap.filter((d) => d >= '2026-10-01' && d <= '2026-10-07'),
    ).toEqual([]);
  });

  it('keeps the lists disjoint per symbol and frozen', () => {
    const overlap = (a, b) => a.filter((d) => b.includes(d));
    expect(
      overlap(REPAIR_LISTS['ndx-repair'], REPAIR_LISTS['ndx-fill']),
    ).toEqual([]);
    expect(overlap(REPAIR_LISTS['ndx-repair'], REPAIR_LISTS.gap)).toEqual([]);
    expect(overlap(REPAIR_LISTS['spx-repair'], REPAIR_LISTS.gap)).toEqual([]);
    expect(Object.isFrozen(REPAIR_LISTS)).toBe(true);
    expect(Object.isFrozen(REPAIR_LISTS.gap)).toBe(true);
    expect(LIST_SYMBOLS).toEqual({
      'spx-repair': ['SPX'],
      'ndx-repair': ['NDX'],
      'ndx-fill': ['NDX'],
      gap: ['SPX', 'NDX'],
      summer: ['SPX', 'NDX'],
    });
  });

  it('the summer list is the 33 trading days 07-22 to 09-04, disjoint from the others', () => {
    expect(REPAIR_LISTS.summer).toEqual(weekdays('2026-07-22', '2026-09-04'));
    expect(REPAIR_LISTS.summer).toHaveLength(33);
    expect(REPAIR_LISTS.summer.at(0)).toBe('2026-07-22');
    expect(REPAIR_LISTS.summer.at(-1)).toBe('2026-09-04');
    expect(Object.isFrozen(REPAIR_LISTS.summer)).toBe(true);
    for (const other of ['spx-repair', 'ndx-repair', 'ndx-fill', 'gap']) {
      expect(
        REPAIR_LISTS.summer.filter((d) => REPAIR_LISTS[other].includes(d)),
      ).toEqual([]);
    }
  });
});

// ── The delete predicate ───────────────────────────────────

describe('deleteSelection', () => {
  it('gives the SPX cuts, and the 04-10 timestamp cut only on 04-10', () => {
    expect(deleteSelection('SPX', '2026-03-26')).toEqual({
      kind: 'repair',
      createdFrom: null,
      createdThrough: null,
      createdBefore: '2026-04-11T00:00:00Z',
      timestampBefore: null,
    });
    expect(deleteSelection('SPX', '2026-04-10')).toMatchObject({
      kind: 'repair',
      createdBefore: '2026-04-11T00:00:00Z',
      timestampBefore: '2026-04-10T17:11:00Z',
    });
  });

  it('gives the NDX batch window', () => {
    expect(deleteSelection('NDX', '2026-04-20')).toEqual({
      kind: 'repair',
      createdFrom: '2026-05-03T23:00:00Z',
      createdThrough: '2026-05-03T23:59:59Z',
      createdBefore: null,
      timestampBefore: null,
    });
  });

  it('selects nothing for fill lists', () => {
    for (const date of REPAIR_LISTS['ndx-fill']) {
      expect(deleteSelection('NDX', date)).toEqual({ kind: 'fill' });
    }
    for (const date of REPAIR_LISTS.gap) {
      expect(deleteSelection('SPX', date)).toEqual({ kind: 'fill' });
      expect(deleteSelection('NDX', date)).toEqual({ kind: 'fill' });
    }
    // An NDX repair date is a fill date for SPX only if no SPX list has it.
    expect(deleteSelection('SPX', '2026-05-01')).toEqual({ kind: 'fill' });
  });

  it('refuses a symbol it does not repair', () => {
    expect(() => deleteSelection('ES', '2026-03-26')).toThrow(/ES/);
  });
});

describe('what a repair selects (real SQL)', () => {
  it('selects 04-10 placeholders before 17:11Z only', async () => {
    const date = '2026-04-10';
    const realCreated = '2026-04-10T17:12:00.000001Z';
    const placeholder = [
      await seed({ date, at: '2026-04-10T17:09:00Z' }),
      await seed({ date, at: '2026-04-10T17:10:00Z' }),
    ];
    const real = [
      await seed({ date, at: SPX_CUT, created: realCreated }),
      await seed({ date, at: '2026-04-10T17:12:00Z', created: realCreated }),
    ];
    const before = await snapshot();
    const rows = ['17:09', '17:10', '17:11', '17:12'].map((hhmm, i) =>
      newRow('SPX', date, `2026-04-10T${hhmm}:00.000Z`, 6600 + i),
    );

    const dry = await repairDay(
      makeSql(),
      repairArgs({ date, rows, apply: false }),
    );
    expect(dry).toMatchObject({ deleted: 2, inserted: 2 });

    const res = await repairDay(makeSql(), repairArgs({ date, rows }));
    expect(res).toMatchObject({ deleted: 2, inserted: 2 });

    const after = await snapshot();
    const kept = after.filter((r) => real.map(String).includes(r.id));
    expect(kept).toEqual(before.filter((r) => real.map(String).includes(r.id)));
    expect(after.filter((r) => placeholder.map(String).includes(r.id))).toEqual(
      [],
    );
    expect(after).toHaveLength(4);
  });

  it('never selects a row written after the cut', async () => {
    await seed({
      at: '2026-03-26T13:30:00Z',
      created: '2026-11-25T14:00:00Z',
    });
    await seed({
      symbol: 'NDX',
      date: '2026-04-20',
      at: '2026-04-20T13:30:00Z',
      created: '2026-05-04T00:00:00Z',
    });
    const before = await snapshot();

    const spx = await repairDay(
      makeSql(),
      repairArgs({
        rows: [newRow('SPX', SPX_DATE, '2026-03-26T13:30:00.000Z', 6500)],
      }),
    );
    const ndx = await repairDay(
      makeSql(),
      repairArgs({
        symbol: 'NDX',
        date: '2026-04-20',
        list: 'ndx-repair',
        rows: [newRow('NDX', '2026-04-20', '2026-04-20T13:30:00.000Z', 23000)],
      }),
    );

    expect(spx).toMatchObject({ deleted: 0, inserted: 0 });
    expect(ndx).toMatchObject({ deleted: 0, inserted: 0 });
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);
  });

  it('selects only the NDX rows in the batch window, and only for NDX', async () => {
    const date = '2026-04-20';
    const batch = '2026-05-03T23:30:00Z';
    const ndxIn = await seed({
      symbol: 'NDX',
      date,
      at: '2026-04-20T13:30:00Z',
      created: batch,
    });
    const ndxEarly = await seed({
      symbol: 'NDX',
      date,
      at: '2026-04-20T13:31:00Z',
      created: '2026-05-03T22:59:59Z',
    });
    const ndxEdge = await seed({
      symbol: 'NDX',
      date,
      at: '2026-04-20T13:32:00Z',
      created: '2026-05-03T23:59:59Z',
    });
    const spxSame = await seed({
      symbol: 'SPX',
      date,
      at: '2026-04-20T13:30:00Z',
      created: batch,
    });
    // A bar for each stored minute that is deleted (13:30 and 13:32), so no
    // regular minute is left empty.
    const rows = [
      newRow('NDX', date, '2026-04-20T13:30:00.000Z', 23000),
      newRow('NDX', date, '2026-04-20T13:32:00.000Z', 23001),
    ];

    const res = await repairDay(
      makeSql(),
      repairArgs({ symbol: 'NDX', date, list: 'ndx-repair', rows }),
    );

    expect(res).toMatchObject({ deleted: 2, inserted: 2 });
    const left = (await snapshot()).map((r) => r.id);
    expect(left).toContain(String(ndxEarly));
    expect(left).toContain(String(spxSame));
    expect(left).not.toContain(String(ndxIn));
    expect(left).not.toContain(String(ndxEdge));
  });

  it('leaves the other symbol and the other dates of the same time alone', async () => {
    await seedPlaceholderDay();
    const otherSymbol = await seed({
      symbol: 'NDX',
      at: '2026-03-26T13:30:00Z',
      created: PLACEHOLDER_CREATED,
    });
    const otherDate = await seed({
      date: '2026-03-25',
      at: '2026-03-25T13:30:00Z',
    });

    await repairDay(makeSql(), repairArgs());

    const ids = (await snapshot()).map((r) => r.id);
    expect(ids).toContain(String(otherSymbol));
    expect(ids).toContain(String(otherDate));
  });
});

// ── The day check ──────────────────────────────────────────

function bars(date, { regular, closeOf = () => 6500 }) {
  const open = Date.parse(`${date}T13:30:00.000Z`);
  return Array.from({ length: regular }, (_, i) => ({
    timestamp: new Date(open + i * 60_000).toISOString(),
    close: closeOf(i),
    market_time: 'r',
  }));
}

describe('checkMappedDay', () => {
  const spx = (rows, settlement) =>
    checkMappedDay({ symbol: 'SPX', date: SPX_DATE, rows, settlement });
  const ndx = (rows, ndxClose) =>
    checkMappedDay({ symbol: 'NDX', date: SPX_DATE, rows, ndxClose });
  const lastClose = (value) => (i) => (i === 389 ? value : 6400);

  it('passes a full day whose close matches', () => {
    const rows = bars(SPX_DATE, { regular: 390, closeOf: lastClose(6500) });
    expect(spx(rows, 6500)).toEqual({ ok: true });
    expect(
      spx(bars(SPX_DATE, { regular: 390, closeOf: lastClose(6503.99) }), 6500),
    ).toEqual({ ok: true });
  });

  it('fails an SPX close more than 4 pt from the settlement', () => {
    const rows = bars(SPX_DATE, { regular: 390, closeOf: lastClose(6504.01) });
    const out = spx(rows, 6500);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/4\.01 pt/);
    expect(out.reason).toMatch(/settlement/);
  });

  it('fails a short or empty day', () => {
    expect(spx(bars(SPX_DATE, { regular: 389 }), 6500)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/389 regular bars, expected 390/),
    });
    expect(spx([], 6500)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/0 regular bars, expected 390/),
    });
  });

  it('fails when there is no settlement to check against', () => {
    const rows = bars(SPX_DATE, { regular: 390 });
    for (const settlement of [null, undefined, Number.NaN]) {
      expect(spx(rows, settlement)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no outcomes\.settlement/),
      });
    }
  });

  it('counts regular bars only, and reads the last one by time', () => {
    const regular = bars(SPX_DATE, { regular: 390, closeOf: lastClose(6500) });
    const extras = ['pr', 'pr', 'po'].map((marketTime, i) => ({
      timestamp: `2026-03-26T0${i}:00:00.000Z`,
      close: 1,
      market_time: marketTime,
    }));
    expect(spx([...extras, ...regular], 6500)).toEqual({ ok: true });
    expect(spx([...regular].reverse(), 6500)).toEqual({ ok: true });
    expect(
      spx([...extras, ...bars(SPX_DATE, { regular: 385 })], 6500),
    ).toMatchObject({ ok: false });
  });

  it('uses the half-day length, not 390', () => {
    const date = '2026-11-27';
    const rows = bars(date, { regular: 210 });
    expect(
      checkMappedDay({ symbol: 'SPX', date, rows, settlement: 6500 }),
    ).toEqual({ ok: true });
    expect(
      checkMappedDay({
        symbol: 'SPX',
        date,
        rows: bars(date, { regular: 390 }),
        settlement: 6500,
      }),
    ).toMatchObject({ ok: false });
  });

  it('fails a day that is not a trading day, even with no bars', () => {
    expect(
      checkMappedDay({
        symbol: 'SPX',
        date: '2026-04-03',
        rows: [],
        settlement: 6500,
      }),
    ).toMatchObject({ ok: false });
  });

  it('checks NDX against the Schwab close within 15 pt', () => {
    const rows = (close) =>
      bars(SPX_DATE, { regular: 390, closeOf: (i) => (i === 389 ? close : 1) });
    expect(ndx(rows(23014.99), 23000)).toEqual({ ok: true });
    expect(ndx(rows(22985.01), 23000)).toEqual({ ok: true });
    const bad = ndx(rows(23015.01), 23000);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/15\.01 pt/);
    expect(ndx(rows(23000), null)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/\$NDX/),
    });
  });

  describe('a fitted day (spec decision 9)', () => {
    const fittedSpx = (rows, over = {}) =>
      checkMappedDay({
        symbol: 'SPX',
        date: SPX_DATE,
        rows,
        fitted: true,
        ...over,
      });

    it('keeps the count check', () => {
      expect(fittedSpx(bars(SPX_DATE, { regular: 390 }))).toEqual({
        ok: true,
      });
      expect(fittedSpx(bars(SPX_DATE, { regular: 389 }))).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/389 regular bars, expected 390/),
      });
      expect(fittedSpx([])).toMatchObject({ ok: false });
      expect(
        checkMappedDay({
          symbol: 'NDX',
          date: SPX_DATE,
          rows: bars(SPX_DATE, { regular: 391 }),
          fitted: true,
        }),
      ).toMatchObject({ ok: false });
    });

    it('applies neither close check, and needs no reference', () => {
      const rows = bars(SPX_DATE, {
        regular: 390,
        closeOf: (i) => (i === 389 ? 6504.01 : 6400),
      });
      // 4.01 pt from the settlement: the plain check refuses it.
      expect(spx(rows, 6500)).toMatchObject({ ok: false });
      expect(fittedSpx(rows, { settlement: 6500 })).toEqual({ ok: true });
      // No settlement at all, and no NDX close.
      expect(fittedSpx(rows)).toEqual({ ok: true });
      const far = bars(SPX_DATE, {
        regular: 390,
        closeOf: (i) => (i === 389 ? 23020 : 1),
      });
      expect(ndx(far, 23000)).toMatchObject({ ok: false });
      expect(
        checkMappedDay({
          symbol: 'NDX',
          date: SPX_DATE,
          rows: far,
          ndxClose: 23000,
          fitted: true,
        }),
      ).toEqual({ ok: true });
    });

    it('still refuses a symbol it has no check for', () => {
      expect(() =>
        checkMappedDay({
          symbol: 'ES',
          date: SPX_DATE,
          rows: [],
          fitted: true,
        }),
      ).toThrow(/no day check for ES/);
    });
  });
});

// ── prepareDay ─────────────────────────────────────────────

/** UW's answer for one ETF-day: `regular` 'r' bars plus 3 pre and 3 post. */
function uwBars(
  date,
  { regular = 390, lastClose = 647, openUtc = '13:30' } = {},
) {
  const open = Date.parse(`${date}T${openUtc}:00.000Z`);
  const bar = (offset, marketTime, close) => ({
    start_time: new Date(open + offset * 60_000).toISOString(),
    open: String(close),
    high: String(close + 0.1),
    low: String(close - 0.1),
    close: String(close),
    volume: 1000 + offset,
    market_time: marketTime,
  });
  return [
    ...[-3, -2, -1].map((o) => bar(o, 'pr', 640)),
    ...Array.from({ length: regular }, (_, i) =>
      bar(i, 'r', lastClose - (regular - 1 - i) * 0.01),
    ),
    ...[0, 1, 2].map((o) => bar(regular + o, 'po', 646)),
  ];
}

function schwabCloses(
  date,
  { spx = 6500, spy = 647, ndx = 23000, qqq = 560 } = {},
) {
  const entry = (value) => ({ closes: new Map([[date, value]]) });
  return new Map([
    ['$SPX', entry(spx)],
    ['SPY', entry(spy)],
    ['$NDX', entry(ndx)],
    ['QQQ', entry(qqq)],
  ]);
}

async function seedSettlement(date, settlement) {
  await pg.query('INSERT INTO outcomes (date, settlement) VALUES ($1, $2)', [
    date,
    settlement,
  ]);
}

function prepareArgs(over = {}) {
  return {
    symbol: 'SPX',
    date: SPX_DATE,
    closes: schwabCloses(SPX_DATE),
    uwKey: 'uw-key',
    waitForSlot: vi.fn(),
    ...over,
  };
}

describe('prepareDay', () => {
  it('maps the ETF bars by the day ratio and checks the settlement', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE),
    });
    const args = prepareArgs();

    const out = await prepareDay(makeSql(), args);

    expect(out.ok).toBe(true);
    expect(out.ratio).toBeCloseTo(6500 / 647, 12);
    expect(out.rows).toHaveLength(396);
    expect(out.rows.filter((r) => r.market_time === 'r')).toHaveLength(390);
    const lastRegular = out.rows.filter((r) => r.market_time === 'r').at(-1);
    expect(lastRegular.close).toBeCloseTo(6500, 6);
    expect(lastRegular.symbol).toBe('SPX');
    expect(lastRegular.date).toBe(SPX_DATE);
    expect(mocks.fetchUwCandles).toHaveBeenCalledWith(
      'uw-key',
      'SPY',
      SPX_DATE,
      args.waitForSlot,
    );
  });

  it('maps NDX from QQQ and checks the Schwab $NDX close, not outcomes', async () => {
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE, { lastClose: 560 }),
    });

    const out = await prepareDay(makeSql(), prepareArgs({ symbol: 'NDX' }));

    expect(out.ok).toBe(true);
    expect(out.ratio).toBeCloseTo(23000 / 560, 12);
    expect(mocks.fetchUwCandles).toHaveBeenCalledWith(
      'uw-key',
      'QQQ',
      SPX_DATE,
      expect.any(Function),
    );
  });

  it('skips a UW error, an empty answer and a missing ratio, writing nothing', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    await seedPlaceholderDay();
    const before = await snapshot();

    mocks.fetchUwCandles.mockResolvedValueOnce({
      kind: 'error',
      status: 'http_503',
      detail: 'upstream down',
    });
    const uwError = await prepareDay(makeSql(), prepareArgs());
    expect(uwError).toMatchObject({ ok: false, kind: 'uw_http_503' });
    expect(uwError.reason).toMatch(/http_503/);
    expect(uwError.reason).toMatch(/upstream down/);

    mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'empty' });
    const empty = await prepareDay(makeSql(), prepareArgs());
    expect(empty).toMatchObject({ ok: false });
    expect(empty.reason).toMatch(/no SPY bars/);

    mocks.fetchUwCandles.mockClear();
    const noRatio = await prepareDay(
      makeSql(),
      prepareArgs({ closes: new Map([['$SPX', { closes: new Map() }]]) }),
    );
    expect(noRatio).toMatchObject({ ok: false });
    expect(noRatio.reason).toMatch(/no ratio for SPX on 2026-03-26/);
    expect(mocks.fetchUwCandles).not.toHaveBeenCalled();

    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);
  });

  it('skips a short or empty day before any write', async () => {
    await seedPlaceholderDay();
    await seedSettlement(SPX_DATE, '6500.00');
    const before = await snapshot();
    const run = (rows, over = {}) => {
      mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'ok', rows });
      return prepareDay(makeSql(), prepareArgs(over));
    };

    const short = await run(uwBars(SPX_DATE, { regular: 389 }));
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/389 regular bars, expected 390/);

    const empty = await run([]);
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/0 regular bars, expected 390/);

    await pg.query('UPDATE outcomes SET settlement = 6504.01');
    const off = await run(uwBars(SPX_DATE));
    expect(off.ok).toBe(false);
    expect(off.reason).toMatch(/4\.01 pt/);

    await pg.query('DELETE FROM outcomes');
    const noOutcome = await run(uwBars(SPX_DATE));
    expect(noOutcome.ok).toBe(false);
    expect(noOutcome.reason).toMatch(/no outcomes\.settlement/);

    // QQQ's last bar scales to 23015.01, 15.01 pt over the Schwab $NDX close.
    const ndx = await run(uwBars(SPX_DATE, { lastClose: 560.3655 }), {
      symbol: 'NDX',
    });
    expect(ndx.ok).toBe(false);
    expect(ndx.reason).toMatch(/15\.01 pt/);

    expect(await snapshot()).toEqual(before);
    expect(existsSync(backupDirOf())).toBe(false);
  });

  it('skips a Schwab failure by name', async () => {
    const closes = new Map([
      [
        '$SPX',
        { failure: { kind: 'network', detail: 'fetch failed (ECONNRESET)' } },
      ],
    ]);
    const out = await prepareDay(makeSql(), prepareArgs({ closes }));
    expect(out).toMatchObject({ ok: false, kind: 'network' });
    expect(out.reason).toMatch(/Schwab \$SPX daily history failed/);
  });

  it("skips an answer that reached UW's row cap", async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: Array.from({ length: 2500 }, () => ({})),
    });
    const out = await prepareDay(makeSql(), prepareArgs());
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toMatch(/2500/);
    expect(out.reason).toMatch(/cut short/);
  });

  it.each(['malformed', 'network', 'timeout'])(
    'passes a UW %s failure through as its kind, with the reason',
    async (status) => {
      mocks.fetchUwCandles.mockResolvedValueOnce({
        kind: 'error',
        status,
        detail: `boom ${status}`,
      });

      const out = await prepareDay(makeSql(), prepareArgs());

      expect(out).toMatchObject({ ok: false, kind: status });
      expect(out.reason).toBe(
        `UW SPY bars for ${SPX_DATE}: ${status} boom ${status}`,
      );
    },
  );

  it('names the bars it left out as malformed when the day then fails the count', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    const answer = uwBars(SPX_DATE);
    // Index 0-2 are pre-market; 100 and 101 are regular minutes.
    answer[100] = { ...answer[100], close: 'n/a' };
    mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'ok', rows: answer });
    const one = await prepareDay(makeSql(), prepareArgs());
    expect(one.ok).toBe(false);
    expect(one.reason).toBe(
      '389 regular bars, expected 390 for 2026-03-26 ' +
        '(1 bar dropped as malformed)',
    );

    answer[101] = { ...answer[101], close: 'n/a' };
    mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'ok', rows: answer });
    const two = await prepareDay(makeSql(), prepareArgs());
    expect(two.reason).toBe(
      '388 regular bars, expected 390 for 2026-03-26 ' +
        '(2 bars dropped as malformed)',
    );
  });

  it('counts a malformed extended-hours bar as dropped and still passes the day', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    const answer = uwBars(SPX_DATE);
    answer[0] = { ...answer[0], close: 'n/a' };
    mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'ok', rows: answer });

    const out = await prepareDay(makeSql(), prepareArgs());

    expect(out).toMatchObject({ ok: true, dropped: 1 });
    expect(out.rows).toHaveLength(395);
  });

  it('propagates a database failure instead of reporting a skipped day', async () => {
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE),
    });
    const sql = Object.assign(
      () => ({ then: (_ok, fail) => fail(new Error('connection lost')) }),
      { transaction: vi.fn() },
    );
    await expect(prepareDay(sql, prepareArgs())).rejects.toThrow(
      'connection lost',
    );
  });
});

// ── repairDay ──────────────────────────────────────────────

describe('repairDay', () => {
  it('replaces a placeholder day in one transaction', async () => {
    await seedPlaceholderDay();
    const outsideNdx = await seed({
      symbol: 'NDX',
      at: '2026-03-26T13:30:00Z',
      created: '2026-05-03T23:30:00Z',
    });
    const before = await snapshot();
    const placeholders = before.filter(
      (r) => r.symbol === 'SPX' && r.date === SPX_DATE,
    );
    expect(placeholders).toHaveLength(4);
    const sql = makeSql();

    const res = await repairDay(sql, repairArgs());

    expect(res).toMatchObject({
      date: SPX_DATE,
      symbol: 'SPX',
      ratio: 10.040707,
      deleted: 4,
      inserted: 5,
    });
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toMatch(/^\s*DELETE FROM index_candles_1m/);
    expect(statements[1].text).toMatch(/INSERT INTO index_candles_1m/);

    const after = await snapshot();
    const spxDay = after.filter(
      (r) => r.symbol === 'SPX' && r.date === SPX_DATE,
    );
    expect(spxDay).toHaveLength(5);
    expect(spxDay.map((r) => r.close)).toEqual([
      '6500.111',
      '6500.222',
      '6500.333',
      '6500.444',
      '6500.555',
    ]);
    expect(after.find((r) => r.id === String(outsideNdx))).toEqual(
      before.find((r) => r.id === String(outsideNdx)),
    );

    // The backup holds the four rows exactly, every column as text.
    const [name] = filesIn(backupDirOf()).filter((f) => f.endsWith('.jsonl'));
    expect(name).toMatch(/^SPX-2026-03-26-\d{8}T\d{9}Z\.jsonl$/);
    const backup = readFileSync(path.join(backupDirOf(), name), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(backup).toHaveLength(4);
    expect(backup).toEqual(placeholders);
    expect(backup[1]).toMatchObject({
      id: placeholders[1].id,
      created_at: '2026-04-09 05:13:00.654321+00',
      close: '6471.2',
      spx_schwab_price: null,
    });

    const manifest = readManifest(res.manifest);
    expect(manifest).toMatchObject({
      symbol: 'SPX',
      date: SPX_DATE,
      committed: true,
      backup: path.join(backupDirOf(), name),
    });
    expect(manifest.backedUpIds).toEqual(placeholders.map((r) => Number(r.id)));
    expect(manifest.insertedIds).toEqual(spxDay.map((r) => Number(r.id)));
    expect(manifest.marker).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('reports the counts and the ratio to 6 decimals on a dry run, and writes nothing', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    const sql = makeSql();

    const res = await repairDay(sql, repairArgs({ apply: false }));

    expect(res).toEqual({
      date: SPX_DATE,
      symbol: 'SPX',
      ratio: 10.040707,
      deleted: 4,
      inserted: 5,
      uncovered: 0,
    });
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);
  });

  it('does not need a backup directory on a dry run', async () => {
    const res = await repairDay(
      makeSql(),
      repairArgs({ apply: false, backupDir: undefined }),
    );
    expect(res).toMatchObject({ deleted: 0, inserted: 5 });
  });

  it('a failed backup write deletes nothing', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    const blocker = path.join(tmp, 'not-a-directory');
    writeFileSync(blocker, 'a file where the backup folder should be');
    const sql = makeSql();

    // mkdir on a path that is a file: EEXIST (Windows, Linux) or ENOTDIR.
    await expect(
      repairDay(sql, repairArgs({ backupDir: blocker })),
    ).rejects.toThrow(/EEXIST|ENOTDIR|not a directory/i);

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(blocker, 'utf8')).toMatch(/a file where/);
  });

  it('a DB error mid-transaction rolls back', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    await pg.query(
      'ALTER TABLE index_candles_1m ADD CONSTRAINT reject_volume CHECK (volume <> 777)',
    );
    const rows = replacementRows();
    rows[2] = { ...rows[2], volume: 777 };

    await expect(repairDay(makeSql(), repairArgs({ rows }))).rejects.toThrow(
      /reject_volume/,
    );

    expect(await snapshot()).toEqual(before);
    // The run left its files: the manifest says nothing committed.
    const manifestName = filesIn(backupDirOf()).find((f) =>
      f.endsWith('.manifest.json'),
    );
    const manifest = readManifest(path.join(backupDirOf(), manifestName));
    expect(manifest).toMatchObject({ committed: false, insertedIds: null });
    // And an undo of it changes nothing.
    await pg.query(
      'ALTER TABLE index_candles_1m DROP CONSTRAINT reject_volume',
    );
    await expect(
      undoRepair(makeSql(), path.join(backupDirOf(), manifestName)),
    ).resolves.toEqual({ restored: 0, removed: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('says so by name when the manifest cannot be rewritten after the commit, and the leftover manifest still undoes the run', async () => {
    await seedPlaceholderDay();
    const original = await snapshot();
    // Write 1 is the manifest before the transaction; write 2 is the rewrite
    // after the commit.
    mocks.failManifestWrite = 2;

    const error = await repairDay(makeSql(), repairArgs()).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(
      /^SPX 2026-03-26: committed \(4 deleted, 5 inserted\) but the manifest .+\.manifest\.json could not be rewritten \(ENOSPC: no space left on device, write\); it still says committed: false, and --undo falls back to the run marker$/,
    );
    expect(error.cause).toMatchObject({ code: 'ENOSPC' });
    // The transaction did commit: the five new rows are in.
    const after = await snapshot();
    expect(after).not.toEqual(original);
    expect(
      after.filter((r) => r.symbol === 'SPX' && r.date === SPX_DATE),
    ).toHaveLength(5);
    // The manifest on disk is the one from before the transaction.
    const manifestFile = path.join(
      backupDirOf(),
      filesIn(backupDirOf()).find((f) => f.endsWith('.manifest.json')),
    );
    expect(readManifest(manifestFile)).toMatchObject({
      committed: false,
      insertedIds: null,
    });

    mocks.failManifestWrite = 0;
    await expect(undoRepair(makeSql(), manifestFile)).resolves.toEqual({
      restored: 4,
      removed: 5,
    });
    expect(await snapshot()).toEqual(original);
  });

  it('a second apply changes nothing', async () => {
    await seedPlaceholderDay();
    await repairDay(makeSql(), repairArgs());
    const afterFirst = await snapshot();
    const filesAfterFirst = filesIn(backupDirOf());

    const second = await repairDay(makeSql(), repairArgs());

    expect(second).toMatchObject({ deleted: 0, inserted: 0 });
    expect(second.manifest).toBeUndefined();
    expect(await snapshot()).toEqual(afterFirst);
    expect(filesIn(backupDirOf())).toEqual(filesAfterFirst);
  });

  it.each([
    ['one regular minute', ['13:31'], /would leave 1 regular minute empty/, 0],
    [
      'two regular minutes',
      ['13:30', '13:31'],
      /would leave 2 regular minutes empty/,
      0,
    ],
    [
      'a regular and a pre-market minute',
      ['13:31', '12:00'],
      /would leave 1 regular minute empty/,
      1,
    ],
  ])(
    'refuses, before any write, mapped rows that would leave %s empty',
    async (_label, missing, reason, uncovered) => {
      await seedPlaceholderDay(); // pr 12:00, r 13:30 and 13:31, po 20:05
      const before = await snapshot();
      const dropped = missing.map((hhmm) => `2026-03-26T${hhmm}:00.000Z`);
      const rows = replacementRows().filter(
        (r) => !dropped.includes(r.timestamp),
      );

      for (const apply of [false, true]) {
        const sql = makeSql();
        const res = await repairDay(sql, repairArgs({ rows, apply }));

        expect(res.skipped).toMatch(reason);
        expect(res.skipped).toContain(`first ${dropped[0]}`);
        expect(res).toMatchObject({ deleted: 0, inserted: 0, uncovered });
        expect(res.manifest).toBeUndefined();
        expect(sql.transaction).not.toHaveBeenCalled();
      }
      expect(await snapshot()).toEqual(before);
      expect(filesIn(backupDirOf())).toEqual([]);
    },
  );

  it('counts the stored pre- and post-market minutes with no mapped row as uncovered, and still repairs', async () => {
    await seedPlaceholderDay(); // pr 12:00 and po 20:05 are stored
    // UW sent no 12:00 pre-market bar.
    const rows = replacementRows().filter(
      (r) => r.timestamp !== '2026-03-26T12:00:00.000Z',
    );

    const dry = await repairDay(makeSql(), repairArgs({ rows, apply: false }));
    expect(dry).toMatchObject({ deleted: 4, inserted: 4, uncovered: 1 });
    expect(dry.skipped).toBeUndefined();

    const res = await repairDay(makeSql(), repairArgs({ rows }));
    expect(res).toMatchObject({ deleted: 4, inserted: 4, uncovered: 1 });
    expect(res.skipped).toBeUndefined();
    const day = (await snapshot()).filter(
      (r) => r.symbol === 'SPX' && r.date === SPX_DATE,
    );
    expect(day.map((r) => r.timestamp)).toEqual([
      '2026-03-26 13:30:00+00',
      '2026-03-26 13:31:00+00',
      '2026-03-26 13:32:00+00',
      '2026-03-26 20:05:00+00',
    ]);
  });

  it('fills only the missing minutes of an insert-only list, deleting nothing', async () => {
    const date = '2026-09-21';
    const live = '2026-09-21T16:18:00Z';
    await seed({ date, at: '2026-09-21T13:30:00Z', created: live });
    await seed({ date, at: '2026-09-21T13:31:00Z', created: live });
    const before = await snapshot();
    const rows = [0, 1, 2, 3].map((i) =>
      newRow('SPX', date, addMinutes('2026-09-21T13:30:00.000Z', i), 6600 + i),
    );

    const res = await repairDay(
      makeSql(),
      repairArgs({ date, list: 'gap', rows }),
    );

    expect(res).toMatchObject({ deleted: 0, inserted: 2 });
    const after = await snapshot();
    expect(after.slice(0, 2)).toEqual(before);
    expect(after).toHaveLength(4);
    // An empty backup file and a manifest, so an undo removes the two.
    const manifest = readManifest(res.manifest);
    expect(manifest.backedUpIds).toEqual([]);
    expect(manifest.insertedIds).toHaveLength(2);

    await expect(undoRepair(makeSql(), res.manifest)).resolves.toEqual({
      restored: 0,
      removed: 2,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('touches nothing when the request does not belong to its list', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    const cases = [
      [{ list: 'ndx-repair' }, /not in the ndx-repair list/],
      [{ list: 'no-such-list' }, /unknown list/],
      [{ date: '2026-04-20' }, /not in the spx-repair list/],
      [{ rows: [] }, /no mapped rows/],
      [
        {
          rows: [newRow('NDX', SPX_DATE, '2026-03-26T13:30:00.000Z', 6500)],
        },
        /not SPX 2026-03-26/,
      ],
      [{ ratio: Number.NaN }, /bad ratio/],
      [{ backupDir: undefined }, /no backup directory/],
    ];
    for (const [over, reason] of cases) {
      const sql = makeSql();
      const res = await repairDay(sql, repairArgs(over));
      expect(res.skipped).toMatch(reason);
      expect(res).toMatchObject({ deleted: 0, inserted: 0 });
      expect(sql.transaction).not.toHaveBeenCalled();
    }
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);
  });

  it('a 1,000-row day inserts in batches of at most 500', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      newRow(
        'SPX',
        SPX_DATE,
        addMinutes('2026-03-26T00:00:00.000Z', i),
        6500 + i / 100,
      ),
    );
    const sql = makeSql();

    const res = await repairDay(sql, repairArgs({ rows }));

    expect(res).toMatchObject({ deleted: 0, inserted: 1000 });
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.text).toMatch(/INSERT INTO index_candles_1m/);
      const sizes = statement.params.map((p) => p.length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
      expect(Math.min(...sizes)).toBe(500);
    }
    expect((await snapshot()).length).toBe(1000);
  });
});

// ── undoRepair ─────────────────────────────────────────────

describe('undoRepair', () => {
  it('restores the exact rows, and a fresh repair selects them again', async () => {
    await seedPlaceholderDay();
    const original = await snapshot();
    const repaired = await repairDay(makeSql(), repairArgs());
    expect(await snapshot()).not.toEqual(original);

    const undone = await undoRepair(makeSql(), repaired.manifest);

    expect(undone).toEqual({ restored: 4, removed: 5 });
    expect(await snapshot()).toEqual(original);
    const again = await repairDay(makeSql(), repairArgs({ apply: false }));
    expect(again).toMatchObject({ deleted: 4, inserted: 5 });
  });

  it('works without the inserted ids', async () => {
    await seedPlaceholderDay();
    const original = await snapshot();
    const repaired = await repairDay(makeSql(), repairArgs());
    // A crash after the commit leaves the first manifest: no ids, not committed.
    const manifest = readManifest(repaired.manifest);
    writeFileSync(
      repaired.manifest,
      JSON.stringify({ ...manifest, committed: false, insertedIds: null }),
    );

    const undone = await undoRepair(makeSql(), repaired.manifest);

    expect(undone).toEqual({ restored: 4, removed: 5 });
    expect(await snapshot()).toEqual(original);
  });

  /** The manifest as a crash after the commit leaves it. */
  function forgetInsertedIds(manifestFile, over = {}) {
    const manifest = readManifest(manifestFile);
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifest,
        committed: false,
        insertedIds: null,
        ...over,
      }),
    );
  }

  it('the marker fallback deletes only this symbol and date', async () => {
    await seedPlaceholderDay();
    const repaired = await repairDay(makeSql(), repairArgs());
    forgetInsertedIds(repaired.manifest);
    // Written after the marker, so only the symbol and the date keep them.
    const later = '2099-01-01T00:00:00Z';
    const otherDate = await seed({
      date: '2026-03-25',
      at: '2026-03-25T13:30:00Z',
      created: later,
    });
    const otherSymbol = await seed({
      symbol: 'NDX',
      at: '2026-03-26T13:30:00Z',
      created: later,
    });

    const undone = await undoRepair(makeSql(), repaired.manifest);

    expect(undone).toEqual({ restored: 4, removed: 5 });
    const ids = (await snapshot()).map((r) => r.id);
    expect(ids).toContain(String(otherDate));
    expect(ids).toContain(String(otherSymbol));
  });

  it('the marker fallback keeps a same-day row written before the run', async () => {
    const date = '2026-04-10';
    await seed({ date, at: '2026-04-10T17:10:00Z' });
    await seed({
      date,
      at: SPX_CUT,
      created: '2026-04-10T17:12:00.000001Z',
    });
    const original = await snapshot();
    const rows = ['17:10', '17:11'].map((hhmm, i) =>
      newRow('SPX', date, `2026-04-10T${hhmm}:00.000Z`, 6600 + i),
    );
    const repaired = await repairDay(makeSql(), repairArgs({ date, rows }));
    forgetInsertedIds(repaired.manifest);

    await undoRepair(makeSql(), repaired.manifest);

    expect(await snapshot()).toEqual(original);
  });

  it('the marker fallback leaves backed-up rows alone', async () => {
    // A run that rolled back leaves its backed-up rows in place. With a marker
    // set before they were written, the fallback must still not remove them.
    await seedPlaceholderDay();
    const original = await snapshot();
    await pg.query(
      'ALTER TABLE index_candles_1m ADD CONSTRAINT reject_volume CHECK (volume <> 777)',
    );
    const rows = replacementRows();
    rows[2] = { ...rows[2], volume: 777 };
    await expect(repairDay(makeSql(), repairArgs({ rows }))).rejects.toThrow(
      /reject_volume/,
    );
    const manifestName = filesIn(backupDirOf()).find((f) =>
      f.endsWith('.manifest.json'),
    );
    const manifestFile = path.join(backupDirOf(), manifestName);
    forgetInsertedIds(manifestFile, { marker: '2000-01-01 00:00:00+00' });

    await expect(undoRepair(makeSql(), manifestFile)).resolves.toEqual({
      restored: 0,
      removed: 0,
    });
    expect(await snapshot()).toEqual(original);
  });

  it('backs up and restores independently of the session time zone', async () => {
    await seedPlaceholderDay();
    const original = await snapshot();
    await pg.query(`SET TimeZone = 'America/New_York'`);
    const repaired = await repairDay(makeSql(), repairArgs());
    await pg.query(`SET TimeZone = 'Asia/Tokyo'`);

    await undoRepair(makeSql(), repaired.manifest);

    await pg.query(`SET TimeZone = 'UTC'`);
    expect(await snapshot()).toEqual(original);
  });

  it('is idempotent: a second undo changes nothing', async () => {
    await seedPlaceholderDay();
    const repaired = await repairDay(makeSql(), repairArgs());
    await undoRepair(makeSql(), repaired.manifest);
    const restored = await snapshot();

    await expect(undoRepair(makeSql(), repaired.manifest)).resolves.toEqual({
      restored: 0,
      removed: 0,
    });
    expect(await snapshot()).toEqual(restored);
  });

  it('a stale undo fails loudly and changes nothing', async () => {
    await seedPlaceholderDay();
    const original = await snapshot();
    const first = await repairDay(makeSql(), repairArgs());
    await undoRepair(makeSql(), first.manifest);
    const second = await repairDay(makeSql(), repairArgs());
    const afterSecond = await snapshot();

    // Undoing the first run again would put its rows over the second run's.
    await expect(undoRepair(makeSql(), first.manifest)).rejects.toThrow(
      /duplicate key|unique/i,
    );
    expect(await snapshot()).toEqual(afterSecond);

    // In reverse order it works.
    await undoRepair(makeSql(), second.manifest);
    expect(await snapshot()).toEqual(original);
  });

  it('a failing undo rolls back whole, removals included', async () => {
    await seedPlaceholderDay();
    // The replacement has no 20:05 bar, so that minute is free after the run.
    const rows = replacementRows().slice(0, 4);
    const repaired = await repairDay(makeSql(), repairArgs({ rows }));
    await seed({
      at: '2026-03-26T20:05:00Z',
      created: '2099-01-01T00:00:00Z',
      close: '1.5',
    });
    const afterRepair = await snapshot();

    // Undo removes the 4 inserted rows, then cannot put the 20:05 row back.
    await expect(undoRepair(makeSql(), repaired.manifest)).rejects.toThrow(
      /duplicate key|unique/i,
    );

    expect(await snapshot()).toEqual(afterRepair);
  });

  it('refuses a manifest it cannot read, before touching the table', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    const bad = path.join(tmp, 'bad.manifest.json');

    await expect(undoRepair(makeSql(), bad)).rejects.toThrow(/ENOENT/);

    writeFileSync(bad, 'not json');
    await expect(undoRepair(makeSql(), bad)).rejects.toThrow(/not valid JSON/);

    writeFileSync(bad, JSON.stringify({ version: 2 }));
    await expect(undoRepair(makeSql(), bad)).rejects.toThrow(
      /not an index-candle repair manifest/,
    );

    // A manifest whose backup file is gone.
    const repaired = await repairDay(makeSql(), repairArgs());
    const manifest = readManifest(repaired.manifest);
    rmSync(manifest.backup);
    const afterRepair = await snapshot();
    await expect(undoRepair(makeSql(), repaired.manifest)).rejects.toThrow(
      /ENOENT/,
    );
    expect(await snapshot()).toEqual(afterRepair);
    expect(before).not.toEqual(afterRepair);
  });

  it('refuses a backup that does not match its manifest', async () => {
    await seedPlaceholderDay();
    const repaired = await repairDay(makeSql(), repairArgs());
    const afterRepair = await snapshot();
    const manifest = readManifest(repaired.manifest);

    // A truncated backup: one row short.
    const lines = readFileSync(manifest.backup, 'utf8').trim().split('\n');
    writeFileSync(manifest.backup, `${lines.slice(1).join('\n')}\n`);
    await expect(undoRepair(makeSql(), repaired.manifest)).rejects.toThrow(
      /does not match/,
    );

    // A row of another symbol.
    const other = JSON.parse(lines[0]);
    other.symbol = 'NDX';
    writeFileSync(
      manifest.backup,
      `${[JSON.stringify(other), ...lines.slice(1)].join('\n')}\n`,
    );
    await expect(undoRepair(makeSql(), repaired.manifest)).rejects.toThrow(
      /does not match/,
    );

    // A line that is not a backup row.
    writeFileSync(manifest.backup, '{"id": "1"}\n');
    await expect(undoRepair(makeSql(), repaired.manifest)).rejects.toThrow(
      /malformed/,
    );
    expect(await snapshot()).toEqual(afterRepair);
  });

  it('describes an undo without touching the database', async () => {
    await seedPlaceholderDay();
    const repaired = await repairDay(makeSql(), repairArgs());

    const lines = await describeUndo(repaired.manifest);

    const text = lines.join('\n');
    expect(text).toMatch(/SPX 2026-03-26/);
    expect(text).toMatch(/restore 4 backed-up rows/);
    expect(text).toMatch(/remove 5 inserted rows \(by id\)/);

    const manifest = readManifest(repaired.manifest);
    writeFileSync(
      repaired.manifest,
      JSON.stringify({ ...manifest, committed: false, insertedIds: null }),
    );
    expect((await describeUndo(repaired.manifest)).join('\n')).toMatch(
      /by run marker/,
    );
  });
});

// ── processRepairDay: prepare, then repair ─────────────────

describe('processRepairDay', () => {
  function dayArgs(over = {}) {
    return {
      symbol: 'SPX',
      date: SPX_DATE,
      list: 'spx-repair',
      closes: schwabCloses(SPX_DATE),
      uwKey: 'uw-key',
      waitForSlot: vi.fn(),
      backupDir: backupDirOf(),
      apply: true,
      ...over,
    };
  }

  it('repairs a day end to end and returns the run-loop counts', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    await seedPlaceholderDay();
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE),
    });

    const out = await processRepairDay(makeSql(), dayArgs());

    expect(out).toMatchObject({
      fetched: 396,
      stored: 396,
      deleted: 4,
      ratio: 10.046368,
      dropped: 0,
      // The stored 12:00 pre-market and 20:05 post-market minutes have no
      // bar in the UW answer; they are deleted, and counted.
      uncovered: 2,
    });
    expect(typeof out.manifest).toBe('string');
    const day = (await snapshot()).filter((r) => r.symbol === 'SPX');
    expect(day).toHaveLength(396);
  });

  it('a dry run counts what would change and stores nothing', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    await seedPlaceholderDay();
    const before = await snapshot();
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE),
    });

    const out = await processRepairDay(makeSql(), dayArgs({ apply: false }));

    expect(out).toMatchObject({
      fetched: 396,
      stored: 0,
      wouldDelete: 4,
      wouldInsert: 396,
      uncovered: 2,
    });
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);

    // The run loop's per-date line carries both, side by side.
    const lines = formatRunSummary(
      summarizeRun({
        days: [{ date: SPX_DATE, ok: true, value: out }],
        stoppedBy: null,
        notRun: [],
      }),
    );
    expect(lines).toContain(
      `  ${SPX_DATE}  fetched 396  stored 0  ratio 10.046368  dropped 0  uncovered 2  wouldDelete 4  wouldInsert 396`,
    );
  });

  it('a partial UW answer skips the date untouched, never delete then half-refill', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    await seedPlaceholderDay();
    const before = await snapshot();
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE, { regular: 389 }),
    });
    const sql = makeSql();

    const failure = await processRepairDay(sql, dayArgs()).catch((e) => e);

    expect(failure).toBeInstanceOf(DayFailure);
    expect(failure.kind).toBe('other');
    expect(failure.message).toMatch(/389 regular bars, expected 390/);
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(existsSync(backupDirOf())).toBe(false);
  });

  it('skips with the UW failure kind', async () => {
    await seedPlaceholderDay();
    const before = await snapshot();
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'error',
      status: 'http_429',
      detail: 'slow down',
    });

    await expect(processRepairDay(makeSql(), dayArgs())).rejects.toMatchObject({
      name: 'DayFailure',
      kind: 'uw_http_429',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('fails the day, with the reason, when the repair itself refuses it', async () => {
    await seedSettlement(SPX_DATE, '6500.00');
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: uwBars(SPX_DATE),
    });

    await expect(
      processRepairDay(makeSql(), dayArgs({ list: 'ndx-repair' })),
    ).rejects.toThrow(/SPX is not in the ndx-repair list/);
  });
});

// ── The refit (spec decision 9) ────────────────────────────

const TICKERS = {
  SPX: { etf: 'SPY', index: '$SPX' },
  NDX: { etf: 'QQQ', index: '$NDX' },
};
/** The last regular ETF close of refitBars(symbol). */
const ETF_LAST = { SPX: 647, NDX: 560 };
/**
 * close: Schwab's index close over its ETF close. prior: the ratio the stored
 * rows carry, on purpose not the close ratio. fitted: what the price file fits
 * to, within the 0.15% of the close ratio the fit allows.
 */
const RATIOS = {
  SPX: { close: 10.04, prior: 10.03, fitted: 10.045 },
  NDX: { close: 41, prior: 40.95, fitted: 41.02 },
};
const GAP_DATE = '2026-09-21'; // insert-only for both symbols; EDT
const SUMMER_DATE = '2026-08-20'; // EDT
const BACKFILL_CREATED = '2026-11-06T22:19:20Z'; // inside the 11-06 window

function spotsDirOf() {
  return path.join(tmp, 'spots');
}

/** UW's answer for one refit day: 390 regular bars ending at ETF_LAST. */
function refitBars(symbol, date, over = {}) {
  return uwBars(date, { lastClose: ETF_LAST[symbol], ...over });
}

function mappedRows(symbol, date, ratio, bars = refitBars(symbol, date)) {
  return toIndexRows(symbol, date, bars, ratio).rows;
}

/** A price file's minutes: each regular bar's ETF close times `ratio`. */
function spotMinutes(bars, ratio) {
  return Object.fromEntries(
    bars
      .filter((bar) => bar.market_time === 'r')
      .map((bar) => [
        String(Date.parse(bar.start_time) / 60_000),
        Number(bar.close) * ratio,
      ]),
  );
}

function writeSpots(
  symbol,
  date,
  minutes,
  source = symbol === 'SPX' ? 'tape' : 'parity',
) {
  mkdirSync(spotsDirOf(), { recursive: true });
  writeFileSync(
    path.join(spotsDirOf(), `${symbol}-${date}-spots.json`),
    JSON.stringify({ symbol, date, source, minutes }),
  );
}

/** The refit's inputs: UW's answer and a price file fitted to `ratio`. */
function stageRefit(
  symbol,
  date,
  { ratio = RATIOS[symbol].fitted, bars = refitBars(symbol, date) } = {},
) {
  mocks.fetchUwCandles.mockResolvedValue({ kind: 'ok', rows: bars });
  writeSpots(symbol, date, spotMinutes(bars, ratio));
  return bars;
}

/**
 * loadSchwabCloses' shape for both indexes: the close (ETF_LAST times the
 * close ratio) and a daily range equal to the regular rows mapped at
 * `rangeRatio`, moved by `shift`, or `ranges[symbol]` as given.
 */
function refitCloses(
  date,
  { rangeRatio, shift = 0, ndxClose, noRange = false, ranges = {} } = {},
) {
  const entries = [];
  for (const symbol of ['SPX', 'NDX']) {
    const { etf, index } = TICKERS[symbol];
    const regular = mappedRows(
      symbol,
      date,
      rangeRatio ?? RATIOS[symbol].fitted,
    ).filter((row) => row.market_time === 'r');
    const range = ranges[symbol] ?? {
      high: Math.max(...regular.map((row) => row.high)) + shift,
      low: Math.min(...regular.map((row) => row.low)) + shift,
    };
    const close =
      symbol === 'NDX' && ndxClose != null
        ? ndxClose
        : ETF_LAST[symbol] * RATIOS[symbol].close;
    entries.push([etf, { closes: new Map([[date, ETF_LAST[symbol]]]) }]);
    entries.push([
      index,
      {
        closes: new Map([[date, close]]),
        ...(noRange ? {} : { extremes: new Map([[date, range]]) }),
      },
    ]);
  }
  return new Map(entries);
}

function refitArgs(over = {}) {
  const { symbol = 'SPX', date = SPX_DATE } = over;
  return {
    symbol,
    date,
    list: 'spx-repair',
    closes: refitCloses(date),
    uwKey: 'uw-key',
    waitForSlot: vi.fn(),
    spotsDir: spotsDirOf(),
    backupDir: backupDirOf(),
    apply: true,
    ...over,
  };
}

/** The stored day a refit starts from: a real repairDay at the prior ratio. */
function repairedDay({
  symbol = 'SPX',
  date = SPX_DATE,
  list = 'spx-repair',
} = {}) {
  return repairDay(makeSql(), {
    symbol,
    date,
    list,
    rows: mappedRows(symbol, date, RATIOS[symbol].prior),
    ratio: RATIOS[symbol].prior,
    backupDir: backupDirOf(),
    apply: true,
  });
}

/** refitDay's arguments from what find and prepare returned. */
function refitCall(args, found, prepared, over = {}) {
  return {
    symbol: args.symbol,
    date: args.date,
    list: args.list,
    prepared,
    found,
    backupDir: args.backupDir,
    apply: args.apply,
    ...over,
  };
}

/** find and prepare, as processRefitDay runs them, for a direct refitDay call. */
async function readyRefit(over = {}) {
  const args = refitArgs(over);
  const found = await findRefitManifest(makeSql(), args);
  const prepared = await prepareRefitDay(makeSql(), args);
  expect(found.ok).toBe(true);
  expect(prepared.ok).toBe(true);
  return { args, found, prepared };
}

/** Each stored row's close over the ETF close of its minute. */
function ratiosOf(rows, bars) {
  const etf = new Map(
    bars.map((bar) => [Date.parse(bar.start_time), Number(bar.close)]),
  );
  return rows.map(
    (row) => Number(row.close) / etf.get(Date.parse(row.timestamp)),
  );
}

const column = (rows, name) => rows.map((row) => row[name]);

/** Insert mapped rows written at `created`, with no Schwab price. */
async function seedMapped(rows, created) {
  await pg.query(
    `INSERT INTO index_candles_1m
       (symbol, date, timestamp, open, high, low, close, volume, market_time,
        created_at)
     SELECT t.symbol, t.date, t.timestamp, t.open, t.high, t.low, t.close,
            t.volume, t.market_time, $10::timestamptz
     FROM unnest($1::text[], $2::date[], $3::timestamptz[], $4::numeric[],
                 $5::numeric[], $6::numeric[], $7::numeric[], $8::bigint[],
                 $9::text[])
       AS t(symbol, date, timestamp, open, high, low, close, volume,
            market_time)`,
    [
      column(rows, 'symbol'),
      column(rows, 'date'),
      column(rows, 'timestamp'),
      column(rows, 'open'),
      column(rows, 'high'),
      column(rows, 'low'),
      column(rows, 'close'),
      column(rows, 'volume'),
      column(rows, 'market_time'),
      created,
    ],
  );
}

describe('findRefitManifest', () => {
  const find = (over = {}) =>
    findRefitManifest(makeSql(), {
      symbol: 'SPX',
      date: SPX_DATE,
      backupDir: backupDirOf(),
      ...over,
    });

  /** A copy of a manifest under another name, with `over` on top. */
  function copyManifest(from, name, over = {}) {
    const file = path.join(backupDirOf(), name);
    writeFileSync(file, JSON.stringify({ ...readManifest(from), ...over }));
    return file;
  }

  it('finds the one committed manifest whose inserted rows are all still there', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();

    const found = await find();

    expect(found).toMatchObject({ ok: true, manifestPath: repaired.manifest });
    expect(found.manifest).toMatchObject({
      symbol: 'SPX',
      date: SPX_DATE,
      committed: true,
    });
    expect(found.ids).toEqual(readManifest(repaired.manifest).insertedIds);
    expect(found.ids).toHaveLength(396);
  });

  it('skips a date with no manifest, a missing folder or no folder', async () => {
    await seedPlaceholderDay();
    expect(await find()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^no manifest for SPX 2026-03-26 in /),
    });
    mkdirSync(backupDirOf());
    expect(await find()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^no manifest for SPX 2026-03-26 in /),
    });
    expect(await find({ backupDir: undefined })).toEqual({
      ok: false,
      reason: 'no backup directory',
    });
    // Another date's manifest is not this date's.
    await repairedDay();
    expect(await find({ date: '2026-03-25' })).toMatchObject({ ok: false });
  });

  it('skips a date with two qualifying manifests, naming both', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();
    const copy = copyManifest(
      repaired.manifest,
      'SPX-2026-03-26-20990101T000000000Z.manifest.json',
    );

    const found = await find();

    expect(found.ok).toBe(false);
    expect(found.reason).toMatch(/2 manifests qualify for SPX 2026-03-26/);
    expect(found.reason).toContain(path.basename(repaired.manifest));
    expect(found.reason).toContain(path.basename(copy));
  });

  it.each([
    [
      'gone',
      (id) => pg.query('DELETE FROM index_candles_1m WHERE id = $1', [id]),
    ],
    [
      'now another symbol',
      (id) =>
        pg.query("UPDATE index_candles_1m SET symbol = 'NDX' WHERE id = $1", [
          id,
        ]),
    ],
    [
      'now another date',
      (id) =>
        pg.query(
          "UPDATE index_candles_1m SET date = '2026-03-25' WHERE id = $1",
          [id],
        ),
    ],
  ])(
    'skips a date whose manifest lists a row that is %s',
    async (_label, change) => {
      await seedPlaceholderDay();
      const repaired = await repairedDay();
      await change(readManifest(repaired.manifest).insertedIds[100]);

      const found = await find();

      expect(found.ok).toBe(false);
      expect(found.reason).toMatch(
        /lists 396 inserted rows, but only 395 are SPX 2026-03-26 rows/,
      );
    },
  );

  it('does not count an uncommitted, empty, foreign or lottery manifest', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();
    const real = readManifest(repaired.manifest);
    const decoys = {
      1: { committed: false },
      2: { insertedIds: [] },
      3: { symbol: 'NDX' },
      4: { date: '2026-03-25' },
      5: { kind: 'lottery-spots' },
      6: { kind: 'something-else' },
      // A repeated id: 397 listed, 396 rows.
      7: { insertedIds: [...real.insertedIds, real.insertedIds[0]] },
    };
    for (const [n, over] of Object.entries(decoys)) {
      copyManifest(
        repaired.manifest,
        `SPX-2026-03-26-2099010100000000${n}Z.manifest.json`,
        over,
      );
    }
    writeFileSync(
      path.join(
        backupDirOf(),
        'SPX-2026-03-26-20990101000000008Z.manifest.json',
      ),
      'not json',
    );
    // A real lottery manifest's own shape, under a name this date matches.
    writeFileSync(
      path.join(
        backupDirOf(),
        'SPX-2026-03-26-20990101000000009Z.manifest.json',
      ),
      JSON.stringify({
        version: 1,
        kind: 'lottery-spots',
        backup: 'x.jsonl',
        backedUpIds: [1],
        committed: true,
        insertedIds: [1],
      }),
    );

    const found = await find();

    expect(found).toMatchObject({ ok: true, manifestPath: repaired.manifest });
  });

  it('names why each candidate failed when none qualifies', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();
    copyManifest(
      repaired.manifest,
      'SPX-2026-03-26-20990101T000000001Z.manifest.json',
      {
        committed: false,
      },
    );
    await pg.query('DELETE FROM index_candles_1m WHERE symbol = $1', ['SPX']);

    const found = await find();

    // Only manifests are read, not the backups beside them, in name order.
    expect(found).toEqual({
      ok: false,
      reason:
        'no manifest for SPX 2026-03-26 qualifies: ' +
        `${path.basename(repaired.manifest)} lists 396 inserted rows, but ` +
        'only 0 are SPX 2026-03-26 rows; ' +
        'SPX-2026-03-26-20990101T000000001Z.manifest.json is not committed',
    });
  });
});

describe('prepareRefitDay', () => {
  const noQuery = () =>
    vi.fn(() => {
      throw new Error('a fitted day reads nothing from the database');
    });

  it('fits the day to the price file, maps it at the fitted ratio, and reads nothing from the database', async () => {
    const bars = stageRefit('SPX', SPX_DATE);
    const sql = noQuery();
    const args = refitArgs();

    const out = await prepareRefitDay(sql, args);

    expect(out).toMatchObject({
      ok: true,
      source: 'tape',
      matched: 390,
      dropped: 0,
    });
    expect(out.ratio).toBeCloseTo(RATIOS.SPX.fitted, 12);
    expect(out.closeRatio).toBeCloseTo(RATIOS.SPX.close, 12);
    expect(out.scatter).toBeCloseTo(0, 6);
    expect(out.dh).toBeCloseTo(0, 6);
    expect(out.dl).toBeCloseTo(0, 6);
    expect(out.rows).toHaveLength(396);
    const last = out.rows.filter((r) => r.market_time === 'r').at(-1);
    expect(last.close).toBeCloseTo(647 * RATIOS.SPX.fitted, 6);
    expect(out.etfCloses.size).toBe(390);
    const first = bars.find((bar) => bar.market_time === 'r');
    expect(out.etfCloses.get(Date.parse(first.start_time) / 60_000)).toBe(
      Number(first.close),
    );
    expect(mocks.fetchUwCandles).toHaveBeenCalledWith(
      'uw-key',
      'SPY',
      SPX_DATE,
      args.waitForSlot,
    );
    expect(sql).not.toHaveBeenCalled();
  });

  it('counts a malformed extended-hours bar as dropped and still passes the day', async () => {
    const bars = refitBars('SPX', SPX_DATE);
    bars[0] = { ...bars[0], close: 'n/a' };
    stageRefit('SPX', SPX_DATE, { bars });

    const out = await prepareRefitDay(noQuery(), refitArgs());

    expect(out).toMatchObject({ ok: true, dropped: 1 });
    expect(out.rows).toHaveLength(395);
  });

  it('skips a fit-gate failure with its reason', async () => {
    // 1.6% above the close ratio: over the 0.15% allowed.
    stageRefit('SPX', SPX_DATE, { ratio: RATIOS.SPX.close * 1.016 });

    const out = await prepareRefitDay(noQuery(), refitArgs());

    expect(out).toMatchObject({ ok: false, kind: 'other' });
    expect(out.reason).toMatch(/from the close ratio .* over the 0.0015/);
  });

  it('skips a day the price file does not cover', async () => {
    const bars = refitBars('SPX', SPX_DATE);
    stageRefit('SPX', SPX_DATE);
    // Under 99% of the 390 cash minutes in the file.
    const minutes = spotMinutes(bars, RATIOS.SPX.fitted);
    for (const key of Object.keys(minutes).slice(0, 10)) delete minutes[key];
    writeSpots('SPX', SPX_DATE, minutes);

    const out = await prepareRefitDay(noQuery(), refitArgs());

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/matched minutes 380 is under the 387/);
  });

  it('skips a level-check failure with its reason', async () => {
    stageRefit('SPX', SPX_DATE);
    // Schwab's range 5 pt above the mapped day on both sides.
    const closes = refitCloses(SPX_DATE, { shift: 5 });

    const out = await prepareRefitDay(noQuery(), refitArgs({ closes }));

    expect(out).toMatchObject({ ok: false, kind: 'other' });
    expect(out.reason).toMatch(/misses Schwab's daily range on one side/);
  });

  it('skips a missing price file before it asks UW', async () => {
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: refitBars('SPX', SPX_DATE),
    });

    const out = await prepareRefitDay(noQuery(), refitArgs());

    expect(out).toMatchObject({ ok: false, kind: 'other' });
    expect(out.reason).toMatch(/no price file SPX-2026-03-26-spots\.json/);
    expect(mocks.fetchUwCandles).not.toHaveBeenCalled();
  });

  it('skips a price file for another symbol or another source', async () => {
    const bars = stageRefit('SPX', SPX_DATE);
    const minutes = spotMinutes(bars, RATIOS.SPX.fitted);
    writeFileSync(
      path.join(spotsDirOf(), `SPX-${SPX_DATE}-spots.json`),
      JSON.stringify({
        symbol: 'NDX',
        date: SPX_DATE,
        source: 'parity',
        minutes,
      }),
    );
    const other = await prepareRefitDay(noQuery(), refitArgs());
    expect(other.ok).toBe(false);
    expect(other.reason).toMatch(/is for symbol NDX, not SPX/);

    rmSync(spotsDirOf(), { recursive: true });
    writeSpots('SPX', SPX_DATE, minutes, 'parity');
    const wrongSource = await prepareRefitDay(noQuery(), refitArgs());
    expect(wrongSource.ok).toBe(false);
    expect(wrongSource.reason).toMatch(/source parity is not tape/);
  });

  it('skips a UW error with its kind, an empty answer and the row cap', async () => {
    writeSpots(
      'SPX',
      SPX_DATE,
      spotMinutes(refitBars('SPX', SPX_DATE), RATIOS.SPX.fitted),
    );
    mocks.fetchUwCandles.mockResolvedValueOnce({
      kind: 'error',
      status: 'http_503',
      detail: 'upstream down',
    });
    const uwError = await prepareRefitDay(noQuery(), refitArgs());
    expect(uwError).toMatchObject({ ok: false, kind: 'uw_http_503' });
    expect(uwError.reason).toBe(
      `UW SPY bars for ${SPX_DATE}: http_503 upstream down`,
    );

    mocks.fetchUwCandles.mockResolvedValueOnce({ kind: 'empty' });
    const empty = await prepareRefitDay(noQuery(), refitArgs());
    expect(empty.reason).toMatch(/UW has no SPY bars/);

    mocks.fetchUwCandles.mockResolvedValueOnce({
      kind: 'ok',
      rows: Array.from({ length: 2500 }, () => ({})),
    });
    const capped = await prepareRefitDay(noQuery(), refitArgs());
    expect(capped.reason).toMatch(/2500.*cut short/);
  });

  it('skips a date with no Schwab close, or no Schwab range, before asking UW', async () => {
    stageRefit('SPX', SPX_DATE);
    const noClose = await prepareRefitDay(
      noQuery(),
      refitArgs({ closes: new Map([['$SPX', { closes: new Map() }]]) }),
    );
    expect(noClose.ok).toBe(false);
    expect(noClose.reason).toMatch(/no ratio for SPX on 2026-03-26/);
    expect(mocks.fetchUwCandles).not.toHaveBeenCalled();

    const noRange = await prepareRefitDay(
      noQuery(),
      refitArgs({ closes: refitCloses(SPX_DATE, { noRange: true }) }),
    );
    expect(noRange.ok).toBe(false);
    expect(noRange.reason).toMatch(/no extremes for SPX on 2026-03-26/);
  });

  it('does not refuse a fitted NDX day whose close is 20 pt from the Schwab $NDX close', async () => {
    stageRefit('NDX', SPX_DATE);
    // The last regular close maps to 560 x 41.02 = 22971.2.
    const closes = refitCloses(SPX_DATE, { ndxClose: 22951.2 });

    const out = await prepareRefitDay(
      noQuery(),
      refitArgs({ symbol: 'NDX', closes }),
    );

    expect(out).toMatchObject({ ok: true, source: 'parity', matched: 390 });
    const last = out.rows.filter((r) => r.market_time === 'r').at(-1);
    expect(Math.abs(last.close - 22951.2)).toBeGreaterThan(19.9);
  });

  it('does not refuse a fitted SPX day whose close is 4.01 pt from the settlement, and refits one with no outcomes row', async () => {
    stageRefit('SPX', SPX_DATE);
    // The last regular close is 647 x 10.045 = 6499.115.
    await seedSettlement(SPX_DATE, '6495.10');
    const far = await prepareRefitDay(noQuery(), refitArgs());
    expect(far.ok).toBe(true);

    await pg.query('DELETE FROM outcomes');
    const none = await prepareRefitDay(noQuery(), refitArgs());
    expect(none.ok).toBe(true);
  });

  it('still refuses a fitted day with 389 regular bars on a 390-minute day', async () => {
    stageRefit('SPX', SPX_DATE, {
      bars: refitBars('SPX', SPX_DATE, { regular: 389 }),
    });

    const out = await prepareRefitDay(noQuery(), refitArgs());

    expect(out).toMatchObject({ ok: false, kind: 'other' });
    expect(out.reason).toMatch(/389 regular bars, expected 390/);
  });

  it('refuses a symbol it has no repair for', async () => {
    await expect(
      prepareRefitDay(noQuery(), refitArgs({ symbol: 'ES' })),
    ).rejects.toThrow(/no repair for symbol ES/);
  });
});

describe('refitDay', () => {
  it('replaces exactly the rows the manifest inserted, at the fitted ratio, and keeps a live row', async () => {
    await seedPlaceholderDay();
    // A live row the repair keeps: written after the placeholder cut.
    const live = await seed({
      at: '2026-03-26T13:40:00Z',
      close: '6481.5',
      created: '2026-11-25T14:00:00Z',
    });
    const repaired = await repairedDay();
    const old = readManifest(repaired.manifest);
    expect(old.insertedIds).toHaveLength(395); // 396 mapped, less the live minute
    const before = await snapshot();
    const bars = stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    const sql = makeSql();

    const res = await refitDay(sql, refitCall(args, found, prepared));

    expect(res).toMatchObject({
      date: SPX_DATE,
      symbol: 'SPX',
      ratio: 10.045,
      closeRatio: 10.04,
      priorRatio: 10.03,
      replaced: 395,
      inserted: 395,
      uncovered: 0,
    });
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toMatch(/^\s*DELETE FROM index_candles_1m/);
    expect(statements[1].text).toMatch(/INSERT INTO index_candles_1m/);
    // The live row's minute is not sent: 395 rows, not 396.
    expect(statements[1].params.map((p) => p.length)).toEqual(
      Array.from({ length: 11 }, () => 395),
    );

    const after = await snapshot();
    const oldIds = new Set(old.insertedIds.map(String));
    expect(after.some((r) => oldIds.has(r.id))).toBe(false);
    // The live row is exactly as it was, and its minute holds one row only.
    expect(after.find((r) => r.id === String(live))).toEqual(
      before.find((r) => r.id === String(live)),
    );
    expect(after).toHaveLength(396);
    expect(new Set(after.map((r) => r.timestamp)).size).toBe(396);
    const fresh = after.filter((r) => r.id !== String(live));
    expect(fresh).toHaveLength(395);
    for (const ratio of ratiosOf(fresh, bars)) {
      expect(ratio).toBeCloseTo(RATIOS.SPX.fitted, 9);
    }

    // The backup holds the replaced rows exactly, every column as text.
    const backup = readFileSync(readManifest(res.manifest).backup, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(backup).toEqual(before.filter((r) => oldIds.has(r.id)));

    const manifest = readManifest(res.manifest);
    expect(manifest).toMatchObject({
      version: 1,
      kind: 'refit',
      refitOf: repaired.manifest,
      symbol: 'SPX',
      date: SPX_DATE,
      list: 'spx-repair',
      source: 'tape',
      committed: true,
    });
    expect(manifest.ratio).toBeCloseTo(10.045, 12);
    expect(manifest.closeRatio).toBeCloseTo(10.04, 12);
    expect(manifest.priorRatio).toBeCloseTo(10.03, 12);
    expect(manifest.backedUpIds).toEqual(old.insertedIds);
    expect(manifest.insertedIds).toEqual(fresh.map((r) => Number(r.id)));
    expect(manifest.marker).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it('a second look finds only the refit manifest', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const first = await processRefitDay(makeSql(), refitArgs());
    const afterFirst = await snapshot();

    const found = await findRefitManifest(makeSql(), refitArgs());

    expect(found).toMatchObject({
      ok: true,
      manifestPath: first.manifest,
      manifest: { kind: 'refit', refitOf: repaired.manifest },
    });
    expect(found.ids).toEqual(readManifest(first.manifest).insertedIds);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('writes nothing in a dry run, and counts what an apply would change', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    const files = filesIn(backupDirOf());
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit({ apply: false });
    const sql = makeSql();

    const res = await refitDay(sql, refitCall(args, found, prepared));

    expect(res).toEqual({
      date: SPX_DATE,
      symbol: 'SPX',
      ratio: 10.045,
      closeRatio: 10.04,
      priorRatio: 10.03,
      replaced: 396,
      inserted: 396,
      uncovered: 0,
    });
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual(files);
  });

  it.each([
    ['a pre-market', '13:27'],
    ['a post-market', '20:00'],
  ])(
    'writes nothing when the new rows would leave %s minute empty',
    async (_label, hhmm) => {
      await seedPlaceholderDay();
      await repairedDay();
      const before = await snapshot();
      const files = filesIn(backupDirOf());
      // UW's answer lacks one extended-hours minute the repaired rows cover.
      const missing = `${SPX_DATE}T${hhmm}:00.000Z`;
      stageRefit('SPX', SPX_DATE, {
        bars: refitBars('SPX', SPX_DATE).filter(
          (bar) => bar.start_time !== missing,
        ),
      });

      for (const apply of [false, true]) {
        const { args, found, prepared } = await readyRefit({ apply });
        const sql = makeSql();

        const res = await refitDay(sql, refitCall(args, found, prepared));

        expect(res.skipped).toMatch(/^would leave 1 minute empty/);
        expect(res.skipped).toContain(`first ${missing}`);
        expect(res).toMatchObject({ uncovered: 1, replaced: 0, inserted: 0 });
        expect(res.manifest).toBeUndefined();
        expect(sql.transaction).not.toHaveBeenCalled();
      }
      expect(await snapshot()).toEqual(before);
      expect(filesIn(backupDirOf())).toEqual(files);
    },
  );

  it('names every minute it would leave empty', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const missing = [`${SPX_DATE}T13:27:00.000Z`, `${SPX_DATE}T20:01:00.000Z`];
    stageRefit('SPX', SPX_DATE, {
      bars: refitBars('SPX', SPX_DATE).filter(
        (bar) => !missing.includes(bar.start_time),
      ),
    });
    const { args, found, prepared } = await readyRefit();

    const res = await refitDay(makeSql(), refitCall(args, found, prepared));

    expect(res.skipped).toMatch(/^would leave 2 minutes empty/);
    expect(res.uncovered).toBe(2);
  });

  it('measures the prior ratio from the rows it replaces, not from the close ratio', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit({ apply: false });

    const res = await refitDay(makeSql(), refitCall(args, found, prepared));

    expect(res.priorRatio).toBe(10.03);
    expect(res.closeRatio).toBe(10.04);
    expect(res.ratio).toBe(10.045);
  });

  it('skips when no replaced regular minute has a UW bar to measure the prior ratio from', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    const sql = makeSql();

    const res = await refitDay(
      sql,
      refitCall(args, found, { ...prepared, etfCloses: new Map() }),
    );

    expect(res.skipped).toMatch(/prior ratio cannot be measured/);
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('skips when a row the manifest lists has gone since it was read, and changes nothing', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    const sql = makeSql();

    const res = await refitDay(
      sql,
      refitCall(args, { ...found, ids: [...found.ids, 999_999] }, prepared),
    );

    expect(res.skipped).toBe(
      'rows to replace: 396 of the 397 are still SPX 2026-03-26 rows',
    );
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('touches nothing when the request does not belong to its list', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    const files = filesIn(backupDirOf());
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    const stray = newRow('NDX', SPX_DATE, `${SPX_DATE}T13:30:00.000Z`, 6500);
    const cases = [
      [{ list: 'ndx-repair' }, /not in the ndx-repair list/],
      [{ list: 'no-such-list' }, /unknown list/],
      [{ date: '2026-04-20' }, /not in the spx-repair list/],
      [{ prepared: { ...prepared, rows: [] } }, /no mapped rows/],
      [{ prepared: { ...prepared, rows: [stray] } }, /not SPX 2026-03-26/],
      [{ prepared: { ...prepared, ratio: Number.NaN } }, /bad ratio/],
      [{ backupDir: undefined }, /no backup directory/],
      [{ found: { ...found, ids: [] } }, /no rows to replace/],
    ];
    for (const [over, reason] of cases) {
      const sql = makeSql();
      const res = await refitDay(sql, refitCall(args, found, prepared, over));
      expect(res.skipped).toMatch(reason);
      expect(res).toMatchObject({ replaced: 0, inserted: 0 });
      expect(sql.transaction).not.toHaveBeenCalled();
    }
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual(files);
  });

  it('an unwritable backup changes nothing', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    const blocker = path.join(tmp, 'not-a-directory');
    writeFileSync(blocker, 'a file where the backup folder should be');
    const sql = makeSql();

    await expect(
      refitDay(sql, refitCall(args, found, prepared, { backupDir: blocker })),
    ).rejects.toThrow(/EEXIST|ENOTDIR|not a directory/i);

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(blocker, 'utf8')).toMatch(/a file where/);
  });

  it('a DB error mid-refit rolls back, and the manifest it left undoes nothing', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    await pg.query(
      'ALTER TABLE index_candles_1m ADD CONSTRAINT reject_volume CHECK (volume <> 777)',
    );
    const rows = [...prepared.rows];
    rows[10] = { ...rows[10], volume: 777 };

    await expect(
      refitDay(makeSql(), refitCall(args, found, { ...prepared, rows })),
    ).rejects.toThrow(/reject_volume/);

    expect(await snapshot()).toEqual(before);
    const manifestName = filesIn(backupDirOf())
      .filter((f) => f.endsWith('.manifest.json'))
      .at(-1);
    const manifest = readManifest(path.join(backupDirOf(), manifestName));
    expect(manifest).toMatchObject({
      kind: 'refit',
      committed: false,
      insertedIds: null,
    });
    await pg.query(
      'ALTER TABLE index_candles_1m DROP CONSTRAINT reject_volume',
    );
    await expect(
      undoRepair(makeSql(), path.join(backupDirOf(), manifestName)),
    ).resolves.toEqual({ restored: 0, removed: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('after a commit whose manifest could not be rewritten, no manifest qualifies, so the date is not refit again', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    // Writes 1-2 were the repair's; this refit's are 3 (before) and 4 (after).
    mocks.manifestWrites = 0;
    mocks.failManifestWrite = 2;

    const error = await refitDay(
      makeSql(),
      refitCall(args, found, prepared),
    ).catch((e) => e);

    expect(error.message).toMatch(
      /^SPX 2026-03-26: committed \(396 deleted, 396 inserted\) but the manifest .+\.manifest\.json could not be rewritten/,
    );
    mocks.failManifestWrite = 0;
    const next = await findRefitManifest(makeSql(), args);
    expect(next.ok).toBe(false);
    expect(next.reason).toContain('is not committed');
  });

  it('measures the prior ratio from the regular minutes only', async () => {
    const date = SUMMER_DATE;
    const base = Date.parse(`${date}T13:00:00.000Z`);
    const at = (i) => new Date(base + i * 60_000).toISOString();
    // Five pre-market rows at twice the ratio, two regular rows at the prior.
    const marketTimes = ['pr', 'pr', 'pr', 'pr', 'pr', 'r', 'r'];
    const rowsAt = (factor, ratio) =>
      marketTimes.map((marketTime, i) =>
        newRow(
          'SPX',
          date,
          at(i),
          650 * ratio * (marketTime === 'pr' ? factor : 1),
          marketTime,
        ),
      );
    await seedMapped(rowsAt(2, RATIOS.SPX.prior), BACKFILL_CREATED);
    const found = await findRefitManifest(makeSql(), {
      symbol: 'SPX',
      date,
      backupDir: backupDirOf(),
    });

    const res = await refitDay(makeSql(), {
      symbol: 'SPX',
      date,
      list: 'summer',
      prepared: {
        ok: true,
        rows: rowsAt(1, RATIOS.SPX.fitted),
        ratio: RATIOS.SPX.fitted,
        closeRatio: RATIOS.SPX.close,
        source: 'tape',
        etfCloses: new Map(marketTimes.map((_, i) => [base / 60_000 + i, 650])),
      },
      found,
      backupDir: backupDirOf(),
      apply: false,
    });

    expect(res).toMatchObject({ priorRatio: 10.03, replaced: 7, inserted: 7 });
  });

  it('inserts a 1,000-row day in batches of at most 500, and deletes by id in the same transaction', async () => {
    const date = SUMMER_DATE;
    const base = Date.parse(`${date}T13:00:00.000Z`);
    const etfs = Array.from({ length: 1000 }, (_, i) => 650 + i / 100);
    const rowsAt = (ratio) =>
      etfs.map((etf, i) =>
        newRow(
          'SPX',
          date,
          new Date(base + i * 60_000).toISOString(),
          etf * ratio,
        ),
      );
    await seedMapped(rowsAt(RATIOS.SPX.prior), BACKFILL_CREATED);
    const found = await findRefitManifest(makeSql(), {
      symbol: 'SPX',
      date,
      backupDir: backupDirOf(),
    });
    expect(found.ids).toHaveLength(1000);
    const prepared = {
      ok: true,
      rows: rowsAt(RATIOS.SPX.fitted),
      ratio: RATIOS.SPX.fitted,
      closeRatio: RATIOS.SPX.close,
      source: 'tape',
      etfCloses: new Map(etfs.map((etf, i) => [base / 60_000 + i, etf])),
    };
    const sql = makeSql();

    const res = await refitDay(sql, {
      symbol: 'SPX',
      date,
      list: 'summer',
      prepared,
      found,
      backupDir: backupDirOf(),
      apply: true,
    });

    expect(res).toMatchObject({ replaced: 1000, inserted: 1000 });
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(3);
    expect(statements[0].text).toMatch(/^\s*DELETE FROM index_candles_1m/);
    for (const statement of statements.slice(1)) {
      expect(statement.text).toMatch(/INSERT INTO index_candles_1m/);
      const sizes = statement.params.map((p) => p.length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
      expect(Math.min(...sizes)).toBe(500);
    }
    expect((await snapshot()).length).toBe(1000);
  });
});

describe('the summer refit', () => {
  /** Stored: the backfill's rows, a live row, a late row and a priced row. */
  async function seedSummerDay() {
    const at = (hhmm) => `${SUMMER_DATE}T${hhmm}:00.000Z`;
    const held = new Set([at('13:40'), at('13:41'), at('13:42')]);
    await seedMapped(
      mappedRows('SPX', SUMMER_DATE, RATIOS.SPX.prior).filter(
        (row) => !held.has(row.timestamp),
      ),
      BACKFILL_CREATED,
    );
    // Written that morning, as 07-22's live rows are: not the backfill's.
    const live = await seed({
      date: SUMMER_DATE,
      at: at('13:40'),
      close: '6480',
      created: `${SUMMER_DATE}T17:40:00Z`,
    });
    // Written at the window's end (exclusive).
    const late = await seed({
      date: SUMMER_DATE,
      at: at('13:41'),
      close: '6480',
      created: '2026-11-06T22:20:00Z',
    });
    // In the window, but it carries a Schwab price.
    const priced = await seed({
      date: SUMMER_DATE,
      at: at('13:42'),
      close: '6480',
      created: BACKFILL_CREATED,
    });
    await pg.query(
      'UPDATE index_candles_1m SET spx_schwab_price = 6480 WHERE id = $1',
      [priced],
    );
    return { live, late, priced };
  }

  const summerArgs = (over = {}) =>
    refitArgs({ date: SUMMER_DATE, list: 'summer', ...over });

  it('selects only the backfill rows, and records no earlier manifest', async () => {
    const kept = await seedSummerDay();
    const before = await snapshot();
    const keptIds = Object.values(kept);
    expect(before).toHaveLength(396);

    const found = await findRefitManifest(makeSql(), summerArgs());
    expect(found).toMatchObject({
      ok: true,
      manifestPath: null,
      manifest: null,
    });
    expect(found.ids).toHaveLength(393);
    for (const id of keptIds) expect(found.ids).not.toContain(Number(id));

    const bars = stageRefit('SPX', SUMMER_DATE);
    const out = await processRefitDay(makeSql(), summerArgs());

    expect(out).toMatchObject({
      fetched: 396,
      stored: 393,
      closeRatio: 10.04,
      priorRatio: 10.03,
      fittedRatio: 10.045,
      replaced: 393,
    });
    const after = await snapshot();
    expect(after).toHaveLength(396);
    for (const id of keptIds) {
      expect(after.find((r) => r.id === String(id))).toEqual(
        before.find((r) => r.id === String(id)),
      );
    }
    const fresh = after.filter((r) => !keptIds.map(String).includes(r.id));
    for (const ratio of ratiosOf(fresh, bars)) {
      expect(ratio).toBeCloseTo(RATIOS.SPX.fitted, 9);
    }
    const manifest = readManifest(out.manifest);
    expect(manifest).toMatchObject({
      kind: 'refit',
      refitOf: null,
      selectedBy: 'summer-backfill',
      list: 'summer',
      committed: true,
    });
    expect(manifest.priorRatio).toBeCloseTo(10.03, 12);
    expect(manifest.backedUpIds).toEqual(found.ids);

    // From now on the date has a refit manifest, and the manifest rule applies.
    const next = await findRefitManifest(makeSql(), summerArgs());
    expect(next).toMatchObject({
      ok: true,
      manifestPath: out.manifest,
      manifest: { kind: 'refit' },
    });
    const again = await processRefitDay(makeSql(), summerArgs());
    expect(again).toMatchObject({
      alreadyRefit: true,
      manifestPath: out.manifest,
    });

    // The rows were written at 10.03, not at today's 10.04: --check passes.
    const check = await checkRefitDay(makeSql(), summerArgs());
    expect(check).toMatchObject({ ok: true, scaledShare: 1 });
  });

  it('after an undo selects the backfill rows again, and the new refit checks out', async () => {
    await seedSummerDay();
    const before = await snapshot();
    stageRefit('SPX', SUMMER_DATE);
    const first = await processRefitDay(makeSql(), summerArgs());
    await undoRepair(makeSql(), first.manifest);
    expect(await snapshot()).toEqual(before);

    // The first refit's rows are gone, so its manifest no longer qualifies.
    const found = await findRefitManifest(makeSql(), summerArgs());
    expect(found).toMatchObject({ ok: true, manifestPath: null });
    expect(found.ids).toHaveLength(393);

    const second = await processRefitDay(makeSql(), summerArgs());
    expect(second).toMatchObject({ replaced: 393, stored: 393 });
    expect(readManifest(second.manifest)).toMatchObject({
      refitOf: null,
      selectedBy: 'summer-backfill',
    });
    expect(await checkRefitDay(makeSql(), summerArgs())).toMatchObject({
      ok: true,
      scaledShare: 1,
    });
  });

  it('skips when the backfill window selects nothing', async () => {
    await seed({
      date: SUMMER_DATE,
      at: `${SUMMER_DATE}T13:40:00Z`,
      created: '2026-11-06T22:20:00Z',
    });

    const found = await findRefitManifest(makeSql(), summerArgs());

    expect(found.ok).toBe(false);
    expect(found.reason).toMatch(/no 11-06 backfill rows for SPX 2026-08-20/);
  });

  it('reads the NDX price column for NDX', async () => {
    const date = SUMMER_DATE;
    await seedMapped(
      mappedRows('NDX', date, RATIOS.NDX.prior),
      BACKFILL_CREATED,
    );
    // An NDX row carrying an NDX price is not the backfill's; an SPX price on
    // an NDX row does not matter.
    const priced = await pg.query(
      `UPDATE index_candles_1m SET ndx_schwab_price = 23000
       WHERE symbol = 'NDX' AND timestamp = $1::timestamptz
       RETURNING id`,
      [`${date}T13:40:00Z`],
    );
    const other = await pg.query(
      `UPDATE index_candles_1m SET spx_schwab_price = 6500
       WHERE symbol = 'NDX' AND timestamp = $1::timestamptz
       RETURNING id`,
      [`${date}T13:41:00Z`],
    );

    const found = await findRefitManifest(makeSql(), {
      symbol: 'NDX',
      date,
      backupDir: backupDirOf(),
    });

    expect(found.ok).toBe(true);
    expect(found.ids).toHaveLength(395);
    expect(found.ids).not.toContain(priced.rows[0].id);
    expect(found.ids).toContain(other.rows[0].id);
  });

  it('is refit only: the plain repair refuses the list', async () => {
    await seedSummerDay();
    await seedSettlement(SUMMER_DATE, '6500.00');
    const before = await snapshot();
    const sql = makeSql();

    const res = await repairDay(
      sql,
      repairArgs({
        date: SUMMER_DATE,
        list: 'summer',
        rows: mappedRows('SPX', SUMMER_DATE, RATIOS.SPX.fitted),
      }),
    );

    expect(res.skipped).toMatch(/summer list is for --refit only/);
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual([]);

    // The whole worker refuses it too, after a day that would pass.
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'ok',
      rows: refitBars('SPX', SUMMER_DATE),
    });
    await expect(
      processRepairDay(makeSql(), {
        symbol: 'SPX',
        date: SUMMER_DATE,
        list: 'summer',
        closes: schwabCloses(SUMMER_DATE),
        uwKey: 'uw-key',
        waitForSlot: vi.fn(),
        backupDir: backupDirOf(),
        apply: true,
      }),
    ).rejects.toThrow(/summer list is for --refit only/);
    expect(await snapshot()).toEqual(before);
  });
});

describe('undoing a refit', () => {
  it('restores the prior rows exactly, id and created_at included', async () => {
    await seedPlaceholderDay();
    const live = await seed({
      at: '2026-03-26T13:40:00Z',
      created: '2026-11-25T14:00:00Z',
    });
    await repairedDay();
    const before = await snapshot();
    stageRefit('SPX', SPX_DATE);
    const refit = await processRefitDay(makeSql(), refitArgs());
    expect(await snapshot()).not.toEqual(before);

    const undone = await undoRepair(makeSql(), refit.manifest);

    expect(undone).toEqual({ restored: 395, removed: 395 });
    expect(await snapshot()).toEqual(before);
    // The live row was never part of the refit.
    expect(before.some((r) => r.id === String(live))).toBe(true);
  });

  it('then a refit again: the prior manifest qualifies, and the new refit checks out', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const first = await processRefitDay(makeSql(), refitArgs());
    await undoRepair(makeSql(), first.manifest);

    const found = await findRefitManifest(makeSql(), refitArgs());
    expect(found).toMatchObject({
      ok: true,
      manifestPath: repaired.manifest,
    });
    expect(found.manifest.kind).toBeUndefined();

    const second = await processRefitDay(makeSql(), refitArgs());
    expect(second).toMatchObject({ replaced: 396, stored: 396 });
    expect(readManifest(second.manifest).refitOf).toBe(repaired.manifest);
    expect(await checkRefitDay(makeSql(), refitArgs())).toMatchObject({
      ok: true,
      scaledShare: 1,
    });
  });

  it('describes a refit as a refit, from the files only', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const refit = await processRefitDay(makeSql(), refitArgs());

    const text = (await describeUndo(refit.manifest)).join('\n');

    expect(text).toMatch(/SPX 2026-03-26, refit of list spx-repair/);
    expect(text).toMatch(/remove 396 inserted rows \(by id\)/);
    expect(text).toMatch(/restore 396 backed-up rows/);
  });
});

describe('checkRefitDay', () => {
  const check = (over = {}) =>
    checkRefitDay(makeSql(), {
      symbol: 'SPX',
      date: SPX_DATE,
      closes: refitCloses(SPX_DATE),
      backupDir: backupDirOf(),
      ...over,
    });

  async function refitDayApplied() {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    return processRefitDay(makeSql(), refitArgs());
  }

  it('passes a refit day, and writes nothing', async () => {
    await refitDayApplied();
    const before = await snapshot();
    const files = filesIn(backupDirOf());
    const sql = makeSql();

    const out = await checkRefitDay(sql, {
      symbol: 'SPX',
      date: SPX_DATE,
      closes: refitCloses(SPX_DATE),
      backupDir: backupDirOf(),
    });

    expect(out).toMatchObject({ ok: true, regular: 390, scaledShare: 1 });
    expect(out.dh).toBeCloseTo(0, 9);
    expect(out.dl).toBeCloseTo(0, 9);
    expect(out.reason).toBeUndefined();
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual(files);
  });

  it('passes an NDX day refit like the rest, from an insert-only date', async () => {
    await repairedDay({ symbol: 'NDX', date: GAP_DATE, list: 'gap' });
    stageRefit('NDX', GAP_DATE);
    const args = refitArgs({ symbol: 'NDX', date: GAP_DATE, list: 'gap' });

    const out = await processRefitDay(makeSql(), args);

    expect(out).toMatchObject({
      fetched: 396,
      stored: 396,
      priorRatio: 40.95,
      fittedRatio: 41.02,
      replaced: 396,
    });
    expect(
      await checkRefitDay(makeSql(), {
        symbol: 'NDX',
        date: GAP_DATE,
        closes: args.closes,
        backupDir: backupDirOf(),
      }),
    ).toMatchObject({ ok: true, regular: 390, scaledShare: 1 });
  });

  it('fails a day whose rows were written at the close ratio: the scaled share is 0', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const { args, found, prepared } = await readyRefit();
    // The manifest says fitted; the rows go in at the close ratio.
    const atClose = {
      ...prepared,
      rows: mappedRows('SPX', SPX_DATE, RATIOS.SPX.close),
    };
    await refitDay(makeSql(), refitCall(args, found, atClose));

    // The daily range matches what was written, so only the share objects.
    const out = await check({
      closes: refitCloses(SPX_DATE, { rangeRatio: RATIOS.SPX.close }),
    });

    expect(out).toMatchObject({ ok: false, scaledShare: 0, regular: 390 });
    expect(out.reason).toMatch(/0 of 396 stored rows/);
    expect(out.reason).not.toMatch(/Schwab's daily range/);
  });

  it("fails a day whose stored high and low miss Schwab's the same way", async () => {
    await refitDayApplied();

    // Schwab's range sits 5 pt above both stored extremes.
    const out = await check({ closes: refitCloses(SPX_DATE, { shift: 5 }) });

    expect(out.ok).toBe(false);
    expect(out.dh).toBeCloseTo(-5, 9);
    expect(out.dl).toBeCloseTo(-5, 9);
    expect(out.scaledShare).toBe(1);
    expect(out.reason).toMatch(/misses Schwab's daily range on one side/);
    expect(out.reason).not.toMatch(/stored rows/);
  });

  it('reads the stored rows, not the manifest: a changed day fails the level check', async () => {
    await refitDayApplied();
    await pg.query(
      `UPDATE index_candles_1m SET high = high + 5, low = low + 5
       WHERE symbol = 'SPX' AND market_time = 'r'`,
    );

    const out = await check();

    expect(out.ok).toBe(false);
    expect(out.dh).toBeCloseTo(5, 6);
    expect(out.dl).toBeCloseTo(5, 6);
    expect(out.reason).toMatch(/misses Schwab's daily range on one side/);
  });

  it('reads only the regular rows for the level check', async () => {
    await refitDayApplied();
    await pg.query(
      `UPDATE index_candles_1m SET high = high + 500, low = low - 500
       WHERE symbol = 'SPX' AND market_time <> 'r'`,
    );

    const out = await check();

    expect(out).toMatchObject({ ok: true, regular: 390 });
    expect(out.dh).toBeCloseTo(0, 9);
  });

  it('fails a date with no refit manifest, whether it has a repair manifest or none', async () => {
    await seedPlaceholderDay();
    const repaired = await repairedDay();

    const plain = await check();
    expect(plain).toMatchObject({
      ok: false,
      dh: null,
      dl: null,
      scaledShare: null,
    });
    expect(plain.reason).toMatch(/SPX 2026-03-26 has no refit manifest/);

    const none = await check({ date: '2026-03-25' });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/no manifest for SPX 2026-03-25/);
    expect(repaired.manifest).toBeDefined();
  });

  it("fails a summer date that was not refit: its rows are the backfill's", async () => {
    await seedMapped(
      mappedRows('SPX', SUMMER_DATE, RATIOS.SPX.prior),
      BACKFILL_CREATED,
    );

    const out = await check({
      date: SUMMER_DATE,
      closes: refitCloses(SUMMER_DATE),
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/has no refit manifest/);
    expect(out.reason).toMatch(/11-06 backfill/);
  });

  it('fails closed when the backup cannot be read, or Schwab has no range', async () => {
    const refit = await refitDayApplied();

    const noRange = await check({
      closes: refitCloses(SPX_DATE, { noRange: true }),
    });
    expect(noRange.ok).toBe(false);
    expect(noRange.reason).toMatch(/no extremes for SPX on 2026-03-26/);
    expect(noRange.scaledShare).toBe(1);

    rmSync(readManifest(refit.manifest).backup);
    const noBackup = await check();
    expect(noBackup.ok).toBe(false);
    expect(noBackup.reason).toMatch(/cannot read the backup of /);
  });

  it('fails a refit manifest with no usable ratio or priorRatio', async () => {
    const refit = await refitDayApplied();
    const manifest = readManifest(refit.manifest);
    for (const over of [
      { priorRatio: 'ten' },
      { priorRatio: 0 },
      { ratio: null },
      { ratio: -10.045 },
    ]) {
      writeFileSync(refit.manifest, JSON.stringify({ ...manifest, ...over }));

      const out = await check();

      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/no usable ratio and priorRatio/);
      expect(out.scaledShare).toBeNull();
    }
  });

  it('fails when no stored row pairs with a backed-up row', async () => {
    await refitDayApplied();
    // Every stored minute moves a day on: same rows, no minute in common.
    await pg.query(
      `UPDATE index_candles_1m SET timestamp = timestamp + interval '1 day'
       WHERE symbol = 'SPX'`,
    );

    const out = await check();

    expect(out.ok).toBe(false);
    expect(out.scaledShare).toBeNull();
    expect(out.reason).toMatch(/no stored row pairs with a backed-up row/);
  });

  describe('the share and its tolerance', () => {
    /** 100 summer rows, refit by hand; stored closes scaled by `scale(i)`. */
    async function hundredRowRefit(scale) {
      const base = Date.parse(`${SUMMER_DATE}T13:00:00.000Z`);
      const etfs = Array.from({ length: 100 }, (_, i) => 650 + i / 100);
      const rowsAt = (ratio) =>
        etfs.map((etf, i) =>
          newRow(
            'SPX',
            SUMMER_DATE,
            new Date(base + i * 60_000).toISOString(),
            etf * ratio,
          ),
        );
      await seedMapped(rowsAt(RATIOS.SPX.prior), BACKFILL_CREATED);
      const found = await findRefitManifest(makeSql(), summerArgs());
      const prepared = {
        ok: true,
        rows: rowsAt(RATIOS.SPX.fitted).map((row, i) => ({
          ...row,
          close: row.close * scale(i),
        })),
        ratio: RATIOS.SPX.fitted,
        closeRatio: RATIOS.SPX.close,
        source: 'tape',
        etfCloses: new Map(etfs.map((etf, i) => [base / 60_000 + i, etf])),
      };
      await refitDay(makeSql(), {
        symbol: 'SPX',
        date: SUMMER_DATE,
        list: 'summer',
        prepared,
        found,
        backupDir: backupDirOf(),
        apply: true,
      });
      // The range holds what was written: only the share is under test.
      const closes = refitCloses(SUMMER_DATE, {
        ranges: {
          SPX: {
            high: Math.max(...prepared.rows.map((r) => r.high)),
            low: Math.min(...prepared.rows.map((r) => r.low)),
          },
        },
      });
      return checkRefitDay(makeSql(), {
        symbol: 'SPX',
        date: SUMMER_DATE,
        closes,
        backupDir: backupDirOf(),
      });
    }
    const summerArgs = (over = {}) =>
      refitArgs({ date: SUMMER_DATE, list: 'summer', ...over });

    it('passes at exactly 99% of the pairs', async () => {
      const at99 = await hundredRowRefit((i) => (i === 0 ? 1.01 : 1));
      expect(at99).toMatchObject({ ok: true, scaledShare: 0.99 });
    });

    it('fails at 98% of the pairs', async () => {
      const at98 = await hundredRowRefit((i) => (i < 2 ? 1.01 : 1));
      expect(at98.ok).toBe(false);
      expect(at98.scaledShare).toBe(0.98);
      expect(at98.reason).toMatch(/98 of 100 stored rows/);
    });

    it('allows 1e-6 of relative error on a pair', async () => {
      const inside = await hundredRowRefit(() => 1 + 5e-7);
      expect(inside).toMatchObject({ ok: true, scaledShare: 1 });
    });

    it('fails a scale 2e-6 off', async () => {
      const outside = await hundredRowRefit(() => 1 + 2e-6);
      expect(outside).toMatchObject({ ok: false, scaledShare: 0 });
    });
  });
});

describe('processRefitDay', () => {
  it('refits a day end to end and returns the run-loop counts', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);

    const out = await processRefitDay(makeSql(), refitArgs());

    expect(Object.keys(out)).toEqual([
      'fetched',
      'stored',
      'closeRatio',
      'priorRatio',
      'fittedRatio',
      'matched',
      'scatter',
      'dh',
      'dl',
      'replaced',
      'dropped',
      'uncovered',
      'manifest',
    ]);
    expect(out).toMatchObject({
      fetched: 396,
      stored: 396,
      closeRatio: 10.04,
      priorRatio: 10.03,
      fittedRatio: 10.045,
      matched: 390,
      scatter: 0,
      dh: 0,
      dl: 0,
      replaced: 396,
      dropped: 0,
      uncovered: 0,
    });
    expect(typeof out.manifest).toBe('string');
  });

  it('a dry run counts what would change, writes nothing, and prints one line', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    const files = filesIn(backupDirOf());
    stageRefit('SPX', SPX_DATE);
    const sql = makeSql();

    const out = await processRefitDay(sql, refitArgs({ apply: false }));

    expect(out).toMatchObject({
      fetched: 396,
      stored: 0,
      wouldReplace: 396,
      wouldInsert: 396,
    });
    expect(out.manifest).toBeUndefined();
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual(files);

    const lines = formatRunSummary(
      summarizeRun({
        days: [{ date: SPX_DATE, ok: true, value: out }],
        stoppedBy: null,
        notRun: [],
      }),
    );
    expect(lines).toContain(
      `  ${SPX_DATE}  fetched 396  stored 0  closeRatio 10.04  priorRatio 10.03  fittedRatio 10.045  matched 390  scatter 0  dh 0  dl 0  wouldReplace 396  wouldInsert 396  dropped 0  uncovered 0`,
    );
  });

  it('leaves an already refit date alone: no UW call, no write, not a failure', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    const first = await processRefitDay(makeSql(), refitArgs());
    const afterFirst = await snapshot();
    const files = filesIn(backupDirOf());
    mocks.fetchUwCandles.mockClear();
    const sql = makeSql();

    const again = await processRefitDay(sql, refitArgs());

    expect(again).toEqual({
      fetched: 0,
      stored: 0,
      alreadyRefit: true,
      manifestPath: first.manifest,
    });
    expect(mocks.fetchUwCandles).not.toHaveBeenCalled();
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(afterFirst);
    expect(filesIn(backupDirOf())).toEqual(files);
    // The run loop counts it as a day done, with the manifest on its line.
    const summary = summarizeRun({
      days: [{ date: SPX_DATE, ok: true, value: again }],
      stoppedBy: null,
      notRun: [],
    });
    expect(summary).toMatchObject({ succeeded: 1, exitCode: 0 });
    expect(summary.failedDays).toEqual([]);
    const line = formatRunSummary(summary).find((l) =>
      l.startsWith(`  ${SPX_DATE}`),
    );
    expect(line).toMatch(
      /^ {2}2026-03-26 {2}fetched 0 {2}stored 0 {2}alreadyRefit true {2}manifestPath .+\.manifest\.json$/,
    );
  });

  it('fails the day with a DayFailure when there is no manifest to refit', async () => {
    stageRefit('SPX', SPX_DATE);
    const failure = await processRefitDay(makeSql(), refitArgs()).catch(
      (e) => e,
    );

    expect(failure).toBeInstanceOf(DayFailure);
    expect(failure.kind).toBe('other');
    expect(failure.message).toMatch(/no manifest for SPX 2026-03-26/);
    expect(mocks.fetchUwCandles).not.toHaveBeenCalled();
  });

  it('fails the day with a DayFailure, and the UW kind, when the day cannot be prepared', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    const files = filesIn(backupDirOf());

    // No price file.
    const noFile = await processRefitDay(makeSql(), refitArgs()).catch(
      (e) => e,
    );
    expect(noFile).toBeInstanceOf(DayFailure);
    expect(noFile.kind).toBe('other');
    expect(noFile.message).toMatch(/no price file/);

    // A UW error keeps its kind.
    stageRefit('SPX', SPX_DATE);
    mocks.fetchUwCandles.mockResolvedValue({
      kind: 'error',
      status: 'http_429',
      detail: 'slow down',
    });
    await expect(processRefitDay(makeSql(), refitArgs())).rejects.toMatchObject(
      { name: 'DayFailure', kind: 'uw_http_429' },
    );

    expect(await snapshot()).toEqual(before);
    expect(filesIn(backupDirOf())).toEqual(files);
  });

  it('fails the day with a DayFailure when the refit itself skips it', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    const before = await snapshot();
    stageRefit('SPX', SPX_DATE, {
      bars: refitBars('SPX', SPX_DATE).filter(
        (bar) => bar.start_time !== `${SPX_DATE}T13:27:00.000Z`,
      ),
    });
    const sql = makeSql();

    const failure = await processRefitDay(sql, refitArgs()).catch((e) => e);

    expect(failure).toBeInstanceOf(DayFailure);
    expect(failure.kind).toBe('other');
    expect(failure.message).toMatch(/^would leave 1 minute empty/);
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('propagates a database failure instead of reporting a skipped day', async () => {
    // A summer date reads the table to find its rows.
    const sql = Object.assign(
      () => ({ then: (_ok, fail) => fail(new Error('connection lost')) }),
      { transaction: vi.fn() },
    );
    await expect(
      processRefitDay(sql, refitArgs({ date: SUMMER_DATE, list: 'summer' })),
    ).rejects.toThrow('connection lost');
  });
});

describe('processCheckDay', () => {
  const checkArgs = (over = {}) => ({
    symbol: 'SPX',
    date: SPX_DATE,
    closes: refitCloses(SPX_DATE),
    backupDir: backupDirOf(),
    ...over,
  });

  it('returns the run-loop counts and the measures of a refit day', async () => {
    await seedPlaceholderDay();
    await repairedDay();
    stageRefit('SPX', SPX_DATE);
    await processRefitDay(makeSql(), refitArgs());

    const out = await processCheckDay(makeSql(), checkArgs());

    expect(Object.keys(out)).toEqual([
      'fetched',
      'stored',
      'dh',
      'dl',
      'scaledShare',
    ]);
    expect(out).toEqual({
      fetched: 390,
      stored: 0,
      dh: 0,
      dl: 0,
      scaledShare: 1,
    });
    const lines = formatRunSummary(
      summarizeRun({
        days: [{ date: SPX_DATE, ok: true, value: out }],
        stoppedBy: null,
        notRun: [],
      }),
    );
    expect(lines).toContain(
      `  ${SPX_DATE}  fetched 390  stored 0  dh 0  dl 0  scaledShare 1`,
    );
  });

  it('fails the day with a DayFailure when the check fails', async () => {
    await seedPlaceholderDay();
    await repairedDay();

    const noManifest = await processCheckDay(makeSql(), checkArgs()).catch(
      (e) => e,
    );
    expect(noManifest).toBeInstanceOf(DayFailure);
    expect(noManifest.kind).toBe('other');
    expect(noManifest.message).toMatch(/has no refit manifest/);

    stageRefit('SPX', SPX_DATE);
    await processRefitDay(makeSql(), refitArgs());
    await expect(
      processCheckDay(
        makeSql(),
        checkArgs({ closes: refitCloses(SPX_DATE, { shift: 5 }) }),
      ),
    ).rejects.toThrow(/misses Schwab's daily range on one side/);
  });
});

// ── The backup folder ──────────────────────────────────────

describe('mainCheckoutDir', () => {
  it('finds the main checkout from a worktree', () => {
    expect(mainCheckoutDir('F:/dev/strike-calculator/.git')).toBe(
      'F:/dev/strike-calculator',
    );
  });

  it('takes git output with a newline and a trailing slash', () => {
    expect(mainCheckoutDir('F:/dev/strike-calculator/.git\n')).toBe(
      'F:/dev/strike-calculator',
    );
    expect(mainCheckoutDir('/home/me/repo/.git/')).toBe('/home/me/repo');
  });

  it('refuses a path that is not a .git directory', () => {
    expect(() => mainCheckoutDir('/home/me/repo/.git/worktrees/x')).toThrow(
      /not a \.git directory/,
    );
    expect(() => mainCheckoutDir('')).toThrow(/not a \.git directory/);
  });

  it('puts the backups under docs/tmp/spx-candle-repair', () => {
    expect(defaultBackupDir('/home/me/repo/.git')).toBe(
      path.join('/home/me/repo', 'docs', 'tmp', 'spx-candle-repair'),
    );
  });
});

// ── The guards ─────────────────────────────────────────────

describe('repairGuardRefusal', () => {
  afterEach(() => vi.useRealTimers());

  /** Only Date is faked; none of these tests touches pglite. */
  function atTime(iso) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  // The text, hours included, is the guards' own: the lib keeps no copy of
  // either, so a change to a window in backfill-cli or schwab-local reaches
  // the CLI. Each case names the guard the clock falls in.
  it.each([
    // 2026-10-29 is a Thursday, CDT (UTC-5).
    [
      '08:15 CT, as the market window opens',
      '2026-10-29T13:15:00Z',
      () => marketHoursRefusal({ allowMarketHours: false, offerFlag: false }),
    ],
    [
      '12:00 CT, mid-session',
      '2026-10-29T17:00:00Z',
      () => marketHoursRefusal({ allowMarketHours: false, offerFlag: false }),
    ],
    [
      '17:00 CT, past the close but inside the Schwab crons window',
      '2026-10-29T22:00:00Z',
      () => schwabCronsBusyRefusal({ offerFlag: false }),
    ],
  ])(
    'refuses at %s with its guard text, and names no flag this CLI rejects',
    (_label, iso, guardText) => {
      atTime(iso);

      const refusal = repairGuardRefusal();

      expect(refusal).toBe(guardText());
      expect(refusal).toEqual(expect.any(String));
      expect(refusal).not.toContain('--');
      expect(refusal).not.toContain('allow-market-hours');
    },
  );

  it.each([
    ['07:30 CT Thursday, before both windows', '2026-10-29T12:30:00Z'],
    ['18:00 CT Thursday, past both windows', '2026-10-29T23:00:00Z'],
    ['10:00 CT Saturday', '2026-10-31T15:00:00Z'],
  ])('lets a run start at %s', (_label, iso) => {
    atTime(iso);
    expect(repairGuardRefusal()).toBeNull();
  });
});

// ── The flags ──────────────────────────────────────────────

describe('parseRepairArgs', () => {
  it('takes a symbol and a list, as a dry run by default', () => {
    const plan = parseRepairArgs(['--symbol', 'SPX', '--list', 'spx-repair']);
    expect(plan).toMatchObject({
      mode: 'repair',
      symbol: 'SPX',
      list: 'spx-repair',
      apply: false,
    });
    expect(plan.dates).toEqual(REPAIR_LISTS['spx-repair']);
    expect(
      parseRepairArgs(['--apply', '--symbol', 'NDX', '--list', 'gap']),
    ).toMatchObject({ symbol: 'NDX', list: 'gap', apply: true });
  });

  it('takes one date and finds its list for that symbol', () => {
    expect(
      parseRepairArgs(['--symbol', 'NDX', '--date', '2026-04-20']),
    ).toMatchObject({ list: 'ndx-repair', dates: ['2026-04-20'] });
    expect(
      parseRepairArgs(['--symbol', 'SPX', '--date', '2026-09-21']),
    ).toMatchObject({ list: 'gap', dates: ['2026-09-21'] });
    expect(
      parseRepairArgs(['--symbol', 'NDX', '--date', '2026-03-10']),
    ).toMatchObject({ list: 'ndx-fill' });
  });

  it('takes an undo of a manifest, a dry run unless --apply comes with it', () => {
    expect(parseRepairArgs(['--undo', 'docs/tmp/x.manifest.json'])).toEqual({
      mode: 'undo',
      manifest: 'docs/tmp/x.manifest.json',
      apply: false,
    });
    expect(parseRepairArgs(['--undo', 'm.json', '--apply'])).toMatchObject({
      mode: 'undo',
      apply: true,
    });
  });

  it('takes --refit with its price folder, for any list including summer, as a dry run by default', () => {
    expect(
      parseRepairArgs([
        '--refit',
        '--spots',
        'docs/tmp/spots',
        '--symbol',
        'SPX',
        '--list',
        'summer',
      ]),
    ).toEqual({
      mode: 'refit',
      symbol: 'SPX',
      list: 'summer',
      dates: REPAIR_LISTS.summer,
      apply: false,
      spots: 'docs/tmp/spots',
    });
    expect(
      parseRepairArgs([
        '--symbol',
        'NDX',
        '--date',
        '2026-08-20',
        '--refit',
        '--spots',
        's',
        '--apply',
      ]),
    ).toMatchObject({
      mode: 'refit',
      list: 'summer',
      dates: ['2026-08-20'],
      apply: true,
    });
    expect(
      parseRepairArgs([
        '--refit',
        '--spots',
        's',
        '--symbol',
        'SPX',
        '--date',
        '2026-03-26',
      ]),
    ).toMatchObject({ list: 'spx-repair', dates: ['2026-03-26'] });
  });

  it('takes --check on a list or a date, which writes nothing and has no --apply', () => {
    expect(
      parseRepairArgs(['--check', '--symbol', 'NDX', '--list', 'summer']),
    ).toEqual({
      mode: 'check',
      symbol: 'NDX',
      list: 'summer',
      dates: REPAIR_LISTS.summer,
    });
    expect(
      parseRepairArgs(['--check', '--symbol', 'SPX', '--date', '2026-09-21']),
    ).toMatchObject({ mode: 'check', list: 'gap', dates: ['2026-09-21'] });
  });

  it.each([
    [
      ['--refit', '--symbol', 'SPX', '--list', 'gap'],
      /--refit needs --spots <folder>/,
    ],
    [
      ['--spots', 's', '--symbol', 'SPX', '--list', 'gap'],
      /--spots needs --refit/,
    ],
    [
      ['--check', '--spots', 's', '--symbol', 'SPX', '--list', 'gap'],
      /--spots needs --refit/,
    ],
    [['--refit', '--spots'], /--spots needs the folder of the price files/],
    [
      ['--refit', '--spots', 's', '--undo', 'm.json'],
      /--undo takes only --apply/,
    ],
    [['--check', '--undo', 'm.json'], /--undo takes only --apply/],
    [
      [
        '--refit',
        '--check',
        '--spots',
        's',
        '--symbol',
        'SPX',
        '--list',
        'gap',
      ],
      /only one of --refit or --check/,
    ],
    [
      ['--check', '--apply', '--symbol', 'SPX', '--list', 'gap'],
      /--check writes nothing, so it takes no --apply/,
    ],
    [['--lottery-spots', '--refit'], /--lottery-spots takes only --apply/],
    [['--lottery-spots', '--check'], /--lottery-spots takes only --apply/],
    [['--lottery-spots', '--spots', 's'], /--lottery-spots takes only --apply/],
    [
      ['--refit', '--spots', 's', '--symbol', 'NDX', '--list', 'spx-repair'],
      /spx-repair is a list for SPX, not NDX/,
    ],
    [
      ['--check', '--symbol', 'SPX', '--date', '2026-04-03'],
      /2026-04-03 is not in any SPX list/,
    ],
    [['--refit', '--spots', 's', '--list', 'gap'], /--symbol is required/],
    [
      ['--symbol', 'SPX', '--list', 'summer'],
      /the summer list is for --refit only/,
    ],
    [
      ['--symbol', 'NDX', '--list', 'summer', '--apply'],
      /the summer list is for --refit only/,
    ],
    [
      ['--symbol', 'NDX', '--date', '2026-08-20'],
      /2026-08-20 is in the summer list, which is for --refit only/,
    ],
    [
      ['--symbol', 'SPX', '--date', '2026-07-22'],
      /2026-07-22 is in the summer list, which is for --refit only/,
    ],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRepairArgs(argv)).toThrow(message);
  });

  it.each([
    [[], /--symbol is required/],
    [['--symbol', 'ES', '--list', 'gap'], /--symbol must be SPX or NDX/],
    [['--symbol', 'SPX'], /one of --list or --date/],
    [
      ['--symbol', 'SPX', '--list', 'gap', '--date', '2026-09-21'],
      /only one of --list or --date/,
    ],
    [['--symbol', 'SPX', '--list', 'nope'], /unknown list nope/],
    [
      ['--symbol', 'NDX', '--list', 'spx-repair'],
      /spx-repair is a list for SPX, not NDX/,
    ],
    [
      ['--symbol', 'SPX', '--list', 'ndx-fill'],
      /ndx-fill is a list for NDX, not SPX/,
    ],
    [
      ['--symbol', 'SPX', '--date', '2026-04-03'],
      /2026-04-03 is not in any SPX list/,
    ],
    [
      ['--symbol', 'SPX', '--date', '2026-05-01'],
      /2026-05-01 is not in any SPX list/,
    ],
    [['--symbol', 'SPX', '--date', '2026-4-1'], /--date needs a YYYY-MM-DD/],
    [['--symbol', 'SPX', '--date'], /--date needs a YYYY-MM-DD/],
    [['--symbol', 'SPX', '--list'], /--list needs a list name/],
    [['--symbol'], /--symbol must be SPX or NDX/],
    [
      ['--symbol', 'SPX', '--list', 'gap', '--bogus'],
      /Unknown argument: --bogus/,
    ],
    [
      ['--symbol', 'SPX', '--symbol', 'NDX', '--list', 'gap'],
      /--symbol given twice/,
    ],
    [['--undo'], /--undo needs the path of a manifest/],
    [['--undo', '--apply'], /--undo needs the path of a manifest/],
    [['--undo', 'm.json', '--symbol', 'SPX'], /--undo takes only --apply/],
    [['--undo', 'm.json', '--list', 'gap'], /--undo takes only --apply/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRepairArgs(argv)).toThrow(message);
  });
});
