// @vitest-environment node

/**
 * REAL-SQL test of the gap-day lottery spot repair (lottery-spot-repair.mjs):
 * which periscope_lottery_fires rows are in scope, the same-session spot the
 * repair reads from the repaired SPX candles, the distance it recomputes from
 * event_strike, the backed-up one-transaction UPDATE, and the undo. The
 * statements run in pglite (real Postgres in WASM) on periscope_lottery_fires
 * (migration #172) and index_candles_1m (migrations #52, #54, #112-#114).
 *
 * Mocked at the module boundary: the file writes a test asks to fail or cut
 * short (node:fs/promises writeFile) and the file-name stamp a test pins
 * (stampOf). Everything else is real: the backup and manifest files go to a
 * temp directory per test, so "a failed backup write" is a real failed write.
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
import { marketHoursRefusal } from './backfill-cli.mjs';
import {
  REPAIR_LISTS,
  parseRepairArgs,
  undoRepair,
} from './index-candle-repair.mjs';
import { schwabCronsBusyRefusal } from './schwab-local.mjs';

const mocks = vi.hoisted(() => ({
  // The nth write of a *.manifest.json that fails (0: none fails), and how many
  // such writes the test has seen. The lib writes the manifest twice per run:
  // before the transaction, and again after the commit.
  failManifestWrite: 0,
  manifestWrites: 0,
  // A backup (*.jsonl) write that keeps only its first line: a write that
  // reports success and leaves a short file.
  shortBackupWrite: false,
  // The file-name stamp a test pins (null: the real one), so it can put a file
  // of that name in the way.
  stamp: null,
}));

// The run's file-name stamp, pinned when a test asks.
vi.mock('./index-candle-repair.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stampOf: (now) => mocks.stamp ?? actual.stampOf(now),
  };
});

// Real writes, except the ones a test asks to fail or cut short: the only way
// to make the write after a real commit fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: (file, ...rest) => {
      if (mocks.shortBackupWrite && String(file).endsWith('.jsonl')) {
        const [firstLine] = String(rest[0]).split('\n');
        return actual.writeFile(file, `${firstLine}\n`, ...rest.slice(1));
      }
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
  LOTTERY_SPOT_SCOPE,
  applyLotterySpots,
  describeUndoLotterySpots,
  lotterySpotLines,
  lotterySpotsGuardRefusal,
  manifestKind,
  planLotterySpots,
  repairLotterySpots,
  undoLotterySpots,
} from './lottery-spot-repair.mjs';

let pg;
let tmp;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const id of [52, 54, 112, 113, 114, 172]) await applyMigration(pg, id);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  mocks.failManifestWrite = 0;
  mocks.manifestWrites = 0;
  mocks.shortBackupWrite = false;
  mocks.stamp = null;
  await pg.query(`SET TimeZone = 'UTC'`);
  await pg.query('TRUNCATE periscope_lottery_fires RESTART IDENTITY');
  await pg.query('TRUNCATE index_candles_1m RESTART IDENTITY');
  tmp = mkdtempSync(path.join(tmpdir(), 'lottery-spot-repair-'));
});

afterEach(async () => {
  await pg.query(
    'ALTER TABLE periscope_lottery_fires DROP CONSTRAINT IF EXISTS reject_dist',
  );
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────

const GAP_DAY = '2026-09-22'; // EDT: the regular session is 13:30Z-19:59Z
const OPEN = '2026-09-22T13:30:00.000Z';
/** What a stale fire carries: the 09-21 12:18 close. */
const STALE_SPOT = 6650.5;
const SPOT_COLUMNS = ['spot_at_event', 'strike_dist', 'spot_txt', 'dist_txt'];

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

function addSeconds(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** One SPX (or other) one-minute bar; the close is text, so it is exact. */
async function seedBar({ symbol = 'SPX', date, at, close }) {
  await pg.query(
    `INSERT INTO index_candles_1m
       (symbol, date, timestamp, open, high, low, close, volume, market_time)
     VALUES ($1, $2::date, $3::timestamptz, $4::numeric, $4::numeric,
             $4::numeric, $4::numeric, 100, 'r')`,
    [symbol, date, at, String(close)],
  );
}

/** What the finder stored for a fire read against `spot`. */
function distFor(type, strike, spot) {
  return type === 'call_lottery' ? strike - spot : spot - strike;
}

/**
 * One stored fire, with every outcome column set to a value the repair must
 * leave alone. The stale spot and its distance are what the repair replaces.
 * Returns its id (text).
 */
async function seedFire({
  type = 'call_lottery',
  at,
  strike = 6720,
  trade = type === 'call_lottery' ? strike + 50 : strike - 50,
  spot = STALE_SPOT,
  dist = distFor(type, strike, spot),
}) {
  const { rows } = await pg.query(
    `INSERT INTO periscope_lottery_fires
       (fire_type, fire_time, expiry, event_strike, trade_strike,
        spot_at_event, strike_dist, greek_post, greek_delta, greek_lvl_rank,
        gex_dollars, entry_px, vix, v3_strict_pass, v4_badge, peak_px,
        peak_pct, peak_time, eod_close_px, realized_r_peak, realized_r_eod,
        outcome_locked)
     VALUES ($1, $2::timestamptz, $3::date, $4, $5, $6::numeric, $7::numeric,
             -1.5, 2.5, 0.95, 123456.7, 1.25, 17.25, true, true, 4.2, 3.4,
             $2::timestamptz + interval '20 minutes', 1.1, 2.3, -0.4, true)
     RETURNING id::text AS id`,
    [type, at, at.slice(0, 10), strike, trade, String(spot), String(dist)],
  );
  return rows[0].id;
}

/**
 * `count` call fires on GAP_DAY, one second apart from the open, all with
 * event_strike 6800 and the stale spot, and one SPX bar before them at 6700.
 */
async function seedManyFires(count) {
  await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
  await pg.query(
    `INSERT INTO periscope_lottery_fires
       (fire_type, fire_time, expiry, event_strike, trade_strike,
        spot_at_event, strike_dist, greek_post, greek_delta)
     SELECT 'call_lottery', $1::timestamptz + (i * interval '1 second'),
            $2::date, 6800, 6850, 6650.5, 149.5, -1, 1
     FROM generate_series(60, 60 + $3::int - 1) AS i`,
    [OPEN, GAP_DAY, count],
  );
}

/** Every column of every fire, plus the two repaired ones as exact text. */
async function snapshot() {
  const { rows } = await pg.query(
    `SELECT to_jsonb(f) || jsonb_build_object(
              'spot_txt', f.spot_at_event::text,
              'dist_txt', f.strike_dist::text) AS r
     FROM periscope_lottery_fires f
     ORDER BY f.id`,
  );
  return rows.map((row) => row.r);
}

/** A snapshot without the columns the repair is allowed to change. */
function untouchedColumns(rows) {
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of SPOT_COLUMNS) delete copy[column];
    return copy;
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function manifestFilesIn(dir) {
  return filesIn(dir)
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => path.join(dir, f));
}

