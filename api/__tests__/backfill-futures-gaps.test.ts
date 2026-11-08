// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks (module boundary — R3) ──────────────────────────

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const {
  mockUwFetch,
  mockCronGuard,
  mockWithRetry,
  mockFetchSchedule,
  mockFetchStored,
  mockRefresh,
} = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
  mockFetchSchedule: vi.fn(),
  mockFetchStored: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: mockWithRetry,
}));

// The per-session store and the volume refresh are mocked at their module
// boundary (the refresh has its own test file). The contract names and the
// pick are real.
vi.mock('../_lib/futures-front-month.js', () => ({
  fetchFrontMonthSchedule: mockFetchSchedule,
  fetchStoredFrontMonths: mockFetchStored,
}));

vi.mock('../_lib/futures-volume-refresh.js', () => ({
  refreshFrontMonthVolumes: mockRefresh,
}));

import handler from '../cron/backfill-futures-gaps.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import { formatMicrosIso, parseUwTimeMicros } from '../_lib/uw-time.js';

// ── Fixtures ──────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-09-30' };
// 06:00 UTC run → window is the three prior UTC days. The current CME
// trade date is 2026-09-30 (01:00 CDT + 7 h).
const NOW = '2026-09-30T06:00:00Z';
const WINDOW_START = '2026-09-27T00:00:00.000Z';
const WINDOW_END = '2026-09-30T00:00:00.000Z';
const candlesPath = (contract: string) =>
  `/futures/${contract}/candles?interval=1m&range=5d`;

/** Each root's front month in the default schedule. */
const FRONT: Record<string, string> = {
  ES: 'ESZ6',
  NQ: 'NQZ6',
  RTY: 'RTYZ6',
  CL: 'CLX6',
  GC: 'GCZ6',
  ZN: 'ZNZ6',
};

/** A schedule that gives every date asked about the root's front month. */
function defaultSchedule(product: string, dates: readonly string[]) {
  const front = FRONT[product]!;
  return {
    contractFor: (tradeDate: string) =>
      dates.includes(tradeDate) ? front : undefined,
    contracts: [front],
  };
}

/** A schedule that gives each listed trade date its own contract. */
function scheduleOf(byDate: Record<string, string>) {
  return {
    contractFor: (tradeDate: string) => byDate[tradeDate],
    contracts: [...new Set(Object.values(byDate))],
  };
}

function candle(
  start: string,
  o: number,
  v: number,
  overrides: Record<string, unknown> = {},
) {
  const startMs = Date.parse(start);
  return {
    start,
    end: Number.isFinite(startMs)
      ? new Date(startMs + 60_000).toISOString()
      : start,
    date: start.slice(0, 10),
    market: 'r',
    o: o.toFixed(9),
    h: (o + 1).toFixed(9),
    l: (o - 1).toFixed(9),
    c: (o + 0.5).toFixed(9),
    v,
    vol: v,
    tv: v,
    ...overrides,
  };
}

/** Gap-query row: bars exist at prev and next, everything between is missing. */
function gapRow(symbol: string, prev: string, next: string) {
  return { symbol, prev_bar: new Date(prev), next_bar: new Date(next) };
}

type Route = unknown[] | Error | Record<string, unknown>;

/** Route uwFetch by path so assertions don't depend on call order. */
function routeUw(routes: Record<string, Route>) {
  mockUwFetch.mockImplementation(async (_key: string, path: string) => {
    const r = routes[path];
    if (r === undefined) throw new Error(`unexpected UW path ${path}`);
    if (r instanceof Error) throw r;
    return r;
  });
}

function sqlText(callIdx: number): string {
  const strings = mockSql.mock.calls[callIdx]?.[0] as readonly string[];
  return strings.join('?');
}

function sqlValues(callIdx: number): unknown[] {
  return mockSql.mock.calls[callIdx]!.slice(1);
}

/** Index of each INSERT call (the gap query is always call 0). */
function insertCalls(): number[] {
  return mockSql.mock.calls
    .map((_, i) => i)
    .filter((i) => sqlText(i).includes('INSERT INTO futures_bars'));
}

/** The `contract` column of one bar INSERT, one entry per row. */
function insertedContracts(callIdx: number): unknown[] {
  return sqlValues(callIdx).at(-1) as unknown[];
}

/** The products `fetchFrontMonthSchedule` was asked about, in call order. */
function scheduledProducts(): string[] {
  return mockFetchSchedule.mock.calls.map((c) => c[0] as string);
}

async function run() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

