// @vitest-environment node

/**
 * fetch-market-internals as a post-close settle job (spec:
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.5). The rules
 * themselves are in market-internals-settle.test.ts and the real SQL in
 * market-internals-settle-pglite.test.ts; this file drives the handler:
 * the guard and the time gate, the request, what is written, and how each
 * failure surfaces. The database and Schwab are mocked at their modules; the
 * real cronGuard and withCronInstrumentation run, on a faked clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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
import { Sentry, metrics } from '../_lib/sentry.js';
import { schwabFetch } from '../_lib/schwab-fetch.js';
import { reportCronRun } from '../_lib/axiom.js';
import { _resetDsnCacheForTest } from '../_lib/cron-instrumentation.js';
import type { InternalSymbol } from '../../src/types/market-internals.js';

// 2026-11-06 is a Friday on EST (UTC-5): 22:30Z is 17:30 ET, after the close.
// The five sessions it settles are 11-02 .. 11-06.
const FRIDAY_EVENING = new Date('2026-11-06T22:30:00.000Z');
const SESSIONS = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
];
const SATURDAY = new Date('2026-11-07T15:00:00.000Z');
const THANKSGIVING_EVENING = new Date('2026-11-26T22:30:00.000Z');
// Black Friday 2026-11-27 is a 13:00 ET half day (210 bars).
const HALF_DAY_EVENING = new Date('2026-11-27T22:30:00.000Z');
const HALF_DAY_SESSIONS = [
  '2026-11-20',
  '2026-11-23',
  '2026-11-24',
  '2026-11-25',
  '2026-11-27',
];

const MIN = 60_000;
const SYMBOLS: InternalSymbol[] = ['$TICK', '$ADD', '$VOLD', '$TRIN'];

type Ohlc = [number, number, number, number];
type Bar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
};

/** TICK swings through zero; every 3rd bar goes negative. */
const tickLike = (i: number): Ohlc =>
  i % 3 === 0 ? [50, 120, -80, -40] : [30, 90, 10, 60];
const steady = (i: number): Ohlc => [100 + i, 110 + i, 90 + i, 105 + i];
const seriesFor = (symbol: InternalSymbol) =>
  symbol === '$TICK' ? tickLike : steady;

