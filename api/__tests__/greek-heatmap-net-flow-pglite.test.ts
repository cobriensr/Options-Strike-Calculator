// @vitest-environment node

/**
 * REAL-SQL test for the day filter in getGreekHeatmapNetFlow.
 *
 * greek-heatmap.test.ts mocks the db and only matches SQL text. This file
 * runs the function's ACTUAL statements against pglite (real Postgres in
 * WASM, with tzdata), on tables built from the real migration entries
 * (#121 ws_net_flow_per_ticker, #122 net_flow_per_ticker_history).
 *
 * The reference is the SQL the function ran before 2026-10-29, kept here
 * verbatim (OLD_LIVE_SQL, OLD_HISTORY_SQL). It filtered on the
 * non-sargable `date(ts) = $2::date`: a 49.5 s seq scan of the 20 GB
 * ws_net_flow_per_ticker heap per call. `date(ts)` on a timestamptz takes
 * the date in the SESSION time zone, which on Neon is GMT, so the old
 * filter selected the UTC day. The new filter must select exactly those
 * rows, from bounds on the bare column.
 *
 * The expected UTC-day bounds are hard-coded instants, independent of the
 * SQL under test: [D 00:00Z, D+1 00:00Z) for every D. UTC has no DST, so
 * the bounds stay 24 h apart on the two US DST days (2026-11-01, 25 h in
 * ET; 2027-03-14, 23 h in ET). Each day also carries rows inside the ET
 * day but outside the UTC day (and the reverse); they pin the UTC
 * semantics, so a switch to ET bounds would fail here rather than slip in.
 *
 * Every day runs under two session time zones: UTC (Neon's) and
 * America/Chicago. Under UTC the old and new statements must return the
 * same row. Under Chicago the new statement must still return the UTC
 * day, which the old one did not: a session-relative rewrite such as
 * `ts >= $2::date::timestamptz` would pass under UTC and fail there.
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

const { pgRef } = vi.hoisted(() => ({
  pgRef: { current: null as PGlite | null },
}));

// getDb() returns a Neon-shaped tagged template over pglite; withDbRetry
// is the real one, wrapping it.
vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb:
      () =>
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const pg = pgRef.current;
        if (!pg) throw new Error('pglite not started');
        const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
        return pg.query(text, values).then((r) => r.rows);
      },
    withDbRetry: actual.withDbRetry,
  };
});

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

import { applyMigration } from './pglite-migrations';
import {
  getGreekHeatmapNetFlow,
  type GreekHeatmapNetFlow,
} from '../_lib/db-greek-heatmap.js';

/** The live-branch statement before 2026-10-29, verbatim (the reference). */
const OLD_LIVE_SQL = `
  SELECT
    ts,
    SUM(net_call_prem) OVER w AS cum_call_prem,
    SUM(net_call_vol)  OVER w AS cum_call_vol,
    SUM(net_put_prem)  OVER w AS cum_put_prem,
    SUM(net_put_vol)   OVER w AS cum_put_vol
  FROM ws_net_flow_per_ticker
  WHERE ticker = $1
    AND date(ts) = $2::date
  WINDOW w AS (PARTITION BY ticker, date(ts) ORDER BY ts)
  ORDER BY ts DESC
  LIMIT 1
`;

/** The history-branch statement before 2026-10-29, verbatim. */
const OLD_HISTORY_SQL = `
  SELECT
    ts,
    SUM(net_call_prem) OVER w AS cum_call_prem,
    SUM(net_call_vol)  OVER w AS cum_call_vol,
    SUM(net_put_prem)  OVER w AS cum_put_prem,
    SUM(net_put_vol)   OVER w AS cum_put_vol
  FROM net_flow_per_ticker_history
  WHERE ticker = $1
    AND date(ts) = $2::date
    AND source = 'rest'
  WINDOW w AS (PARTITION BY ticker, date(ts) ORDER BY ts)
  ORDER BY ts DESC
  LIMIT 1
`;