/** The plan for the current table, and the apply of it. */
async function planAndApply(sql = makeSql(), backupDir = backupDirOf()) {
  const plan = await planLotterySpots(sql);
  return applyLotterySpots(sql, plan, { backupDir });
}

// ── The scope ──────────────────────────────────────────────

describe('LOTTERY_SPOT_SCOPE', () => {
  it('holds the 13 gap days after 09-21, and the 09-21 cut', () => {
    expect(LOTTERY_SPOT_SCOPE.dates).toEqual([
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-08',
      '2026-10-09',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(LOTTERY_SPOT_SCOPE.dates).toEqual(
      REPAIR_LISTS.gap.filter((d) => d !== '2026-09-21'),
    );
    expect(LOTTERY_SPOT_SCOPE.partial).toEqual({
      date: '2026-09-21',
      after: '2026-09-21T16:18:00Z',
    });
    expect(Object.isFrozen(LOTTERY_SPOT_SCOPE)).toBe(true);
    expect(Object.isFrozen(LOTTERY_SPOT_SCOPE.dates)).toBe(true);
    expect(Object.isFrozen(LOTTERY_SPOT_SCOPE.partial)).toBe(true);
  });
});

// ── planLotterySpots ───────────────────────────────────────

describe('planLotterySpots', () => {
  it('selects only gap-day fires and 09-21 after 16:18Z', async () => {
    const inScope = [
      '2026-09-21T16:18:01Z', // 09-21, one second after the cut
      '2026-09-21T19:00:00Z',
      '2026-09-22T00:30:00Z', // 09-21 20:30 ET: ET date 09-21, UTC date 09-22
      '2026-09-22T14:30:00Z',
      '2026-09-30T14:30:00Z',
      '2026-10-08T14:30:00Z',
      '2026-10-15T14:30:00Z',
      '2026-10-16T03:00:00Z', // 10-15 23:00 ET: ET date 10-15, UTC date 10-16
    ];
    const outOfScope = [
      '2026-09-18T14:30:00Z',
      '2026-09-21T14:30:00Z', // 09-21, before the cut
      '2026-09-21T16:18:00Z', // 09-21, exactly at the cut: its bar was real
      '2026-10-01T14:30:00Z', // the days between the two runs of the gap
      '2026-10-07T14:30:00Z',
      '2026-10-07T20:00:00Z', // 10-07 16:00 ET
      '2026-10-08T03:00:00Z', // 10-07 23:00 ET: UTC date 10-08, ET date 10-07
      '2026-10-16T14:00:00Z', // 10-16
      '2026-10-20T14:30:00Z',
    ];
    for (const date of [...LOTTERY_SPOT_SCOPE.dates, '2026-09-21']) {
      await seedBar({ date, at: `${date}T13:30:00Z`, close: 6700 });
      await seedBar({ date, at: `${date}T19:59:00Z`, close: 6701 });
    }
    for (const at of [...inScope, ...outOfScope]) await seedFire({ at });
    const before = await snapshot();

    const plan = await planLotterySpots(makeSql());

    expect(plan.fires.map((f) => f.fire_time)).toEqual(
      inScope.map((at) => new Date(at).toISOString()),
    );
    expect(plan.no_bar).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('reads the ET date whatever the session time zone', async () => {
    await seedBar({
      date: '2026-10-07',
      at: '2026-10-07T19:59:00Z',
      close: 6700,
    });
    await seedBar({
      date: '2026-10-08',
      at: '2026-10-08T13:30:00Z',
      close: 6710,
    });
    await seedFire({ at: '2026-10-07T20:00:00Z' }); // 10-07 ET, out
    await seedFire({ at: '2026-10-08T14:30:00Z' }); // 10-08 ET, in
    await pg.query(`SET TimeZone = 'Asia/Tokyo'`);

    const plan = await planLotterySpots(makeSql());

    expect(plan.fires.map((f) => f.fire_time)).toEqual([
      '2026-10-08T14:30:00.000Z',
    ]);
    expect(plan.fires[0].new_spot).toBe(6710);
  });

  it('uses the same-day bar, never an earlier day', async () => {
    // 09-22 has bars 13:30-13:34Z; 09-23 has none until 15:00Z.
    const closes = [6700, 6701, 6702, 6703, 6704];
    for (const [i, close] of closes.entries()) {
      await seedBar({ date: GAP_DAY, at: addSeconds(OPEN, i * 60), close });
    }
    await seedBar({ date: GAP_DAY, at: '2026-09-22T19:59:00Z', close: 6650 });
    await seedBar({
      date: '2026-09-23',
      at: '2026-09-23T15:00:00Z',
      close: 6600,
    });
    // A bar of another symbol, nearer the fire, is not the spot.
    await seedBar({
      symbol: 'NDX',
      date: GAP_DAY,
      at: '2026-09-22T13:33:20Z',
      close: 25_000,
    });
    const between = await seedFire({ at: '2026-09-22T13:33:30Z' });
    const onTheBar = await seedFire({
      at: '2026-09-22T13:34:00Z',
      strike: 6730,
    });
    // The hole: bars exist the day before and later the same day, not before.
    const hole = await seedFire({ at: '2026-09-23T14:00:00Z' });

    const plan = await planLotterySpots(makeSql());

    const spots = Object.fromEntries(plan.fires.map((f) => [f.id, f.new_spot]));
    expect(spots).toEqual({ [between]: 6703, [onTheBar]: 6704 });
    expect(plan.no_bar).toEqual([
      { id: hole, fire_time: '2026-09-23T14:00:00.000Z' },
    ]);
  });

  it('takes the bar of any market_time, and rounds its close to 4 places', async () => {
    await pg.query(
      `INSERT INTO index_candles_1m
         (symbol, date, timestamp, open, high, low, close, volume, market_time)
       VALUES ('SPX', $1::date, $2::timestamptz, 1, 1, 1, 6700.123456, 1, 'pr')`,
      [GAP_DAY, '2026-09-22T12:00:00Z'],
    );
    await seedFire({ at: '2026-09-22T12:05:00Z' });

    const plan = await planLotterySpots(makeSql());

    expect(plan.fires[0]).toMatchObject({ new_spot: 6700.1235 });
  });

  it('computes the distance from event_strike, not trade_strike', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    const call = await seedFire({
      type: 'call_lottery',
      at: '2026-09-22T14:00:00Z',
      strike: 6720,
      trade: 6770,
    });
    const put = await seedFire({
      type: 'put_lottery',
      at: '2026-09-22T14:10:00Z',
      strike: 6680,
      trade: 6630,
    });

    const plan = await planLotterySpots(makeSql());

    const byId = Object.fromEntries(plan.fires.map((f) => [f.id, f]));
    expect(byId[call]).toMatchObject({
      fire_type: 'call_lottery',
      event_strike: 6720,
      old_spot: STALE_SPOT,
      old_dist: 69.5,
      new_spot: 6700,
      new_dist: 20, // 6720 - 6700; from the trade strike it would be 70
      still_passes: true,
    });
    expect(byId[put]).toMatchObject({
      fire_type: 'put_lottery',
      event_strike: 6680,
      old_dist: -29.5,
      new_spot: 6700,
      new_dist: 20, // 6700 - 6680; from the trade strike it would be 70
      still_passes: true,
    });
  });

  it.each([
    ['a call exactly 15 pt out', 'call_lottery', 6715, '6700.0000', 15, true],
    [
      'a call a hair under 15',
      'call_lottery',
      6715,
      '6700.0001',
      14.9999,
      false,
    ],
    ['a call a hair over 15', 'call_lottery', 6715, '6699.9999', 15.0001, true],
    ['a call the spot has passed', 'call_lottery', 6700, '6710', -10, false],
    ['a call at the spot', 'call_lottery', 6700, '6700', 0, false],
    ['a put exactly 10 pt out', 'put_lottery', 6690, '6700', 10, true],
    ['a put a hair under 10', 'put_lottery', 6690, '6699.9999', 9.9999, false],
    ['a put a hair over 10', 'put_lottery', 6690, '6700.0001', 10.0001, true],
    ['a put the spot has passed', 'put_lottery', 6710, '6700', -10, false],
  ])('judges %s', async (_label, type, strike, close, dist, passes) => {
    await seedBar({ date: GAP_DAY, at: OPEN, close });
    await seedFire({ type, at: '2026-09-22T14:00:00Z', strike });

    const plan = await planLotterySpots(makeSql());

    expect(plan.fires[0]).toMatchObject({
      new_dist: dist,
      still_passes: passes,
    });
  });

  it('lists a fire with no same-day bar and plans nothing for it', async () => {
    const lonely = await seedFire({ at: '2026-09-22T14:00:00Z' });

    const plan = await planLotterySpots(makeSql());

    expect(plan.fires).toEqual([]);
    expect(plan.no_bar).toEqual([
      { id: lonely, fire_time: '2026-09-22T14:00:00.000Z' },
    ]);
  });

  it('propagates a database failure instead of planning nothing', async () => {
    const sql = Object.assign(
      () => ({ then: (_ok, fail) => fail(new Error('connection lost')) }),
      { transaction: vi.fn() },
    );
    await expect(planLotterySpots(sql)).rejects.toThrow('connection lost');
  });
});

// ── applyLotterySpots ──────────────────────────────────────

describe('applyLotterySpots', () => {
  it('updates the spot and distance in one transaction, backed up first', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    const call = await seedFire({ at: '2026-09-22T14:00:00Z', strike: 6720 });
    const put = await seedFire({
      type: 'put_lottery',
      at: '2026-09-22T14:10:00Z',
      strike: 6680,
    });
    const before = await snapshot();
    const sql = makeSql();

    const out = await planAndApply(sql);

    expect(out).toMatchObject({ in_scope: 2, updated: 2, no_longer_pass: 0 });
    expect(out.no_bar).toEqual([]);
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toMatch(/UPDATE periscope_lottery_fires/);

    const after = await snapshot();
    expect(after.map((r) => [r.spot_txt, r.dist_txt])).toEqual([
      ['6700.0000', '20.0000'],
      ['6700.0000', '20.0000'],
    ]);

    // The backup holds the old values exactly, as text, before the UPDATE.
    const [name] = filesIn(backupDirOf()).filter((f) => f.endsWith('.jsonl'));
    expect(name).toMatch(/^lottery-spots-\d{8}T\d{9}Z\.jsonl$/);
    const backup = readFileSync(path.join(backupDirOf(), name), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(backup).toEqual([
      { id: call, spot_at_event: '6650.5000', strike_dist: '69.5000' },
      { id: put, spot_at_event: '6650.5000', strike_dist: '-29.5000' },
    ]);
    expect(backup).toEqual(
      before.map((r) => ({
        id: String(r.id),
        spot_at_event: r.spot_txt,
        strike_dist: r.dist_txt,
      })),
    );

    const manifest = readJson(out.manifest);
    expect(manifest).toMatchObject({
      version: 1,
      kind: 'lottery-spots',
      backup: path.join(backupDirOf(), name),
      backedUpIds: [call, put],
      committed: true,
      updated: 2,
      noLongerPass: 0,
      noBar: [],
    });
  });

  it('leaves outcome columns, trade_strike, entry_px and every other row untouched', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedBar({
      date: '2026-09-18',
      at: '2026-09-18T13:30:00Z',
      close: 6500,
    });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({
      type: 'put_lottery',
      at: '2026-09-22T14:10:00Z',
      strike: 6680,
    });
    // An out-of-scope fire carries a stale-looking spot too; it stays.
    await seedFire({ at: '2026-09-18T14:00:00Z' });
    const before = await snapshot();

    await planAndApply();

    const after = await snapshot();
    expect(untouchedColumns(after)).toEqual(untouchedColumns(before));
    // The out-of-scope fire is whole, spot and distance included.
    const outOfScope = before.find((r) => r.fire_time.startsWith('2026-09-18'));
    expect(after.find((r) => r.id === outOfScope.id)).toEqual(outOfScope);
    // The two in-scope fires moved.
    expect(after.filter((r) => r.spot_txt === '6700.0000')).toHaveLength(2);
  });

  it('counts fires that no longer pass, keeps them, and updates their spot', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    const passes = await seedFire({ at: '2026-09-22T14:00:00Z', strike: 6720 });
    const tooClose = await seedFire({
      at: '2026-09-22T14:01:00Z',
      strike: 6710,
    });
    const passed = await seedFire({ at: '2026-09-22T14:02:00Z', strike: 6690 });
    const putTooClose = await seedFire({
      type: 'put_lottery',
      at: '2026-09-22T14:03:00Z',
      strike: 6695,
    });
    const noBar = await seedFire({ at: '2026-09-23T14:00:00Z' });
    const before = await snapshot();

    const out = await planAndApply();

    expect(out).toMatchObject({
      in_scope: 5,
      updated: 4,
      no_longer_pass: 3, // 6710 is 10 out (< 15), 6690 is below the spot, put 5
    });
    expect(out.no_bar).toEqual([
      { id: noBar, fire_time: '2026-09-23T14:00:00.000Z' },
    ]);
    // Nothing is deleted: every fire is still there, the failing ones moved.
    const after = await snapshot();
    expect(after.map((r) => String(r.id))).toEqual(
      before.map((r) => String(r.id)),
    );
    const byId = Object.fromEntries(after.map((r) => [String(r.id), r]));
    expect(byId[passes].dist_txt).toBe('20.0000');
    expect(byId[tooClose].dist_txt).toBe('10.0000');
    expect(byId[passed].dist_txt).toBe('-10.0000');
    expect(byId[putTooClose].dist_txt).toBe('5.0000');
    expect(readJson(out.manifest)).toMatchObject({
      noLongerPass: 3,
      noBar: [noBar],
    });
  });

  it('leaves a fire with no same-day bar unchanged and lists it', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    const moved = await seedFire({ at: '2026-09-22T14:00:00Z' });
    const hole = await seedFire({ at: '2026-09-23T14:00:00Z' });
    const before = await snapshot();

    const out = await planAndApply();

    expect(out).toMatchObject({ updated: 1 });
    expect(out.no_bar).toEqual([
      { id: hole, fire_time: '2026-09-23T14:00:00.000Z' },
    ]);
    const after = await snapshot();
    const holeBefore = before.find((r) => String(r.id) === hole);
    expect(after.find((r) => String(r.id) === hole)).toEqual(holeBefore);
    expect(after.find((r) => String(r.id) === moved).spot_txt).toBe(
      '6700.0000',
    );
    expect(readJson(out.manifest).backedUpIds).toEqual([moved]);
  });

  it.each([
    ['a spot already right with a wrong distance', { spot: 6700, dist: 0 }],
    ['a distance already right with a wrong spot', { spot: 6650.5, dist: 20 }],
  ])('changes a fire with %s', async (_label, stored) => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z', strike: 6720, ...stored });

    const out = await planAndApply();

    expect(out).toMatchObject({ in_scope: 1, updated: 1 });
    const [fire] = await snapshot();
    expect([fire.spot_txt, fire.dist_txt]).toEqual(['6700.0000', '20.0000']);
  });

  it('a second apply changes nothing and writes no files', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    // 10 pt out: it no longer passes, before and after the repair.
    await seedFire({ at: '2026-09-22T14:01:00Z', strike: 6710 });
    const first = await planAndApply();
    expect(first).toMatchObject({ in_scope: 2, updated: 2, no_longer_pass: 1 });
    const afterFirst = await snapshot();
    const filesAfterFirst = filesIn(backupDirOf());
    const sql = makeSql();

    const second = await planAndApply(sql);

    // Nothing changes, but the report still counts the fire that fails.
    expect(second).toMatchObject({
      in_scope: 2,
      updated: 0,
      no_longer_pass: 1,
    });
    expect(second.manifest).toBeUndefined();
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(afterFirst);
    expect(filesIn(backupDirOf())).toEqual(filesAfterFirst);
  });

  it('writes nothing when no fire changes, and needs no backup directory then', async () => {
    const sql = makeSql();
    const out = await applyLotterySpots(
      sql,
      { fires: [], no_bar: [] },
      { backupDir: undefined },
    );
    expect(out).toEqual({
      in_scope: 0,
      updated: 0,
      no_longer_pass: 0,
      no_bar: [],
    });
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('refuses a change with no backup directory, before any write', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const before = await snapshot();
    const sql = makeSql();

    await expect(
      applyLotterySpots(sql, await planLotterySpots(sql), {
        backupDir: undefined,
      }),
    ).rejects.toThrow(/no backup directory/);

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('applies in batches of at most 500 fires', async () => {
    await seedManyFires(1001);
    const sql = makeSql();

    const out = await planAndApply(sql);

    expect(out).toMatchObject({ in_scope: 1001, updated: 1001 });
    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(3);
    const sizes = statements.map((s) => s.params.map((p) => p.length));
    expect(sizes).toEqual([
      [500, 500, 500],
      [500, 500, 500],
      [1, 1, 1],
    ]);
    const { rows } = await pg.query(
      `SELECT count(*)::int AS n FROM periscope_lottery_fires
       WHERE spot_at_event = 6700 AND strike_dist = 100`,
    );
    expect(rows[0].n).toBe(1001);
  });

  it('a DB reject mid-batch rolls back every update', async () => {
    await seedManyFires(600);
    // The 551st fire (second batch) lands on a distance the table refuses.
    await pg.query(
      `UPDATE periscope_lottery_fires SET event_strike = 6823, trade_strike = 6873
       WHERE fire_time = $1::timestamptz`,
      [addSeconds(OPEN, 60 + 550)],
    );
    await pg.query(
      'ALTER TABLE periscope_lottery_fires ADD CONSTRAINT reject_dist CHECK (strike_dist <> 123)',
    );
    const before = await snapshot();
    const sql = makeSql();

    const error = await planAndApply(sql).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/the transaction failed/);
    expect(error.message).toMatch(/reject_dist/);
    expect(error.cause).toBeInstanceOf(Error);
    // Two statements ran in one transaction; neither batch survived.
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
    // The run left its files, and the manifest says nothing committed.
    const [manifestFile] = manifestFilesIn(backupDirOf());
    expect(readJson(manifestFile)).toMatchObject({
      committed: false,
      updated: null,
    });
    // An undo of it changes nothing.
    await pg.query(
      'ALTER TABLE periscope_lottery_fires DROP CONSTRAINT reject_dist',
    );
    await undoLotterySpots(makeSql(), manifestFile);
    expect(await snapshot()).toEqual(before);
  });

  it('a failed backup changes nothing', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const before = await snapshot();
    const blocker = path.join(tmp, 'not-a-directory');
    writeFileSync(blocker, 'a file where the backup folder should be');
    const sql = makeSql();

    // mkdir on a path that is a file: EEXIST (Windows, Linux) or ENOTDIR.
    await expect(planAndApply(sql, blocker)).rejects.toThrow(
      /EEXIST|ENOTDIR|not a directory/i,
    );

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(blocker, 'utf8')).toMatch(/a file where/);
  });

  it('a failed manifest write before the transaction changes nothing', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const before = await snapshot();
    mocks.failManifestWrite = 1;
    const sql = makeSql();

    await expect(planAndApply(sql)).rejects.toThrow(/ENOSPC/);

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('says so by name when the manifest cannot be rewritten after the commit, and the leftover manifest still undoes the run', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
    const original = await snapshot();
    // Write 1 is the manifest before the transaction; write 2 is the rewrite
    // after the commit.
    mocks.failManifestWrite = 2;

    const error = await planAndApply().catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(
      /^committed \(2 updated\) but the manifest .+\.manifest\.json could not be rewritten \(ENOSPC: no space left on device, write\); it still says committed: false, and --undo restores the backed-up values either way$/,
    );
    expect(error.cause).toMatchObject({ code: 'ENOSPC' });
    // The transaction did commit.
    expect((await snapshot()).map((r) => r.spot_txt)).toEqual([
      '6700.0000',
      '6700.0000',
    ]);
    const [manifestFile] = manifestFilesIn(backupDirOf());
    expect(readJson(manifestFile)).toMatchObject({
      committed: false,
      updated: null,
    });

    mocks.failManifestWrite = 0;
    await undoLotterySpots(makeSql(), manifestFile);
    expect(await snapshot()).toEqual(original);
  });

  it.each([
    [
      'its spot changed',
      'UPDATE periscope_lottery_fires SET spot_at_event = 1234.5',
    ],
    [
      'its distance changed',
      'UPDATE periscope_lottery_fires SET strike_dist = 12.5',
    ],
    ['it was deleted', 'DELETE FROM periscope_lottery_fires'],
  ])(
    'refuses a plan that is stale because %s, before any write',
    async (_label, change) => {
      await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
      const first = await seedFire({ at: '2026-09-22T14:00:00Z' });
      await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
      const sql = makeSql();
      const plan = await planLotterySpots(sql);
      // Another writer got to one of the two fires after the plan.
      await pg.query(`${change} WHERE id = $1::bigint`, [first]);
      const before = await snapshot();

      await expect(
        applyLotterySpots(sql, plan, { backupDir: backupDirOf() }),
      ).rejects.toThrow(
        new RegExp(`stale plan: 1 fire changed or vanished.*first id ${first}`),
      );

      expect(sql.transaction).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(filesIn(backupDirOf())).toEqual([]);
    },
  );

  it('names every stale fire in the count', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    const first = await seedFire({ at: '2026-09-22T14:00:00Z' });
    const second = await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
    const sql = makeSql();
    const plan = await planLotterySpots(sql);
    await pg.query(
      'UPDATE periscope_lottery_fires SET spot_at_event = 1234.5 WHERE id = $1::bigint',
      [first],
    );
    await pg.query(
      'DELETE FROM periscope_lottery_fires WHERE id = $1::bigint',
      [second],
    );

    await expect(
      applyLotterySpots(sql, plan, { backupDir: backupDirOf() }),
    ).rejects.toThrow(/stale plan: 2 fires changed or vanished/);
  });

  it('a backup that reads back short stops the run before the manifest and the update', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
    const before = await snapshot();
    mocks.shortBackupWrite = true;
    const sql = makeSql();

    await expect(planAndApply(sql)).rejects.toThrow(
      /does not read back as written/,
    );

    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(manifestFilesIn(backupDirOf())).toEqual([]);
  });

  it.each([
    ['backup', 'jsonl'],
    ['manifest', 'manifest.json'],
  ])(
    'never overwrites an existing %s file: the run stops, the table is untouched',
    async (_label, extension) => {
      await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
      await seedFire({ at: '2026-09-22T14:00:00Z' });
      const before = await snapshot();
      mocks.stamp = 'FIXED';
      mkdirSync(backupDirOf(), { recursive: true });
      const inTheWay = path.join(
        backupDirOf(),
        `lottery-spots-FIXED.${extension}`,
      );
      writeFileSync(inTheWay, 'precious\n');
      const sql = makeSql();

      await expect(planAndApply(sql)).rejects.toThrow(/EEXIST/);

      expect(readFileSync(inTheWay, 'utf8')).toBe('precious\n');
      expect(sql.transaction).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});

