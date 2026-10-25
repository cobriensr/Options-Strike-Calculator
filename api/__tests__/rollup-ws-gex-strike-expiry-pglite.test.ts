// @vitest-environment node

/**
 * REAL-SQL test for the per-ticker WS GEX rollup.
 *
 * rollup-ws-gex-strike-expiry.test.ts mocks `db.query` and only matches SQL
 * text. This file runs the rollup's ACTUAL statements against pglite (real
 * Postgres in WASM, with tzdata, so `AT TIME ZONE 'America/New_York'`
 * resolves as on Neon). Both tables are created by the real migration
 * entries (#8 strike_exposures, #111 ws_gex_strike_expiry), not copies.
 *
 * The reference is the statement the rollup ran before 2026-10-25: one
 * INSERT...SELECT filtered on the non-sargable
 * `(ts_minute AT TIME ZONE 'America/New_York')::date = $1`. It is kept here
 * verbatim as OLD_ROLLUP_SQL. For each date, the old statement and the new
 * per-ticker statements must write exactly the same rows.
 *
 * The expected ET-day bounds are hard-coded UTC instants, independent of
 * the SQL under test:
 *   - 2026-10-23 (EDT weekday):   [04:00Z, next day 04:00Z)
 *   - 2026-12-04 (EST weekday):   [05:00Z, next day 05:00Z)
 *   - 2026-11-01 (DST ends 02:00, a 25 h day): starts 00:00 EDT = 04:00Z,
 *     ends 00:00 EST on 11-02 = 05:00Z.
 *   - 2027-03-14 (DST starts 02:00, a 23 h day): starts 00:00 EST = 05:00Z,
 *     ends 00:00 EDT on 03-15 = 04:00Z.
 * The two DST days also carry "trap" rows that a fixed-offset bound would
 * misplace (see TRAPS).
 *
 * Every day runs under two session time zones: UTC (Neon's) and a zone
 * that is neither UTC nor New York. A bound written as
 * `$1::date AT TIME ZONE 'America/New_York'` resolves through
 * date → timestamptz (the preferred cast) in the SESSION zone, so it is
 * only ET midnight when the session happens to be New York; the ET bounds
 * must go through `::timestamp` to be session-independent.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// The rollup takes its db handle as an argument; nothing here may reach
// getDb() (whose DATABASE_URL would be a real database).
vi.mock('../_lib/db.js', () => ({
  getDb: () => {
    throw new Error('getDb() must not be called in the pglite rollup test');
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import { MIGRATIONS } from '../_lib/db-migrations.js';
import { rollupWsGexToStrikeExposures } from '../_lib/rollup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';

/** The pre-2026-10-25 single statement, verbatim (the reference). */
const OLD_ROLLUP_SQL = `
  INSERT INTO strike_exposures (
    date, timestamp, ticker, expiry, strike, price,
    call_gamma_oi, put_gamma_oi,
    call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
    call_charm_oi, put_charm_oi,
    call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
    call_delta_oi, put_delta_oi,
    call_vanna_oi, put_vanna_oi
  )
  SELECT
    (ts_minute AT TIME ZONE 'America/New_York')::date AS date,
    ts_minute AS timestamp,
    CASE WHEN ticker = 'SPX' THEN 'SPXW' ELSE ticker END AS ticker,
    expiry,
    strike,
    price,
    call_gamma_oi,
    put_gamma_oi,
    call_gamma_ask_vol  AS call_gamma_ask,
    call_gamma_bid_vol  AS call_gamma_bid,
    put_gamma_ask_vol   AS put_gamma_ask,
    put_gamma_bid_vol   AS put_gamma_bid,
    call_charm_oi,
    put_charm_oi,
    call_charm_ask_vol  AS call_charm_ask,
    call_charm_bid_vol  AS call_charm_bid,
    put_charm_ask_vol   AS put_charm_ask,
    put_charm_bid_vol   AS put_charm_bid,
    NULL::numeric AS call_delta_oi,
    NULL::numeric AS put_delta_oi,
    call_vanna_oi,
    put_vanna_oi
  FROM ws_gex_strike_expiry
  WHERE expiry = $1::date
    AND (ts_minute AT TIME ZONE 'America/New_York')::date = $1::date
  ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
  RETURNING id
`;

/** UTC as on Neon, and a zone that is neither UTC nor New York. */
const SESSION_TIME_ZONES = ['UTC', 'America/Chicago'];

const TICKERS = ['AAPL', 'SPY', 'SPX'] as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface DayCase {
  label: string;
  date: string;
  /** ET 00:00 of `date`, as a UTC instant. */
  start: string;
  /** ET 00:00 of the next day, as a UTC instant. */
  end: string;
}