const DAYS = [
  { label: 'an EDT weekday', date: '2026-10-28' },
  { label: 'an EST weekday', date: '2026-12-04' },
  { label: 'the day DST ends (25 h in ET)', date: '2026-11-01' },
  { label: 'the day DST starts (23 h in ET)', date: '2027-03-14' },
] as const;

const TICKER = 'SPY';
/** Same instants, other ticker: must never leak into SPY's sums. */
const OTHER_TICKER = 'TEAM';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The instants seeded for day D, each with its membership in the UTC day.
 * The 03:30Z rows sit in the previous ET day (23:30 EDT / 22:30 EST), so
 * the UTC day keeps D's and drops D+1's.
 */
function dayInstants(date: string): { at: string; included: boolean }[] {
  const next = addDays(date, 1);
  return [
    { at: `${addDays(date, -1)}T23:59:59.999Z`, included: false },
    { at: `${date}T00:00:00.000Z`, included: true },
    { at: `${date}T03:30:00.000Z`, included: true },
    { at: `${date}T14:30:00.000Z`, included: true },
    { at: `${date}T19:59:00.000Z`, included: true },
    { at: `${date}T23:59:59.999Z`, included: true },
    { at: `${next}T00:00:00.000Z`, included: false },
    { at: `${next}T03:30:00.000Z`, included: false },
  ];
}

interface SeedRow {
  ticker: string;
  ts: string;
  callPrem: number;
  callVol: number;
  putPrem: number;
  putVol: number;
}

/**
 * Row i of a day gets call vol 2^i, so a day's summed call vol is a bitmask
 * of exactly which rows were included. The other ticker scales by 1000.
 */
function seedRowsFor(date: string): SeedRow[] {
  const rows: SeedRow[] = [];
  dayInstants(date).forEach(({ at }, i) => {
    for (const [ticker, scale] of [
      [TICKER, 1],
      [OTHER_TICKER, 1000],
    ] as const) {
      rows.push({
        ticker,
        ts: at,
        callPrem: scale * (2 ** i + 0.25),
        callVol: scale * 2 ** i,
        putPrem: -scale * (2 ** i + 0.5),
        putVol: scale * 2 ** (i + 8),
      });
    }
  });
  return rows;
}

/** The expected result for SPY on `date`, from the fixture alone. */
function expectedNetFlow(date: string): GreekHeatmapNetFlow {
  const included = dayInstants(date)
    .map((inst, i) => ({ ...inst, i }))
    .filter((inst) => inst.included);
  const sum = (f: (i: number) => number) =>
    included.reduce((acc, { i }) => acc + f(i), 0);
  return {
    cumulativeCallPrem: sum((i) => 2 ** i + 0.25),
    cumulativeCallVol: sum((i) => 2 ** i),
    cumulativePutPrem: sum((i) => -(2 ** i + 0.5)),
    cumulativePutVol: sum((i) => 2 ** (i + 8)),
    asOf: included.at(-1)!.at,
  };
}

let pg: PGlite;

/** Normalize a reference row the way getGreekHeatmapNetFlow does. */
async function runOld(
  text: string,
  date: string,
): Promise<GreekHeatmapNetFlow | null> {
  const res = await pg.query<{
    ts: Date;
    cum_call_prem: string;
    cum_call_vol: string;
    cum_put_prem: string;
    cum_put_vol: string;
  }>(text, [TICKER, date]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    cumulativeCallPrem: Number.parseFloat(String(r.cum_call_prem)),
    cumulativeCallVol: Number.parseInt(String(r.cum_call_vol), 10),
    cumulativePutPrem: Number.parseFloat(String(r.cum_put_prem)),
    cumulativePutVol: Number.parseInt(String(r.cum_put_vol), 10),
    asOf: r.ts.toISOString(),
  };
}