// ── repairLotterySpots ─────────────────────────────────────

describe('repairLotterySpots', () => {
  it('a dry run counts what would change and writes nothing', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z', strike: 6720 });
    await seedFire({ at: '2026-09-22T14:01:00Z', strike: 6710 });
    const hole = await seedFire({ at: '2026-09-23T14:00:00Z' });
    const before = await snapshot();
    const sql = makeSql();

    const out = await repairLotterySpots(sql, {
      apply: false,
      backupDir: backupDirOf(),
    });

    expect(out).toEqual({
      in_scope: 3,
      updated: 2,
      no_longer_pass: 1,
      no_bar: [{ id: hole, fire_time: '2026-09-23T14:00:00.000Z' }],
    });
    expect(sql.transaction).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(existsSync(backupDirOf())).toBe(false);
    expect(filesIn(tmp)).toEqual([]);
  });

  it('applies when asked, and reports the manifest', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });

    const out = await repairLotterySpots(makeSql(), {
      apply: true,
      backupDir: backupDirOf(),
    });

    expect(out).toMatchObject({ updated: 1 });
    expect(typeof out.manifest).toBe('string');
    expect((await snapshot())[0].spot_txt).toBe('6700.0000');
  });
});

// ── undoLotterySpots ───────────────────────────────────────