const DAYS: DayCase[] = [
  {
    label: 'an EDT weekday',
    date: '2026-10-23',
    start: '2026-10-23T04:00:00.000Z',
    end: '2026-10-24T04:00:00.000Z',
  },
  {
    label: 'an EST weekday',
    date: '2026-12-04',
    start: '2026-12-04T05:00:00.000Z',
    end: '2026-12-05T05:00:00.000Z',
  },
  {
    label: 'the day DST ends (starts EDT, ends EST)',
    date: '2026-11-01',
    start: '2026-11-01T04:00:00.000Z',
    end: '2026-11-02T05:00:00.000Z',
  },
  {
    label: 'the day DST starts (starts EST, ends EDT)',
    date: '2027-03-14',
    start: '2027-03-14T05:00:00.000Z',
    end: '2027-03-15T04:00:00.000Z',
  },
];

/**
 * Rows a fixed-offset bound would misplace, with their true membership.
 * 2026-11-01: a naive EST start (05:00Z) would drop 04:30Z (00:30 EDT), a
 * naive EDT end (11-02 04:00Z) would drop 11-02 04:30Z (23:30 EST, 11-01).
 * 2027-03-14: a naive EDT start (04:00Z) would keep 04:30Z (23:30 EST,
 * 03-13), a naive EST end (03-15 05:00Z) would keep 03-15 04:30Z (00:30
 * EDT, 03-15).
 */
const TRAPS: Record<string, { at: string; included: boolean }[]> = {
  '2026-11-01': [
    { at: '2026-11-01T04:30:00.000Z', included: true },
    { at: '2026-11-02T04:30:00.000Z', included: true },
  ],
  '2027-03-14': [
    { at: '2027-03-14T04:30:00.000Z', included: false },
    { at: '2027-03-15T04:30:00.000Z', included: false },
  ],
};

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

interface SourceRow {
  ticker: string;
  expiry: string;
  ts: string;
}

/** Source rows for one day, and the timestamps that must be copied. */
function dayRows(day: DayCase): { rows: SourceRow[]; included: string[] } {
  const included = [
    day.start,
    shift(day.start, MINUTE),
    shift(day.start, 14 * HOUR),
    shift(day.end, -MINUTE),
    ...(TRAPS[day.date] ?? []).filter((t) => t.included).map((t) => t.at),
  ];
  const excludedSameExpiry = [
    shift(day.start, -MINUTE),
    day.end,
    ...(TRAPS[day.date] ?? []).filter((t) => !t.included).map((t) => t.at),
  ];
  const midday = shift(day.start, 14 * HOUR);
  const rows: SourceRow[] = [];
  for (const ticker of TICKERS) {
    for (const ts of [...included, ...excludedSameExpiry]) {
      rows.push({ ticker, expiry: day.date, ts });
    }
    // Same ET day, other expiries: never copied (0DTE only).
    rows.push({ ticker, expiry: addDays(day.date, 1), ts: midday });
    rows.push({ ticker, expiry: addDays(day.date, -1), ts: midday });
  }
  return { rows, included: [...included].sort() };
}

type Sql = Parameters<NonNullable<(typeof MIGRATIONS)[number]['run']>>[0];

let pg: PGlite;

/**
 * Neon-shaped tagged template over pglite, enough for the migrations'
 * `sql\`...\`` calls. Lazy (runs on await), so a `statements` array is
 * applied strictly in order.
 */
function taggedSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
  return {
    then<T>(
      onFulfilled: (rows: unknown[]) => T,
      onRejected?: (err: unknown) => T,
    ) {
      return pg
        .query(text, values)
        .then((r) => r.rows)
        .then(onFulfilled, onRejected);
    },
  };
}

/** Neon-shaped handle the rollup takes: `.query(text, params)` → rows. */
const db = {
  query: async (text: string, params: unknown[] = []) =>
    (await pg.query(text, params)).rows,
} as unknown as Parameters<typeof rollupWsGexToStrikeExposures>[0];

async function applyMigration(id: number): Promise<void> {
  const migration = MIGRATIONS.find((m) => m.id === id);
  if (!migration) throw new Error(`migration #${id} not found`);
  const sql = taggedSql as unknown as Sql;
  if (migration.statements) {
    for (const statement of migration.statements(sql)) await statement;
  } else if (migration.run) {
    await migration.run(sql);
  }
}

async function seedSource(rows: SourceRow[]): Promise<void> {
  // Every value column gets a distinct offset from the row's ordinal, so a
  // swapped column (ask vs bid, gamma vs charm) changes the copied row.
  await pg.query(
    `INSERT INTO ws_gex_strike_expiry (
       ticker, expiry, strike, ts_minute, price,
       call_gamma_oi, put_gamma_oi,
       call_gamma_ask_vol, call_gamma_bid_vol, put_gamma_ask_vol, put_gamma_bid_vol,
       call_charm_oi, put_charm_oi,
       call_charm_ask_vol, call_charm_bid_vol, put_charm_ask_vol, put_charm_bid_vol,
       call_vanna_oi, put_vanna_oi
     )
     SELECT t.ticker, t.expiry, 100 + t.n, t.ts, 5000 + t.n,
            t.n + 0.01, -(t.n + 0.02),
            t.n + 0.03, t.n + 0.04, t.n + 0.05, t.n + 0.06,
            t.n + 0.07, -(t.n + 0.08),
            t.n + 0.09, t.n + 0.10, t.n + 0.11, t.n + 0.12,
            t.n + 0.13, -(t.n + 0.14)
       FROM unnest($1::text[], $2::date[], $3::timestamptz[])
              WITH ORDINALITY AS t(ticker, expiry, ts, n)`,
    [
      rows.map((r) => r.ticker),
      rows.map((r) => r.expiry),
      rows.map((r) => r.ts),
    ],
  );
}