/** `count` one-minute bars of ET day `day` (EST) from `openZ` on. */
function dayBars(
  day: string,
  make: (i: number) => Ohlc,
  count = 390,
  openZ = '14:30',
): Bar[] {
  const start = Date.parse(`${day}T${openZ}:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const [open, high, low, close] = make(i);
    return { open, high, low, close, volume: 0, datetime: start + i * MIN };
  });
}

/** What Schwab answers for one symbol: a body for the given days. */
const body = (candles: Bar[]) => ({
  symbol: 'x',
  empty: candles.length === 0,
  candles,
});

type PerSymbol = Partial<Record<InternalSymbol, unknown>>;

/**
 * Route schwabFetch by the symbol in the request path. `overrides` replaces
 * the answer for a symbol (a body, or a ready-made ApiResult via `fail`).
 */
function mockSchwab(days: string[], overrides: PerSymbol = {}) {
  vi.mocked(schwabFetch).mockImplementation(((path: string) => {
    const symbol = new URLSearchParams(path.split('?')[1]).get(
      'symbol',
    ) as InternalSymbol;
    const override = overrides[symbol];
    if (override !== undefined) {
      return Promise.resolve(override);
    }
    return Promise.resolve({
      ok: true as const,
      data: body(days.flatMap((d) => dayBars(d, seriesFor(symbol)))),
    });
  }) as never);
}

const ok = (candles: Bar[]) => ({ ok: true as const, data: body(candles) });
const okRaw = (data: unknown) => ({ ok: true as const, data });
const fail = (status: number, code: string, error = `[${code}] boom`) => ({
  ok: false as const,
  status,
  error,
  code,
});

type Written = { symbols: string[]; ts: string[]; closes: number[] };

/**
 * Replace the batch transaction with a recorder. Every INSERT statement's
 * bound arrays (ts, symbol, open, high, low, close) are pushed to the returned
 * list, and each is answered with a new row per input row, or with
 * `answer(statementIndex)` when given.
 */
function recordWrites(
  answer?: (ts: string, symbol: string) => 'inserted' | 'updated' | 'unchanged',
) {
  const writes: Written[] = [];
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      fn((_strings: unknown, ...values: unknown[]) => {
        bound.push(values);
        return {};
      });
      return bound.map((values) => {
        const [ts, symbols, , , , closes] = values as [
          string[],
          string[],
          number[],
          number[],
          number[],
          number[],
        ];
        writes.push({ symbols, ts, closes });
        const out: Array<{ ts: string; inserted: boolean }> = [];
        ts.forEach((t, i) => {
          const verdict = answer?.(t, symbols[i]!) ?? 'inserted';
          if (verdict !== 'unchanged') {
            out.push({ ts: t, inserted: verdict === 'inserted' });
          }
        });
        return out;
      });
    },
  );
  return writes;
}

const writtenFor = (writes: Written[], symbol: string): string[] =>
  writes.flatMap((w) => w.ts.filter((_, i) => w.symbols[i] === symbol));

const call = async (
  query: Record<string, string> = {},
  headers: Record<string, string> = { authorization: 'Bearer test-secret' },
  method = 'GET',
) => {
  const res = mockResponse();
  await handler(mockRequest({ method, headers, query } as never), res);
  return res;
};

type Body = {
  status: string;
  message?: string;
  reason?: string;
  skipped?: boolean;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  results: Array<{
    symbol: string;
    error?: string;
    failure?: string;
    inserted: number;
    updated: number;
    unchanged: number;
    zeroBars: number;
    malformed: number;
    outOfSession: number;
    sessions: Array<{ date: string; status: string; bars: number }>;
    problems: Array<{ kind: string; date: string; symbol: string }>;
  }>;
  problems: Array<{ kind: string; date: string; symbol: string }>;
  /** Problems on today's own session: not final yet at 22:30 UTC. */
  pending: Array<{ kind: string; date: string; symbol: string }>;
  allZero: Array<{ symbol: string; date: string }>;
};

const messages = () =>
  vi.mocked(Sentry.captureMessage).mock.calls as unknown as Array<
    [string, { level: string; tags: Record<string, string>; extra: unknown }]
  >;

describe('fetch-market-internals (post-close settle)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.transaction = mockTransaction;
    // sessionRowCounts: nothing stored, nothing to flag.
    mockSql.mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FRIDAY_EVENING);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSchwab(SESSIONS);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Guard and time gate ────────────────────────────────────

  it.each([
    ['missing', {}],
    ['wrong', { authorization: 'Bearer wrong' }],
  ])('returns 401 when CRON_SECRET is %s', async (_label, headers) => {
    const writes = recordWrites();
    const res = await call({}, headers);
    expect(res._status).toBe(401);
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('answers 405 to anything but GET', async () => {
    const res = await call({}, { authorization: 'Bearer test-secret' }, 'POST');
    expect(res._status).toBe(405);
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('runs after the close on a trading day', async () => {
    recordWrites();
    const res = await call();
    expect(res._status).toBe(200);
    expect((res._json as Body).status).toBe('success');
  });

  it('skips on a weekend without ?force=1: no Schwab call, no write', async () => {
    vi.setSystemTime(SATURDAY);
    const writes = recordWrites();
    const res = await call();
    expect(res._json).toEqual({ skipped: true, reason: 'Outside time window' });
    expect(schwabFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('skips on a market holiday (Thanksgiving) without ?force=1', async () => {
    vi.setSystemTime(THANKSGIVING_EVENING);
    const res = await call();
    expect(res._json).toEqual({ skipped: true, reason: 'Outside time window' });
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  it('?force=1 runs on a weekend and settles the five sessions ending the day before', async () => {
    vi.setSystemTime(SATURDAY);
    const writes = recordWrites();

    const res = await call({ force: '1' });

    expect(res._status).toBe(200);
    const out = res._json as Body;
    expect(out.status).toBe('success');
    expect(out.results[0]!.sessions.map((s) => s.date)).toEqual(SESSIONS);
    expect(schwabFetch).toHaveBeenCalledTimes(4);
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390);
  });

  it('?force=1 still needs the CRON_SECRET', async () => {
    vi.setSystemTime(SATURDAY);
    const res = await call({ force: '1' }, {});
    expect(res._status).toBe(401);
    expect(schwabFetch).not.toHaveBeenCalled();
  });

  // ── The request ────────────────────────────────────────────

  it('asks Schwab for the settled 1-minute bars of all four symbols over the window, and never for a quote', async () => {
    recordWrites();
    await call();

    const paths = vi.mocked(schwabFetch).mock.calls.map((c) => c[0] as string);
    expect(paths).toHaveLength(4);
    expect(paths.every((p) => p.startsWith('/pricehistory?'))).toBe(true);
    expect(paths.some((p) => p.includes('quotes'))).toBe(false);

    const asked = paths.map((p) =>
      Object.fromEntries(new URLSearchParams(p.split('?')[1])),
    );
    expect(asked.map((a) => a.symbol).sort()).toEqual([...SYMBOLS].sort());
    for (const a of asked) {
      expect(a).toMatchObject({
        periodType: 'day',
        frequencyType: 'minute',
        frequency: '1',
        needExtendedHoursData: 'false',
        needPreviousClose: 'false',
      });
      // An hour before the 11-02 open (14:30Z), an hour after the 11-06 close (21:00Z).
      expect(Number(a.startDate)).toBe(Date.parse('2026-11-02T13:30:00Z'));
      expect(Number(a.endDate)).toBe(Date.parse('2026-11-06T22:00:00Z'));
    }
  });

  // ── What is written ────────────────────────────────────────

  it('writes five complete sessions per symbol in one transaction each and reports success', async () => {
    const writes = recordWrites();

    const res = await call();

    expect(res._status).toBe(200);
    const out = res._json as Body;
    expect(out.status).toBe('success');
    expect(out.inserted).toBe(4 * 5 * 390);
    expect(out.updated).toBe(0);
    expect(out.unchanged).toBe(0);
    for (const symbol of SYMBOLS) {
      expect(writtenFor(writes, symbol)).toHaveLength(5 * 390);
    }
    // 500 rows an INSERT: 1,950 rows are 4 statements, one transaction.
    expect(mockTransaction).toHaveBeenCalledTimes(4);
    expect(writes.every((w) => w.ts.length <= 500)).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.allZero).toEqual([]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-market-internals',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('counts inserted, updated and unchanged separately', async () => {
    // Answer by minute: 11-02 already right, 11-03 revised, the rest new.
    recordWrites((ts) =>
      ts.startsWith('2026-11-02')
        ? 'unchanged'
        : ts.startsWith('2026-11-03')
          ? 'updated'
          : 'inserted',
    );

    const out = (await call())._json as Body;

    expect(out.unchanged).toBe(4 * 390);
    expect(out.updated).toBe(4 * 390);
    expect(out.inserted).toBe(4 * 3 * 390);
    expect(out.results[1]).toMatchObject({
      symbol: '$ADD',
      inserted: 3 * 390,
      updated: 390,
      unchanged: 390,
    });
  });

  it('drops bars outside 09:30 to the last minute before 16:00 ET, and bars of other days', async () => {
    const writes = recordWrites();
    // 09:25-16:04 ET on 11-06, plus a bar from the day before the window.
    const wide = dayBars('2026-11-06', steady, 400, '14:25');
    const stray = dayBars('2026-10-30', steady, 3);
    mockSchwab(SESSIONS, {
      $ADD: ok([
        ...stray,
        ...SESSIONS.slice(0, 4).flatMap((d) => dayBars(d, steady)),
        ...wide,
      ]),
    });

    const out = (await call())._json as Body;

    const add = writtenFor(writes, '$ADD');
    expect(add).toHaveLength(5 * 390);
    expect(add.includes('2026-11-06T14:25:00.000Z')).toBe(false);
    expect(add.includes('2026-11-06T21:00:00.000Z')).toBe(false);
    expect(add.includes('2026-10-30T14:30:00.000Z')).toBe(false);
    expect(add.includes('2026-11-06T14:30:00.000Z')).toBe(true);
    expect(add.includes('2026-11-06T20:59:00.000Z')).toBe(true);
    expect(out.results[1]!.outOfSession).toBe(5 + 5 + 3);
    expect(out.status).toBe('success');
  });

  it('settles a half day with 210 bars as complete', async () => {
    vi.setSystemTime(HALF_DAY_EVENING);
    const writes = recordWrites();
    vi.mocked(schwabFetch).mockImplementation(((path: string) => {
      const symbol = new URLSearchParams(path.split('?')[1]).get(
        'symbol',
      ) as InternalSymbol;
      return Promise.resolve(
        ok(
          HALF_DAY_SESSIONS.flatMap((d) =>
            dayBars(d, seriesFor(symbol), d === '2026-11-27' ? 210 : 390),
          ),
        ),
      );
    }) as never);

    const out = (await call())._json as Body;

    expect(out.status).toBe('success');
    expect(out.results[1]!.sessions.map((s) => [s.date, s.status])).toEqual(
      HALF_DAY_SESSIONS.map((d) => [d, 'complete']),
    );
    expect(writtenFor(writes, '$ADD')).toHaveLength(4 * 390 + 210);
  });

  it('a half day with the ordinary 390 bars keeps only the 210 before 13:00 ET', async () => {
    vi.setSystemTime(HALF_DAY_EVENING);
    const writes = recordWrites();
    vi.mocked(schwabFetch).mockImplementation(((path: string) => {
      const symbol = new URLSearchParams(path.split('?')[1]).get(
        'symbol',
      ) as InternalSymbol;
      return Promise.resolve(
        ok(HALF_DAY_SESSIONS.flatMap((d) => dayBars(d, seriesFor(symbol)))),
      );
    }) as never);

    await call();

    const add = writtenFor(writes, '$ADD').filter((t) =>
      t.startsWith('2026-11-27'),
    );
    expect(add).toHaveLength(210);
    expect(add.at(-1)).toBe('2026-11-27T17:59:00.000Z');
  });

  // ── Validation surfaced by name ────────────────────────────

  it('rejects an all-zero bar, writes the rest, and reports the session as incomplete', async () => {
    const writes = recordWrites();
    const bars = SESSIONS.flatMap((d) => dayBars(d, steady));
    bars[10] = { ...bars[10]!, open: 0, high: 0, low: 0, close: 0 };
    mockSchwab(SESSIONS, { $ADD: ok(bars) });

    const res = await call();

    const out = res._json as Body;
    expect(out.status).toBe('partial');
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390 - 1);
    expect(out.results[1]).toMatchObject({ symbol: '$ADD', zeroBars: 1 });
    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$ADD',
        date: '2026-11-02',
        kind: 'incomplete',
        bars: 389,
        expected: 390,
        zeroBars: 1,
      }),
    ]);
    const alert = messages().find(
      ([, o]) => o.tags.stage === 'session_problem',
    );
    expect(alert).toBeDefined();
    expect(alert![1].level).toBe('error');
    expect(alert![1].tags.cron).toBe('fetch-market-internals');
  });

  // The problems below are on 11-05, a session a night old: it has had its
  // chance to settle, so each is a Sentry error and the run is partial. The
  // same problems on 11-06, today's own session at 22:30 UTC, are pending (see
  // "Same-day sessions" below).

  it('refuses a $TICK session that has no negative value, writes the other sessions and symbols, and reports tick_clamped', async () => {
    const writes = recordWrites();
    const clamp = (i: number): Ohlc => {
      const [o, h, l, c] = tickLike(i);
      return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
    };
    mockSchwab(SESSIONS, {
      $TICK: ok(
        SESSIONS.flatMap((d) =>
          dayBars(d, d === '2026-11-05' ? clamp : tickLike),
        ),
      ),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    const tick = writtenFor(writes, '$TICK');
    expect(tick).toHaveLength(4 * 390);
    expect(tick.some((t) => t.startsWith('2026-11-05'))).toBe(false);
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390);
    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$TICK',
        date: '2026-11-05',
        kind: 'tick_clamped',
      }),
    ]);
    const alert = messages().find(
      ([, o]) => o.tags.stage === 'session_problem',
    );
    expect(alert![1].level).toBe('error');
  });

  it('reports a session with the wrong bar count (389)', async () => {
    recordWrites();
    mockSchwab(SESSIONS, {
      $VOLD: ok([
        ...['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06'].flatMap(
          (d) => dayBars(d, steady),
        ),
        ...dayBars('2026-11-05', steady, 389),
      ]),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$VOLD',
        date: '2026-11-05',
        kind: 'incomplete',
        bars: 389,
        expected: 390,
      }),
    ]);
  });

  it('reports a session Schwab sent no bar for at all (0 of 390)', async () => {
    recordWrites();
    mockSchwab(SESSIONS, {
      $TRIN: ok(
        ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06'].flatMap((d) =>
          dayBars(d, steady),
        ),
      ),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$TRIN',
        date: '2026-11-05',
        kind: 'incomplete',
        bars: 0,
      }),
    ]);
  });

  // ── Same-day sessions are pending, older ones are not ──────
  //
  // Observed in production (Sentry SENTRY-EMERALD-DESERT-KJ, "settled series
  // unusable for session(s)"): at 22:30 UTC on 2026-11-09 and 2026-11-10 the
  // error fired for TODAY's session only ($TICK tick_clamped with 0 bars,
  // $ADD and $VOLD incomplete with 0 bars): Schwab's same-day settled series
  // is not final yet for those symbols. The next evening's run heals it (11-09
  // came back with all four symbols at 390 bars). So a problem on the newest
  // session, when that is the run's own ET date, is pending: logged, counted,
  // listed in the report, and not an error. Any older session has had a full
  // night, so it is.

  const sessionAlerts = () =>
    messages().filter(([, o]) => o.tags.stage === 'session_problem');
  const without = (day: string) => SESSIONS.filter((d) => d !== day);

  it("a problem on today's session is pending: counted and listed, quiet in Sentry, and the run is a success", async () => {
    const writes = recordWrites();
    const clamp = (i: number): Ohlc => {
      const [o, h, l, c] = tickLike(i);
      return [Math.max(o, 0), Math.max(h, 0), Math.max(l, 0), Math.max(c, 0)];
    };
    const addBars = SESSIONS.flatMap((d) => dayBars(d, steady));
    addBars[addBars.length - 5] = {
      ...addBars.at(-5)!,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
    };
    mockSchwab(SESSIONS, {
      // clamped today, the pattern seen on 11-10
      $TICK: ok(
        SESSIONS.flatMap((d) =>
          dayBars(d, d === '2026-11-06' ? clamp : tickLike),
        ),
      ),
      // a zero bar today: 389 valid bars
      $ADD: ok(addBars),
      // short today
      $VOLD: ok([
        ...without('2026-11-06').flatMap((d) => dayBars(d, steady)),
        ...dayBars('2026-11-06', steady, 389),
      ]),
      // nothing at all for today
      $TRIN: ok(without('2026-11-06').flatMap((d) => dayBars(d, steady))),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('success');
    expect(out.problems).toEqual([]);
    expect(out.pending.map((p) => [p.symbol, p.date, p.kind]).sort()).toEqual(
      [
        ['$TICK', '2026-11-06', 'tick_clamped'],
        ['$ADD', '2026-11-06', 'incomplete'],
        ['$VOLD', '2026-11-06', 'incomplete'],
        ['$TRIN', '2026-11-06', 'incomplete'],
      ].sort(),
    );
    expect(sessionAlerts()).toEqual([]);
    expect(metrics.increment).toHaveBeenCalledTimes(4);
    expect(metrics.increment).toHaveBeenCalledWith(
      'market_internals.session_pending',
    );
    // What Schwab did send is still stored: pending only changes the alert.
    expect(writtenFor(writes, '$VOLD')).toHaveLength(4 * 390 + 389);
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390 - 1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a problem on the previous session, a night old, still alerts and makes the run partial', async () => {
    recordWrites();
    mockSchwab(SESSIONS, {
      $VOLD: ok([
        ...without('2026-11-05').flatMap((d) => dayBars(d, steady)),
        ...dayBars('2026-11-05', steady, 389),
      ]),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.problems).toEqual([
      expect.objectContaining({ symbol: '$VOLD', date: '2026-11-05' }),
    ]);
    expect(out.pending).toEqual([]);
    expect(sessionAlerts()).toHaveLength(1);
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  it('a run with an old problem and a pending one alerts for the old one only', async () => {
    recordWrites();
    mockSchwab(SESSIONS, {
      $VOLD: ok([
        ...without('2026-11-05').flatMap((d) => dayBars(d, steady)),
        ...dayBars('2026-11-05', steady, 389),
      ]),
      $TRIN: ok(without('2026-11-06').flatMap((d) => dayBars(d, steady))),
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.problems.map((p) => [p.symbol, p.date])).toEqual([
      ['$VOLD', '2026-11-05'],
    ]);
    expect(out.pending.map((p) => [p.symbol, p.date])).toEqual([
      ['$TRIN', '2026-11-06'],
    ]);
    const alerts = sessionAlerts();
    expect(alerts).toHaveLength(1);
    // The Sentry event names the old problem and not the pending one.
    const extra = alerts[0]![1].extra as {
      problems: Array<{ symbol: string; date: string }>;
    };
    expect(extra.problems.map((p) => [p.symbol, p.date])).toEqual([
      ['$VOLD', '2026-11-05'],
    ]);
    expect(metrics.increment).toHaveBeenCalledTimes(1);
  });

  it('on a half day the same rule holds: a short 11-27 is pending, a short 11-25 alerts', async () => {
    vi.setSystemTime(HALF_DAY_EVENING);
    recordWrites();
    const bars = (d: string, count: number) =>
      dayBars(d, steady, d === '2026-11-27' ? count : 390);
    vi.mocked(schwabFetch).mockImplementation(((path: string) => {
      const symbol = new URLSearchParams(path.split('?')[1]).get(
        'symbol',
      ) as InternalSymbol;
      // $ADD: today's half day is short (209 of 210). $VOLD: 11-25 is short.
      return Promise.resolve(
        ok(
          HALF_DAY_SESSIONS.flatMap((d) => {
            if (symbol === '$ADD' && d === '2026-11-27') return bars(d, 209);
            if (symbol === '$VOLD' && d === '2026-11-25') {
              return dayBars(d, steady, 389);
            }
            return d === '2026-11-27'
              ? dayBars(d, seriesFor(symbol), 210)
              : dayBars(d, seriesFor(symbol));
          }),
        ),
      );
    }) as never);

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.pending.map((p) => [p.symbol, p.date])).toEqual([
      ['$ADD', '2026-11-27'],
    ]);
    expect(out.problems.map((p) => [p.symbol, p.date])).toEqual([
      ['$VOLD', '2026-11-25'],
    ]);
    expect(sessionAlerts()).toHaveLength(1);
  });

  it("a problem on the newest session is not pending when that session is not the run's own day (a forced Saturday run)", async () => {
    vi.setSystemTime(SATURDAY);
    recordWrites();
    mockSchwab(SESSIONS, {
      $VOLD: ok([
        ...without('2026-11-06').flatMap((d) => dayBars(d, steady)),
        ...dayBars('2026-11-06', steady, 389),
      ]),
    });

    const out = (await call({ force: '1' }))._json as Body;

    // Friday's session ended a day ago: it is an error, not pending.
    expect(out.status).toBe('partial');
    expect(out.problems.map((p) => [p.symbol, p.date])).toEqual([
      ['$VOLD', '2026-11-06'],
    ]);
    expect(out.pending).toEqual([]);
    expect(sessionAlerts()).toHaveLength(1);
  });

  // ── Schwab failures are not success ────────────────────────

  it.each([
    ['403 forbidden', 502, 'SCHWAB_API_403'],
    ['401 rejected', 401, 'SCHWAB_API_REJECTED'],
    ['500', 502, 'SCHWAB_API_500'],
    ['502', 502, 'SCHWAB_API_502'],
    ['503', 502, 'SCHWAB_API_503'],
    ['a token-store failure', 500, 'SCHWAB_TOKEN_ERROR'],
    ['a network failure', 504, 'SCHWAB_API_NETWORK'],
  ])(
    'Schwab %s on every symbol: status error, each failure named, each captured, nothing written',
    async (_label, status, code) => {
      const writes = recordWrites();
      vi.mocked(schwabFetch).mockResolvedValue(fail(status, code) as never);

      const res = await call();

      expect(res._status).toBe(200);
      const out = res._json as Body;
      expect(out.status).toBe('error');
      expect(out.results.map((r) => r.failure)).toEqual(
        SYMBOLS.map(() => 'schwab_error'),
      );
      expect(out.results[0]!.error).toContain(`Schwab pricehistory ${status}`);
      expect(out.results[0]!.error).toContain(code);
      expect(Sentry.captureException).toHaveBeenCalledTimes(4);
      expect(writes).toEqual([]);
      expect(reportCronRun).toHaveBeenCalledWith(
        'fetch-market-internals',
        expect.objectContaining({ status: 'error' }),
      );
    },
  );

  it('Schwab logged out: status error with the re-auth message, no exception spam, nothing written', async () => {
    const writes = recordWrites();
    vi.mocked(schwabFetch).mockResolvedValue(
      fail(
        401,
        'SCHWAB_TOKEN_EXPIRED',
        '[SCHWAB_TOKEN_EXPIRED] No tokens',
      ) as never,
    );

    const out = (await call())._json as Body;

    expect(out.status).toBe('error');
    expect(out.message).toContain('/api/auth/init');
    expect(out.results.map((r) => r.failure)).toEqual(
      SYMBOLS.map(() => 'schwab_logged_out'),
    );
    // A lapsed login is an expected state: the 'error' check-in is the alert.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('one symbol failing is partial: the other three are still written', async () => {
    const writes = recordWrites();
    mockSchwab(SESSIONS, { $VOLD: fail(502, 'SCHWAB_API_503') });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.results.find((r) => r.symbol === '$VOLD')).toMatchObject({
      failure: 'schwab_error',
    });
    expect(writtenFor(writes, '$VOLD')).toEqual([]);
    expect(writtenFor(writes, '$TICK')).toHaveLength(5 * 390);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('a thrown fetch error is a failure of that symbol, not of the run', async () => {
    const writes = recordWrites();
    vi.mocked(schwabFetch).mockImplementation(((path: string) => {
      if (path.includes('%24VOLD'))
        return Promise.reject(new Error('socket hang up'));
      const symbol = new URLSearchParams(path.split('?')[1]).get(
        'symbol',
      ) as InternalSymbol;
      return Promise.resolve(
        ok(SESSIONS.flatMap((d) => dayBars(d, seriesFor(symbol)))),
      );
    }) as never);

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.results.find((r) => r.symbol === '$VOLD')).toMatchObject({
      failure: 'schwab_error',
      error: 'socket hang up',
    });
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390);
  });

  it("an error thrown by our own parsing is that symbol's failure, named unexpected, not schwab_error", async () => {
    const writes = recordWrites();
    // Schwab answered fine (ok: true); the throw comes from reading the body.
    mockSchwab(SESSIONS, {
      $VOLD: {
        ok: true as const,
        data: {
          get candles(): unknown {
            throw new TypeError('plan bug');
          },
        },
      },
    });

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(out.results.find((r) => r.symbol === '$VOLD')).toMatchObject({
      failure: 'unexpected',
      error: 'plan bug',
    });
    expect(out.results.filter((r) => r.failure === 'schwab_error')).toEqual([]);
    expect(writtenFor(writes, '$VOLD')).toEqual([]);
    expect(writtenFor(writes, '$ADD')).toHaveLength(5 * 390);
    // Captured with its own stage, so Sentry does not file it as a Schwab outage.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'plan bug' }),
      expect.objectContaining({
        tags: expect.objectContaining({
          stage: 'unexpected',
          symbol: '$VOLD',
        }),
      }),
    );
  });

  // ── Malformed and empty payloads ───────────────────────────

  it.each([
    [
      'an empty candle list',
      okRaw({ symbol: '$X', empty: true, candles: [] }),
      'empty_payload',
    ],
    [
      'no candles at all',
      okRaw({ symbol: '$X', empty: false }),
      'malformed_payload',
    ],
    ['a body that is not an object', okRaw('<html>'), 'malformed_payload'],
    [
      'candles with no usable bar',
      okRaw({ candles: [{ open: 'x' }] }),
      'malformed_payload',
    ],
  ])(
    '%s on every symbol: status error, named, nothing written',
    async (_label, answer, kind) => {
      const writes = recordWrites();
      vi.mocked(schwabFetch).mockResolvedValue(answer as never);

      const out = (await call())._json as Body;

      expect(out.status).toBe('error');
      expect(out.results.map((r) => r.failure)).toEqual(
        SYMBOLS.map(() => kind),
      );
      expect(Sentry.captureException).toHaveBeenCalledTimes(4);
      expect(writes).toEqual([]);
    },
  );

  it('a malformed bar inside a good payload is dropped, counted, and makes the run partial', async () => {
    recordWrites();
    const bars: unknown[] = SESSIONS.flatMap((d) => dayBars(d, steady));
    bars.push({ open: 1, high: null, low: 1, close: 1, datetime: 5 });
    mockSchwab(SESSIONS, { $ADD: okRaw({ candles: bars }) });

    const out = (await call())._json as Body;

    expect(out.results.find((r) => r.symbol === '$ADD')).toMatchObject({
      malformed: 1,
    });
    expect(out.status).toBe('partial');
  });

  // ── Database failures ──────────────────────────────────────

  it('a rejected write is a failure of that symbol, named db_write and captured', async () => {
    recordWrites();
    let n = 0;
    const inner = mockTransaction.getMockImplementation()!;
    mockTransaction.mockImplementation(async (fn: never) => {
      n += 1;
      if (n === 2) throw new Error('connection lost');
      return inner(fn);
    });

    const res = await call();

    const out = res._json as Body;
    expect(out.status).toBe('partial');
    const failed = out.results.filter((r) => r.failure !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      failure: 'db_write',
      error: 'connection lost',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException).mock.calls[0]![0]).toMatchObject({
      message: 'connection lost',
    });
  });

  it('every write rejected: status error, not success', async () => {
    mockTransaction.mockRejectedValue(new Error('connection lost'));

    const res = await call();

    expect((res._json as Body).status).toBe('error');
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-market-internals',
      expect.objectContaining({ status: 'error' }),
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(4);
  });

  it('a write failure does not hide a session problem found before it', async () => {
    mockTransaction.mockRejectedValue(new Error('connection lost'));
    mockSchwab(SESSIONS, {
      // 11-05 missing: a night old, so a real problem (11-06 would be pending).
      $VOLD: ok(without('2026-11-05').flatMap((d) => dayBars(d, steady))),
    });

    const out = (await call())._json as Body;

    expect(out.problems).toEqual([
      expect.objectContaining({
        symbol: '$VOLD',
        date: '2026-11-05',
        kind: 'incomplete',
        bars: 0,
      }),
    ]);
  });

  // ── The per-symbol quality alert ───────────────────────────

  it('alerts when $ADD is stored all zero although $TICK is not (the F9 regression)', async () => {
    recordWrites();
    mockSql.mockResolvedValueOnce([
      { symbol: '$ADD', day: '2026-11-06', total: 390, nonzero: 0 },
      { symbol: '$TICK', day: '2026-11-06', total: 390, nonzero: 390 },
      { symbol: '$VOLD', day: '2026-11-06', total: 390, nonzero: 390 },
      { symbol: '$TRIN', day: '2026-11-06', total: 390, nonzero: 390 },
    ]);

    const res = await call();

    const out = res._json as Body;
    expect(out.status).toBe('partial');
    expect(out.allZero).toEqual([
      { symbol: '$ADD', date: '2026-11-06', total: 390, nonzero: 0 },
    ]);
    const alert = messages().find(
      ([, o]) => o.tags.stage === 'symbol_all_zero',
    );
    expect(alert).toBeDefined();
    expect(alert![0]).toContain('all zero');
    expect(alert![1].level).toBe('error');
    expect(JSON.stringify(alert![1].extra)).toContain('$ADD');
    expect(JSON.stringify(alert![1].extra)).not.toContain('$TICK');
  });

  it('stays quiet when every symbol-session has a non-zero row', async () => {
    recordWrites();
    mockSql.mockResolvedValueOnce(
      SYMBOLS.map((symbol) => ({
        symbol,
        day: '2026-11-06',
        total: 390,
        nonzero: 390,
      })),
    );

    const out = (await call())._json as Body;

    expect(out.status).toBe('success');
    expect(messages()).toEqual([]);
  });

  it('does not alert on a handful of zero rows (10 or fewer)', async () => {
    recordWrites();
    mockSql.mockResolvedValueOnce([
      { symbol: '$ADD', day: '2026-11-06', total: 10, nonzero: 0 },
    ]);
    expect(((await call())._json as Body).allZero).toEqual([]);
  });

  it('a failing quality query is surfaced: captured, and the run is partial', async () => {
    recordWrites();
    mockSql.mockRejectedValueOnce(new Error('statement timeout'));

    const out = (await call())._json as Body;

    expect(out.status).toBe('partial');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException).mock.calls[0]![0]).toMatchObject({
      message: 'statement timeout',
    });
  });

  it('runs the quality check even when Schwab failed, so a stale all-zero day is still seen', async () => {
    vi.mocked(schwabFetch).mockResolvedValue(
      fail(502, 'SCHWAB_API_503') as never,
    );
    mockSql.mockResolvedValueOnce([
      { symbol: '$ADD', day: '2026-11-06', total: 390, nonzero: 0 },
    ]);

    const out = (await call())._json as Body;

    expect(out.status).toBe('error');
    expect(out.allZero).toHaveLength(1);
    expect(messages().some(([, o]) => o.tags.stage === 'symbol_all_zero')).toBe(
      true,
    );
  });

  // ── Sentry cron monitor (withCronInstrumentation) ──────────
  //
  // The schedule is pinned in cron-schedules.test.ts against vercel.json and
  // SCHEDULE_MAP; this drives the real wrapper to show the job actually checks
  // in under its own slug with that schedule, once a weekday at 22:30 UTC.

  describe('Sentry cron check-ins', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      // The outer beforeEach copied process.env, so this DSN is dropped when
      // the outer afterEach restores it.
      process.env.SENTRY_DSN = 'https://pubkey@o1.ingest.us.sentry.io/42';
      _resetDsnCacheForTest();
      fetchMock
        .mockReset()
        .mockResolvedValue(new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      _resetDsnCacheForTest();
    });

    interface CheckInBody {
      check_in_id: string;
      monitor_slug: string;
      status: string;
      monitor_config?: Record<string, unknown>;
    }

    /** The check-in POSTs, in order. */
    async function checkIns(count: number) {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count));
      return fetchMock.mock.calls.map(([url, init]) => ({
        url: url as string,
        body: JSON.parse((init as { body: string }).body) as CheckInBody,
      }));
    }

    it('checks in under its own slug, in_progress then ok, with the 30 22 * * 1-5 UTC schedule', async () => {
      recordWrites();

      const res = await call();

      expect(res._status).toBe(200);
      const calls = await checkIns(2);
      expect(calls[0]!.url).toContain('/cron/fetch-market-internals/');
      expect(calls.map((c) => c.body.monitor_slug)).toEqual([
        'fetch-market-internals',
        'fetch-market-internals',
      ]);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'ok']);
      expect(calls[1]!.body.check_in_id).toBe(calls[0]!.body.check_in_id);
      expect(calls[0]!.body.monitor_config).toMatchObject({
        schedule: { type: 'crontab', value: '30 22 * * 1-5' },
        timezone: 'UTC',
        failure_issue_threshold: 1,
      });
    });

    it('sends an error check-in, not ok, when every symbol fails', async () => {
      recordWrites();
      vi.mocked(schwabFetch).mockResolvedValue(
        fail(502, 'SCHWAB_API_503') as never,
      );

      const res = await call();

      expect((res._json as Body).status).toBe('error');
      const calls = await checkIns(2);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'error']);
    });

    it('sends no check-in for a request without the cron bearer', async () => {
      const res = await call({}, { authorization: 'Bearer wrong' });

      expect(res._status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
