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
import { DayFailure, formatRunSummary, summarizeRun } from './backfill-cli.mjs';

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

import {
  LIST_SYMBOLS,
  REPAIR_LISTS,
  checkMappedDay,
  defaultBackupDir,
  deleteSelection,
  describeUndo,
  mainCheckoutDir,
  parseRepairArgs,
  prepareDay,
  processRepairDay,
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
    });
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

  it.each([
    // 2026-10-29 is a Thursday, CDT (UTC-5).
    [
      '08:15 CT, as the market window opens',
      '2026-10-29T13:15:00Z',
      /08:15–15:30 CT/,
    ],
    ['12:00 CT, mid-session', '2026-10-29T17:00:00Z', /08:15–15:30 CT/],
    [
      '17:00 CT, past the close but inside the Schwab crons window',
      '2026-10-29T22:00:00Z',
      /13:00–22:59 UTC/,
    ],
  ])(
    'refuses at %s, and names no flag this CLI rejects',
    (_label, iso, window) => {
      atTime(iso);

      const refusal = repairGuardRefusal();

      expect(refusal).toMatch(window);
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
