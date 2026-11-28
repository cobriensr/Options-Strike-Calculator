// @vitest-environment node

/**
 * scripts/_lib/regime-0dte-backfill.ts, the logic of backfill-regime-0dte.ts.
 *
 * The candidate-day statement and the upsert run for real, against pglite
 * (Postgres in WASM): flow_regime_0dte_daily is built from the REAL migration
 * (#189) and the three source tables carry only the columns the day list reads.
 * The date range is SQL (a sargable CT-day bound on strike_iv_snapshots.ts), so
 * a mocked sql could only match its text; here the day list and the rows are
 * read back. The session runs in Asia/Tokyo, not Neon's UTC: nothing may depend
 * on the session time zone.
 *
 * The three regime readers (`getGexStrikes`, `getPutIvSeries`, `getCandles30`)
 * and the day-OHLC reader are mocked at their modules, as `loadDayContext` is in
 * the gamma backfill's pglite test: they are the cron's own readers, not the
 * code under test. The evaluator (`evaluateRegime0dte`) and the realized-outcome
 * maths run for real.
 */

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
  type MockInstance,
} from 'vitest';

const h = vi.hoisted(() => ({
  sql: undefined as unknown,
  getDb: vi.fn(),
  getGexStrikes: vi.fn(),
  getPutIvSeries: vi.fn(),
  getCandles30: vi.fn(),
  readDayOhlcFromPostgres: vi.fn(),
  // Runs `fn` once, with no backoff: the retry itself is db.ts's, and tested
  // there. The calls are recorded so a read that skips the wrapper shows.
  withDbRetry: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: h.getDb,
  withDbRetry: h.withDbRetry,
}));
vi.mock('../../api/_lib/regime-0dte-queries.js', () => ({
  getGexStrikes: h.getGexStrikes,
  getPutIvSeries: h.getPutIvSeries,
  getCandles30: h.getCandles30,
}));
vi.mock('../../api/_lib/postgres-day-summary.js', () => ({
  readDayOhlcFromPostgres: h.readDayOhlcFromPostgres,
}));

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';
import {
  parseArgs,
  runRegimeBackfill,
  UsageError,
} from './regime-0dte-backfill.js';

let pg: PGlite;
let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;
const originalDatabaseUrl = process.env.DATABASE_URL;

const run = (...argv: string[]): Promise<number> => runRegimeBackfill(argv);

const lines = (spy: MockInstance): string =>
  spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

/** The dates of the table rows the dry run or the apply printed, in order. */
const printedDates = (): string[] =>
  lines(log)
    .split('\n')
    .filter((line) => /^\d{4}-\d{2}-\d{2} {2}/.test(line))
    .map((line) => line.slice(0, 10));

const storedRows = async (): Promise<
  Array<{ date: string; gate: string; oc_ret_pct: number | null }>
> =>
  (
    await pg.query<{
      date: string;
      gate: string;
      oc_ret_pct: number | null;
    }>(
      `SELECT date::text AS date, gate, oc_ret_pct::float8 AS oc_ret_pct
       FROM flow_regime_0dte_daily ORDER BY date`,
    )
  ).rows;

const storedDates = async (): Promise<string[]> =>
  (await storedRows()).map((r) => r.date);

// ----------------------------------------------------------------------------
// The source tables. Summer dates are CDT (UTC-5): 08:31 CT = 13:31Z. The two
// December dates are CST (UTC-6): 08:31 CT = 14:31Z, and a CT day runs from
// 06:00Z to 05:59Z the next day, so a bound fixed at the summer offset moves.
//
//   07-21 (A)  complete
//   07-22 (B)  complete; its only put IV row is at 00:00 CT sharp (05:00Z)
//   07-23 (C)  complete; its only put IV row is at 23:59 CT (07-24 04:59Z)
//   07-24 (D)  no usable put IV: a SPXW call, a SPY put and a row the day
//              before at 23:59 CT (07-23's) do not count for it
//   07-27 (E)  gex only after 11:00 CT (the open window is < 11:00 CT)
//   07-28 (F)  SPX candles only outside the regular session
//   07-29 (H)  its put IV row is at 00:00 CT of 07-30, which is 07-30's
//   09-21 (G)  complete
//   12-01 (W)  complete; its only put IV row is at 23:59 CST (12-02 05:59Z)
//   12-02 (V)  complete; its only put IV row is at 00:00 CST sharp (06:00Z):
//              the first instant of 12-02, one minute after W's row on the
//              same UTC day
// ----------------------------------------------------------------------------

