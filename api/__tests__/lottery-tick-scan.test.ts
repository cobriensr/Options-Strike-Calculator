// @vitest-environment node

/**
 * Unit tests for the sliced tick scan (plan 2026-10-29-lottery-phase-b-e.md,
 * B1). The database is a function over an in-memory table that answers each
 * slice query by its two bound instants, as ws_option_trades would. What
 * Postgres itself does with those bounds, filters and ordering is proven
 * against the old three-way query in lottery-tick-scan-pglite.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWithDbRetry = vi.hoisted(() =>
  vi.fn<
    (
      fn: () => Promise<unknown>,
      retries?: number,
      perAttemptTimeoutMs?: number,
    ) => Promise<unknown>
  >((fn) => fn()),
);
vi.mock('../_lib/db.js', () => ({ withDbRetry: mockWithDbRetry }));

import {
  groupTickRows,
  isResponseTooLargeError,
  MAX_SPLIT_DEPTH,
  scanLotteryTicks,
  SCAN_WINDOW_MIN,
  type TickRow,
} from '../_lib/lottery-tick-scan.js';

const SCAN_END = new Date('2026-11-05T15:00:00.123Z');
const MINUTE = 60_000;
const OPEN = 'infinity';

const iso = (ms: number): string => new Date(ms).toISOString();
const sliceStart = (i: number): number =>
  SCAN_END.getTime() - SCAN_WINDOW_MIN * MINUTE + i * MINUTE;

let tickSeq = 0;
function tickRow(
  chain: string,
  executedAtMs: number,
  overrides: Partial<TickRow> = {},
): TickRow {
  tickSeq += 1;
  return {
    ticker: 'SNDK',
    option_chain: chain,
    option_type: 'C',
    strike: '1175.000',
    expiry: '2026-11-05',
    executed_at: new Date(executedAtMs),
    price: '0.5000',
    // The size doubles as a row label in the order assertions.
    size: tickSeq,
    underlying_price: '1170.0000',
    side: 'ask',
    implied_volatility: '0.500000',
    delta: '0.180000',
    gamma: '0.012300',
    open_interest: 1000,
    ...overrides,
  };
}

interface SliceCall {
  from: string;
  to: string;
  sql: string;
}

/**
 * A db over an in-memory table: answers `[from, to)` (to = 'infinity' is
 * open) with the table's rows in (executed_at, insertion) order, unless
 * `fail` returns an error for that call. Calls are recorded in issue order.
 */
function fakeDb(
  table: TickRow[],
  fail: (call: SliceCall, nth: number) => Error | null = () => null,
) {
  const calls: SliceCall[] = [];
  const db = vi.fn(
    async (strings: TemplateStringsArray, from: string, to: string) => {
      const call: SliceCall = { from, to, sql: strings.join('?') };
      const nth = calls.length;
      calls.push(call);
      const failure = fail(call, nth);
      if (failure) throw failure;
      const lo = Date.parse(from);
      const hi = to === OPEN ? Number.POSITIVE_INFINITY : Date.parse(to);
      return table
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => {
          const at = (row.executed_at as Date).getTime();
          return at >= lo && at < hi;
        })
        .sort(
          (a, b) =>
            (a.row.executed_at as Date).getTime() -
              (b.row.executed_at as Date).getTime() || a.i - b.i,
        )
        .map(({ row }) => row);
    },
  );
  return { db: db as never, calls, mock: db };
}

const widthOf = (call: SliceCall): number =>
  call.to === OPEN ? Number.NaN : Date.parse(call.to) - Date.parse(call.from);

const tooLarge = (): Error =>
  new Error('Server error (HTTP status 507): response too large');

beforeEach(() => {
  mockWithDbRetry.mockClear();
  tickSeq = 0;
});

