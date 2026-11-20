// @vitest-environment node

/**
 * REAL-SQL test of the split repair: the selection, the guarded batch UPDATE
 * with its nullable numeric[] element, the undo, and the two runs that wire
 * them to the candle fetch and the backup file. The unit test
 * (range-pos-split-repair.test.mjs) sees only the plain-data decisions; this
 * file runs the statements in pglite (real Postgres in WASM) on
 * lottery_finder_fires built by the real migrations #110 and #153.
 *
 * Mocked at the module boundary: the UW candle fetch (fetchDayCandles) and
 * the three node:fs/promises calls the backup uses, kept in an in-memory map
 * so no test writes to the repo's docs/tmp/.
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

import { applyMigration } from '../../api/__tests__/pglite-migrations';

const mocks = vi.hoisted(() => {
  const files = new Map();
  return {
    files,
    fetchDayCandles: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    // Honors flag 'wx' like fs: an existing path is an error, not an overwrite.
    writeFile: vi.fn(async (path, text, options) => {
      if (options?.flag === 'wx' && files.has(path)) {
        throw Object.assign(
          new Error(`EEXIST: file already exists, open '${path}'`),
          { code: 'EEXIST' },
        );
      }
      files.set(path, text);
    }),
    readFile: vi.fn(async (path) => {
      if (!files.has(path)) {
        throw Object.assign(new Error(`ENOENT: no such file ${path}`), {
          code: 'ENOENT',
        });
      }
      return files.get(path);
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
}));
vi.mock('./range-pos-backfill.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchDayCandles: mocks.fetchDayCandles,
}));

import {
  SPLIT_REPAIRS,
  applyInBatches,
  restoreInBatches,
  runRepair,
  runUndo,
  selectRepairRows,
} from './range-pos-split-repair.mjs';

let pg;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 110);
  await applyMigration(pg, 153);
  await pg.query(`SET TimeZone = 'UTC'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

/** The one method the script's neon handle is used through, spied. */
function makeSql() {
  return {
    query: vi.fn((text, params) => pg.query(text, params).then((r) => r.rows)),
  };
}

const CRWD = SPLIT_REPAIRS[0];
const SOXS = SPLIT_REPAIRS[1];

async function insertFire({ id, ticker, date, spot, old = null }) {
  const time = ticker === 'SOXS' ? '18:35:37' : '13:30:54';
  await pg.query(
    `INSERT INTO lottery_finder_fires (
       id, date, trigger_time_ct, entry_time_ct, option_chain_id,
       underlying_symbol, option_type, strike, expiry, dte,
       trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
       trigger_delta, trigger_ask_pct, trigger_window_size,
       trigger_window_prints, entry_price, open_interest, spot_at_first,
       alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
       range_pos_at_trigger
     ) VALUES (
       $1, $2::date, ($2 || 'T${time}Z')::timestamptz,
       ($2 || 'T${time}Z')::timestamptz, $6, $3, 'C', 100,
       $2::date, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, $4, 1, 'call_ask', 'AM_open',
       'A_intraday_0DTE', false, false, $5::numeric
     )`,
    [id, date, ticker, spot, old, `chain-${id}`],
  );
}