const SEED = `
  INSERT INTO gex_strike_0dte (date, timestamp) VALUES
    ('2026-07-21', '2026-07-21T13:31:00Z'),
    ('2026-07-22', '2026-07-22T13:31:00Z'),
    ('2026-07-23', '2026-07-23T13:31:00Z'),
    ('2026-07-24', '2026-07-24T13:31:00Z'),
    ('2026-07-27', '2026-07-27T16:30:00Z'),
    ('2026-07-28', '2026-07-28T13:31:00Z'),
    ('2026-07-29', '2026-07-29T13:31:00Z'),
    ('2026-09-21', '2026-09-21T13:31:00Z'),
    ('2026-12-01', '2026-12-01T14:31:00Z'),
    ('2026-12-02', '2026-12-02T14:31:00Z');
  INSERT INTO strike_iv_snapshots (ticker, side, ts) VALUES
    ('SPXW', 'put',  '2026-07-21T13:31:00Z'),
    ('SPXW', 'put',  '2026-07-22T05:00:00Z'),
    ('SPXW', 'put',  '2026-07-24T04:59:00Z'),
    ('SPXW', 'call', '2026-07-24T13:31:00Z'),
    ('SPY',  'put',  '2026-07-24T13:31:00Z'),
    ('SPXW', 'put',  '2026-07-27T13:31:00Z'),
    ('SPXW', 'put',  '2026-07-28T13:31:00Z'),
    ('SPXW', 'put',  '2026-07-30T05:00:00Z'),
    ('SPXW', 'put',  '2026-09-21T13:31:00Z'),
    ('SPXW', 'put',  '2026-12-02T05:59:00Z'),
    ('SPXW', 'put',  '2026-12-02T06:00:00Z');
  INSERT INTO index_candles_1m (symbol, market_time, date) VALUES
    ('SPX', 'r', '2026-07-21'),
    ('SPX', 'r', '2026-07-22'),
    ('SPX', 'r', '2026-07-23'),
    ('SPX', 'r', '2026-07-24'),
    ('SPX', 'r', '2026-07-27'),
    ('SPX', 'e', '2026-07-28'),
    ('SPX', 'r', '2026-07-29'),
    ('SPX', 'r', '2026-09-21'),
    ('SPX', 'r', '2026-12-01'),
    ('SPX', 'r', '2026-12-02');
`;