describe('scanLotteryTicks slices', () => {
  it('issues seven one-minute slices anchored on scanEnd, the last one open-ended', async () => {
    const { db, calls } = fakeDb([]);

    await scanLotteryTicks(db, SCAN_END);

    expect(calls).toHaveLength(SCAN_WINDOW_MIN);
    expect(SCAN_WINDOW_MIN).toBe(7);
    for (let i = 0; i < 6; i += 1) {
      expect(calls[i]).toMatchObject({
        from: iso(sliceStart(i)),
        to: iso(sliceStart(i + 1)),
      });
    }
    // The first slice starts exactly 7 minutes before the anchor, to the
    // millisecond, and the last starts 1 minute before it with no upper
    // bound: a row stamped after scanEnd is still read.
    expect(calls[0]!.from).toBe('2026-11-05T14:53:00.123Z');
    expect(calls[6]).toMatchObject({
      from: '2026-11-05T14:59:00.123Z',
      to: OPEN,
    });
  });

  it('adjacent slices share their bound, so no instant is in two slices or none', async () => {
    const { db, calls } = fakeDb([]);
    await scanLotteryTicks(db, SCAN_END);
    for (let i = 0; i < 6; i += 1) {
      expect(calls[i]!.to).toBe(calls[i + 1]!.from);
    }
  });

  it('sends every slice with the same filters and ordering as the old scan', async () => {
    const { db, calls } = fakeDb([]);
    await scanLotteryTicks(db, SCAN_END);
    for (const { sql } of calls) {
      expect(sql).toMatch(/FROM ws_option_trades/);
      expect(sql).toMatch(/executed_at >= \?::timestamptz/);
      expect(sql).toMatch(/executed_at < \?::timestamptz/);
      expect(sql).toMatch(/canceled = FALSE/);
      expect(sql).toMatch(/price > 0/);
      expect(sql).toMatch(/ORDER BY executed_at, id/);
      expect(sql).toMatch(/expiry::text AS expiry/);
      expect(sql).toMatch(/NULLIF\(raw_payload->>'gamma', ''\)::numeric/);
      // No NOW(): every bound comes from the one captured anchor.
      expect(sql).not.toMatch(/NOW\(\)/i);
      // No ticker partition any more: each row is read once.
      expect(sql).not.toMatch(/hashtext/);
    }
  });

  it('runs each slice under withDbRetry with 2 retries and a 10 s attempt cap', async () => {
    const { db } = fakeDb([]);
    await scanLotteryTicks(db, SCAN_END);
    expect(mockWithDbRetry).toHaveBeenCalledTimes(SCAN_WINDOW_MIN);
    for (const call of mockWithDbRetry.mock.calls) {
      expect(call.slice(1)).toEqual([2, 10_000]);
    }
  });

  it('starts all seven slices before any answer arrives', async () => {
    const release: (() => void)[] = [];
    const db = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          release.push(() => resolve([]));
        }),
    );
    const scan = scanLotteryTicks(db as never, SCAN_END);
    await Promise.resolve();
    await Promise.resolve();
    expect(db).toHaveBeenCalledTimes(SCAN_WINDOW_MIN);
    for (const r of release) r();
    await expect(scan).resolves.toMatchObject({ scanned: 0 });
  });
});

