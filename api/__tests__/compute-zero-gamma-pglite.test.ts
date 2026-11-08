// @vitest-environment node

/**
 * REAL-SQL test for compute-zero-gamma's row key (R6) and its sign-flip read.
 *
 * cron-compute-zero-gamma.test.ts mocks the db and can only match the SQL
 * text. Here the cron's ACTUAL statements run against pglite (real Postgres in
 * WASM) with the tables built from the real migrations: #8 strike_exposures,
 * #82 zero_gamma_levels and #98, whose unique index (ticker, ts) is what
 * `ON CONFLICT (ticker, ts) DO NOTHING` needs. #98 also touches the tables
 * made by #83, #84, #87 and #97, so those are applied first.
 *
 * Two ladders and a repeat of each go through the whole handler. Expected:
 *   - one zero_gamma_levels row per LADDER, labelled with the END of the
 *     ladder's 5-minute bucket (not the compute time);
 *   - the second run of an unchanged ladder writes nothing;
 *   - the sign-flip read sees the EARLIER ladder (`ts <`), so a flip between
 *     the two ladders is logged exactly once. With `ts <=` it would read the
 *     row just written and never see a flip.
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

const holder = vi.hoisted(() => ({ sql: null as unknown }));

// The cron's db handle is the pglite one; withDbRetry is the real one.
vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb: () => holder.sql,
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
    addBreadcrumb: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

import handler from '../cron/compute-zero-gamma.js';
import { Sentry } from '../_lib/sentry.js';
import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations.js';

let pg: PGlite;

const TODAY = '2026-03-24'; // Tuesday, EDT (UTC-4)
const LADDER_A = '2026-03-24T13:50:00.000Z'; // 09:50 ET bucket
const LADDER_B = '2026-03-24T13:55:00.000Z'; // 09:55 ET bucket
const LABEL_A = '2026-03-24T13:55:00.000Z';
const LABEL_B = '2026-03-24T14:00:00.000Z';

/** A put-heavy-below / call-heavy-above chain: net long gamma at spot. */
const CHAIN: Array<[number, number, number]> = [
  [7095, 0, 1_000_000_000],
  [7100, 0, 1_500_000_000],
  [7105, 0, 0],
  [7110, -1_500_000_000, 0],
  [7115, -1_000_000_000, 0],
];

async function seedLadder(ts: string, sign: 1 | -1): Promise<void> {
  for (const [strike, call, put] of CHAIN) {
    await pg.query(
      `INSERT INTO strike_exposures
         (date, timestamp, ticker, expiry, strike, price, call_gamma_oi, put_gamma_oi)
       VALUES ($1, $2, 'SPX', $1, $3, 7105, $4, $5)`,
      [TODAY, ts, strike, sign * call, sign * put],
    );
  }
}

async function runCron(at: string) {
  vi.setSystemTime(new Date(at));
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  expect(res._status).toBe(200);
  return res._json as {
    status: string;
    perTicker: Record<
      string,
      { stored: boolean; reason?: string; skip?: string }
    >;
  };
}

async function levels(): Promise<
  Array<{ ticker: string; ts: string; net: number }>
> {
  const { rows } = await pg.query<{
    ticker: string;
    ts: Date;
    net: string;
  }>(
    `SELECT ticker, ts, net_gamma_at_spot::float8 AS net
       FROM zero_gamma_levels ORDER BY ticker, ts`,
  );
  return rows.map((r) => ({
    ticker: r.ticker,
    ts: r.ts.toISOString(),
    net: Number(r.net),
  }));
}

const originalSecret = process.env.CRON_SECRET;

beforeAll(async () => {
  pg = await PGlite.create();
  holder.sql = neonOverPglite(pg);
  for (const id of [8, 82, 83, 84, 87, 97, 98]) await applyMigration(pg, id);
  process.env.CRON_SECRET = 'test-secret';
});

afterAll(async () => {
  await pg.close();
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec('DELETE FROM zero_gamma_levels; DELETE FROM strike_exposures');
});

describe('compute-zero-gamma against real Postgres', () => {
  it('has the unique index on (ticker, ts) that the ON CONFLICT clause needs', async () => {
    const { rows } = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'uniq_zero_gamma_levels_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/UNIQUE.*\(ticker, ts\)/);
  });

  it('writes one row per ladder, labelled with the bucket end, and none for a repeat', async () => {
    await seedLadder(LADDER_A, 1);

    // 09:54 ET: the first run computes ladder A.
    const first = await runCron('2026-03-24T13:54:00.000Z');
    expect(first.perTicker.SPX).toMatchObject({ stored: true });
    expect(await levels()).toEqual([
      { ticker: 'SPX', ts: LABEL_A, net: expect.any(Number) },
    ]);

    // 09:59 ET: ladder A is still the newest (fetch-strike-exposure stored
    // nothing newer). Recomputing it hits ON CONFLICT and writes nothing.
    const repeat = await runCron('2026-03-24T13:59:00.000Z');
    expect(repeat.perTicker.SPX).toMatchObject({
      stored: false,
      reason: 'ladder already stored',
    });
    expect(repeat.status).toBe('skipped');
    expect(await levels()).toHaveLength(1);

    // Ladder B arrives and is computed; its repeat writes nothing either.
    await seedLadder(LADDER_B, 1);
    await runCron('2026-03-24T14:04:00.000Z');
    await runCron('2026-03-24T14:04:30.000Z');
    expect((await levels()).map((l) => l.ts)).toEqual([LABEL_A, LABEL_B]);
  });

  it('reads the previous ladder for the sign-flip check, so a flip between two ladders is logged once', async () => {
    // Ladder A first (the only one the cron has seen): net long gamma.
    await seedLadder(LADDER_A, 1);
    await runCron('2026-03-24T13:54:00.000Z');
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();

    // Five minutes later ladder B arrives: net short, the regime flipped.
    await seedLadder(LADDER_B, -1);
    await runCron('2026-03-24T14:04:00.000Z');

    const stored = await levels();
    expect(stored.map((l) => l.ts)).toEqual([LABEL_A, LABEL_B]);
    // The ladders really do have opposite net-gamma signs.
    expect(Math.sign(stored[0]!.net)).toBe(1);
    expect(Math.sign(stored[1]!.net)).toBe(-1);
    // The flip read saw ladder A (ts < B's label): one flip, logged once.
    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
    const [crumb] = vi.mocked(Sentry.addBreadcrumb).mock.calls[0]!;
    expect(crumb).toMatchObject({
      category: 'dealer-regime',
      data: { ticker: 'SPX' },
    });
    // Previous ladder long (read from the table), new ladder short.
    const data = crumb.data as { prevNetGamma: number; newNetGamma: number };
    expect(data.prevNetGamma).toBeGreaterThan(0);
    expect(data.newNetGamma).toBeLessThan(0);

    // A repeat of ladder B stores nothing and logs no second flip.
    await runCron('2026-03-24T14:04:30.000Z');
    expect(await levels()).toHaveLength(2);
    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
  });
});