/** id -> stored range_pos as text (null for NULL). */
async function stored() {
  const { rows } = await pg.query(
    `SELECT id::text AS id, range_pos_at_trigger::text AS v
       FROM lottery_finder_fires ORDER BY id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

beforeEach(async () => {
  await pg.query('TRUNCATE lottery_finder_fires RESTART IDENTITY');
  mocks.files.clear();
  mocks.fetchDayCandles.mockReset();
  mocks.mkdir.mockClear();
  mocks.writeFile.mockClear();
  mocks.readFile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('selectRepairRows', () => {
  it("returns the ticker's pinned rows inside the window, window ends included, as the script reads them", async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-17',
      spot: 600,
      old: '1',
    }); // before
    await insertFire({
      id: '2',
      ticker: 'CRWD',
      date: '2026-05-18',
      spot: 620.49,
      old: '1',
    }); // first day
    await insertFire({
      id: '3',
      ticker: 'CRWD',
      date: '2026-07-01',
      spot: 640.1,
      old: '0.4567',
    }); // last day
    await insertFire({
      id: '4',
      ticker: 'CRWD',
      date: '2026-07-02',
      spot: 160,
      old: '0.5',
    }); // after
    await insertFire({
      id: '5',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: null,
    }); // NULL
    await insertFire({
      id: '6',
      ticker: 'SOXS',
      date: '2026-05-19',
      spot: 4,
      old: '0',
    }); // other ticker
    const rows = await selectRepairRows(makeSql(), CRWD);
    expect(rows).toEqual([
      {
        id: '2',
        ticker: 'CRWD',
        date: '2026-05-18',
        trigger_time_ct: '2026-05-18T13:30:54.000Z',
        spot: 620.49,
        old: '1',
      },
      {
        id: '3',
        ticker: 'CRWD',
        date: '2026-07-01',
        trigger_time_ct: '2026-07-01T13:30:54.000Z',
        spot: 640.1,
        old: '0.4567',
      },
    ]);
  });

  it('reads the stored value exactly, long decimals included', async () => {
    await insertFire({
      id: '1',
      ticker: 'SOXS',
      date: '2026-06-01',
      spot: 4,
      old: '0.71197718631178707',
    });
    const [row] = await selectRepairRows(makeSql(), SOXS);
    expect(row.old).toBe('0.71197718631178707');
  });
});

const batch = (id, next, old = '1') => ({ id, next, old });

describe('applyInBatches', () => {
  it('writes a repaired value and a blank (a NULL element), and skips a row changed since the read', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    });
    await insertFire({
      id: '2',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    });
    await insertFire({
      id: '3',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '0.3',
    }); // changed since the read
    await insertFire({
      id: '4',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    }); // not in the list
    const results = [];
    for await (const r of applyInBatches(makeSql(), [
      batch('1', '0.7119771863117871'),
      batch('2', null),
      batch('3', '0.5'), // its old says 1, but the row holds 0.3
    ])) {
      results.push(r);
    }
    expect(results).toEqual([{ size: 3, written: 2 }]);
    expect(await stored()).toEqual({
      1: '0.7119771863117871',
      2: null,
      3: '0.3',
      4: '1',
    });
  });

  it('matches a value of 0 or 1 stored with a different scale (numeric equality, not text)', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1.0000',
    });
    const results = [];
    for await (const r of applyInBatches(makeSql(), [batch('1', '0.5')])) {
      results.push(r);
    }
    expect(results).toEqual([{ size: 1, written: 1 }]);
    expect(await stored()).toEqual({ 1: '0.5' });
  });

  it('writes in batches of 500', async () => {
    await pg.query(
      `INSERT INTO lottery_finder_fires (
         id, date, trigger_time_ct, entry_time_ct, option_chain_id,
         underlying_symbol, option_type, strike, expiry, dte,
         trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
         trigger_delta, trigger_ask_pct, trigger_window_size,
         trigger_window_prints, entry_price, open_interest, spot_at_first,
         alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
         range_pos_at_trigger)
       SELECT g, '2026-05-19', '2026-05-19T13:30:54Z', '2026-05-19T13:30:54Z',
         'chain-' || g, 'CRWD', 'C', 100, '2026-05-19', 0, 1, 1, 1, 1, 1, 1, 1,
         1, 1, 620, 1, 'call_ask', 'AM_open', 'A_intraday_0DTE', false, false, 1
       FROM generate_series(1, 1001) AS g`,
    );
    const rows = Array.from({ length: 1_001 }, (_, i) =>
      batch(String(i + 1), '0.5'),
    );
    const sql = makeSql();
    const results = [];
    for await (const r of applyInBatches(sql, rows)) results.push(r);
    expect(results).toEqual([
      { size: 500, written: 500 },
      { size: 500, written: 500 },
      { size: 1, written: 1 },
    ]);
    expect(sql.query.mock.calls.map(([, params]) => params[0].length)).toEqual([
      500, 500, 1,
    ]);
    const { rows: counted } = await pg.query(
      `SELECT COUNT(*)::int AS n FROM lottery_finder_fires
        WHERE range_pos_at_trigger = 0.5`,
    );
    expect(counted[0].n).toBe(1_001);
  });

  it('stops at a DB failure, keeping what the earlier batches wrote and not trying the later ones', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    });
    await insertFire({
      id: '501',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    });
    const sql = makeSql();
    const real = sql.query.getMockImplementation();
    sql.query
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('syntax error near UPDATE'));
    const rows = [
      ...Array.from({ length: 500 }, (_, i) => batch(String(i + 1), '0.5')),
      batch('501', '0.5'),
      batch('502', '0.5'),
    ];
    const results = [];
    await expect(
      (async () => {
        for await (const r of applyInBatches(sql, rows)) results.push(r);
      })(),
    ).rejects.toThrow('syntax error near UPDATE');
    expect(results).toEqual([{ size: 500, written: 1 }]);
    expect(await stored()).toEqual({ 1: '0.5', 501: '1' });
    expect(sql.query).toHaveBeenCalledTimes(2);
  });
});

describe('restoreInBatches', () => {
  const back = (id, old) => ({ id, ticker: 'CRWD', old });

  it('puts the backed-up values back, a NULL included, and counts only rows that changed', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '0.7',
    }); // repaired
    await insertFire({
      id: '2',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: null,
    }); // blanked
    await insertFire({
      id: '3',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '1',
    }); // already at the backup
    await insertFire({
      id: '4',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '0.4',
    }); // not in the backup
    const rows = [back('1', '1'), back('2', '1'), back('3', '1')];
    const results = [];
    for await (const r of restoreInBatches(makeSql(), rows)) results.push(r);
    expect(results).toEqual([{ size: 3, written: 2 }]);
    expect(await stored()).toEqual({ 1: '1', 2: '1', 3: '1', 4: '0.4' });
  });

  it('can restore a NULL, and a second pass changes nothing', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '0.5',
    });
    const rows = [back('1', null)];
    const first = [];
    for await (const r of restoreInBatches(makeSql(), rows)) first.push(r);
    const second = [];
    for await (const r of restoreInBatches(makeSql(), rows)) second.push(r);
    expect(first).toEqual([{ size: 1, written: 1 }]);
    expect(second).toEqual([{ size: 1, written: 0 }]);
    expect(await stored()).toEqual({ 1: null });
  });

  it("does not restore a row of another ticker, whatever the backup's own label says", async () => {
    await insertFire({
      id: '1',
      ticker: 'AAPL',
      date: '2026-05-19',
      spot: 200,
      old: '0.7',
    }); // labelled CRWD in the backup
    await insertFire({
      id: '2',
      ticker: 'CRWD',
      date: '2026-05-19',
      spot: 620,
      old: '0.7',
    }); // really CRWD
    const results = [];
    for await (const r of restoreInBatches(makeSql(), [
      back('1', '1'),
      back('2', '1'),
    ])) {
      results.push(r);
    }
    expect(results).toEqual([{ size: 2, written: 1 }]);
    expect(await stored()).toEqual({ 1: '0.7', 2: '1' });
  });
});

// ── The two runs ───────────────────────────────────────────

const CRWD_DAY = '2026-05-19'; // UW answers
const CRWD_FAIL_DAY = '2026-05-20'; // UW answers 503
const SOXS_DAY = '2026-07-10'; // UW answers
const SOXS_EMPTY_DAY = '2026-06-01'; // UW has no candles

/** Pre-trigger candles on `date`, plus one after the trigger to be ignored. */
const candlesFor = (ticker, date) =>
  ticker === 'CRWD'
    ? [
        { start_time: `${date}T13:31:00Z`, high: '700', low: '600' },
        { start_time: `${date}T13:29:00Z`, high: '155.88', low: '153.25' },
      ]
    : [{ start_time: `${date}T18:34:00Z`, high: '43.9', low: '39.8' }];

function uwAnswers() {
  mocks.fetchDayCandles.mockImplementation(async (_key, ticker, date) => {
    if (date === CRWD_FAIL_DAY) {
      return { kind: 'error', status: 'http_503', detail: 'upstream down' };
    }
    if (date === SOXS_EMPTY_DAY) return { kind: 'empty' };
    return { kind: 'ok', candles: candlesFor(ticker, date) };
  });
}

async function seedWorld() {
  const fires = [
    // CRWD, a day UW answers: repaired, blanked, notArtifact
    ['1001', 'CRWD', CRWD_DAY, 620.49, '1'],
    ['1002', 'CRWD', CRWD_DAY, 100000, '1'],
    ['1003', 'CRWD', CRWD_DAY, 154.5, '0.4'],
    // CRWD, a day UW fails on: untouched, failed
    ['1004', 'CRWD', CRWD_FAIL_DAY, 620, '1'],
    // SOXS: a day UW answers, and a day it has no candles for
    ['2001', 'SOXS', SOXS_DAY, 4.0701, '0'],
    ['2002', 'SOXS', SOXS_EMPTY_DAY, 4, '0'],
    // Never selected: outside the window, another ticker, no value yet
    ['3001', 'CRWD', '2026-07-02', 160, '1'],
    ['3002', 'AAPL', CRWD_DAY, 200, '1'],
    ['3003', 'CRWD', CRWD_DAY, 620, null],
  ];
  for (const [id, ticker, date, spot, old] of fires) {
    await insertFire({ id, ticker, date, spot, old });
  }
}

const ORIGINAL = {
  1001: '1',
  1002: '1',
  1003: '0.4',
  1004: '1',
  2001: '0',
  2002: '0',
  3001: '1',
  3002: '1',
  3003: null,
};

function collect() {
  const lines = [];
  return { lines, say: (line = '') => lines.push(line) };
}

const BACKUP_FILE =
  'docs/tmp/range-pos-split-repair/backup-20261119T224501Z.json';

function frozenClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T22:45:01.234Z'));
}

describe('runRepair', () => {
  it('on a dry run plans every row, prints the plan and the samples, and writes nothing (no backup either)', async () => {
    await seedWorld();
    uwAnswers();
    const { lines, say } = collect();
    const sql = makeSql();

    const result = await runRepair({ sql, apiKey: 'k', apply: false, say });

    expect(await stored()).toEqual(ORIGINAL);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(sql.query.mock.calls.some(([text]) => /UPDATE/i.test(text))).toBe(
      false,
    );
    expect(result.exitCode).toBe(1); // two failed days
    expect(result.summaries).toMatchObject([
      {
        ticker: 'CRWD',
        rows: 4,
        repaired: 1,
        blanked: 1,
        notArtifact: 1,
        failed: 1,
        written: 2,
      },
      {
        ticker: 'SOXS',
        rows: 2,
        repaired: 1,
        blanked: 0,
        notArtifact: 0,
        failed: 1,
        written: 1,
      },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain(
      'CRWD 2026-05-19  rows 3 · repaired 1 · blanked 1 · notArtifact 1 · failed 0',
    );
    expect(text).toContain('CRWD 2026-05-20  rows 1');
    expect(text).toContain('failed 1 (UW http_503)');
    expect(text).toContain('SOXS 2026-06-01  rows 1');
    expect(text).toContain('failed 1 (UW empty)');
    expect(text).toContain('would write 2');
    expect(text).toContain('id 1001');
    expect(text).toContain('scaled 155.1225');
    expect(text).toContain('id 2001');
    expect(text).toContain('scaled 40.701');
    expect(text).toMatch(/http_503\s+1\b/);
  });

  it('calls UW once per ticker-day, with the key', async () => {
    await seedWorld();
    uwAnswers();
    await runRepair({
      sql: makeSql(),
      apiKey: 'the-key',
      apply: false,
      say: collect().say,
    });
    expect(
      mocks.fetchDayCandles.mock.calls
        .map(([key, ticker, date]) => `${key} ${ticker} ${date}`)
        .sort(),
    ).toEqual([
      'the-key CRWD 2026-05-19',
      'the-key CRWD 2026-05-20',
      'the-key SOXS 2026-06-01',
      'the-key SOXS 2026-07-10',
    ]);
  });

  it('on --apply writes the backup first, then repairs and blanks, leaving failed days and notArtifact rows alone', async () => {
    frozenClock();
    await seedWorld();
    uwAnswers();
    const { lines, say } = collect();
    const sql = makeSql();

    const result = await runRepair({ sql, apiKey: 'k', apply: true, say });

    const after = await stored();
    expect(Number(after['1001'])).toBeCloseTo(0.712, 3);
    expect(after['1002']).toBeNull(); // blanked
    expect(after['1003']).toBe('0.4'); // notArtifact
    expect(after['1004']).toBe('1'); // UW failed that day
    expect(Number(after['2001'])).toBeCloseTo(0.2198, 3);
    expect(after['2002']).toBe('0'); // UW had no candles
    expect(after['3001']).toBe('1'); // outside the window
    expect(after['3002']).toBe('1'); // another ticker
    expect(after['3003']).toBeNull();

    expect(result.exitCode).toBe(1);
    expect(result.summaries).toMatchObject([
      { ticker: 'CRWD', written: 2, changedSinceRead: 0 },
      { ticker: 'SOXS', written: 1, changedSinceRead: 0 },
    ]);
    expect(result.backupFile).toBe(BACKUP_FILE);

    // The backup lists every selected row (failed days too) with the old value.
    const backup = JSON.parse(mocks.files.get(BACKUP_FILE));
    expect(backup.createdAt).toBe('2026-11-19T22:45:01.234Z');
    expect(backup.rows.map((r) => [r.id, r.ticker, r.date, r.old])).toEqual([
      ['1001', 'CRWD', CRWD_DAY, '1'],
      ['1002', 'CRWD', CRWD_DAY, '1'],
      ['1003', 'CRWD', CRWD_DAY, '0.4'],
      ['1004', 'CRWD', CRWD_FAIL_DAY, '1'],
      ['2001', 'SOXS', SOXS_DAY, '0'],
      ['2002', 'SOXS', SOXS_EMPTY_DAY, '0'],
    ]);
    expect(backup.rows[0]).toMatchObject({
      trigger_time_ct: '2026-05-19T13:30:54.000Z',
      spot: 620.49,
    });

    // The backup was written before the first UPDATE.
    const firstUpdate = sql.query.mock.calls.findIndex(([text]) =>
      /UPDATE/i.test(text),
    );
    expect(mocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      sql.query.mock.invocationCallOrder[firstUpdate],
    );
    expect(lines.join('\n')).toContain(`backup: ${BACKUP_FILE}`);
    expect(lines.join('\n')).toContain('written 2');
  });

  it('exits 0 when every day answered', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: CRWD_DAY,
      spot: 620.49,
      old: '1',
    });
    uwAnswers();
    const result = await runRepair({
      sql: makeSql(),
      apiKey: 'k',
      apply: true,
      say: collect().say,
    });
    expect(result.exitCode).toBe(0);
    expect(Number((await stored())['1'])).toBeCloseTo(0.712, 3);
  });

  it('counts a row changed between the read and the write, and does not overwrite it', async () => {
    await insertFire({
      id: '1',
      ticker: 'CRWD',
      date: CRWD_DAY,
      spot: 620.49,
      old: '1',
    });
    uwAnswers();
    const sql = makeSql();
    const real = sql.query.getMockImplementation();
    // Another writer sets the row just before the UPDATE runs.
    sql.query.mockImplementation(async (text, params) => {
      if (/UPDATE/i.test(text)) {
        await pg.query(
          'UPDATE lottery_finder_fires SET range_pos_at_trigger = 0.9 WHERE id = 1',
        );
      }
      return real(text, params);
    });
    const result = await runRepair({
      sql,
      apiKey: 'k',
      apply: true,
      say: collect().say,
    });
    expect(result.summaries[0]).toMatchObject({
      written: 0,
      changedSinceRead: 1,
    });
    expect(await stored()).toEqual({ 1: '0.9' });
  });

  it('aborts before any write when the backup cannot be written', async () => {
    await seedWorld();
    uwAnswers();
    mocks.writeFile.mockRejectedValueOnce(
      new Error('EACCES: permission denied'),
    );
    const sql = makeSql();
    await expect(
      runRepair({ sql, apiKey: 'k', apply: true, say: collect().say }),
    ).rejects.toThrow('EACCES: permission denied');
    expect(await stored()).toEqual(ORIGINAL);
    expect(sql.query.mock.calls.some(([text]) => /UPDATE/i.test(text))).toBe(
      false,
    );
  });

  it('aborts before any write, and keeps the old file, when a backup of the same name already exists', async () => {
    frozenClock();
    await seedWorld();
    uwAnswers();
    mocks.files.set(BACKUP_FILE, 'the backup from an earlier run');
    const sql = makeSql();
    await expect(
      runRepair({ sql, apiKey: 'k', apply: true, say: collect().say }),
    ).rejects.toThrow(/EEXIST/);
    expect(mocks.files.get(BACKUP_FILE)).toBe('the backup from an earlier run');
    expect(await stored()).toEqual(ORIGINAL);
    expect(sql.query.mock.calls.some(([text]) => /UPDATE/i.test(text))).toBe(
      false,
    );
  });

  it('aborts before any write when the backup does not read back the same', async () => {
    await seedWorld();
    uwAnswers();
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, rows: [] }),
    );
    const sql = makeSql();
    await expect(
      runRepair({ sql, apiKey: 'k', apply: true, say: collect().say }),
    ).rejects.toThrow(/read-back does not match/);
    expect(await stored()).toEqual(ORIGINAL);
    expect(sql.query.mock.calls.some(([text]) => /UPDATE/i.test(text))).toBe(
      false,
    );
  });

  it('reports the progress and the backup path when a write fails, and rethrows', async () => {
    frozenClock();
    await seedWorld();
    uwAnswers();
    const sql = makeSql();
    const real = sql.query.getMockImplementation();
    sql.query.mockImplementation(async (text, params) => {
      if (/UPDATE/i.test(text)) throw new Error('connection lost');
      return real(text, params);
    });
    const { lines, say } = collect();
    await expect(
      runRepair({ sql, apiKey: 'k', apply: true, say }),
    ).rejects.toThrow('connection lost');
    const text = lines.join('\n');
    expect(text).toContain('write failed');
    expect(text).toContain(BACKUP_FILE);
    expect(await stored()).toEqual(ORIGINAL);
  });

  it('surfaces a failing selection read', async () => {
    const sql = {
      query: vi.fn().mockRejectedValue(new Error('relation missing')),
    };
    await expect(
      runRepair({ sql, apiKey: 'k', apply: false, say: collect().say }),
    ).rejects.toThrow('relation missing');
  });

  it('stops a run that finds nothing to repair without calling UW', async () => {
    const { lines, say } = collect();
    const result = await runRepair({
      sql: makeSql(),
      apiKey: 'k',
      apply: false,
      say,
    });
    expect(result.exitCode).toBe(0);
    expect(mocks.fetchDayCandles).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('0 rows selected');
  });
});

describe('runUndo', () => {
  async function repairedWorld() {
    frozenClock();
    await seedWorld();
    uwAnswers();
    await runRepair({
      sql: makeSql(),
      apiKey: 'k',
      apply: true,
      say: collect().say,
    });
    vi.useRealTimers();
  }

  it('puts every backed-up row back after an apply', async () => {
    await repairedWorld();
    expect(await stored()).not.toEqual(ORIGINAL);
    const { lines, say } = collect();

    const result = await runUndo({
      sql: makeSql(),
      backupPath: BACKUP_FILE,
      apply: true,
      say,
    });

    expect(await stored()).toEqual(ORIGINAL);
    expect(result.exitCode).toBe(0);
    expect(result.restored).toBe(2 + 1); // 1001, 1002 and 2001; the rest never moved
    expect(lines.join('\n')).toContain('restored 3');
  });

  it('is a dry run without --apply: it reports the plan and writes nothing', async () => {
    await repairedWorld();
    const before = await stored();
    const { lines, say } = collect();
    const sql = makeSql();

    const result = await runUndo({
      sql,
      backupPath: BACKUP_FILE,
      apply: false,
      say,
    });

    expect(await stored()).toEqual(before);
    expect(sql.query).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(lines.join('\n')).toContain('DRY RUN');
    expect(lines.join('\n')).toContain('6 rows listed');
  });

  it('never touches a ticker outside SPLIT_REPAIRS and says it rejected the id', async () => {
    await seedWorld();
    mocks.files.set(
      BACKUP_FILE,
      JSON.stringify({
        version: 1,
        rows: [
          { id: '3002', ticker: 'AAPL', old: '0.1' },
          { id: '1001', ticker: 'CRWD', old: '0.2' },
        ],
      }),
    );
    const { lines, say } = collect();

    const result = await runUndo({
      sql: makeSql(),
      backupPath: BACKUP_FILE,
      apply: true,
      say,
    });

    const after = await stored();
    expect(after['3002']).toBe('1'); // AAPL row left alone
    expect(after['1001']).toBe('0.2');
    expect(result.restored).toBe(1);
    expect(result.rejected).toBe(1);
    expect(lines.join('\n')).toContain(
      'rejected 1 row(s) of tickers outside SPLIT_REPAIRS',
    );
  });

  it('leaves a row alone when a hand-edited backup labels the id of an AAPL row as CRWD', async () => {
    await seedWorld();
    mocks.files.set(
      BACKUP_FILE,
      JSON.stringify({
        version: 1,
        rows: [
          { id: '3002', ticker: 'CRWD', old: '0.1' }, // really AAPL
          { id: '1001', ticker: 'CRWD', old: '0.2' },
        ],
      }),
    );

    const result = await runUndo({
      sql: makeSql(),
      backupPath: BACKUP_FILE,
      apply: true,
      say: collect().say,
    });

    const after = await stored();
    expect(after['3002']).toBe('1'); // AAPL row left alone
    expect(after['1001']).toBe('0.2');
    expect(result.restored).toBe(1);
  });

  it('fails on a missing file and on a backup it cannot read', async () => {
    await expect(
      runUndo({
        sql: makeSql(),
        backupPath: 'nope.json',
        apply: true,
        say: collect().say,
      }),
    ).rejects.toThrow(/ENOENT/);
    mocks.files.set('bad.json', '{"version": 2, "rows": []}');
    await expect(
      runUndo({
        sql: makeSql(),
        backupPath: 'bad.json',
        apply: true,
        say: collect().say,
      }),
    ).rejects.toThrow(/not a range_pos split-repair backup/);
  });

  it('surfaces a DB failure while restoring', async () => {
    await seedWorld();
    mocks.files.set(
      BACKUP_FILE,
      JSON.stringify({
        version: 1,
        rows: [{ id: '1001', ticker: 'CRWD', old: '0.2' }],
      }),
    );
    const sql = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    const { lines, say } = collect();
    await expect(
      runUndo({ sql, backupPath: BACKUP_FILE, apply: true, say }),
    ).rejects.toThrow('connection lost');
    expect(lines.join('\n')).toContain('undo failed after 0 rows restored');
  });
});