describe('undoLotterySpots', () => {
  it('restores the spot and distance exactly', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({
      type: 'put_lottery',
      at: '2026-09-22T14:10:00Z',
      strike: 6680,
    });
    const original = await snapshot();
    const applied = await planAndApply();
    expect(await snapshot()).not.toEqual(original);

    const undone = await undoLotterySpots(makeSql(), applied.manifest);

    expect(undone).toEqual({ restored: 2 });
    expect(await snapshot()).toEqual(original);
  });

  it('is idempotent: a second undo restores the same values', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const original = await snapshot();
    const applied = await planAndApply();
    await undoLotterySpots(makeSql(), applied.manifest);

    await expect(
      undoLotterySpots(makeSql(), applied.manifest),
    ).resolves.toEqual({ restored: 1 });
    expect(await snapshot()).toEqual(original);
  });

  it('runs in one transaction of batches of at most 500', async () => {
    await seedManyFires(501);
    const original = await snapshot();
    const applied = await planAndApply();
    const sql = makeSql();

    const undone = await undoLotterySpots(sql, applied.manifest);

    expect(undone).toEqual({ restored: 501 });
    const [statements] = sql.transaction.mock.calls[0];
    expect(statements).toHaveLength(2);
    expect(await snapshot()).toEqual(original);
  });

  it('runs no transaction for a manifest with nothing backed up', async () => {
    const backup = path.join(tmp, 'empty.jsonl');
    writeFileSync(backup, '');
    const manifestFile = path.join(tmp, 'empty.manifest.json');
    writeFileSync(
      manifestFile,
      JSON.stringify({
        version: 1,
        kind: 'lottery-spots',
        backup,
        backedUpIds: [],
        committed: true,
        updated: 0,
      }),
    );
    const sql = makeSql();

    await expect(undoLotterySpots(sql, manifestFile)).resolves.toEqual({
      restored: 0,
    });
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('changes nothing when an update in it is rejected', async () => {
    await seedManyFires(2);
    const applied = await planAndApply();
    const repaired = await snapshot();
    // The restored distance (149.5) is one the table now refuses.
    await pg.query(
      'ALTER TABLE periscope_lottery_fires ADD CONSTRAINT reject_dist CHECK (strike_dist <> 149.5)',
    );

    await expect(undoLotterySpots(makeSql(), applied.manifest)).rejects.toThrow(
      /reject_dist/,
    );

    expect(await snapshot()).toEqual(repaired);
  });

  it('refuses a manifest or backup it cannot read, before touching the table', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
    const applied = await planAndApply();
    const repaired = await snapshot();
    const manifest = readJson(applied.manifest);
    const bad = path.join(tmp, 'bad.manifest.json');

    await expect(undoLotterySpots(makeSql(), bad)).rejects.toThrow(/ENOENT/);

    writeFileSync(bad, 'not json');
    await expect(undoLotterySpots(makeSql(), bad)).rejects.toThrow(
      /not valid JSON/,
    );

    writeFileSync(bad, JSON.stringify({ ...manifest, version: 2 }));
    await expect(undoLotterySpots(makeSql(), bad)).rejects.toThrow(
      /not a lottery-spots repair manifest/,
    );

    // An id the table cannot take.
    writeFileSync(bad, JSON.stringify({ ...manifest, backedUpIds: ['abc'] }));
    await expect(undoLotterySpots(makeSql(), bad)).rejects.toThrow(
      /not a lottery-spots repair manifest/,
    );

    // A truncated backup: its last row is missing.
    const lines = readFileSync(manifest.backup, 'utf8').trim().split('\n');
    writeFileSync(manifest.backup, `${lines.slice(0, -1).join('\n')}\n`);
    await expect(undoLotterySpots(makeSql(), applied.manifest)).rejects.toThrow(
      /does not match/,
    );

    // A row of another fire.
    const other = JSON.parse(lines[0]);
    other.id = String(Number(other.id) + 1000);
    writeFileSync(
      manifest.backup,
      `${[JSON.stringify(other), ...lines.slice(1)].join('\n')}\n`,
    );
    await expect(undoLotterySpots(makeSql(), applied.manifest)).rejects.toThrow(
      /does not match/,
    );

    // A line that is not a backup row.
    writeFileSync(manifest.backup, '{"id": "1"}\n');
    await expect(undoLotterySpots(makeSql(), applied.manifest)).rejects.toThrow(
      /malformed/,
    );

    rmSync(manifest.backup);
    await expect(undoLotterySpots(makeSql(), applied.manifest)).rejects.toThrow(
      /ENOENT/,
    );

    expect(await snapshot()).toEqual(repaired);
  });

  it('refuses an index-candle manifest, and the candle undo refuses ours', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const applied = await planAndApply();
    const repaired = await snapshot();
    const candleManifest = path.join(tmp, 'SPX-2026-03-26.manifest.json');
    writeFileSync(
      candleManifest,
      JSON.stringify({
        version: 1,
        symbol: 'SPX',
        date: '2026-03-26',
        backup: path.join(tmp, 'SPX-2026-03-26.jsonl'),
        backedUpIds: [],
        insertedIds: [],
        marker: '2026-11-25 23:15:00+00',
        committed: true,
      }),
    );

    await expect(undoLotterySpots(makeSql(), candleManifest)).rejects.toThrow(
      /not a lottery-spots repair manifest/,
    );
    await expect(undoRepair(makeSql(), applied.manifest)).rejects.toThrow(
      /not an index-candle repair manifest/,
    );

    expect(await snapshot()).toEqual(repaired);
  });

  it('describes an undo without touching the database', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    await seedFire({ at: '2026-09-22T14:05:00Z', strike: 6730 });
    const applied = await planAndApply();

    const lines = await describeUndoLotterySpots(applied.manifest);

    expect(lines).toEqual([
      'periscope_lottery_fires spot repair, 2 fires backed up',
      '  restore their spot_at_event and strike_dist from ' +
        readJson(applied.manifest).backup,
    ]);
  });
});