const WINTER = ['2026-12-01', '2026-12-02'];
const ALL = ['2026-07-21', '2026-07-22', '2026-07-23', '2026-09-21', ...WINTER];

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 189); // flow_regime_0dte_daily
  await pg.exec(`
    CREATE TABLE gex_strike_0dte (
      date DATE NOT NULL, timestamp TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE strike_iv_snapshots (
      ticker TEXT NOT NULL, side TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE index_candles_1m (
      symbol TEXT NOT NULL, market_time TEXT NOT NULL, date DATE NOT NULL
    );
  `);
  await pg.exec(SEED);
  await pg.query(`SET TIME ZONE 'Asia/Tokyo'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// What each scored day looks like to the evaluator. A day absent here is calm:
// five in-band strikes at +1e9 (net 5e9), flat-ish candles, a +0.15% day.
interface Scenario {
  netGex?: number; // per strike, open profile
  midNetGex?: number; // per strike, midday profile
  spot?: number | null;
  candles?: Array<{ ctMin: number; open: number; close: number }>;
  putIv?: Array<{ ctMin: number; iv: number }>;
  close?: number;
}

const FLAT = [{ ctMin: 510, open: 6500, close: 6501 }];
const RED4 = [510, 540, 570, 600].map((ctMin) => ({
  ctMin,
  open: 6500,
  close: 6490,
}));

const SCENARIOS: Record<string, Scenario> = {
  // calm, four red half-hours before 11:00 CT: mostly_red fires
  '2026-07-21': { candles: RED4 },
  // deep negative at open and at midday: lean_down + midday_deep_neg
  '2026-07-22': { netGex: -1e10, midNetGex: -1e10 },
  // negative but shallow: big_move; put IV breaks out of its 08:30-10:00 range
  '2026-07-23': {
    netGex: -1e9,
    putIv: [
      { ctMin: 540, iv: 0.2 },
      { ctMin: 620, iv: 0.21 },
    ],
  },
  // no open spot: unknown; closes -1.54% below its open: big_down
  '2026-09-21': { spot: null, close: 6400 },
};

function installScenarios(
  overrides: Record<string, Scenario> = SCENARIOS,
): void {
  const of = (d: string): Scenario => overrides[d] ?? {};
  const profile = (d: string, anchor: string) => {
    const s = of(d);
    const each = anchor === 'midday' ? (s.midNetGex ?? s.netGex) : s.netGex;
    return {
      strikes: [6490, 6495, 6500, 6505, 6510].map((strike) => ({
        strike,
        netGex: each ?? 1e9,
      })),
      spot: s.spot === undefined ? 6500 : s.spot,
    };
  };
  // mockReset clears the calls the previous test recorded as well as its
  // implementation: the tests count which days were read.
  h.getGexStrikes
    .mockReset()
    .mockImplementation(async (d: string, anchor: string) =>
      profile(d, anchor),
    );
  h.getPutIvSeries
    .mockReset()
    .mockImplementation(async (d: string) => of(d).putIv ?? []);
  h.getCandles30
    .mockReset()
    .mockImplementation(async (d: string) => of(d).candles ?? FLAT);
  h.readDayOhlcFromPostgres
    .mockReset()
    .mockImplementation(async (d: string) => ({
      ohlc: {
        open: 6500,
        high: 6520,
        low: 6390,
        close: of(d).close ?? 6510,
        range: 130,
        up_excursion: 20,
        down_excursion: 110,
      },
      barCount: 390,
    }));
}

beforeEach(async () => {
  await pg.query('TRUNCATE flow_regime_0dte_daily');
  process.env.DATABASE_URL = 'postgres://unused.example/db';
  h.sql = neonOverPglite(pg);
  h.getDb.mockReset().mockImplementation(() => h.sql);
  h.withDbRetry.mockClear();
  installScenarios();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the date range limits the candidate days', () => {
  it('no range keeps every intersection date', async () => {
    expect(await run()).toBe(0);

    // E (gex only after 11:00 CT), F (no regular candles), D (no put IV) and
    // H (its IV is on the next CT day) are not in the intersection.
    expect(printedDates()).toEqual(ALL);
    expect(lines(log)).toContain(
      'backfill 6 candidate days (2026-07-21 -> 2026-12-02) | mode=DRY-RUN\n',
    );
  });

  it.each([
    ['one day', ['--from', '2026-07-22', '--to', '2026-07-22'], ['2026-07-22']],
    [
      'both ends inclusive',
      ['--from', '2026-07-22', '--to', '2026-07-23'],
      ['2026-07-22', '2026-07-23'],
    ],
    [
      '--from alone runs to the last day',
      ['--from', '2026-07-23'],
      ['2026-07-23', '2026-09-21', ...WINTER],
    ],
    [
      '--to alone runs from the first day',
      ['--to', '2026-07-22'],
      ['2026-07-21', '2026-07-22'],
    ],
    [
      'the same flags in the other order',
      ['--to', '2026-07-23', '--from', '2026-07-22'],
      ['2026-07-22', '2026-07-23'],
    ],
  ])('limits dates to the range: %s', async (_name, argv, expected) => {
    expect(await run(...argv)).toBe(0);

    expect(printedDates()).toEqual(expected);
    // A day outside the range is neither read nor scored.
    const read = h.getCandles30.mock.calls.map((c) => c[0]);
    expect(read).toEqual(expected);
  });

  it('keeps a day whose only put IV sits on the CT day edge', async () => {
    // 07-22: IV at 00:00 CT sharp (the first instant in), 07-23: at 23:59 CT.
    // A bound a minute off on either side drops one of them.
    expect(await run('--from', '2026-07-22', '--to', '2026-07-23')).toBe(0);
    expect(printedDates()).toEqual(['2026-07-22', '2026-07-23']);

    // 07-29's only IV row is 07-30's 00:00 CT: not 07-29's, in any range.
    log.mockClear();
    expect(await run('--from', '2026-07-29', '--to', '2026-07-30')).toBe(1);
    expect(printedDates()).toEqual([]);
  });

  it('puts the CT day edge at 06:00Z in winter, not at the summer 05:00Z', async () => {
    // 12-01's only IV row is its last CST minute (12-02 05:59Z): a bound fixed
    // at the CDT offset ends the day an hour early and drops it.
    expect(await run('--from', '2026-12-01', '--to', '2026-12-01')).toBe(0);
    expect(printedDates()).toEqual(['2026-12-01']);

    // 12-02's only IV row is its first CST instant (06:00Z), the minute after
    // 12-01's row on the same UTC day: the range for 12-02 holds that row and
    // not 12-01's, and 12-01's range does not hold 12-02's.
    log.mockClear();
    expect(await run('--from', '2026-12-02', '--to', '2026-12-02')).toBe(0);
    expect(printedDates()).toEqual(['2026-12-02']);

    log.mockClear();
    expect(await run('--from', '2026-12-01', '--to', '2026-12-02')).toBe(0);
    expect(printedDates()).toEqual(WINTER);
  });

  it('adds the range to the header only when one was given', async () => {
    await run('--from', '2026-07-22', '--to', '2026-07-23');
    expect(lines(log)).toContain(
      'backfill 2 candidate days (2026-07-22 -> 2026-07-23) | range=2026-07-22..2026-07-23 | mode=DRY-RUN',
    );

    log.mockClear();
    await run('--to', '2026-07-22');
    expect(lines(log)).toContain('| range=*..2026-07-22 |');
  });
});

describe('the dry run and the printed rows', () => {
  it('prints each row as before and writes nothing', async () => {
    expect(await run('--from', '2026-07-22', '--to', '2026-07-22')).toBe(0);

    const out = lines(log);
    expect(out).toContain(
      'date        gate       gex_open   gex_mid    oc%    bigD  mRed(g/r) ivB@    midDN',
    );
    // gate 'lean_down', gex_open = gex_mid = 5 strikes x -1e10, +0.15%, no
    // big_down, 1 green / 0 red candles, no IV break, midday_deep_neg fired.
    expect(out).toContain(
      '2026-07-22  lean_down -5.00e+10 -5.00e+10   0.15  false n(1/0)    --      Y',
    );
    expect(out).toContain(
      '"scored":1,"skipped":0,"lean_down":1,"big_move":0,"calm":0,"unknown":0',
    );
    expect(out).toContain(
      'DRY-RUN — no rows written. Re-run with --apply to upsert.',
    );
    expect(out).not.toContain('APPLIED');
    expect(await storedDates()).toEqual([]);
  });

  it('tallies every gate and trigger over the scored days', async () => {
    expect(await run()).toBe(0);

    expect(lines(log)).toContain(
      'tallies: {"scored":6,"skipped":0,"lean_down":1,"big_move":1,"calm":3,' +
        '"unknown":1,"big_down":1,"mostly_red":1,"iv_break":1,' +
        '"midday_deep_neg":1}',
    );
  });

  it('skips a day with no candles or a thin open profile', async () => {
    installScenarios({
      ...SCENARIOS,
      '2026-07-21': { candles: [] },
    });
    h.getGexStrikes.mockImplementation(async (d: string) => ({
      strikes:
        d === '2026-07-23'
          ? [{ strike: 6500, netGex: 1e9 }] // 1 < MIN_STRIKES
          : [6490, 6495, 6500, 6505, 6510].map((strike) => ({
              strike,
              netGex: 1e9,
            })),
      spot: 6500,
    }));

    expect(await run()).toBe(0);

    expect(printedDates()).toEqual(['2026-07-22', '2026-09-21', ...WINTER]);
    expect(lines(error)).toContain('[skip] 2026-07-21 candles=0 openStrikes=5');
    expect(lines(error)).toContain('[skip] 2026-07-23 candles=1 openStrikes=1');
    expect(lines(log)).toContain('"scored":4,"skipped":2');
  });
});

describe('--apply', () => {
  it('upserts only the days in the range', async () => {
    await pg.query(
      `INSERT INTO flow_regime_0dte_daily (date, gate)
       VALUES ('2026-07-21', 'stale-keep'), ('2026-09-21', 'stale-replace')`,
    );

    expect(
      await run('--from', '2026-07-22', '--to', '2026-09-21', '--apply'),
    ).toBe(0);

    // 07-22 and 07-23 are inserted, 09-21 is rewritten, 07-21 is untouched.
    expect(await storedRows()).toEqual([
      { date: '2026-07-21', gate: 'stale-keep', oc_ret_pct: null },
      {
        date: '2026-07-22',
        gate: 'lean_down',
        oc_ret_pct: expect.closeTo(0.1538, 3),
      },
      {
        date: '2026-07-23',
        gate: 'big_move',
        oc_ret_pct: expect.closeTo(0.1538, 3),
      },
      {
        date: '2026-09-21',
        gate: 'unknown',
        oc_ret_pct: expect.closeTo(-1.5385, 3),
      },
    ]);
    expect(lines(log)).toContain(
      'APPLIED — upserted 3 rows. flow_regime_0dte_daily now has 4 rows.',
    );
  });

  it('with no range upserts every intersection date, and a rerun changes nothing', async () => {
    expect(await run('--apply')).toBe(0);
    expect(await storedDates()).toEqual(ALL);

    expect(await run('--apply')).toBe(0);
    expect(await storedDates()).toEqual(ALL);
    expect(lines(log)).toContain(
      'APPLIED — upserted 6 rows. flow_regime_0dte_daily now has 6 rows.',
    );
  });

  it('prints a day with no bars as NULL outcome columns and exits 0', async () => {
    // The read resolves null (no regular bars for the day): not a failure, and
    // what the cron records for such a day.
    h.readDayOhlcFromPostgres.mockResolvedValue(null);

    expect(
      await run('--from', '2026-07-22', '--to', '2026-07-22', '--apply'),
    ).toBe(0);

    const [row] = (
      await pg.query<Record<string, unknown>>(
        `SELECT gate, oc_ret_pct, range_pct, dir_eff, big_down, big_up
         FROM flow_regime_0dte_daily`,
      )
    ).rows;
    expect(row).toEqual({
      gate: 'lean_down',
      oc_ret_pct: null,
      range_pct: null,
      dir_eff: null,
      big_down: null,
      big_up: null,
    });
    expect(lines(log)).toContain('APPLIED — upserted 1 rows.');
  });

  it('writes the columns the cron writes', async () => {
    await run('--from', '2026-07-23', '--to', '2026-07-23', '--apply');

    const [row] = (
      await pg.query<Record<string, unknown>>(
        `SELECT date::text AS date, gate, gex_open::float8 AS gex_open,
                gex_mid::float8 AS gex_mid,
                flip_minus_open_pct::float8 AS flip_minus_open_pct,
                mostly_red, mostly_red_at, iv_break, iv_break_at,
                iv_break_mag_pct::float8 AS iv_break_mag_pct, midday_deep_neg,
                oc_ret_pct::float8 AS oc_ret_pct, range_pct::float8 AS range_pct,
                dir_eff::float8 AS dir_eff, big_down, big_up
         FROM flow_regime_0dte_daily`,
      )
    ).rows;
    expect(row).toMatchObject({
      date: '2026-07-23',
      gate: 'big_move',
      gex_open: -5e9,
      gex_mid: -5e9,
      flip_minus_open_pct: null,
      mostly_red: false,
      mostly_red_at: null,
      iv_break: true,
      iv_break_at: '10:20',
      midday_deep_neg: false,
      big_down: false,
      big_up: false,
    });
    expect(row?.iv_break_mag_pct).toBeCloseTo(5, 6); // 0.21 vs 0.20
    expect(row?.range_pct).toBeCloseTo((130 / 6500) * 100, 6);
    expect(row?.dir_eff).toBeCloseTo(10 / 130, 6);
  });
});

describe('bad flags exit 2 before any SQL', () => {
  it.each([
    [
      'from after to',
      ['--from', '2026-07-23', '--to', '2026-07-22'],
      /--from 2026-07-23 is after --to 2026-07-22/,
    ],
    [
      'an impossible date',
      ['--from', '2026-02-30'],
      /--from 2026-02-30 is not a YYYY-MM-DD date/,
    ],
    ['a month 13', ['--to', '2026-13-01'], /not a YYYY-MM-DD date/],
    // JS has a year 0 and Postgres does not: SQL would reject it as exit 1.
    ['year 0', ['--from', '0000-01-01'], /not a YYYY-MM-DD date/],
    ['an unpadded date', ['--from', '2026-7-22'], /not a YYYY-MM-DD date/],
    ['a US date', ['--from', '07/22/2026'], /not a YYYY-MM-DD date/],
    ['a compact date', ['--to', '20260722'], /not a YYYY-MM-DD date/],
    ['--from with no value', ['--from'], /--from needs a YYYY-MM-DD value/],
    [
      '--to followed by a flag',
      ['--to', '--apply'],
      /--to needs a YYYY-MM-DD value/,
    ],
    [
      '--from given twice',
      ['--from', '2026-07-21', '--from', '2026-07-22'],
      /--from given twice/,
    ],
    [
      '--to given twice',
      ['--to', '2026-07-21', '--to', '2026-07-22'],
      /--to given twice/,
    ],
    ['an unknown flag', ['--aply'], /unknown argument --aply/],
    ['the = form', ['--from=2026-07-22'], /unknown argument --from=2026-07-22/],
    ['a stray date', ['2026-07-22'], /unknown argument 2026-07-22/],
    [
      'a bad flag after a good range',
      ['--from', '2026-07-22', '--dry-run'],
      /unknown argument --dry-run/,
    ],
  ])('%s', async (_name, argv, message) => {
    expect(await run(...argv)).toBe(2);

    expect(lines(error)).toMatch(message);
    expect(lines(error)).toContain('usage: backfill-regime-0dte.ts');
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.getCandles30).not.toHaveBeenCalled();
  });

  it('never applies when a flag is bad, even beside --apply', async () => {
    expect(
      await run('--apply', '--from', '2026-07-23', '--to', '2026-07-22'),
    ).toBe(2);
    expect(await storedDates()).toEqual([]);
  });

  it('rejects from > to, and accepts from = to', () => {
    expect(() =>
      parseArgs(['--from', '2026-07-23', '--to', '2026-07-22']),
    ).toThrow(UsageError);
    expect(parseArgs(['--from', '2026-07-22', '--to', '2026-07-22'])).toEqual({
      from: '2026-07-22',
      to: '2026-07-22',
      apply: false,
    });
  });

  it('parses --apply and leaves an absent side null', () => {
    expect(parseArgs([])).toEqual({ from: null, to: null, apply: false });
    expect(parseArgs(['--to', '2026-07-22', '--apply'])).toEqual({
      from: null,
      to: '2026-07-22',
      apply: true,
    });
  });
});

describe('an explicit range that scores nothing is not a success', () => {
  it('exits 1 when no candidate day falls in the range', async () => {
    // 07-24 is complete except for its put IV; 08-01 .. 09-20 has no rows.
    expect(
      await run('--from', '2026-07-24', '--to', '2026-09-20', '--apply'),
    ).toBe(1);

    expect(lines(error)).toContain(
      'no candidate day between 2026-07-24 and 2026-09-20',
    );
    expect(lines(log)).not.toContain('APPLIED');
    expect(h.getCandles30).not.toHaveBeenCalled();
    expect(await storedDates()).toEqual([]);
  });

  it('exits 1 when every day in the range is skipped', async () => {
    h.getCandles30.mockResolvedValue([]);

    expect(
      await run('--from', '2026-07-22', '--to', '2026-07-22', '--apply'),
    ).toBe(1);

    expect(lines(error)).toContain('[skip] 2026-07-22');
    expect(lines(error)).toContain(
      'no day between 2026-07-22 and 2026-07-22 was scored',
    );
    expect(lines(log)).not.toContain('APPLIED');
    expect(await storedDates()).toEqual([]);
  });

  it('keeps an unranged run with nothing to score at exit 0, as before', async () => {
    h.getCandles30.mockResolvedValue([]);

    expect(await run('--apply')).toBe(0);
    expect(lines(log)).toContain('APPLIED — upserted 0 rows.');
  });
});

describe('an unranged run with no candidate day', () => {
  /** The day-list statement finds nothing; every other statement is real. */
  function emptyDayList(): void {
    const real = neonOverPglite(pg);
    h.sql = Object.assign(
      (strings: TemplateStringsArray, ...params: unknown[]) =>
        strings.join('?').includes('WITH gd AS')
          ? Promise.resolve([])
          : real(strings, ...params),
      real,
    );
  }

  it('says so in the header instead of printing undefined, and exits 0 as before', async () => {
    emptyDayList();

    expect(await run()).toBe(0);

    expect(lines(log)).toContain('backfill no candidate days | mode=DRY-RUN\n');
    expect(lines(log)).not.toContain('undefined');
    expect(lines(log)).toContain('"scored":0,"skipped":0');
    expect(h.getCandles30).not.toHaveBeenCalled();
  });

  it('upserts nothing under --apply, and still exits 0', async () => {
    emptyDayList();

    expect(await run('--apply')).toBe(0);

    expect(lines(log)).toContain('backfill no candidate days | mode=APPLY\n');
    expect(lines(log)).toContain(
      'APPLIED — upserted 0 rows. flow_regime_0dte_daily now has 0 rows.',
    );
    expect(await storedDates()).toEqual([]);
  });
});

describe('a failure is never reported as success', () => {
  const noSuccessLine = (): void => {
    expect(lines(log)).not.toContain('APPLIED');
    expect(lines(log)).not.toContain('DRY-RUN — no rows written');
  };

  /** pglite behind a tagged template that rejects the statements `fail` picks. */
  function failingSql(
    fail: (text: string, params: unknown[]) => boolean,
  ): unknown {
    const real = neonOverPglite(pg);
    return Object.assign(
      (strings: TemplateStringsArray, ...params: unknown[]) =>
        fail(strings.join('?'), params)
          ? Promise.reject(new Error('connection lost'))
          : real(strings, ...params),
      real,
    );
  }

  it('exits 1 when the candidate-day query rejects', async () => {
    h.sql = failingSql((text) => text.includes('WITH gd AS'));

    expect(
      await run('--from', '2026-07-22', '--to', '2026-07-22', '--apply'),
    ).toBe(1);

    expect(lines(error)).toContain('regime-0dte backfill failed');
    expect(lines(error)).toContain('connection lost');
    noSuccessLine();
    expect(h.getCandles30).not.toHaveBeenCalled();
  });

  it('exits 1, names the day and writes nothing when a day read rejects', async () => {
    h.getPutIvSeries.mockImplementation(async (d: string) => {
      if (d === '2026-07-23') throw new Error('connection lost');
      return [];
    });

    expect(await run('--apply')).toBe(1);

    expect(lines(error)).toContain('scoring 2026-07-23 failed');
    expect(lines(error)).toContain('connection lost');
    noSuccessLine();
    expect(await storedDates()).toEqual([]);
  });

  it('exits 1, names the day and writes nothing when the day OHLC read rejects', async () => {
    // The read that used to be fail-soft: a null here would have been upserted
    // as five NULL outcome columns over a good row, with APPLIED and exit 0.
    await pg.query(
      `INSERT INTO flow_regime_0dte_daily (date, gate, oc_ret_pct, range_pct, dir_eff)
       VALUES ('2026-07-23', 'big_move', 0.6768, 0.7509, 0.9013)`,
    );
    h.readDayOhlcFromPostgres.mockImplementation(async (d: string) => {
      if (d === '2026-07-23') throw new Error('connection lost');
      return {
        ohlc: {
          open: 6500,
          high: 6520,
          low: 6390,
          close: 6510,
          range: 130,
          up_excursion: 20,
          down_excursion: 110,
        },
        barCount: 390,
      };
    });

    expect(
      await run('--from', '2026-07-22', '--to', '2026-07-23', '--apply'),
    ).toBe(1);

    expect(lines(error)).toContain('scoring 2026-07-23 failed');
    expect(lines(error)).toContain('connection lost');
    noSuccessLine();
    // Scoring runs before any upsert: the stored row is exactly as it was and
    // 07-22, scored before the failure, was not written either.
    expect(await storedRows()).toEqual([
      {
        date: '2026-07-23',
        gate: 'big_move',
        oc_ret_pct: expect.closeTo(0.6768, 4),
      },
    ]);
  });

  it('reads the day OHLC under withDbRetry, as every other read here', async () => {
    expect(await run('--from', '2026-07-22', '--to', '2026-07-22')).toBe(0);

    // The day list and the OHLC read: the regime readers (mocked) wrap their own.
    expect(h.readDayOhlcFromPostgres).toHaveBeenCalledTimes(1);
    expect(h.withDbRetry.mock.calls).toEqual([
      [expect.any(Function), 2, 10_000],
      [expect.any(Function), 2, 10_000],
    ]);
  });

  it('exits 1, names the day and stops when an upsert rejects', async () => {
    h.sql = failingSql(
      (text, params) =>
        text.includes('INSERT INTO flow_regime_0dte_daily') &&
        params[0] === '2026-07-23',
    );

    expect(await run('--apply')).toBe(1);

    expect(lines(error)).toContain('upserting 2026-07-23 failed');
    expect(lines(error)).toContain('connection lost');
    noSuccessLine();
    // The rows before it stay (a rerun rewrites them); none after it ran.
    expect(await storedDates()).toEqual(['2026-07-21', '2026-07-22']);
  });

  it('exits 1 when the closing row count rejects', async () => {
    h.sql = failingSql((text) => text.includes('count(*)'));

    expect(await run('--apply')).toBe(1);

    expect(lines(error)).toContain('connection lost');
    noSuccessLine();
  });

  it('exits 1 without touching the database when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;

    expect(await run('--apply')).toBe(1);

    expect(lines(error)).toContain('DATABASE_URL not set');
    expect(h.getDb).not.toHaveBeenCalled();
  });
});
