// @vitest-environment node

/**
 * fetch-market-internals end to end over REAL SQL: the handler, the settle
 * rules and the upsert run unchanged against pglite (real Postgres in WASM) on
 * the table built by the real migrations #63 and #64. Only Schwab, the logger,
 * Sentry and Axiom are mocked, at their modules. The mocked-database cron
 * tests (fetch-market-internals.test.ts) can only match SQL text; here the
 * stored rows decide the counts, the replaced values and the alert.
 *
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5)
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

import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('../_lib/db.js', () => ({
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/schwab-fetch.js', () => ({
  schwabFetch: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/fetch-market-internals.js';
import { Sentry } from '../_lib/sentry.js';
import { schwabFetch } from '../_lib/schwab-fetch.js';
import type { InternalSymbol } from '../../src/types/market-internals.js';

// Friday 2026-11-06 17:30 ET (EST): the five sessions are 11-02 .. 11-06.
const SETTLE_TIME = new Date('2026-11-06T22:30:00.000Z');
const SESSIONS = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
];
const SYMBOLS: InternalSymbol[] = ['$TICK', '$ADD', '$VOLD', '$TRIN'];
const MIN = 60_000;

type Ohlc = [number, number, number, number];
interface Bar {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** What the settled series looks like, per symbol. */
const settled = (symbol: InternalSymbol, i: number): Ohlc => {
  if (symbol === '$TICK') {
    return i % 3 === 0 ? [50, 120, -80, -40] : [30, 90, 10, 60];
  }
  if (symbol === '$TRIN') return [0.8, 0.9, 0.7, 0.83];
  if (symbol === '$VOLD') return [1e8 + i, 1.1e8 + i, 9e7 + i, 1.05e8 + i];
  return [300 + i, 320 + i, 280 + i, 310 + i];
};

const dayBars = (
  day: string,
  symbol: InternalSymbol,
  make: (symbol: InternalSymbol, i: number) => Ohlc = settled,
): Bar[] => {
  const start = Date.parse(`${day}T14:30:00Z`);
  return Array.from({ length: 390 }, (_, i) => {
    const [open, high, low, close] = make(symbol, i);
    return { datetime: start + i * MIN, open, high, low, close };
  });
};

/** Schwab's answer for every symbol; `make` may change a symbol-day. */
function mockSchwab(
  make: (symbol: InternalSymbol, day: string) => Bar[] = (symbol, day) =>
    dayBars(day, symbol),
) {
  vi.mocked(schwabFetch).mockImplementation(((path: string) => {
    const symbol = new URLSearchParams(path.split('?')[1]).get(
      'symbol',
    ) as InternalSymbol;
    return Promise.resolve({
      ok: true as const,
      data: {
        symbol,
        empty: false,
        candles: SESSIONS.flatMap((day) => make(symbol, day)),
      },
    });
  }) as never);
}

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await applyMigration(pg, 63);
  await applyMigration(pg, 64);
  await pg.query(`SET TimeZone = 'UTC'`);
  const base = neonOverPglite(pg);
  type Txn = typeof base;
  holder.sql = Object.assign(
    (strings: TemplateStringsArray, ...params: unknown[]) =>
      base(strings, ...params),
    {
      transaction: (queries: unknown) =>
        base.transaction(
          typeof queries === 'function'
            ? (queries as (txn: Txn) => Parameters<Txn['transaction']>[0])(base)
            : (queries as Parameters<Txn['transaction']>[0]),
        ),
    },
  );
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('TRUNCATE market_internals');
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SETTLE_TIME);
  process.env.CRON_SECRET = 'test-secret';
  mockSchwab();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Store `bars` as `symbol` rows (what an earlier run, or the old cron, left). */
async function seed(symbol: InternalSymbol, bars: Bar[]): Promise<void> {
  await pg.query(
    `INSERT INTO market_internals (ts, symbol, open, high, low, close)
     SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::numeric[],
                          $4::numeric[], $5::numeric[], $6::numeric[])`,
    [
      bars.map((b) => new Date(b.datetime).toISOString()),
      bars.map(() => symbol),
      bars.map((b) => b.open),
      bars.map((b) => b.high),
      bars.map((b) => b.low),
      bars.map((b) => b.close),
    ],
  );
}