describe('scanLotteryTicks merge', () => {
  it('returns no groups for an empty window', async () => {
    const { db } = fakeDb([]);
    const scan = await scanLotteryTicks(db, SCAN_END);
    expect(scan.scanned).toBe(0);
    expect(scan.groups.size).toBe(0);
  });

  it('keeps each chain time-ordered across slices, whatever order the slices answer in', async () => {
    const A = 'SNDK261105C01175000';
    const B = 'TSLA261105C00400000';
    // Chain A prints in slices 0, 2, 3, 6 (the open one); B in 1, 3, 6.
    const table = [
      tickRow(A, sliceStart(0) + 5),
      tickRow(B, sliceStart(1) + 5, { ticker: 'TSLA' }),
      tickRow(A, sliceStart(2) + 5),
      tickRow(A, sliceStart(3) + 5),
      tickRow(B, sliceStart(3) + 9, { ticker: 'TSLA' }),
      tickRow(A, sliceStart(6) + 5),
      tickRow(B, sliceStart(6) + 9, { ticker: 'TSLA' }),
      // After scanEnd: the open slice still reads it.
      tickRow(A, SCAN_END.getTime() + 2 * MINUTE),
    ];
    // Answer the slices in reverse: slice 6 first, slice 0 last.
    const inner = fakeDb(table);
    const held: (() => void)[] = [];
    const db = vi.fn(
      (strings: TemplateStringsArray, from: string, to: string) =>
        new Promise<TickRow[]>((resolve, reject) => {
          held.push(() => {
            inner.mock(strings, from, to).then(resolve, reject);
          });
        }),
    );
    const scan = scanLotteryTicks(db as never, SCAN_END);
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toHaveLength(SCAN_WINDOW_MIN);
    for (const release of [...held].reverse()) release();
    const result = await scan;

    expect(result.scanned).toBe(table.length);
    const a = result.groups.get(A)!;
    const times = a.ticks.map((t) => t.executedAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(a.ticks).toHaveLength(5);
    const b = result.groups.get(B)!;
    expect(b.ticks.map((t) => t.size)).toEqual([2, 5, 7]);
    expect(b.ticker).toBe('TSLA');
  });

  it('keeps rows that share a millisecond in the order the database gave them (executed_at, id)', async () => {
    const A = 'SNDK261105C01175000';
    const at = sliceStart(2) + 500;
    // Labelled by size: 1, 2, 3 in id order, all at the same millisecond.
    const table = [tickRow(A, at), tickRow(A, at), tickRow(A, at)];
    const { db } = fakeDb(table);
    const scan = await scanLotteryTicks(db, SCAN_END);
    expect(scan.groups.get(A)!.ticks.map((t) => t.size)).toEqual([1, 2, 3]);
  });
});

describe('groupTickRows', () => {
  it('normalises a row and takes the per-chain max open interest', () => {
    const chain = 'SNDK261105C01175000';
    const { scanned, groups } = groupTickRows([
      tickRow(chain, Date.parse('2026-11-05T14:55:00.000Z'), {
        open_interest: 900,
      }),
      tickRow(chain, Date.parse('2026-11-05T14:55:30.000Z'), {
        open_interest: 1200,
        underlying_price: null,
        implied_volatility: null,
        delta: null,
        gamma: null,
        side: 'bid',
        // A string timestamp, as a driver without Date parsing would give.
        executed_at: '2026-11-05T14:55:30.000Z',
      }),
      tickRow(chain, Date.parse('2026-11-05T14:56:00.000Z'), {
        open_interest: null,
      }),
    ]);

    expect(scanned).toBe(3);
    const g = groups.get(chain)!;
    expect(g).toMatchObject({
      ticker: 'SNDK',
      optionChain: chain,
      optionType: 'C',
      strike: 1175,
      expiry: '2026-11-05',
      oi: 1200,
    });
    expect(g.ticks).toHaveLength(3);
    expect(g.ticks[0]).toEqual({
      executedAt: new Date('2026-11-05T14:55:00.000Z'),
      optionChain: chain,
      optionType: 'C',
      strike: 1175,
      expiry: new Date('2026-11-05T00:00:00Z'),
      price: 0.5,
      size: g.ticks[0]!.size,
      underlyingPrice: 1170,
      side: 'ask',
      impliedVolatility: 0.5,
      delta: 0.18,
      gamma: 0.0123,
      openInterest: 900,
    });
    expect(g.ticks[1]).toMatchObject({
      executedAt: new Date('2026-11-05T14:55:30.000Z'),
      underlyingPrice: null,
      impliedVolatility: null,
      delta: null,
      gamma: null,
      side: 'bid',
      openInterest: 1200,
    });
    expect(g.ticks[2]!.openInterest).toBeNull();
  });

  it('keeps zero greeks and a zero strike-free price as numbers, not nulls', () => {
    const { groups } = groupTickRows([
      tickRow('SNDK261105C01175000', Date.parse('2026-11-05T14:55:00.000Z'), {
        delta: '0',
        gamma: 0,
        implied_volatility: '0.000000',
        underlying_price: '0.0000',
      }),
    ]);
    expect(groups.get('SNDK261105C01175000')!.ticks[0]).toMatchObject({
      delta: 0,
      gamma: 0,
      impliedVolatility: 0,
      underlyingPrice: 0,
    });
  });
});

describe('scanLotteryTicks size-error bisection', () => {
  const A = 'SNDK261105C01175000';

  it('splits a slice in half when Neon reports the response too large, and merges the halves in order', async () => {
    const SLICE = 2;
    const table = [
      tickRow(A, sliceStart(SLICE) + 1_000),
      tickRow(A, sliceStart(SLICE) + 31_000),
      tickRow(A, sliceStart(SLICE) + 45_000),
      // The bound between the halves belongs to the upper half.
      tickRow(A, sliceStart(SLICE) + 30_000),
    ];
    const { db, calls } = fakeDb(table, (call) =>
      widthOf(call) === MINUTE && call.from === iso(sliceStart(SLICE))
        ? tooLarge()
        : null,
    );

    const scan = await scanLotteryTicks(db, SCAN_END);

    const lower = {
      from: iso(sliceStart(SLICE)),
      to: iso(sliceStart(SLICE) + 30_000),
    };
    const upper = {
      from: iso(sliceStart(SLICE) + 30_000),
      to: iso(sliceStart(SLICE + 1)),
    };
    expect(calls.slice(SCAN_WINDOW_MIN)).toEqual([
      expect.objectContaining(lower),
      expect.objectContaining(upper),
    ]);
    expect(scan.scanned).toBe(4);
    expect(scan.groups.get(A)!.ticks.map((t) => t.size)).toEqual([1, 4, 2, 3]);
  });

  it('splits the open last slice at the middle of its minute and keeps the upper half open', async () => {
    const table = [
      tickRow(A, sliceStart(6) + 10_000),
      tickRow(A, sliceStart(6) + 50_000),
      tickRow(A, SCAN_END.getTime() + 90_000),
    ];
    const { db, calls } = fakeDb(table, (call) =>
      call.to === OPEN && call.from === iso(sliceStart(6)) ? tooLarge() : null,
    );

    const scan = await scanLotteryTicks(db, SCAN_END);

    expect(calls.slice(SCAN_WINDOW_MIN)).toEqual([
      expect.objectContaining({
        from: iso(sliceStart(6)),
        to: iso(sliceStart(6) + 30_000),
      }),
      expect.objectContaining({
        from: iso(sliceStart(6) + 30_000),
        to: OPEN,
      }),
    ]);
    expect(scan.scanned).toBe(3);
    expect(scan.groups.get(A)!.ticks.map((t) => t.size)).toEqual([1, 2, 3]);
  });

  it('splits again when a half is still too large, down to 3 levels', async () => {
    const SLICE = 4;
    const start = sliceStart(SLICE);
    const table = [tickRow(A, start + 1_000), tickRow(A, start + 59_000)];
    // Everything wider than 7.5 s overflows: 60 s, 30 s and 15 s pieces
    // fail, and the 7.5 s pieces (the 3rd split) fit.
    const { db, calls } = fakeDb(table, (call) =>
      call.from >= iso(start) &&
      call.to <= iso(start + MINUTE) &&
      widthOf(call) > 7_500
        ? tooLarge()
        : null,
    );

    const scan = await scanLotteryTicks(db, SCAN_END);

    expect(MAX_SPLIT_DEPTH).toBe(3);
    // 6 other slices + the failing slice's 1 + 2 + 4 + 8 attempts.
    expect(calls).toHaveLength(6 + 1 + 2 + 4 + 8);
    const pieces = calls.filter((c) => widthOf(c) === 7_500);
    expect(pieces).toHaveLength(8);
    expect(scan.groups.get(A)!.ticks.map((t) => t.size)).toEqual([1, 2]);
  });

  it('fails the scan when a slice is still too large after 3 splits', async () => {
    const SLICE = 1;
    const start = sliceStart(SLICE);
    const { db, calls } = fakeDb([], (call) =>
      call.from >= iso(start) &&
      call.to <= iso(start + MINUTE) &&
      widthOf(call) >= 7_500
        ? tooLarge()
        : null,
    );

    const failure = await scanLotteryTicks(db, SCAN_END).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /still too large after 3 splits/,
    );
    expect((failure as Error).message).toContain(iso(start));
    // The original Neon error is kept as the cause.
    expect(isResponseTooLargeError((failure as Error).cause)).toBe(true);
    // Nothing narrower than the 3rd split was ever tried.
    expect(Math.min(...calls.map(widthOf).filter(Number.isFinite))).toBe(7_500);
  });

  it('does not split on any other error: the original error rejects the scan and the slice is not retried here', async () => {
    const boom = new Error('connection lost');
    const { db, calls } = fakeDb([], (_call, nth) => (nth === 2 ? boom : null));

    await expect(scanLotteryTicks(db, SCAN_END)).rejects.toBe(boom);
    // One query per slice and no sub-slices.
    expect(calls).toHaveLength(SCAN_WINDOW_MIN);
  });

  it.each([
    ['a NeonDbError 400 that mentions the word large', 'query is too large'],
    ['an HTTP 500', 'Server error (HTTP status 500): upstream failure'],
    ['an HTTP 5070 look-alike', 'Server error (HTTP status 5070): nope'],
  ])('does not treat %s as a size error', async (_label, message) => {
    const err = new Error(message);
    const { db, calls } = fakeDb([], (_call, nth) => (nth === 0 ? err : null));
    await expect(scanLotteryTicks(db, SCAN_END)).rejects.toBe(err);
    expect(calls).toHaveLength(SCAN_WINDOW_MIN);
  });
});

