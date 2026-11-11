// @vitest-environment node

/**
 * scripts/_lib/market-internals-backfill.ts: the arguments, the window, the
 * Schwab request, the dry run that reads and prints without writing, and the
 * apply that upserts. The database is REAL SQL on pglite (the table built by
 * the real migrations #63 and #64); Schwab is a stubbed `fetch`. Nothing here
 * reaches Neon, Upstash or Schwab.
 *
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.5, Tier 2)
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

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations';

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  fetchPriceHistory,
  formatReport,
  parseArgs,
  resolveSessions,
  runBackfill,
  type CliArgs,
} from './market-internals-backfill.js';
import { SettleFailure } from '../../api/_lib/market-internals-settle.js';
import { SCHWAB_BASE } from './schwab-local.mjs';

const MIN = 60_000;
const SESSIONS = ['2026-11-05', '2026-11-06'];
const SYMBOLS = ['$TICK', '$ADD', '$VOLD', '$TRIN'] as const;
type Symbol4 = (typeof SYMBOLS)[number];

type Ohlc = [number, number, number, number];
interface Bar {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const settled = (symbol: Symbol4, i: number): Ohlc => {
  if (symbol === '$TICK') {
    return i % 3 === 0 ? [50, 120, -80, -40] : [30, 90, 10, 60];
  }
  if (symbol === '$TRIN') return [0.8, 0.9, 0.7, 0.83];
  return [300 + i, 320 + i, 280 + i, 310 + i];
};

const dayBars = (
  day: string,
  symbol: Symbol4,
  make: (symbol: Symbol4, i: number) => Ohlc = settled,
  count = 390,
): Bar[] => {
  const start = Date.parse(`${day}T14:30:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const [open, high, low, close] = make(symbol, i);
    return { datetime: start + i * MIN, open, high, low, close };
  });
};

/** Route the stubbed fetch by the symbol in the URL. */
function stubSchwab(
  make: (symbol: Symbol4, day: string) => Bar[] = (symbol, day) =>
    dayBars(day, symbol),
  onRequest?: (url: string, init: RequestInit) => Response | undefined,
) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const custom = onRequest?.(url, init);
    if (custom !== undefined) return custom;
    const symbol = new URL(url).searchParams.get('symbol') as Symbol4;
    return new Response(
      JSON.stringify({
        symbol,
        empty: false,
        candles: SESSIONS.flatMap((day) => make(symbol, day)),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(symbol: Symbol4, bars: Bar[]): Promise<void> {
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

/** Every stored row, with the xmin that shows a rewrite. */
const snapshot = async () =>
  (
    await pg.query<{ symbol: string; ts: string; close: number; xmin: string }>(
      `SELECT symbol, ts::text AS ts, close::float8 AS close, xmin::text AS xmin
         FROM market_internals ORDER BY symbol, ts`,
    )
  ).rows;

const token = () => Promise.resolve('access-token');

/** The old cron's wrong rows for 11-05: clamped $TICK, zero $ADD. */
async function seedWrongRows(): Promise<void> {
  await seed(
    '$TICK',
    dayBars('2026-11-05', '$TICK', (s, i) => {
      const [o, h, l, c] = settled(s, i);
      return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
    }),
  );
  await seed(
    '$ADD',
    dayBars('2026-11-05', '$ADD', () => [0, 0, 0, 0]),
  );
}

// ── arguments ───────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to a dry run of the cron window', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      from: null,
      to: null,
      allowMarketHours: false,
      envFile: null,
    });
  });

  it('reads --apply, --from, --to, --allow-market-hours and --env-file', () => {
    expect(
      parseArgs([
        '--from',
        '2026-09-21',
        '--to',
        '2026-10-30',
        '--apply',
        '--allow-market-hours',
        '--env-file',
        'some.env',
      ]),
    ).toEqual({
      apply: true,
      from: '2026-09-21',
      to: '2026-10-30',
      allowMarketHours: true,
      envFile: 'some.env',
    });
  });

  it('accepts --dry-run on its own', () => {
    expect(parseArgs(['--dry-run']).apply).toBe(false);
  });

  it.each([
    [['--apply', '--dry-run'], '--apply and --dry-run contradict'],
    [['--from'], '--from needs a value'],
    [['--from', '--apply'], '--from needs a value'],
    [['--from', '2026-13-01'], '--from must be YYYY-MM-DD'],
    [['--to', 'tomorrow', '--from', '2026-10-01'], '--to must be YYYY-MM-DD'],
    [['--to', '2026-10-30'], '--to needs --from'],
    [['--from', '2026-10-30', '--to', '2026-10-01'], '--from is after --to'],
    [['--env-file'], '--env-file needs a value'],
    [['--wat'], 'unknown argument --wat'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('resolveSessions', () => {
  const NOW = new Date('2026-11-06T22:30:00Z');
  const args = (overrides: Partial<CliArgs>): CliArgs => ({
    ...parseArgs([]),
    ...overrides,
  });

  it("without --from: the cron's own window, the last five sessions", () => {
    expect(resolveSessions(args({}), NOW)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('--from and --to: the trading days between them, weekends and holidays left out', () => {
    // Thanksgiving (11-26) and the weekend are not sessions.
    expect(
      resolveSessions(
        args({ from: '2026-11-20', to: '2026-11-27' }),
        new Date('2026-11-30T15:00:00Z'),
      ),
    ).toEqual([
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
  });

  it('--from alone runs up to the newest settled session', () => {
    expect(resolveSessions(args({ from: '2026-11-05' }), NOW)).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('refuses a session still being traded', () => {
    // 20:00Z on Friday 11-06 is 15:00 ET: the session is not over.
    expect(() =>
      resolveSessions(
        args({ from: '2026-11-05', to: '2026-11-06' }),
        new Date('2026-11-06T20:00:00Z'),
      ),
    ).toThrow('is after the newest settled session 2026-11-05');
  });

  it('refuses a window with no trading day', () => {
    // A Saturday and a Sunday.
    expect(() =>
      resolveSessions(args({ from: '2026-10-31', to: '2026-11-01' }), NOW),
    ).toThrow('no trading day from 2026-10-31 to 2026-11-01');
  });
});

// ── the Schwab request ──────────────────────────────────────

describe('fetchPriceHistory', () => {
  it('sends a bearer token to the Schwab market-data base and returns the JSON', async () => {
    const fetchMock = stubSchwab(undefined, () =>
      Response.json({ candles: [1] }),
    );

    const out = await fetchPriceHistory(
      '/pricehistory?symbol=%24TICK',
      'tok-1',
    );

    expect(out).toEqual({ candles: [1] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SCHWAB_BASE}/pricehistory?symbol=%24TICK`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-1',
    );
  });

  it('names a non-2xx answer and masks token-like text in its body', async () => {
    const leak = 'T0kenLikeRun'.repeat(4).slice(0, 40);
    stubSchwab(
      undefined,
      () => new Response(`{"echo":"${leak}"}`, { status: 403 }),
    );

    await expect(fetchPriceHistory('/pricehistory', 'tok')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof SettleFailure &&
        err.kind === 'schwab_error' &&
        err.message.includes('Schwab pricehistory 403') &&
        err.message.includes('[redacted]') &&
        !err.message.includes(leak),
    );
  });

  it('names a body that is not JSON', async () => {
    stubSchwab(undefined, () => new Response('<html>', { status: 200 }));
    await expect(
      fetchPriceHistory('/pricehistory', 'tok'),
    ).rejects.toMatchObject({ kind: 'malformed_payload' });
  });

  it('names a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    await expect(
      fetchPriceHistory('/pricehistory', 'tok'),
    ).rejects.toMatchObject({
      kind: 'schwab_error',
      message: 'Schwab pricehistory request failed: socket hang up',
    });
  });
});

// ── the run ─────────────────────────────────────────────────

describe('runBackfill: dry run (the default)', () => {
  it('prints per-day counts from what is stored and writes nothing', async () => {
    await seedWrongRows();
    const before = await snapshot();
    stubSchwab();

    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(report.apply).toBe(false);
    expect(report.failures).toEqual([]);
    // 11-05: $TICK has 130 clamped minutes to replace and 260 right ones,
    // $ADD is 390 zero rows to replace, $VOLD and $TRIN are new. 11-06: all new.
    expect(
      report.days.map((d) => [d.date, d.inserted, d.updated, d.unchanged]),
    ).toEqual([
      ['2026-11-05', 2 * 390, 130 + 390, 260],
      ['2026-11-06', 4 * 390, 0, 0],
    ]);
    // Nothing was written: the same rows, none rewritten.
    expect(await snapshot()).toEqual(before);
  });

  it('counts the all-zero bars it rejects, per day', async () => {
    stubSchwab((symbol, day) => {
      const bars = dayBars(day, symbol);
      if (symbol === '$ADD' && day === '2026-11-06') {
        bars[3] = { ...bars[3]!, open: 0, high: 0, low: 0, close: 0 };
        bars[4] = { ...bars[4]!, open: 0, high: 0, low: 0, close: 0 };
      }
      return bars;
    });

    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(report.days.map((d) => [d.date, d.rejectedZero])).toEqual([
      ['2026-11-05', 0],
      ['2026-11-06', 2],
    ]);
    expect(report.days[1]!.problems).toEqual([
      expect.objectContaining({
        symbol: '$ADD',
        kind: 'incomplete',
        bars: 388,
        zeroBars: 2,
      }),
    ]);
  });

  it('reports a clamped $TICK session as refused', async () => {
    stubSchwab((symbol, day) =>
      symbol === '$TICK' && day === '2026-11-06'
        ? dayBars(day, symbol, (s, i) => {
            const [o, h, l, c] = settled(s, i);
            return [
              Math.max(o, 0),
              Math.max(h, 0),
              Math.max(l, 0),
              Math.max(c, 0),
            ];
          })
        : dayBars(day, symbol),
    );

    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(report.days[1]!.problems).toEqual([
      expect.objectContaining({ symbol: '$TICK', kind: 'tick_clamped' }),
    ]);
    // Its 390 bars are not counted as rows to write.
    expect(report.days[1]!.inserted).toBe(3 * 390);
  });
});

describe('runBackfill: --apply', () => {
  it('writes what the dry run predicted, replacing the wrong rows, and a second run changes nothing', async () => {
    await seedWrongRows();
    stubSchwab();
    const dry = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    const applied = await runBackfill({
      apply: true,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(applied.apply).toBe(true);
    expect(applied.days).toEqual(dry.days);
    const { rows } = await pg.query<{ n: number; zero: number; neg: number }>(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE symbol = '$ADD' AND close = 0)::int AS zero,
              COUNT(*) FILTER (WHERE symbol = '$TICK' AND low < 0)::int AS neg
         FROM market_internals`,
    );
    expect(rows[0]).toEqual({ n: 4 * 2 * 390, zero: 0, neg: 2 * 130 });

    const before = await snapshot();
    const again = await runBackfill({
      apply: true,
      sessions: SESSIONS,
      getToken: token,
    });
    expect(again.days.map((d) => [d.inserted, d.updated])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(await snapshot()).toEqual(before);
  });
});

describe('runBackfill: failures are named, and the other symbols still run', () => {
  it('a Schwab 403 on one symbol', async () => {
    stubSchwab(undefined, (url) =>
      url.includes('%24VOLD')
        ? new Response('nope', { status: 403 })
        : undefined,
    );

    const report = await runBackfill({
      apply: true,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(report.failures).toEqual([
      {
        symbol: '$VOLD',
        failure: 'schwab_error',
        error: expect.stringContaining('Schwab pricehistory 403'),
      },
    ]);
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM market_internals WHERE symbol = '$VOLD'`,
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM market_internals WHERE symbol = '$ADD'`,
        )
      ).rows[0]!.n,
    ).toBe(2 * 390);
  });

  it('an empty answer', async () => {
    stubSchwab(undefined, () =>
      Response.json({ symbol: '$X', empty: true, candles: [] }),
    );
    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });
    expect(report.failures.map((f) => f.failure)).toEqual(
      SYMBOLS.map(() => 'empty_payload'),
    );
  });

  it('a token that cannot be had: every symbol fails, no request is made', async () => {
    const fetchMock = stubSchwab();
    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: () => Promise.reject(new Error('No Schwab tokens in Redis')),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.failures).toHaveLength(4);
    expect(report.failures[0]).toMatchObject({
      failure: 'schwab_error',
      error: 'No Schwab tokens in Redis',
    });
  });

  it('a throw from our own planning is named unexpected, not schwab_error, and the other symbols still run', async () => {
    // Schwab answers fine; one $VOLD bar carries a finite time that is not a
    // date (new Date(1e20) is invalid), so planning throws a RangeError.
    stubSchwab((symbol, day) =>
      symbol === '$VOLD' && day === SESSIONS[0]
        ? [
            ...dayBars(day, symbol),
            { datetime: 1e20, open: 1, high: 1, low: 1, close: 1 },
          ]
        : dayBars(day, symbol),
    );

    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    expect(report.failures).toEqual([
      {
        symbol: '$VOLD',
        failure: 'unexpected',
        error: expect.stringContaining('Invalid time value'),
      },
    ]);
    // The three other symbols were planned.
    expect(report.days.every((d) => d.inserted > 0)).toBe(true);
  });

  it('a rejected write', async () => {
    stubSchwab();
    const real = holder.sql as {
      transaction: (q: unknown) => Promise<unknown>;
    };
    const original = real.transaction;
    real.transaction = () => Promise.reject(new Error('connection lost'));
    try {
      const report = await runBackfill({
        apply: true,
        sessions: SESSIONS,
        getToken: token,
      });
      expect(report.failures.map((f) => [f.failure, f.error])).toEqual(
        SYMBOLS.map(() => ['db_error', 'connection lost']),
      );
    } finally {
      real.transaction = original;
    }
  });
});

describe('formatReport', () => {
  it('prints the mode, the window, the per-day counts, the totals and the problems', async () => {
    stubSchwab((symbol, day) => {
      const bars = dayBars(day, symbol);
      return symbol === '$ADD' && day === '2026-11-06'
        ? bars.slice(0, 389)
        : bars;
    });
    const report = await runBackfill({
      apply: false,
      sessions: SESSIONS,
      getToken: token,
    });

    const text = formatReport(report);

    expect(text).toContain('DRY RUN: nothing was written');
    expect(text).toContain('Sessions: 2026-11-05 .. 2026-11-06 (2)');
    expect(text).toMatch(/2026-11-05\s+1560\s+0\s+0\s+0/);
    expect(text).toMatch(
      /2026-11-06\s+1559\s+0\s+0\s+0\s+\$ADD incomplete 389\/390/,
    );
    expect(text).toContain('Total: 3119 inserted, 0 updated, 0 unchanged');
    expect(text).not.toContain('FAILED');
  });

  it('says APPLY after a write and lists the failures', () => {
    const text = formatReport({
      apply: true,
      sessions: ['2026-11-06'],
      days: [
        {
          date: '2026-11-06',
          inserted: 1,
          updated: 2,
          unchanged: 3,
          rejectedZero: 4,
          problems: [],
        },
      ],
      failures: [{ symbol: '$VOLD', failure: 'db_error', error: 'boom' }],
    });
    expect(text).toContain('APPLY: the settled bars below were written.');
    expect(text).toContain(
      'Total: 1 inserted, 2 updated, 3 unchanged, 4 all-zero bars rejected (written).',
    );
    expect(text).toContain('FAILED:\n  $VOLD db_error: boom');
  });
});