const run = async () => {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: {},
    } as never),
    res,
  );
  return res._json as {
    status: string;
    inserted: number;
    updated: number;
    unchanged: number;
    problems: Array<{ symbol: string; date: string; kind: string }>;
    pending: Array<{ symbol: string; date: string; kind: string }>;
    allZero: Array<{ symbol: string; date: string }>;
    results: Array<{
      symbol: string;
      inserted: number;
      updated: number;
      unchanged: number;
    }>;
  };
};

const count = async (where = 'TRUE'): Promise<number> =>
  Number(
    (
      await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM market_internals WHERE ${where}`,
      )
    ).rows[0]!.n,
  );

describe('fetch-market-internals over real SQL', () => {
  it('happy path: one session already right, one stored wrong, three new, counted apart', async () => {
    // 11-02 stored exactly as Schwab settled it.
    for (const symbol of SYMBOLS)
      await seed(symbol, dayBars('2026-11-02', symbol));
    // 11-03 stored the way the old cron wrote it.
    await seed(
      '$TICK',
      dayBars('2026-11-03', '$TICK', (_s, i) => {
        const [o, h, l, c] = settled('$TICK', i);
        return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
      }),
    );
    await seed(
      '$ADD',
      dayBars('2026-11-03', '$ADD', () => [0, 0, 0, 0]),
    );
    await seed(
      '$VOLD',
      dayBars('2026-11-03', '$VOLD', () => [0, 0, 0, 0]),
    );
    await seed(
      '$TRIN',
      dayBars('2026-11-03', '$TRIN', () => [0.0026, 0.0026, 0.0026, 0.0026]),
    );

    const out = await run();

    expect(out.status).toBe('success');
    // Clamping changed only the 130 negative minutes of $TICK's 11-03; its
    // other 260 bars were already right.
    expect(out.inserted).toBe(4 * 3 * 390);
    expect(out.updated).toBe(3 * 390 + 130);
    expect(out.unchanged).toBe(4 * 390 + 260);
    expect(
      out.results.map((r) => [r.symbol, r.inserted, r.updated, r.unchanged]),
    ).toEqual([
      ['$TICK', 3 * 390, 130, 390 + 260],
      ['$ADD', 3 * 390, 390, 390],
      ['$VOLD', 3 * 390, 390, 390],
      ['$TRIN', 3 * 390, 390, 390],
    ]);
    expect(await count()).toBe(4 * 5 * 390);
    expect(out.problems).toEqual([]);
    expect(out.allZero).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('replaces the stored clamped $TICK, zero $ADD/$VOLD and wrong-scale $TRIN rows with the settled values', async () => {
    const day = '2026-11-03';
    await seed(
      '$TICK',
      dayBars(day, '$TICK', () => [0, 0, 0, 0]),
    );
    await seed(
      '$ADD',
      dayBars(day, '$ADD', () => [0, 0, 0, 0]),
    );
    await seed(
      '$TRIN',
      dayBars(day, '$TRIN', () => [0.0026, 0.0026, 0.0026, 0.0026]),
    );

    await run();

    // Every 11-03 row of every symbol is now the settled value.
    const { rows } = await pg.query<{
      symbol: string;
      n: number;
      wrong: number;
    }>(
      `SELECT symbol, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE
                (symbol = '$ADD' AND close <> 310 + (EXTRACT(EPOCH FROM ts - '2026-11-03T14:30Z'::timestamptz) / 60))
                OR (symbol = '$TRIN' AND close <> 0.83)
              )::int AS wrong
         FROM market_internals
        WHERE ts >= '2026-11-03T14:30Z' AND ts < '2026-11-03T21:00Z'
        GROUP BY symbol ORDER BY symbol`,
    );
    expect(rows.map((r) => [r.symbol, r.n, r.wrong])).toEqual([
      ['$ADD', 390, 0],
      ['$TICK', 390, 0],
      ['$TRIN', 390, 0],
      ['$VOLD', 390, 0],
    ]);
    const negatives = await count(
      `symbol = '$TICK' AND ts >= '2026-11-03T14:30Z' AND ts < '2026-11-03T21:00Z' AND low < 0`,
    );
    expect(negatives).toBe(130);
  });

  it('a second run changes nothing and reports success', async () => {
    await run();
    const before = await pg.query<{ xmin: string }>(
      `SELECT xmin::text FROM market_internals ORDER BY symbol, ts`,
    );

    const again = await run();

    expect(again.status).toBe('success');
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(4 * 5 * 390);
    const after = await pg.query<{ xmin: string }>(
      `SELECT xmin::text FROM market_internals ORDER BY symbol, ts`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('leaves rows outside the session alone (the repair of those is a separate, approved step)', async () => {
    await pg.query(
      `INSERT INTO market_internals (ts, symbol, open, high, low, close) VALUES
         ('2026-11-03T23:30:00Z', '$ADD', 0, 0, 0, 0),
         ('2026-11-03T13:00:00Z', '$VOLD', 0, 0, 0, 0)`,
    );

    await run();

    expect(
      await count(`ts IN ('2026-11-03T23:30:00Z', '2026-11-03T13:00:00Z')`),
    ).toBe(2);
  });

  it('F9 regression: $ADD stored all zero is alerted by name although $TICK is healthy', async () => {
    // Schwab's $ADD for 11-06 is all zero (every bar rejected), and the table
    // still holds the old zero rows for it. $TICK is fine.
    await seed(
      '$ADD',
      dayBars('2026-11-06', '$ADD', () => [0, 0, 0, 0]),
    );
    mockSchwab((symbol, day) =>
      symbol === '$ADD' && day === '2026-11-06'
        ? dayBars(day, symbol, () => [0, 0, 0, 0])
        : dayBars(day, symbol),
    );

    const out = await run();

    // Partial because of the stored all-zero rows (the old cron's, from before
    // the settle). Today's incomplete $ADD is pending, not a second alert.
    expect(out.status).toBe('partial');
    expect(out.allZero).toEqual([
      expect.objectContaining({ symbol: '$ADD', date: '2026-11-06' }),
    ]);
    expect(out.problems).toEqual([]);
    expect(out.pending).toEqual([
      expect.objectContaining({
        symbol: '$ADD',
        date: '2026-11-06',
        kind: 'incomplete',
      }),
    ]);
    const alert = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.find(
        ([, o]) =>
          (o as { tags: { stage: string } }).tags.stage === 'symbol_all_zero',
      );
    expect(alert).toBeDefined();
    expect((alert![1] as { level: string }).level).toBe('error');
    // The other three symbols were still settled.
    expect(await count(`symbol <> '$ADD'`)).toBe(3 * 5 * 390);
    expect(await count(`symbol = '$ADD' AND close <> 0`)).toBe(4 * 390);
  });

  it('a clamped $TICK session is refused and the stored rows stay as they were', async () => {
    const clamped = (symbol: InternalSymbol, i: number): Ohlc => {
      const [o, h, l, c] = settled(symbol, i);
      return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
    };
    // 11-05, a night old: a real problem, so an error and a partial run.
    mockSchwab((symbol, day) =>
      symbol === '$TICK' && day === '2026-11-05'
        ? dayBars(day, symbol, clamped)
        : dayBars(day, symbol),
    );

    const out = await run();

    expect(out.status).toBe('partial');
    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$TICK',
        date: '2026-11-05',
        kind: 'tick_clamped',
      }),
    ]);
    expect(out.pending).toEqual([]);
    expect(
      await count(
        `symbol = '$TICK' AND ts >= '2026-11-05T14:30Z' AND ts < '2026-11-06T14:30Z'`,
      ),
    ).toBe(0);
    expect(await count(`symbol = '$TICK'`)).toBe(4 * 390);
  });

  it("today's own clamped $TICK session is pending: not stored, not an error, the run is a success", async () => {
    // The 2026-11-10 pattern: at 22:30 UTC Schwab's same-day $TICK series is
    // not final yet (clamped), and the next evening's run heals it.
    const clamped = (symbol: InternalSymbol, i: number): Ohlc => {
      const [o, h, l, c] = settled(symbol, i);
      return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
    };
    mockSchwab((symbol, day) =>
      symbol === '$TICK' && day === '2026-11-06'
        ? dayBars(day, symbol, clamped)
        : dayBars(day, symbol),
    );

    const out = await run();

    expect(out.status).toBe('success');
    expect(out.problems).toEqual([]);
    expect(out.pending).toEqual([
      expect.objectContaining({
        symbol: '$TICK',
        date: '2026-11-06',
        kind: 'tick_clamped',
      }),
    ]);
    expect(
      vi
        .mocked(Sentry.captureMessage)
        .mock.calls.filter(
          ([, o]) =>
            (o as { tags: { stage: string } }).tags.stage === 'session_problem',
        ),
    ).toEqual([]);
    // The clamped session is still refused: nothing of it is stored.
    expect(await count(`symbol = '$TICK' AND ts >= '2026-11-06T14:30Z'`)).toBe(
      0,
    );
    expect(await count(`symbol = '$TICK'`)).toBe(4 * 390);
  });
});