// A Tuesday 09:00–09:30 CDT hole (14:00Z–14:30Z): 29 open minutes missing.
const ES_GAP = gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z');

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockCronGuard.mockReturnValue(GUARD);
  mockWithRetry.mockImplementation((fn: () => unknown) => fn());
  // Every query after the queued ones (the order-flow pass's NULL-flow
  // scan in the OHLC tests) finds nothing.
  mockSql.mockResolvedValue([]);
  // No date is decided yet, so a schedule read needs the volume refresh
  // first; the refresh reads and stores one earlier session.
  mockFetchStored.mockResolvedValue(new Map());
  mockRefresh.mockImplementation(async (_key: string, product: string) => ({
    contracts: [FRONT[product]!],
    offered: 1,
    inserted: 1,
  }));
  mockFetchSchedule.mockImplementation(defaultSchedule);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backfill-futures-gaps handler', () => {
  // ── Guard + wiring ────────────────────────────────────

  it('exits without touching the DB, UW or the front-month store when cronGuard rejects', async () => {
    mockCronGuard.mockReturnValue(null);
    await run();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('runs outside market hours (daily 06:00 UTC schedule)', async () => {
    mockSql.mockResolvedValueOnce([]);
    await run();
    expect(mockCronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ marketHours: false }),
    );
  });

  // ── Gap detection ─────────────────────────────────────

  it('scans the three prior UTC days for the six UW-covered roots (no DX), for missing bars and then for NULL order flow', async () => {
    mockSql.mockResolvedValueOnce([]);
    await run();
    expect(mockSql).toHaveBeenCalledTimes(2);
    const text = sqlText(0);
    expect(text).toContain('FROM futures_bars');
    expect(text).toContain('LEAD(ts) OVER (PARTITION BY symbol ORDER BY ts)');
    for (const idx of [0, 1]) {
      const values = sqlValues(idx);
      expect(values).toContainEqual(['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN']);
      expect(values).toContain(WINDOW_START);
      expect(values).toContain(WINDOW_END);
    }
    expect(sqlText(1)).toContain('buy_volume IS NULL');
  });

  it('no-gap run: makes no UW call, reads no schedule, refreshes no volume, and reports success with zero rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await run();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(mockFetchStored).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('ignores missing intervals that fall entirely in the daily halt or the weekend', async () => {
    mockSql.mockResolvedValueOnce([
      // Mon 15:59 → 17:00 CDT: only the 16:xx halt is missing.
      gapRow('ES', '2026-09-28T20:59:00Z', '2026-09-28T22:00:00Z'),
      // Fri 15:59 CDT → Sun 17:00 CDT: the weekend.
      gapRow('NQ', '2026-09-25T20:59:00Z', '2026-09-27T22:00:00Z'),
    ]);
    const res = await run();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('repairs a single missing open minute (a deploy / lease-handoff hole)', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([{}]);
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:00:00Z', 7740, 10),
        candle('2026-09-29T14:01:00Z', 7741, 10),
        candle('2026-09-29T14:02:00Z', 7742, 10),
      ],
    });

    const res = await run();

    expect(sqlValues(insertCalls()[0]!)).toContainEqual([
      '2026-09-29T14:01:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      symbols: { ES: expect.objectContaining({ gapMinutes: 1 }) },
    });
  });

  it('fills the open minutes on both sides of a hole that straddles the daily halt', async () => {
    // 15:57 → 17:02 CDT: 15:58-15:59 and 17:00-17:01 are open (4 minutes).
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T20:57:00Z', '2026-09-28T22:02:00Z'),
      ])
      .mockResolvedValueOnce([{}, {}, {}, {}]);
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-28T20:58:00Z', 7740, 10),
        candle('2026-09-28T20:59:00Z', 7741, 10),
        candle('2026-09-28T22:00:00Z', 7742, 10),
        candle('2026-09-28T22:01:00Z', 7743, 10),
      ],
    });
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESZ6' }),
    );

    const res = await run();

    expect(sqlValues(insertCalls()[0]!)).toContainEqual([
      '2026-09-28T20:58:00.000Z',
      '2026-09-28T20:59:00.000Z',
      '2026-09-28T22:00:00.000Z',
      '2026-09-28T22:01:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      rows: 4,
      symbols: { ES: expect.objectContaining({ gapMinutes: 4 }) },
    });
  });

  // ── Volume refresh ────────────────────────────────────
  // What a refresh reads, stores and checks is tested in
  // futures-volume-refresh.test.ts; these are about how the cron uses it.

  it("refreshes a root's volumes over 1m before its schedule is read, when a date is undecided", async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
    });

    await run();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('test-uw-key', 'ES', '1m');
    expect(mockRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFetchSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it('logs each root’s refreshed row count and reports it in meta', async () => {
    mockRefresh.mockResolvedValue({
      contracts: ['ESZ6', 'ESH7', 'ESM7'],
      offered: 3,
      inserted: 1,
    });
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
    });

    const res = await run();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ES',
        offered: 3,
        inserted: 1,
        range: '1m',
      }),
      expect.stringContaining('volumes refreshed'),
    );
    expect(res._json).toMatchObject({
      volumeRefresh: {
        ES: expect.objectContaining({ offered: 3, inserted: 1 }),
      },
    });
  });

  it('refreshes each root that reads an undecided schedule once, and no other', async () => {
    mockSql
      .mockResolvedValueOnce([
        ES_GAP,
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValue([]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
      [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
    });

    await run();

    expect(mockRefresh.mock.calls.map((c) => c[1])).toEqual(['ES', 'NQ']);
  });

  it.each([
    ['a UW error', 'UW API 502: bad gateway'],
    [
      'stale daily candles',
      'stale daily candles for ES: the newest ESZ6 candle is 2026-09-28, the last session with bars is 2026-09-29',
    ],
    ['a database error', 'connection terminated'],
  ])(
    'a volume refresh that fails on %s fails that root by name, writes no decision row for it, and leaves the other roots to run → partial',
    async (_name, message) => {
      mockRefresh.mockImplementation(async (_key: string, product: string) => {
        if (product === 'ES') throw new Error(message);
        return { contracts: [FRONT[product]!], offered: 1, inserted: 1 };
      });
      mockSql
        .mockResolvedValueOnce([
          ES_GAP,
          gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
        ])
        .mockResolvedValueOnce([{}])
        .mockResolvedValue([]);
      routeUw({
        [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
      });

      const res = await run();

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message }),
        expect.objectContaining({
          tags: expect.objectContaining({ symbol: 'ES' }),
          extra: { root: 'ES', range: '1m' },
        }),
      );
      expect(scheduledProducts()).toEqual(['NQ']);
      expect(mockUwFetch).not.toHaveBeenCalledWith(
        expect.anything(),
        candlesPath('ESZ6'),
      );
      expect(insertCalls()).toHaveLength(1);
      expect(sqlValues(insertCalls()[0]!)).toContain('NQ');
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 1,
        failures: [expect.stringContaining('ES volume refresh')],
      });
    },
  );

  it('a refresh failure on the only root reports status error, names the root, and writes no decision row', async () => {
    mockRefresh.mockRejectedValue(new Error('connection terminated'));
    mockSql.mockResolvedValueOnce([ES_GAP]);

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES' }),
        extra: { root: 'ES', range: '1m' },
      }),
    );
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'error',
      rows: 0,
      failures: ['ES volume refresh: connection terminated'],
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
  });

  // ── Dates already decided ─────────────────────────────

  it('skips the refresh and its UW calls when every date is already decided, and repairs from the stored schedule', async () => {
    mockFetchStored.mockResolvedValue(new Map([['2026-09-29', 'ESZ6']]));
    // UW's daily candles are down: a refresh would fail, and is not attempted.
    mockRefresh.mockRejectedValue(new Error('UW API 502: bad gateway'));
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([{ ts: 'a' }]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
    });

    const res = await run();

    expect(mockFetchStored).toHaveBeenCalledWith(
      'ES',
      '2026-09-29',
      '2026-09-29',
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'ES',
      ['2026-09-29'],
      'cron',
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('refreshes before the schedule when only some of the dates are decided', async () => {
    mockFetchStored.mockResolvedValue(new Map([['2026-09-29', 'ESH7']]));
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-28T14:05:00Z', 7745, 100)],
      [candlesPath('ESH7')]: [candle('2026-09-29T14:01:00Z', 7845, 100)],
    });

    await run();

    expect(mockFetchStored).toHaveBeenCalledWith(
      'ES',
      '2026-09-28',
      '2026-09-29',
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFetchSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it('a failed stored-decision read fails the root before any refresh: Sentry exception, the other roots still repair → partial', async () => {
    mockFetchStored.mockImplementation(async (product: string) => {
      if (product === 'ES') throw new Error('connection terminated');
      return new Map();
    });
    mockSql
      .mockResolvedValueOnce([
        ES_GAP,
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}])
      .mockResolvedValue([]);
    routeUw({
      [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
    });

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES' }),
      }),
    );
    expect(mockRefresh.mock.calls.map((c) => c[1])).toEqual(['NQ']);
    expect(scheduledProducts()).toEqual(['NQ']);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 1,
      failures: ['ES: connection terminated'],
    });
  });

  // ── Schedule ──────────────────────────────────────────

  it("reads the schedule from the CME trade dates of the root's gap minutes, oldest first, with source 'cron'", async () => {
    // 15:57 → 17:02 CDT straddles the 17:00 CDT open: two trade dates.
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T20:57:00Z', '2026-09-28T22:02:00Z'),
      ])
      .mockResolvedValueOnce([]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-28T20:58:00Z', 7740, 10)],
    });

    await run();

    expect(mockFetchSchedule).toHaveBeenCalledTimes(1);
    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'ES',
      ['2026-09-28', '2026-09-29'],
      'cron',
    );
  });

  it('reads one schedule per root from the dates of all its gaps, each minute landing on its own date’s contract', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T14:00:00Z', '2026-09-28T14:02:00Z'),
        gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([{}, {}]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-28T14:01:00Z', 7741, 10)],
      [candlesPath('ESH7')]: [candle('2026-09-29T14:01:00Z', 7841, 10)],
    });

    await run();

    expect(mockFetchSchedule).toHaveBeenCalledTimes(1);
    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'ES',
      ['2026-09-28', '2026-09-29'],
      'cron',
    );
    expect(insertedContracts(insertCalls()[0]!)).toEqual(['ESZ6', 'ESH7']);
  });

  it('asks for no weekend trade date when a hole spans the weekend: Friday and the Monday session only', async () => {
    // Fri 15:57 CDT → Sun 17:02 CDT: Fri 15:58-15:59 and the Sunday 17:00
    // open (Monday's trade date) are the only open minutes.
    mockSql
      .mockResolvedValueOnce([
        gapRow('NQ', '2026-09-25T20:57:00Z', '2026-09-27T22:02:00Z'),
      ])
      .mockResolvedValueOnce([]);
    routeUw({
      [candlesPath('NQZ6')]: [candle('2026-09-25T20:58:00Z', 26_000, 10)],
    });

    await run();

    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'NQ',
      ['2026-09-25', '2026-09-28'],
      'cron',
    );
  });

  it('fetches 1m candles only for the schedule’s contracts, and never calls /futures/contracts', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([]);
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
    });

    await run();

    // ESH7 and ESM7 are in the volume refresh but not in the schedule.
    expect(mockUwFetch.mock.calls.map((c) => c[1])).toEqual([
      candlesPath('ESZ6'),
    ]);
    expect(mockUwFetch.mock.calls.every((c) => c[0] === 'test-uw-key')).toBe(
      true,
    );
  });

  it('fetches every contract the schedule uses when the window holds a roll', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-28T14:05:00Z', 7745, 100)],
      [candlesPath('ESH7')]: [candle('2026-09-29T14:05:00Z', 7845, 100)],
    });

    await run();

    expect(mockUwFetch.mock.calls.map((c) => c[1])).toEqual([
      candlesPath('ESZ6'),
      candlesPath('ESH7'),
    ]);
  });

  it('upserts only the scheduled contract’s bars inside the gap via one batched unnest ON CONFLICT DO NOTHING, each carrying its contract', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:00:00Z', 7740, 500), // bounding bar: exists already
        candle('2026-09-29T14:05:00Z', 7745, 400),
        candle('2026-09-29T14:06:00Z', 7746, 300),
        candle('2026-09-29T14:30:00Z', 7750, 200), // bounding bar
        candle('2026-09-29T15:00:00Z', 7760, 100), // outside the gap
      ],
    });

    const res = await run();

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const text = sqlText(inserts[0]!);
    expect(text).toContain('unnest(');
    expect(text).toContain('ON CONFLICT (symbol, ts) DO NOTHING');
    const values = sqlValues(inserts[0]!);
    expect(values).toContain('ES');
    expect(values).toContainEqual([
      '2026-09-29T14:05:00.000Z',
      '2026-09-29T14:06:00.000Z',
    ]);
    expect(values).toContainEqual([7745, 7746]); // opens
    expect(values).toContainEqual([400, 300]); // volumes
    expect(insertedContracts(inserts[0]!)).toEqual(['ESZ6', 'ESZ6']);
    expect(res._status).toBe(200);
    // rows = what ON CONFLICT actually inserted (RETURNING), not bars sent.
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });
  });

  it('builds minutes either side of a session open from their own session’s contract, even where another month printed more', async () => {
    // Mon 15:57 → 17:02 CDT. 20:58–20:59Z are 09-28's session (ESZ6),
    // 22:00–22:01Z are the next session's (ESH7, rolled at the open).
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T20:57:00Z', '2026-09-28T22:02:00Z'),
      ])
      .mockResolvedValueOnce([{}, {}, {}, {}]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-28T20:58:00Z', 7740, 10),
        candle('2026-09-28T20:59:00Z', 7741, 10),
        // The old contract still prints after the open, in size.
        candle('2026-09-28T22:00:00Z', 7742, 9_000),
        candle('2026-09-28T22:01:00Z', 7743, 9_000),
      ],
      [candlesPath('ESH7')]: [
        // The new contract printed before the open: not its session yet.
        candle('2026-09-28T20:58:00Z', 7840, 9_000),
        candle('2026-09-28T22:00:00Z', 7842, 10),
        candle('2026-09-28T22:01:00Z', 7843, 10),
      ],
    });

    await run();

    const values = sqlValues(insertCalls()[0]!);
    expect(values).toContainEqual([
      '2026-09-28T20:58:00.000Z',
      '2026-09-28T20:59:00.000Z',
      '2026-09-28T22:00:00.000Z',
      '2026-09-28T22:01:00.000Z',
    ]);
    expect(values).toContainEqual([7740, 7741, 7842, 7843]);
    expect(insertedContracts(insertCalls()[0]!)).toEqual([
      'ESZ6',
      'ESZ6',
      'ESH7',
      'ESH7',
    ]);
  });

  it('leaves a minute empty when the scheduled contract has no candle for it, never filling it from another month', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}, {}]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-28T14:05:00Z', 7745, 100),
        // ESZ6 still prints on 09-29, but 09-29 belongs to ESH7.
        candle('2026-09-29T14:05:00Z', 7746, 5_000),
      ],
      [candlesPath('ESH7')]: [candle('2026-09-29T14:07:00Z', 7847, 100)],
    });

    await run();

    const inserts = insertCalls();
    expect(sqlValues(inserts[0]!)).toContainEqual([
      '2026-09-28T14:05:00.000Z',
      '2026-09-29T14:07:00.000Z',
    ]);
    expect(insertedContracts(inserts[0]!)).toEqual(['ESZ6', 'ESH7']);
  });

  it('stores NULL, with one warning per root, for a scheduled name that is no outright of the root: the column’s CHECK would fail the whole chunk', async () => {
    // A decision row naming another root's contract (a corrupt row).
    mockSql
      .mockResolvedValueOnce([
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}, {}]);
    mockFetchSchedule.mockResolvedValue(scheduleOf({ '2026-09-29': 'ESZ6' }));
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:05:00Z', 7745, 100),
        candle('2026-09-29T14:06:00Z', 7746, 100),
      ],
    });

    const res = await run();

    expect(insertedContracts(insertCalls()[0]!)).toEqual([null, null]);
    const warnings = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => String(c[1]).includes('not an outright'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toMatchObject({
      symbol: 'NQ',
      contracts: ['ESZ6'],
    });
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });
  });

  // ── Failure modes (R4) ────────────────────────────────

  it('a DB error in the schedule read fails the root: Sentry exception, status error, no candles fetched, no bars written', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    mockFetchSchedule.mockRejectedValue(new Error('connection terminated'));

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES' }),
      }),
    );
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('a schedule read that fails for one root leaves the other roots to repair → partial', async () => {
    mockSql
      .mockResolvedValueOnce([
        ES_GAP,
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}])
      .mockResolvedValue([]);
    mockFetchSchedule.mockImplementation(
      async (product: string, dates: readonly string[]) => {
        if (product === 'ES') throw new Error('connection terminated');
        return defaultSchedule(product, dates);
      },
    );
    routeUw({
      [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
    });

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({ status: 'partial', rows: 1 });
  });

  it('a candle payload at the UW row cap that no longer reaches the gap fails the symbol instead of reporting a clean run', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    // 5,000 rows (UW keeps the NEWEST at the cap) starting after the gap.
    const start = Date.parse('2026-09-29T15:00:00Z');
    routeUw({
      [candlesPath('ESZ6')]: Array.from({ length: 5000 }, (_, i) =>
        candle(new Date(start + i * 60_000).toISOString(), 7700, 10),
      ),
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/truncated/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a capped payload only has to reach the first minute to repair: no UTC-day tally needs the rest of its day', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([{}]);
    // Starts 10:00Z, after 00:00Z of the gap's UTC day but before the gap.
    const start = Date.parse('2026-09-29T10:00:00Z');
    routeUw({
      [candlesPath('ESZ6')]: Array.from({ length: 5000 }, (_, i) =>
        candle(new Date(start + i * 60_000).toISOString(), 7700, 10),
      ),
    });

    const res = await run();

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({ status: 'success' });
  });

  it('network error on one symbol surfaces to Sentry while the other symbol still repairs → partial', async () => {
    mockSql
      .mockResolvedValueOnce([
        ES_GAP,
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}]);
    routeUw({
      [candlesPath('ESZ6')]: new TypeError('fetch failed'),
      [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
    });

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fetch failed' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES' }),
      }),
    );
    expect(insertCalls()).toHaveLength(1);
    expect(sqlValues(insertCalls()[0]!)).toContain('NQ');
    expect(res._json).toMatchObject({ status: 'partial', rows: 1 });
  });

  it('every gap symbol failing reports status error, never ok', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({
      [candlesPath('ESZ6')]: new Error('UW API 502: bad gateway'),
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('an empty candle payload for a scheduled contract is a failure, not a clean zero-row success', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({ [candlesPath('ESZ6')]: [] });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/no candles/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('an empty candle payload for the second scheduled contract is also a failure', async () => {
    mockSql.mockResolvedValueOnce([
      gapRow('ES', '2026-09-28T14:00:00Z', '2026-09-29T14:30:00Z'),
    ]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-28T14:05:00Z', 7745, 100)],
      [candlesPath('ESH7')]: [],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/no candles for ESH7/),
      }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('skips malformed candles, surfaces them via captureMessage, and still inserts the valid ones', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([{}]);
    routeUw({
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:05:00Z', 7745, 100),
        candle('not-a-date', 7745, 100),
        candle('2026-09-29T14:06:30Z', 7745, 100), // not minute-aligned
        candle('2026-09-29T14:07:00Z', 7745, 100, { o: 'abc' }),
        candle('2026-09-29T14:08:00Z', 7745, 100, { h: '7000.0' }), // h < l
        candle('2026-09-29T14:09:00Z', 7745, -5),
        candle('2026-09-29T14:10:00Z', 7745, 1.5),
        candle('2026-09-29T14:11:00Z', 1e9, 100), // overflows NUMERIC(12,4)
      ],
    });

    const res = await run();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ symbol: 'ES', malformed: 7 }),
      }),
    );
    expect(sqlValues(insertCalls()[0]!)).toContainEqual([
      '2026-09-29T14:05:00.000Z',
    ]);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('a payload of only malformed candles fails the symbol', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({ [candlesPath('ESZ6')]: [candle('garbage', 7745, 100)] });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/malformed/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a non-array candle payload fails the symbol', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({ [candlesPath('ESZ6')]: { unexpected: 'shape' } });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/non-array/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a rejected DB insert fails the symbol (status error + Sentry), not success', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockRejectedValueOnce(new Error('numeric field overflow'));
    routeUw({
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'numeric field overflow' }),
      expect.anything(),
    );
  });

  it('a rejected gap query → 500 + Sentry, and no UW calls', async () => {
    mockSql.mockRejectedValueOnce(new Error('db attempt timeout'));

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// ── Order-flow pass (Phase 6) ─────────────────────────────

/** A NULL-flow row as fetchNullFlowBars' query returns it. */
function nullFlowRow(
  symbol: string,
  ts: string,
  volume: number,
  startsRange: boolean,
) {
  return { symbol, ts: new Date(ts), volume, starts_range: startsRange };
}

/** A regular REST /trades print (probe 0a shape). */
function print(id: number, at: string, size: number, side: string | null) {
  return {
    crossed: false,
    executed_at: at,
    is_block: false,
    is_spread: false,
    nbbo_ask: '7765.75',
    nbbo_bid: '7765.50',
    price: '7765.75',
    side,
    size,
    strategy: null,
    trade_id: id,
  };
}

const tradesPrefix = (contract: string) => `/futures/${contract}/trades?`;

/**
 * Route UW calls: exact paths from `routes`, and each contract's
 * /trades pages served in order from `pages` (an Error rejects).
 */
function routeUwWithTrades(
  routes: Record<string, Route>,
  pages: Record<string, Route[]>,
) {
  const served: Record<string, number> = {};
  mockUwFetch.mockImplementation(async (_key: string, path: string) => {
    const contract = /^\/futures\/([^/]+)\/trades\?/.exec(path)?.[1];
    if (contract) {
      const i = served[contract] ?? 0;
      served[contract] = i + 1;
      const page = pages[contract]?.[i];
      if (page === undefined) throw new Error(`unexpected trades page ${path}`);
      if (page instanceof Error) throw page;
      return page;
    }
    const r = routes[path];
    if (r === undefined) throw new Error(`unexpected UW path ${path}`);
    if (r instanceof Error) throw r;
    return r;
  });
}

function tradesCalls(contract: string): string[] {
  return mockUwFetch.mock.calls
    .map((c) => c[1] as string)
    .filter((p) => p.startsWith(tradesPrefix(contract)));
}

function olderThan(path: string): string | null {
  return new URL(`https://uw.test${path}`).searchParams.get('older_than');
}

function updateCalls(): number[] {
  return mockSql.mock.calls
    .map((_, i) => i)
    .filter((i) => sqlText(i).includes('UPDATE futures_bars'));
}

/** ESZ6 candles for the two NULL-flow minutes most tests repair. */
const ES_CANDLES = {
  [candlesPath('ESZ6')]: [
    candle('2026-09-29T14:01:00Z', 7740, 10),
    candle('2026-09-29T14:02:00Z', 7741, 5),
  ],
};

/** The one warning a run raises when it leaves NULL-flow minutes behind. */
const BACKLOG_WARNING =
  'backfill-futures-gaps: order-flow minutes left NULL (deferred or unrepairable)';

/** Two ESZ6 prints in 14:01 and one before it, ending the paging. */
const ES_1401_PAGE = [
  print(2, '2026-09-29T14:01:30.000000Z', 10, 'buy'),
  print(1, '2026-09-29T14:00:30.000000Z', 1, 'buy'),
];

describe('backfill-futures-gaps order-flow pass', () => {
  it('fills NULL-flow minutes from the scheduled contract REST prints with one conditional UPDATE, and reports the counts in meta', async () => {
    mockSql
      .mockResolvedValueOnce([]) // no missing bars
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 5, false),
      ])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeUwWithTrades(ES_CANDLES, {
      ESZ6: [
        [
          print(5, '2026-09-29T14:02:40.000001Z', 3, 'buy'),
          print(4, '2026-09-29T14:02:10.000000Z', 2, 'sell'),
          print(3, '2026-09-29T14:01:50.000000Z', 6, 'buy'),
          print(2, '2026-09-29T14:01:05.000000Z', 4, 'none'),
          print(1, '2026-09-29T14:00:59.999999Z', 9, 'buy'),
        ],
      ],
    });

    const res = await run();

    // Paged back from the end of the range, on the scheduled contract.
    const calls = tradesCalls('ESZ6');
    expect(calls).toHaveLength(1);
    expect(olderThan(calls[0]!)).toBe('2026-09-29T14:03:00.000000Z');

    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(sqlText(updates[0]!)).toContain('AND b.buy_volume IS NULL');
    const values = sqlValues(updates[0]!);
    expect(values).toContain('ES');
    expect(values).toContainEqual([
      '2026-09-29T14:01:00.000Z',
      '2026-09-29T14:02:00.000Z',
    ]);
    expect(values).toContainEqual([6, 3]); // buy volume
    expect(values).toContainEqual([0, 2]); // sell volume

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0, // OHLC rows inserted
      flow_minutes_repaired: 2,
      flow_minutes_skipped_tolerance: 0,
      flow_ranges_unrepairable: 0,
      flow_ranges_deferred: 0,
      flow_pages: 1,
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ flow_minutes_repaired: 2 }),
    );
  });

  it('reads the flow schedule from the trade dates of the root’s NULL-flow bars, after refreshing the root’s volumes', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      // Two ranges on two trade dates for ES, one for NQ.
      nullFlowRow('ES', '2026-09-28T14:01:00Z', 10, true),
      nullFlowRow('ES', '2026-09-29T14:01:00Z', 5, true),
      nullFlowRow('NQ', '2026-09-29T14:01:00Z', 4, true),
    ]);
    routeUwWithTrades(
      {
        [candlesPath('ESZ6')]: [
          candle('2026-09-28T14:01:00Z', 7740, 10),
          candle('2026-09-29T14:01:00Z', 7741, 5),
        ],
        [candlesPath('NQZ6')]: [candle('2026-09-29T14:01:00Z', 26_000, 4)],
      },
      {
        ESZ6: [
          [print(1, '2026-09-28T14:00:30.000000Z', 1, 'buy')],
          [print(2, '2026-09-29T14:00:30.000000Z', 1, 'buy')],
        ],
        NQZ6: [[print(3, '2026-09-29T14:00:30.000000Z', 1, 'buy')]],
      },
    );

    await run();

    expect(mockFetchSchedule).toHaveBeenCalledTimes(2);
    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'ES',
      ['2026-09-28', '2026-09-29'],
      'cron',
    );
    expect(mockFetchSchedule).toHaveBeenCalledWith(
      'NQ',
      ['2026-09-29'],
      'cron',
    );
    // Neither root had a gap: each is refreshed here, before its schedule.
    expect(mockRefresh.mock.calls.map((c) => c[1])).toEqual(['ES', 'NQ']);
    expect(mockRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFetchSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it('skips the refresh for a root whose NULL-flow dates are all decided: UW’s daily candles being down does not block it', async () => {
    mockFetchStored.mockResolvedValue(new Map([['2026-09-29', 'ESZ6']]));
    mockRefresh.mockRejectedValue(new Error('UW API 502: bad gateway'));
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    routeUwWithTrades(ES_CANDLES, { ESZ6: [ES_1401_PAGE] });

    const res = await run();

    expect(mockFetchStored).toHaveBeenCalledWith(
      'ES',
      '2026-09-29',
      '2026-09-29',
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'success',
      flow_minutes_repaired: 1,
    });
  });

  it('gives flow to the bars the OHLC pass inserts in the same run: one volume refresh and one candle load per contract, a schedule read per pass', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]) // OHLC insert of 14:01
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]); // flow UPDATE
    routeUwWithTrades(ES_CANDLES, { ESZ6: [ES_1401_PAGE] });

    const res = await run();

    const paths = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(paths.filter((p) => p === candlesPath('ESZ6'))).toHaveLength(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(scheduledProducts()).toEqual(['ES', 'ES']);
    expect(insertCalls()).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      flow_minutes_repaired: 1,
    });
  });

  it('fetches prints from the contract the schedule gives each date, and skips a minute whose scheduled contract has no candle', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        // ESZ6 has a candle at 14:05 but ESH7, the scheduled contract for
        // 09-29, has none: unattributed.
        nullFlowRow('ES', '2026-09-29T14:05:00Z', 7, false),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    routeUwWithTrades(
      {
        [candlesPath('ESZ6')]: [
          candle('2026-09-29T14:01:00Z', 7740, 5),
          candle('2026-09-29T14:05:00Z', 7745, 5),
        ],
        [candlesPath('ESH7')]: [candle('2026-09-29T14:01:00Z', 7761, 10)],
      },
      { ESH7: [ES_1401_PAGE] },
    );

    const res = await run();

    expect(tradesCalls('ESZ6')).toEqual([]);
    expect(tradesCalls('ESH7')).toHaveLength(1);
    expect(sqlValues(updateCalls()[0]!)).toContainEqual([
      '2026-09-29T14:01:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      status: 'success',
      flow_minutes_repaired: 1,
      flowSymbols: { ES: expect.objectContaining({ unattributed: 1 }) },
    });
  });

  it('a minute whose REST volume misses the bar by more than 2% stays NULL and is counted', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 100, true),
      ]);
    routeUwWithTrades(ES_CANDLES, { ESZ6: [ES_1401_PAGE] });

    const res = await run();

    expect(updateCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'success',
      flow_minutes_repaired: 0,
      flow_minutes_skipped_tolerance: 1,
    });
  });

  it('an empty trades page before the range start (UW history edge) counts the range as unrepairable', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 5, false),
      ]);
    routeUwWithTrades(ES_CANDLES, {
      ESZ6: [[print(9, '2026-09-29T14:02:30.000000Z', 5, 'buy')], []],
    });

    const res = await run();

    expect(updateCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'success',
      flow_ranges_unrepairable: 1,
      flow_minutes_repaired: 0,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      BACKLOG_WARNING,
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ unrepairable: 1, deferred: 0 }),
      }),
    );
  });

  it('stops at 600 pages per run, oldest range first, and defers the rest to the next run', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      // Older: processed first.
      nullFlowRow('NQ', '2026-09-29T13:00:00Z', 10, true),
      nullFlowRow('NQ', '2026-09-29T13:01:00Z', 10, false),
    ]);
    let id = 1;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === candlesPath('NQZ6')) {
        return [
          candle('2026-09-29T13:00:00Z', 26_000, 50),
          candle('2026-09-29T13:01:00Z', 26_001, 50),
        ];
      }
      if (path.startsWith(tradesPrefix('NQZ6'))) {
        // One print 2 µs older than the cursor, so each page steps back
        // 1 µs and never reaches the range start.
        const us = parseUwTimeMicros(olderThan(path))! - 2n;
        return [print(id++, formatMicrosIso(us), 1, 'buy')];
      }
      throw new Error(`unexpected UW path ${path}`);
    });

    const res = await run();

    expect(tradesCalls('NQZ6')).toHaveLength(600);
    expect(tradesCalls('ESZ6')).toEqual([]);
    expect(updateCalls()).toHaveLength(0);
    // ES waited behind the budget: it was never refreshed or scheduled.
    expect(scheduledProducts()).toEqual(['NQ']);
    // Deferred but still inside tomorrow's window: success, with a warning.
    expect(res._json).toMatchObject({
      status: 'success',
      flow_pages: 600,
      flow_ranges_deferred: 2,
      flow_minutes_aged_out: 0,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      BACKLOG_WARNING,
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ deferred: 2, agedOut: 0 }),
      }),
    );
  });

  it('deferred minutes on the window’s oldest day age out before the next run: counted, and the run is partial', async () => {
    // 2026-09-27 is the oldest UTC day of this run's window; tomorrow's
    // window starts 09-28, so its NULL bars will never be seen again.
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('NQ', '2026-09-27T22:30:00Z', 10, true),
        nullFlowRow('NQ', '2026-09-27T22:31:00Z', 10, false),
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    let id = 1;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === candlesPath('NQZ6')) {
        return [
          candle('2026-09-27T22:30:00Z', 26_000, 50),
          candle('2026-09-27T22:31:00Z', 26_001, 50),
        ];
      }
      if (path.startsWith(tradesPrefix('NQZ6'))) {
        const us = parseUwTimeMicros(olderThan(path))! - 2n;
        return [print(id++, formatMicrosIso(us), 1, 'buy')];
      }
      throw new Error(`unexpected UW path ${path}`);
    });

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'partial',
      flow_ranges_deferred: 2,
      // The two NQ bars; ES 09-29 is still inside tomorrow's window.
      flow_minutes_aged_out: 2,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      BACKLOG_WARNING,
      expect.objectContaining({
        extra: expect.objectContaining({ deferred: 2, agedOut: 2 }),
      }),
    );
  });

  it('a Saturday run counts the window’s oldest TWO days as aging out: the next run is Monday, whose window starts on Friday', async () => {
    // Saturday 2026-10-03 06:00 UTC: window Wed 09-30 → Sat 10-03 00:00.
    // Monday's window starts Fri 10-02, so Wed and Thu bars are never
    // seen again.
    vi.setSystemTime(new Date('2026-10-03T06:00:00Z'));
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      nullFlowRow('NQ', '2026-09-30T13:00:00Z', 10, true), // Wed: ages out
      nullFlowRow('NQ', '2026-10-01T13:00:00Z', 10, true), // Thu: ages out
      nullFlowRow('ES', '2026-10-02T14:01:00Z', 10, true), // Fri: kept
    ]);
    let id = 1;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === candlesPath('NQZ6')) {
        return [
          candle('2026-09-30T13:00:00Z', 26_000, 50),
          candle('2026-10-01T13:00:00Z', 26_001, 50),
        ];
      }
      if (path.startsWith(tradesPrefix('NQZ6'))) {
        // Never reaches the range start: the oldest range takes the budget.
        const us = parseUwTimeMicros(olderThan(path))! - 2n;
        return [print(id++, formatMicrosIso(us), 1, 'buy')];
      }
      throw new Error(`unexpected UW path ${path}`);
    });

    const res = await run();

    expect(res._json).toMatchObject({
      status: 'partial',
      flow_ranges_deferred: 3,
      flow_minutes_aged_out: 2,
    });
  });

  it('an upstream 5xx on /trades fails the symbol: Sentry exception, status error, never success', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    routeUwWithTrades(ES_CANDLES, {
      ESZ6: [new Error('UW API 503: unavailable')],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 503: unavailable' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES', pass: 'flow' }),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('a malformed /trades page fails the symbol', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    routeUwWithTrades(ES_CANDLES, { ESZ6: [{ unexpected: 'shape' }] });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/non-array/) }),
      expect.anything(),
    );
    expect(updateCalls()).toHaveLength(0);
  });

  it('a rejected flow UPDATE fails the symbol (status error + Sentry), not success', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ])
      .mockRejectedValueOnce(new Error('canceling statement due to timeout'));
    routeUwWithTrades(ES_CANDLES, { ESZ6: [ES_1401_PAGE] });

    const res = await run();

    expect(updateCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({
      status: 'error',
      flow_minutes_repaired: 0,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'canceling statement due to timeout',
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ pass: 'flow' }),
      }),
    );
  });

  it('a failed flow symbol does not stop another symbol repair → partial', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('NQ', '2026-09-29T14:01:00Z', 4, true),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    routeUwWithTrades(
      {
        ...ES_CANDLES,
        [candlesPath('NQZ6')]: [candle('2026-09-29T14:01:00Z', 26_000, 4)],
      },
      {
        ESZ6: [new TypeError('fetch failed')],
        NQZ6: [
          [
            print(2, '2026-09-29T14:01:30.000000Z', 4, 'sell'),
            print(1, '2026-09-29T14:00:30.000000Z', 1, 'buy'),
          ],
        ],
      },
    );

    const res = await run();

    expect(sqlValues(updateCalls()[0]!)).toContain('NQ');
    expect(res._json).toMatchObject({
      status: 'partial',
      flow_minutes_repaired: 1,
    });
  });

  it('a failed candle fetch in the flow pass reports status error with a Sentry exception, still answering 200', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    routeUwWithTrades(
      { [candlesPath('ESZ6')]: new Error('UW API 500: upstream down') },
      {},
    );

    const res = await run();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 500: upstream down' }),
      expect.objectContaining({
        tags: expect.objectContaining({ pass: 'flow' }),
      }),
    );
  });

  it('a DB error in the flow pass’s schedule read fails the root: Sentry exception tagged flow, status error, no prints fetched', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    mockFetchSchedule.mockRejectedValue(new Error('connection terminated'));

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: expect.objectContaining({ symbol: 'ES', pass: 'flow' }),
      }),
    );
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'error' });
  });

  it('a schedule read that fails in both passes fails the root in each pass: two exceptions, two failures, status error', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:40:00Z', 10, true),
      ]);
    mockFetchSchedule.mockRejectedValue(new Error('connection terminated'));

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: { cron: 'backfill-futures-gaps', symbol: 'ES' },
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection terminated' }),
      expect.objectContaining({
        tags: { cron: 'backfill-futures-gaps', symbol: 'ES', pass: 'flow' },
      }),
    );
    expect(res._json).toMatchObject({
      status: 'error',
      failures: ['ES: connection terminated', 'ES flow: connection terminated'],
    });
  });

  it('a malformed print withholds its minute and surfaces as a Sentry warning, while the rest of the range is written', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 5, false),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    routeUwWithTrades(ES_CANDLES, {
      ESZ6: [
        [
          print(5, '2026-09-29T14:02:40.000000Z', 3, 'up'), // unknown side
          print(4, '2026-09-29T14:02:10.000000Z', 2, 'sell'),
          ...ES_1401_PAGE,
        ],
      ],
    });

    const res = await run();

    expect(sqlValues(updateCalls()[0]!)).toContainEqual([
      '2026-09-29T14:01:00.000Z',
    ]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'backfill-futures-gaps: malformed UW prints skipped',
      expect.objectContaining({
        level: 'warning',
        extra: { symbol: 'ES', malformed: 1 },
      }),
    );
    expect(res._json).toMatchObject({
      status: 'success',
      flow_minutes_repaired: 1,
      flow_minutes_skipped_tolerance: 1,
    });
  });

  it('a budget spent mid-range defers the rest of it, including the part led by the next contract', async () => {
    // A range across the Monday 17:00 CDT open: 20:59Z is 09-28's session
    // (ESZ6), 22:00Z is the next session's (ESH7).
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-28T20:59:00Z', 10, true),
        nullFlowRow('ES', '2026-09-28T22:00:00Z', 10, false),
      ]);
    mockFetchSchedule.mockResolvedValue(
      scheduleOf({ '2026-09-28': 'ESZ6', '2026-09-29': 'ESH7' }),
    );
    let id = 1;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === candlesPath('ESZ6')) {
        return [candle('2026-09-28T20:59:00Z', 7740, 100)];
      }
      if (path === candlesPath('ESH7')) {
        return [candle('2026-09-28T22:00:00Z', 7790, 1_000)];
      }
      if (path.startsWith(tradesPrefix('ESZ6'))) {
        const us = parseUwTimeMicros(olderThan(path))! - 2n;
        return [print(id++, formatMicrosIso(us), 1, 'buy')];
      }
      throw new Error(`unexpected UW path ${path}`);
    });

    const res = await run();

    expect(tradesCalls('ESZ6')).toHaveLength(600);
    expect(tradesCalls('ESH7')).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'success',
      flow_pages: 600,
      flow_ranges_deferred: 1,
      flow_minutes_repaired: 0,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      BACKLOG_WARNING,
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ deferred: 1, agedOut: 0 }),
      }),
    );
  });

  it('ranges starting at the same minute go ES, NQ, RTY, CL, GC, ZN (spec D7), not alphabetically', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        // The scan orders by symbol, so CL comes first.
        nullFlowRow('CL', '2026-09-29T14:01:00Z', 3, true),
        nullFlowRow('NQ', '2026-09-29T14:01:00Z', 4, true),
      ])
      .mockResolvedValue([{ ts: 'x' }]);
    routeUwWithTrades(
      {
        [candlesPath('NQZ6')]: [candle('2026-09-29T14:01:00Z', 26_000, 4)],
        [candlesPath('CLX6')]: [candle('2026-09-29T14:01:00Z', 60, 3)],
      },
      {
        NQZ6: [
          [
            print(2, '2026-09-29T14:01:30.000000Z', 4, 'buy'),
            print(1, '2026-09-29T14:00:30.000000Z', 1, 'buy'),
          ],
        ],
        CLX6: [
          [
            print(2, '2026-09-29T14:01:30.000000Z', 3, 'sell'),
            print(1, '2026-09-29T14:00:30.000000Z', 1, 'buy'),
          ],
        ],
      },
    );

    await run();

    const paths = mockUwFetch.mock.calls.map((c) => c[1] as string);
    const first = (contract: string) =>
      paths.findIndex((p) => p.startsWith(tradesPrefix(contract)));
    expect(first('NQZ6')).toBeGreaterThanOrEqual(0);
    expect(first('NQZ6')).toBeLessThan(first('CLX6'));
  });

  it('repairs a long range oldest piece first, so a budget stop leaves the newer minutes, not the older', async () => {
    // One range, one contract, 90 minutes long: two pieces of ≤ 60 min.
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:00:00Z', 599, true),
        nullFlowRow('ES', '2026-09-29T15:30:00Z', 7, false),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    let call = 0;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === candlesPath('ESZ6')) {
        return [
          candle('2026-09-29T14:00:00Z', 7740, 599),
          candle('2026-09-29T15:30:00Z', 7750, 7),
        ];
      }
      if (path.startsWith(tradesPrefix('ESZ6'))) {
        call += 1;
        // 599 one-lot pages stepping back from the first cursor, then a
        // print before 14:00 ends the piece: the whole budget for one piece.
        if (call === 600) {
          return [print(999_999, '2026-09-29T13:59:59.000000Z', 1, 'buy')];
        }
        const us = parseUwTimeMicros(olderThan(path))! - 2n;
        return [print(call, formatMicrosIso(us), 1, 'buy')];
      }
      throw new Error(`unexpected UW path ${path}`);
    });

    const res = await run();

    // The first piece pages back from 14:01, not from 15:31.
    expect(olderThan(tradesCalls('ESZ6')[0]!)).toBe(
      '2026-09-29T14:01:00.000000Z',
    );
    expect(tradesCalls('ESZ6')).toHaveLength(600);
    expect(sqlValues(updateCalls()[0]!)).toContainEqual([
      '2026-09-29T14:00:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      flow_minutes_repaired: 1,
      flow_ranges_deferred: 1,
    });
  });

  it('a root whose candles already failed in the OHLC pass is skipped by the flow pass, not reported twice', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:40:00Z', 10, true),
      ]);
    routeUwWithTrades(
      { [candlesPath('ESZ6')]: new Error('UW API 502: bad gateway') },
      {},
    );

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(tradesCalls('ESZ6')).toEqual([]);
    expect(res._json).toMatchObject({
      status: 'error',
      failures: ['ES: UW API 502: bad gateway'],
      flowSkippedSymbols: ['ES'],
    });
  });

  it('a root whose volume refresh failed in the OHLC pass is skipped by the flow pass: not refreshed again, not reported twice, no schedule read', async () => {
    mockRefresh.mockRejectedValue(new Error('UW API 502: bad gateway'));
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:40:00Z', 10, true),
      ]);

    const res = await run();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'error',
      failures: ['ES volume refresh: UW API 502: bad gateway'],
      flowSkippedSymbols: ['ES'],
    });
  });

  it('a volume refresh that fails in the flow pass fails the root there, once, with no schedule read', async () => {
    mockRefresh.mockRejectedValue(new Error('UW API 502: bad gateway'));
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);

    const res = await run();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 502: bad gateway' }),
      expect.objectContaining({ extra: { root: 'ES', range: '1m' } }),
    );
    expect(mockFetchSchedule).not.toHaveBeenCalled();
    expect(updateCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'error',
      failures: ['ES volume refresh: UW API 502: bad gateway'],
    });
  });

  it('a root that fails its volume refresh in the flow pass is not retried for its later ranges, and is not listed as skipped', async () => {
    mockRefresh.mockRejectedValue(new Error('UW API 502: bad gateway'));
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T15:01:00Z', 10, true),
      ]);

    const res = await run();

    // One stored-decision read, for the first range; the second is not tried.
    expect(mockFetchStored).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      status: 'error',
      flowSymbols: { ES: expect.objectContaining({ ranges: 2 }) },
    });
    // Skipped symbols are the ones the OHLC pass already reported.
    expect(res._json).not.toHaveProperty('flowSkippedSymbols');
  });
});
