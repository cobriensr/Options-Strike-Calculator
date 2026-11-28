// @vitest-environment node

/**
 * REAL-SQL test for the gamma fire backfill's two window-bound statements.
 *
 * gamma-fires-backfill.test.ts stubs the DB and only sees the SQL text and the
 * bound values, so it cannot tell whether `[from 00:00 ET, to+1 00:00 ET)`
 * lands on the ET day edges, whether the NULL-bound COALESCE keeps the fill
 * table-wide, or whether the session-date grouping and the five-column UPDATE
 * touch the right rows. This file runs the real `runGammaBackfill` against
 * pglite (Postgres in WASM) with ws_gamma_setup_fires built from the REAL
 * migration (#179), and reads the rows back. `loadDayContext` is the one
 * mocked piece: it is the detector's own reader, not the code under test.
 *
 * The session runs in America/Chicago, not Neon's UTC: nothing here may
 * depend on the session time zone.
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

const { mockLoadDayContext } = vi.hoisted(() => ({
  mockLoadDayContext: vi.fn(),
}));

vi.mock('../../api/_lib/gamma-detector.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../api/_lib/gamma-detector.js')
  >()),
  loadDayContext: mockLoadDayContext,
}));

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';
import type { DayContext } from '../../api/_lib/gamma-detector.js';
import { runGammaBackfill } from './gamma-fires-backfill.js';

let pg: PGlite;
let log: MockInstance<typeof console.log>;

const run = (...argv: string[]): Promise<number> =>
  runGammaBackfill(argv, neonOverPglite(pg) as never);

const logged = (): string =>
  log.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 179); // ws_gamma_setup_fires
  // Only the columns the outcome fill's forward lookups read. Candles every
  // five minutes, 2026-09-20 through 2026-09-23, so each fire has a close
  // within 90 minutes after +15, +30 and +60.
  await pg.query(
    `CREATE TABLE index_candles_1m (
       symbol TEXT NOT NULL, market_time TEXT NOT NULL,
       timestamp TIMESTAMPTZ NOT NULL, date DATE NOT NULL, close NUMERIC NOT NULL
     )`,
  );
  await pg.query(
    `INSERT INTO index_candles_1m
       SELECT 'SPX', 'r', ts, (ts AT TIME ZONE 'America/New_York')::date, 6510
       FROM generate_series(
         '2026-09-20T00:00:00Z'::timestamptz,
         '2026-09-23T00:00:00Z'::timestamptz,
         INTERVAL '5 minutes') AS ts`,
  );
  await pg.query(`SET TIME ZONE 'America/Chicago'`);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE ws_gamma_setup_fires');
  mockLoadDayContext.mockReset();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedFire(
  firedAt: string,
  over: { ret30?: number | null; tier?: string; node?: number } = {},
): Promise<void> {
  await pg.query(
    `INSERT INTO ws_gamma_setup_fires (
       fired_at, signal_type, dow_label, confidence_tier, spot_at_fire,
       node_strike, node_gex, bar_open, bar_high, bar_low, bar_close, bar_range,
       prior_5d_ret, prior_iv_rank, pre_day_filter_fires, open_gap_pct, ret_30m
     ) VALUES ($1, 'e1_long_call', 'Monday', $2, 6500, $3, 1000000,
       6500, 6501, 6499, 6500.5, 2, 0.0195, 30, false, 2.81, $4)`,
    [firedAt, over.tier ?? 'HIGH', over.node ?? 6500, over.ret30 ?? null],
  );
}

describe('--outcomes-only against real SQL', () => {
  // The ET day 2026-09-21 is [04:00Z, 04:00Z next day) under EDT.
  const BEFORE = '2026-09-21T03:59:00Z'; // 23:59 ET on 09-20
  const MIDNIGHT = '2026-09-21T04:00:00Z'; // 00:00 ET on 09-21: the first instant
  const OPENING = '2026-09-21T13:35:00Z'; // 09:35 ET on 09-21
  const LAST_MINUTE = '2026-09-22T03:59:00Z'; // 23:59 ET on 09-21
  const AFTER = '2026-09-22T04:00:00Z'; // 00:00 ET on 09-22: the first instant out

  beforeEach(async () => {
    const all = [BEFORE, MIDNIGHT, OPENING, LAST_MINUTE, AFTER];
    for (const [i, firedAt] of all.entries()) {
      await seedFire(firedAt, { node: 6500 + i });
    }
  });

  const filled = async (): Promise<string[]> =>
    (
      await pg.query<{ fired_at: Date }>(
        `SELECT fired_at FROM ws_gamma_setup_fires
         WHERE ret_30m IS NOT NULL ORDER BY fired_at`,
      )
    ).rows.map((r) => r.fired_at.toISOString());

  it('fills exactly the fires of the explicit ET day, both of its edges included', async () => {
    expect(
      await run(
        '--outcomes-only',
        '--from',
        '2026-09-21',
        '--to',
        '2026-09-21',
      ),
    ).toBe(0);

    expect(await filled()).toEqual([
      new Date(MIDNIGHT).toISOString(),
      new Date(OPENING).toISOString(),
      new Date(LAST_MINUTE).toISOString(),
    ]);
    expect(logged()).toMatch(/outcome-backfill: 3 pending fires/);
  });

  it('fills every pending fire when no window is passed', async () => {
    expect(await run('--outcomes-only')).toBe(0);

    expect(await filled()).toHaveLength(5);
    expect(logged()).toMatch(/outcome-backfill: 5 pending fires/);
  });
});

describe('--context-only against real SQL', () => {
  const dayContext = (now: Date): DayContext => {
    const monday = now.toISOString().startsWith('2026-09-14');
    return {
      today: now.toISOString().slice(0, 10),
      dow_label: monday ? 'Monday' : 'Tuesday',
      day_open: 6500,
      prior_close: 6490,
      open_gap_pct: -0.14,
      prior_5d_ret: -0.0115,
      prior_iv_rank: 31,
      pre_day_filter_fires: true,
      is_fomc_day: false,
      is_dom_1_5: false,
      is_dom_16_20: false,
    };
  };

  interface Stored {
    fired_at: Date;
    prior_5d_ret: number | null;
    prior_iv_rank: number | null;
    pre_day_filter_fires: boolean;
    open_gap_pct: number | null;
    confidence_tier: string;
    dow_label: string;
    ret_30m: number | null;
    bar_close: number;
  }

  const stored = async (): Promise<Stored[]> =>
    (
      await pg.query<Stored>(
        `SELECT fired_at, prior_5d_ret::float8 AS prior_5d_ret,
                prior_iv_rank::float8 AS prior_iv_rank, pre_day_filter_fires,
                open_gap_pct::float8 AS open_gap_pct, confidence_tier, dow_label,
                ret_30m::float8 AS ret_30m, bar_close::float8 AS bar_close
         FROM ws_gamma_setup_fires ORDER BY fired_at`,
      )
    ).rows;

  const UNTOUCHED = {
    prior_5d_ret: 0.0195,
    prior_iv_rank: 30,
    pre_day_filter_fires: false,
    open_gap_pct: 2.81,
    confidence_tier: 'HIGH',
  };

  it('rewrites the five context columns of the fires on each ET date in the window, and no others', async () => {
    mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
      dayContext(now),
    );
    await seedFire('2026-09-14T13:40:00Z', { ret30: 1.5 }); // 09-14 09:40 ET
    // 21:00 ET on 09-14: the UTC date is already 09-15, the ET session is 09-14.
    await seedFire('2026-09-15T01:00:00Z', { ret30: 2.5, node: 6501 });
    await seedFire('2026-09-15T14:00:00Z', { ret30: -3 }); // 09-15 10:00 ET
    await seedFire('2026-09-16T14:00:00Z', { ret30: 4 }); // 09-16: outside

    expect(
      await run('--context-only', '--from', '2026-09-14', '--to', '2026-09-15'),
    ).toBe(0);

    const rows = await stored();
    expect(rows.map((r) => r.confidence_tier)).toEqual([
      'MAXIMUM',
      'MAXIMUM',
      'MEDIUM',
      'HIGH',
    ]);
    // The first three carry the new context; the 09-16 fire is exactly as seeded.
    for (const row of rows.slice(0, 3)) {
      expect(row).toMatchObject({
        prior_5d_ret: -0.0115,
        prior_iv_rank: 31,
        pre_day_filter_fires: true,
        open_gap_pct: -0.14,
      });
    }
    expect(rows[3]).toMatchObject(UNTOUCHED);
    // Nothing else moved.
    expect(rows.map((r) => r.ret_30m)).toEqual([1.5, 2.5, -3, 4]);
    expect(rows.map((r) => r.bar_close)).toEqual([
      6500.5, 6500.5, 6500.5, 6500.5,
    ]);
    expect(rows.map((r) => r.dow_label)).toEqual([
      'Monday',
      'Monday',
      'Monday',
      'Monday',
    ]);
    expect(logged()).toMatch(/^2026-09-14 {2}2 {2}2$/m);
    expect(logged()).toMatch(/^2026-09-15 {2}1 {2}1$/m);
  });

  it('keeps the edges of an EST day (05:00Z) and reads nothing outside it', async () => {
    mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
      dayContext(now),
    );
    await seedFire('2026-02-27T04:59:00Z'); // 23:59 ET on 02-26: outside
    await seedFire('2026-02-27T05:00:00Z', { node: 6501 }); // 00:00 ET on 02-27
    await seedFire('2026-02-28T04:59:00Z', { node: 6502 }); // 23:59 ET on 02-27
    await seedFire('2026-02-28T05:00:00Z', { node: 6503 }); // 00:00 ET on 02-28: outside

    expect(
      await run('--context-only', '--from', '2026-02-27', '--to', '2026-02-27'),
    ).toBe(0);

    const tiers = (await stored()).map((r) => r.confidence_tier);
    expect(tiers).toEqual(['HIGH', 'MEDIUM', 'MEDIUM', 'HIGH']);
    expect(mockLoadDayContext).toHaveBeenCalledTimes(1);
    // 12:00 EST is 17:00Z.
    expect(mockLoadDayContext.mock.calls[0]?.[1]).toEqual(
      new Date('2026-02-27T17:00:00Z'),
    );
  });

  it('finds a date whose only fire is stamped at the first instant of its ET day', async () => {
    mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
      dayContext(now),
    );
    await seedFire('2026-02-27T05:00:00Z'); // 00:00 ET on 02-27

    expect(
      await run('--context-only', '--from', '2026-02-27', '--to', '2026-02-27'),
    ).toBe(0);

    expect(logged()).toMatch(/^2026-02-27 {2}1 {2}1$/m);
    expect((await stored())[0]?.confidence_tier).toBe('MEDIUM');
  });

  it('writes nothing under --dry-run, and reads the stored values it prints', async () => {
    mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
      dayContext(now),
    );
    await seedFire('2026-09-14T13:40:00Z');

    expect(
      await run(
        '--context-only',
        '--dry-run',
        '--from',
        '2026-09-14',
        '--to',
        '2026-09-14',
      ),
    ).toBe(0);

    expect((await stored())[0]).toMatchObject(UNTOUCHED);
    expect(logged()).toMatch(
      /prior_5d_ret\s+stored 0\.0195\s+new -0\.0115\s+CHANGED/,
    );
    expect(logged()).toMatch(/prior_iv_rank\s+stored 30\s+new 31\s+CHANGED/);
  });
});