// ── manifestKind ───────────────────────────────────────────

describe('manifestKind', () => {
  it('names the lottery manifest, and treats any other as an index-candle one', async () => {
    await seedBar({ date: GAP_DAY, at: OPEN, close: 6700 });
    await seedFire({ at: '2026-09-22T14:00:00Z' });
    const applied = await planAndApply();
    const candle = path.join(tmp, 'candle.manifest.json');
    writeFileSync(candle, JSON.stringify({ version: 1, symbol: 'SPX' }));
    const garbled = path.join(tmp, 'garbled.manifest.json');
    writeFileSync(garbled, 'not json');

    expect(await manifestKind(applied.manifest)).toBe('lottery-spots');
    expect(await manifestKind(candle)).toBe('index-candles');
    // The candle undo reports its own error for a file it cannot read.
    expect(await manifestKind(garbled)).toBe('index-candles');
    await expect(manifestKind(path.join(tmp, 'missing'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});

// ── The report ─────────────────────────────────────────────

describe('lotterySpotLines', () => {
  const noBar = [
    { id: '41', fire_time: '2026-09-23T14:00:00.000Z' },
    { id: '42', fire_time: '2026-09-23T14:10:00.000Z' },
  ];

  it('reads a dry run, each no_bar fire by id and fire_time', () => {
    expect(
      lotterySpotLines(
        { in_scope: 10, updated: 7, no_longer_pass: 2, no_bar: noBar },
        { apply: false },
      ),
    ).toEqual([
      '  in scope: 10 fires',
      '  would update: 7',
      '  no longer pass their filter (kept, not deleted): 2',
      '  no same-day SPX bar (left unchanged): 2',
      '    id 41  2026-09-23T14:00:00.000Z',
      '    id 42  2026-09-23T14:10:00.000Z',
    ]);
  });

  it('reads an apply, with the manifest', () => {
    expect(
      lotterySpotLines(
        {
          in_scope: 3,
          updated: 3,
          no_longer_pass: 0,
          no_bar: [],
          manifest: '/b/lottery-spots-1.manifest.json',
        },
        { apply: true },
      ),
    ).toEqual([
      '  in scope: 3 fires',
      '  updated: 3',
      '  no longer pass their filter (kept, not deleted): 0',
      '  no same-day SPX bar (left unchanged): 0',
      '  manifest: /b/lottery-spots-1.manifest.json',
    ]);
  });
});

// ── The guard ──────────────────────────────────────────────

describe('lotterySpotsGuardRefusal', () => {
  afterEach(() => vi.useRealTimers());

  /** Only Date is faked; none of these tests touches pglite. */
  function atTime(iso) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  it.each([
    ['08:15 CT, as the market window opens', '2026-10-29T13:15:00Z'],
    ['12:00 CT, mid-session', '2026-10-29T17:00:00Z'],
  ])('refuses at %s with the market-hours text, naming no flag', (_l, iso) => {
    atTime(iso);

    const refusal = lotterySpotsGuardRefusal();

    expect(refusal).toBe(
      marketHoursRefusal({ allowMarketHours: false, offerFlag: false }),
    );
    expect(refusal).toEqual(expect.any(String));
    expect(refusal).not.toContain('--');
  });

  it('does not apply the Schwab window: no token is touched', () => {
    // 17:00 CT Thursday: past the close, inside the Schwab crons' window.
    atTime('2026-10-29T22:00:00Z');
    expect(schwabCronsBusyRefusal({ offerFlag: false })).toEqual(
      expect.any(String),
    );
    expect(lotterySpotsGuardRefusal()).toBeNull();
  });

  it.each([
    ['07:30 CT Thursday, before the window', '2026-10-29T12:30:00Z'],
    ['15:30 CT Thursday, as the window closes', '2026-10-29T20:30:00Z'],
    ['10:00 CT Saturday', '2026-10-31T15:00:00Z'],
  ])('lets a run start at %s', (_label, iso) => {
    atTime(iso);
    expect(lotterySpotsGuardRefusal()).toBeNull();
  });
});

// ── The flag ───────────────────────────────────────────────

describe('parseRepairArgs --lottery-spots', () => {
  it('is a dry run unless --apply comes with it', () => {
    expect(parseRepairArgs(['--lottery-spots'])).toEqual({
      mode: 'lottery-spots',
      apply: false,
    });
    expect(parseRepairArgs(['--apply', '--lottery-spots'])).toEqual({
      mode: 'lottery-spots',
      apply: true,
    });
  });

  it.each([
    [['--lottery-spots', '--symbol', 'SPX']],
    [['--symbol', 'SPX', '--lottery-spots']],
    [['--lottery-spots', '--list', 'gap']],
    [['--lottery-spots', '--date', '2026-09-22']],
    [['--lottery-spots', '--undo', 'm.json']],
    [['--undo', 'm.json', '--lottery-spots']],
  ])('rejects %j: it takes only --apply', (argv) => {
    expect(() => parseRepairArgs(argv)).toThrow(
      /--lottery-spots takes only --apply/,
    );
  });

  it('still rejects an unknown flag next to it', () => {
    expect(() => parseRepairArgs(['--lottery-spots', '--bogus'])).toThrow(
      /Unknown argument: --bogus/,
    );
  });
});