interface TargetRow {
  date: string;
  timestamp: string;
  ticker: string;
  rest: string;
}

/** Every copied row, every column except id/created_at, in a stable order. */
async function targetRows(): Promise<TargetRow[]> {
  const res = await pg.query<{
    date: string;
    timestamp: Date;
    ticker: string;
    rest: string;
  }>(
    `SELECT date::text AS date, timestamp, ticker,
            concat_ws('|', expiry::text, strike::text, price::text,
              call_gamma_oi::text, put_gamma_oi::text,
              call_gamma_ask::text, call_gamma_bid::text,
              put_gamma_ask::text, put_gamma_bid::text,
              call_charm_oi::text, put_charm_oi::text,
              call_charm_ask::text, call_charm_bid::text,
              put_charm_ask::text, put_charm_bid::text,
              coalesce(call_delta_oi::text, 'null'),
              coalesce(put_delta_oi::text, 'null'),
              call_vanna_oi::text, put_vanna_oi::text) AS rest
       FROM strike_exposures
      ORDER BY ticker, timestamp, strike`,
  );
  return res.rows.map((r) => ({
    date: r.date,
    timestamp: r.timestamp.toISOString(),
    ticker: r.ticker,
    rest: r.rest,
  }));
}

async function clearTarget(): Promise<void> {
  await pg.query('TRUNCATE strike_exposures RESTART IDENTITY');
}

/** A deadline the rollup cannot hit: every ticker starts. */
function farDeadline(): number {
  return Date.now() + 10 * MINUTE;
}

const expectedByDay = new Map<string, string[]>();

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(8);
  await applyMigration(111);
  for (const day of DAYS) {
    const { rows, included } = dayRows(day);
    await seedSource(rows);
    expectedByDay.set(day.date, included);
  }
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(Sentry.captureMessage).mockClear();
  await clearTarget();
});

describe.each(SESSION_TIME_ZONES)(
  'rollup-ws-gex-strike-expiry against Postgres (pglite), session TimeZone %s',
  (timeZone) => {
    beforeEach(async () => {
      await pg.query(`SET TimeZone = '${timeZone}'`);
    });

    it.each(DAYS)(
      'copies exactly the rows the old single statement copied — $label',
      async (day) => {
        const included = expectedByDay.get(day.date)!;

        const oldReturned = (await pg.query(OLD_ROLLUP_SQL, [day.date])).rows;
        const oldRows = await targetRows();
        await clearTarget();

        const result = await rollupWsGexToStrikeExposures(
          db,
          day.date,
          farDeadline(),
        );
        const newRows = await targetRows();

        // Same rows, column for column, as the reference statement.
        expect(newRows).toEqual(oldRows);

        // And those rows are the hard-coded ET day, independent of either SQL.
        expect(newRows).toHaveLength(included.length * TICKERS.length);
        expect(oldReturned).toHaveLength(newRows.length);
        for (const ticker of ['AAPL', 'SPXW', 'SPY']) {
          expect(
            newRows
              .filter((r) => r.ticker === ticker)
              .map((r) => r.timestamp)
              .sort(),
          ).toEqual(included);
        }
        expect(new Set(newRows.map((r) => r.date))).toEqual(
          new Set([day.date]),
        );

        // SPX lands as SPXW; nothing is stored under SPX.
        expect(newRows.some((r) => r.ticker === 'SPX')).toBe(false);

        // SPX first, then the rest; the server-side counts match the rows.
        expect(result.copied.map((c) => c.ticker)).toEqual([
          'SPX',
          'AAPL',
          'SPY',
        ]);
        for (const c of result.copied) expect(c.inserted).toBe(included.length);
        expect(result.inserted).toBe(newRows.length);
        expect(result.failed).toEqual([]);
        expect(result.deferred).toEqual([]);
        expect(Sentry.captureException).not.toHaveBeenCalled();

        // Idempotent: a re-run inserts nothing and changes nothing.
        const again = await rollupWsGexToStrikeExposures(
          db,
          day.date,
          farDeadline(),
        );
        expect(again.inserted).toBe(0);
        expect(again.copied.map((c) => c.inserted)).toEqual([0, 0, 0]);
        expect(await targetRows()).toEqual(newRows);
      },
    );
  },
);

describe('rollup-ws-gex-strike-expiry against Postgres (pglite)', () => {
  it('copies nothing for a date the source does not hold', async () => {
    const result = await rollupWsGexToStrikeExposures(
      db,
      '2026-10-26',
      farDeadline(),
    );
    expect(result).toMatchObject({
      tickers: [],
      copied: [],
      inserted: 0,
      failed: [],
      deferred: [],
    });
    expect(await targetRows()).toEqual([]);
  });
});