async function seed(rows: SeedRow[]): Promise<void> {
  const cols = [
    rows.map((r) => r.ticker),
    rows.map((r) => r.ts),
    rows.map((r) => r.callPrem),
    rows.map((r) => r.callVol),
    rows.map((r) => r.putPrem),
    rows.map((r) => r.putVol),
  ];
  await pg.query(
    `INSERT INTO ws_net_flow_per_ticker (
       ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
       raw_payload
     )
     SELECT t.ticker, t.ts, t.cp, t.cv, t.pp, t.pv, '{}'::jsonb
       FROM unnest($1::text[], $2::timestamptz[], $3::numeric[],
                   $4::int[], $5::numeric[], $6::int[])
              AS t(ticker, ts, cp, cv, pp, pv)`,
    cols,
  );
  // The history copy carries source='rest'; a 'ws'-source twin at every
  // instant (huge values) must never be summed.
  await pg.query(
    `INSERT INTO net_flow_per_ticker_history (
       ticker, ts, net_call_prem, net_call_vol, net_put_prem, net_put_vol,
       call_volume, call_volume_ask_side, call_volume_bid_side,
       put_volume, put_volume_ask_side, put_volume_bid_side, source
     )
     SELECT t.ticker, t.ts, t.cp * m.k, t.cv * m.k, t.pp * m.k, t.pv * m.k,
            0, 0, 0, 0, 0, 0, m.source
       FROM unnest($1::text[], $2::timestamptz[], $3::numeric[],
                   $4::int[], $5::numeric[], $6::int[])
              AS t(ticker, ts, cp, cv, pp, pv)
      CROSS JOIN (VALUES ('rest', 1), ('ws', 7)) AS m(source, k)`,
    cols,
  );
}

beforeAll(async () => {
  pg = await PGlite.create();
  pgRef.current = pg;
  await applyMigration(pg, 121);
  await applyMigration(pg, 122);
  await seed(DAYS.flatMap((d) => seedRowsFor(d.date)));
}, 60_000);

afterAll(async () => {
  pgRef.current = null;
  await pg.close();
});

const BRANCHES = [
  {
    name: 'live (ws_net_flow_per_ticker)',
    oldSql: OLD_LIVE_SQL,
    // `today === date` routes to the live table.
    todayFor: (date: string) => date,
  },
  {
    name: 'historical (net_flow_per_ticker_history, source=rest)',
    oldSql: OLD_HISTORY_SQL,
    todayFor: (date: string) => addDays(date, 30),
  },
] as const;

describe.each(BRANCHES)(
  'getGreekHeatmapNetFlow day filter against Postgres (pglite) — $name',
  (branch) => {
    describe('session TimeZone UTC (Neon)', () => {
      beforeEach(async () => {
        await pg.query(`SET TimeZone = 'UTC'`);
      });

      it.each(DAYS)(
        'returns exactly what the old date(ts) statement returned — $label',
        async ({ date }) => {
          const oldResult = await runOld(branch.oldSql, date);
          const newResult = await getGreekHeatmapNetFlow(
            TICKER,
            date,
            branch.todayFor(date),
          );

          expect(newResult).toEqual(oldResult);
          // And that is the hard-coded UTC day, independent of either SQL.
          expect(newResult).toEqual(expectedNetFlow(date));
        },
      );

      it('returns null for a day with no rows, as the old statement did', async () => {
        const empty = '2026-10-20';
        expect(await runOld(branch.oldSql, empty)).toBeNull();
        expect(
          await getGreekHeatmapNetFlow(TICKER, empty, branch.todayFor(empty)),
        ).toBeNull();
      });
    });

    describe('session TimeZone America/Chicago', () => {
      beforeEach(async () => {
        await pg.query(`SET TimeZone = 'America/Chicago'`);
      });

      it.each(DAYS)(
        'still returns the UTC day (the bounds do not depend on the session zone) — $label',
        async ({ date }) => {
          const newResult = await getGreekHeatmapNetFlow(
            TICKER,
            date,
            branch.todayFor(date),
          );
          expect(newResult).toEqual(expectedNetFlow(date));

          // The old statement followed the session zone; this is why the
          // new bounds name UTC explicitly.
          expect(await runOld(branch.oldSql, date)).not.toEqual(
            expectedNetFlow(date),
          );
        },
      );
    });
  },
);