describe('isResponseTooLargeError', () => {
  it('matches the error the real Neon driver throws for an HTTP 507', async () => {
    // The driver's own code builds the message: any non-400 failure is
    // `Server error (HTTP status <status>): <body>`. Run the real package
    // (the setup file blocks neon() itself) against a stubbed fetch that
    // answers 507, so the match is on what the driver produces, not on a
    // message written here.
    const real = await vi.importActual<
      typeof import('@neondatabase/serverless')
    >('@neondatabase/serverless');
    const stub = (status: number) =>
      vi.fn(async () => new Response('{"message":"body"}', { status }));
    try {
      real.neonConfig.fetchFunction = stub(507);
      const sql = real.neon('postgresql://u:p@ep-fake-123.example.test/db');
      const err = await sql`SELECT 1`.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(real.NeonDbError);
      expect((err as Error).message).toMatch(/HTTP status 507/);
      expect(isResponseTooLargeError(err)).toBe(true);

      real.neonConfig.fetchFunction = stub(500);
      const other = await sql`SELECT 1`.catch((e: unknown) => e);
      expect((other as Error).message).toMatch(/HTTP status 500/);
      expect(isResponseTooLargeError(other)).toBe(false);
    } finally {
      real.neonConfig.fetchFunction = undefined;
    }
  });

  it('rejects everything that is not an Error with a 507 status', () => {
    expect(isResponseTooLargeError(null)).toBe(false);
    expect(isResponseTooLargeError('HTTP status 507')).toBe(false);
    expect(isResponseTooLargeError(new Error('fetch failed'))).toBe(false);
  });
});
