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

const { mockUwFetch, mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: mockWithRetry,
}));

import handler from '../cron/backfill-futures-gaps.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import { formatMicrosIso, parseUwTimeMicros } from '../_lib/uw-time.js';

// ── Fixtures ──────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-09-30' };
// 06:00 UTC run → window is the three prior UTC days.
const NOW = '2026-09-30T06:00:00Z';
const WINDOW_START = '2026-09-27T00:00:00.000Z';
const WINDOW_END = '2026-09-30T00:00:00.000Z';
const CONTRACTS_PATH = '/futures/contracts?days=5';
const candlesPath = (contract: string) =>
  `/futures/${contract}/candles?interval=1m&range=5d`;

/** Live `/futures/contracts` shape (probed 2026-09-30), trimmed. */
const CONTRACTS = [
  { name: 'ESZ6', product: 'ES', is_spread: false, volume: 3_267_170 },
  // Micro: `q=ES` substring-matches it, so the resolver must use EQUALITY.
  { name: 'MESZ6', product: 'MES', is_spread: false, volume: 2_363_415 },
  { name: 'ESH7', product: 'ES', is_spread: false, volume: 1_562 },
  { name: 'ESZ7', product: 'ES', is_spread: false, volume: 5 },
  { name: 'ESZ6-ESH7', product: 'ES', is_spread: true, volume: 9_999_999 },
  { name: 'NQZ6', product: 'NQ', is_spread: false, volume: 1_270_100 },
  { name: 'NQH7', product: 'NQ', is_spread: false, volume: 1_789 },
];

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

describe('backfill-futures-gaps handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    // Every query after the queued ones (the order-flow pass's NULL-flow
    // scan in the OHLC tests) finds nothing.
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guard + wiring ────────────────────────────────────

  it('exits without touching the DB or UW when cronGuard rejects', async () => {
    mockCronGuard.mockReturnValue(null);
    await run();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
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

  it('no-gap run: makes no UW calls and reports success with zero rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await run();
    expect(mockUwFetch).not.toHaveBeenCalled();
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
    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('repairs a single missing open minute (a deploy / lease-handoff hole)', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([{}]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:00:00Z', 7740, 10),
        candle('2026-09-29T14:01:00Z', 7741, 10),
        candle('2026-09-29T14:02:00Z', 7742, 10),
      ],
      [candlesPath('ESH7')]: [],
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
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [
        candle('2026-09-28T20:58:00Z', 7740, 10),
        candle('2026-09-28T20:59:00Z', 7741, 10),
        candle('2026-09-28T22:00:00Z', 7742, 10),
        candle('2026-09-28T22:01:00Z', 7743, 10),
      ],
      [candlesPath('ESH7')]: [],
    });

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

  // ── Front-month resolution + fetch ────────────────────

  it('gap → fetches 1m candles for the top-2 exact-product, non-spread contracts by volume', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
      [candlesPath('ESH7')]: [],
    });
    await run();
    expect(mockUwFetch.mock.calls.map((c) => c[1])).toEqual([
      CONTRACTS_PATH,
      candlesPath('ESZ6'),
      candlesPath('ESH7'),
    ]);
    expect(mockUwFetch.mock.calls.every((c) => c[0] === 'test-uw-key')).toBe(
      true,
    );
  });

  it('upserts only the front-month bars inside the gap via one batched unnest ON CONFLICT DO NOTHING', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [
        candle('2026-09-29T14:00:00Z', 7740, 500), // bounding bar: exists already
        candle('2026-09-29T14:05:00Z', 7745, 400),
        candle('2026-09-29T14:06:00Z', 7746, 300),
        candle('2026-09-29T14:30:00Z', 7750, 200), // bounding bar
        candle('2026-09-29T15:00:00Z', 7760, 100), // outside the gap
      ],
      [candlesPath('ESH7')]: [candle('2026-09-29T14:05:00Z', 7805, 3)],
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
    expect(values).toContainEqual([7745, 7746]); // opens — ESZ6, not ESH7
    expect(values).toContainEqual([400, 300]); // volumes
    expect(res._status).toBe(200);
    // rows = what ON CONFLICT actually inserted (RETURNING), not bars sent.
    expect(res._json).toMatchObject({ status: 'success', rows: 2 });
  });

  it('mirrors the uw-stream front-month rule: per minute, the larger cumulative UTC-day volume wins, ties to the larger symbol, and a leader with no print that minute leaves the minute empty', async () => {
    // Mon 18:50 CDT → Mon 19:20 CDT spans the 00:00 UTC session reset.
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-28T23:50:00Z', '2026-09-29T00:20:00Z'),
      ])
      .mockResolvedValueOnce([]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [
        candle('2026-09-28T23:55:00Z', 7740, 10),
        candle('2026-09-29T00:00:00Z', 7741, 20),
        candle('2026-09-29T00:02:00Z', 7742, 5),
        candle('2026-09-29T00:03:00Z', 7743, 10),
      ],
      [candlesPath('ESH7')]: [
        candle('2026-09-28T23:55:00Z', 7800, 1_000),
        candle('2026-09-29T00:00:00Z', 7801, 20),
        candle('2026-09-29T00:01:00Z', 7802, 100),
        candle('2026-09-29T00:03:00Z', 7803, 10),
      ],
    });

    await run();

    const values = sqlValues(insertCalls()[0]!);
    // 23:55 ESH7 leads the 09-28 tally (1000 vs 10).
    // 00:00 new UTC day resets the tally: 20 vs 20 tie → 'ESZ6' > 'ESH7'.
    // 00:01 ESH7 overtakes (120 vs 20).
    // 00:02 ESH7 still leads (120 vs 25) but has no candle → skipped.
    // 00:03 ESH7 (130 vs 35).
    expect(values).toContainEqual([
      '2026-09-28T23:55:00.000Z',
      '2026-09-29T00:00:00.000Z',
      '2026-09-29T00:01:00.000Z',
      '2026-09-29T00:03:00.000Z',
    ]);
    expect(values).toContainEqual([7800, 7741, 7802, 7803]);
  });

  it('chunks large repairs into 500-row batches', async () => {
    // Mon 22:00 CDT → Tue 08:01 CDT: 600 open minutes missing.
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-29T03:00:00Z', '2026-09-29T13:01:00Z'),
      ])
      .mockResolvedValueOnce(Array.from({ length: 500 }, () => ({})))
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => ({})));
    const start = Date.parse('2026-09-29T03:01:00Z');
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: Array.from({ length: 600 }, (_, i) =>
        candle(new Date(start + i * 60_000).toISOString(), 7700 + i, 10),
      ),
      [candlesPath('ESH7')]: [],
    });

    const res = await run();

    const inserts = insertCalls();
    expect(inserts).toHaveLength(2);
    expect((sqlValues(inserts[0]!)[1] as unknown[]).length).toBe(500);
    expect((sqlValues(inserts[1]!)[1] as unknown[]).length).toBe(100);
    expect(res._json).toMatchObject({ status: 'success', rows: 600 });
  });

  // ── Failure modes (R4) ────────────────────────────────

  it('UW non-OK on /futures/contracts → 500, Sentry exception, error reported (not ok)', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({ [CONTRACTS_PATH]: new Error('UW API 500: upstream down') });

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 500: upstream down' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a non-array /futures/contracts payload → 500, Sentry exception, error reported', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({ [CONTRACTS_PATH]: { unexpected: 'shape' } });

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/non-array/) }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'backfill-futures-gaps',
      expect.objectContaining({ status: 'error' }),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a candle payload at the UW row cap that no longer reaches the gap fails the symbol instead of reporting a clean run', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    // 5,000 rows (UW keeps the NEWEST at the cap) starting after the gap.
    const start = Date.parse('2026-09-29T15:00:00Z');
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: Array.from({ length: 5000 }, (_, i) =>
        candle(new Date(start + i * 60_000).toISOString(), 7700, 10),
      ),
      [candlesPath('ESH7')]: [],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/truncated/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('a capped payload that reaches the gap but not the start of its UTC day also fails (the front-month tally needs the whole day)', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    // Starts 10:00Z — before the 14:01Z gap minute but after 00:00Z, so the
    // replay's UTC-day volume tally for 2026-09-29 would be incomplete.
    const start = Date.parse('2026-09-29T10:00:00Z');
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: Array.from({ length: 5000 }, (_, i) =>
        candle(new Date(start + i * 60_000).toISOString(), 7700, 10),
      ),
      [candlesPath('ESH7')]: [],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/truncated/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('network error on one symbol surfaces to Sentry while the other symbol still repairs → partial', async () => {
    mockSql
      .mockResolvedValueOnce([
        ES_GAP,
        gapRow('NQ', '2026-09-29T14:00:00Z', '2026-09-29T14:30:00Z'),
      ])
      .mockResolvedValueOnce([{}]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: new TypeError('fetch failed'),
      [candlesPath('NQZ6')]: [candle('2026-09-29T14:10:00Z', 26_000, 50)],
      [candlesPath('NQH7')]: [],
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
      [CONTRACTS_PATH]: CONTRACTS,
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

  it('an empty candle payload for the most-active contract is a failure, not a clean zero-row success', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [],
      [candlesPath('ESH7')]: [],
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/no candles/) }),
      expect.anything(),
    );
    expect(insertCalls()).toHaveLength(0);
  });

  it('skips malformed candles, surfaces them via captureMessage, and still inserts the valid ones', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]).mockResolvedValueOnce([{}]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
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
      [candlesPath('ESH7')]: [],
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
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [candle('garbage', 7745, 100)],
    });

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
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: { unexpected: 'shape' },
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  it('fails the symbol when /futures/contracts lists no contract for its root', async () => {
    mockSql.mockResolvedValueOnce([ES_GAP]);
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS.filter((c) => c.product !== 'ES'),
    });

    const res = await run();

    expect(res._json).toMatchObject({ status: 'error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/ES/) }),
      expect.anything(),
    );
  });

  it('a rejected DB insert fails the symbol (status error + Sentry), not success', async () => {
    mockSql
      .mockResolvedValueOnce([ES_GAP])
      .mockRejectedValueOnce(new Error('numeric field overflow'));
    routeUw({
      [CONTRACTS_PATH]: CONTRACTS,
      [candlesPath('ESZ6')]: [candle('2026-09-29T14:05:00Z', 7745, 100)],
      [candlesPath('ESH7')]: [],
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

/** ESZ6 leads 2026-09-29 by a wide margin; ESH7 barely trades. */
const ES_CANDLES = {
  [candlesPath('ESZ6')]: [
    candle('2026-09-29T00:00:00Z', 7700, 5_000),
    candle('2026-09-29T14:01:00Z', 7740, 10),
    candle('2026-09-29T14:02:00Z', 7741, 5),
  ],
  [candlesPath('ESH7')]: [candle('2026-09-29T00:00:00Z', 7760, 3)],
};

/** Two ESZ6 prints in 14:01 and one before it, ending the paging. */
const ES_1401_PAGE = [
  print(2, '2026-09-29T14:01:30.000000Z', 10, 'buy'),
  print(1, '2026-09-29T14:00:30.000000Z', 1, 'buy'),
];

describe('backfill-futures-gaps order-flow pass', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills NULL-flow minutes from the front contract REST prints with one conditional UPDATE, and reports the counts in meta', async () => {
    mockSql
      .mockResolvedValueOnce([]) // no missing bars
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 5, false),
      ])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      {
        ESZ6: [
          [
            print(5, '2026-09-29T14:02:40.000001Z', 3, 'buy'),
            print(4, '2026-09-29T14:02:10.000000Z', 2, 'sell'),
            print(3, '2026-09-29T14:01:50.000000Z', 6, 'buy'),
            print(2, '2026-09-29T14:01:05.000000Z', 4, 'none'),
            print(1, '2026-09-29T14:00:59.999999Z', 9, 'buy'),
          ],
        ],
      },
    );

    const res = await run();

    // Paged back from the end of the range, on the replay's leader.
    expect(tradesCalls('ESH7')).toEqual([]);
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

  it('gives flow to the bars the OHLC pass inserts in the same run, reusing its candles', async () => {
    mockSql
      .mockResolvedValueOnce([
        gapRow('ES', '2026-09-29T14:00:00Z', '2026-09-29T14:02:00Z'),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]) // OHLC insert of 14:01
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]); // flow UPDATE
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [ES_1401_PAGE] },
    );

    const res = await run();

    const paths = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(paths.filter((p) => p === candlesPath('ESZ6'))).toHaveLength(1);
    expect(paths.filter((p) => p === CONTRACTS_PATH)).toHaveLength(1);
    expect(insertCalls()).toHaveLength(1);
    expect(updateCalls()).toHaveLength(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      flow_minutes_repaired: 1,
    });
  });

  it('fetches prints from the contract the roll replay picks, and skips a minute whose leader has no candle', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        // No candle for any ES contract at 14:05: unattributed.
        nullFlowRow('ES', '2026-09-29T14:05:00Z', 7, false),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    routeUwWithTrades(
      {
        [CONTRACTS_PATH]: CONTRACTS,
        [candlesPath('ESZ6')]: [candle('2026-09-29T14:01:00Z', 7740, 5)],
        // Mid-roll: ESH7 leads the 09-29 tally.
        [candlesPath('ESH7')]: [
          candle('2026-09-29T00:00:00Z', 7760, 90_000),
          candle('2026-09-29T14:01:00Z', 7761, 10),
        ],
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
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [ES_1401_PAGE] },
    );

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
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [[print(9, '2026-09-29T14:02:30.000000Z', 5, 'buy')], []] },
    );

    const res = await run();

    expect(updateCalls()).toHaveLength(0);
    expect(res._json).toMatchObject({
      status: 'success',
      flow_ranges_unrepairable: 1,
      flow_minutes_repaired: 0,
    });
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
      if (path === CONTRACTS_PATH) return CONTRACTS;
      if (path === candlesPath('NQZ6')) {
        return [
          candle('2026-09-29T13:00:00Z', 26_000, 50),
          candle('2026-09-29T13:01:00Z', 26_001, 50),
        ];
      }
      if (path === candlesPath('NQH7')) return [];
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
    expect(res._json).toMatchObject({
      status: 'success',
      flow_pages: 600,
      flow_ranges_deferred: 2,
    });
  });

  it('an upstream 5xx on /trades fails the symbol: Sentry exception, status error, never success', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [new Error('UW API 503: unavailable')] },
    );

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
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [{ unexpected: 'shape' }] },
    );

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
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      { ESZ6: [ES_1401_PAGE] },
    );

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
        [CONTRACTS_PATH]: CONTRACTS,
        ...ES_CANDLES,
        [candlesPath('NQZ6')]: [candle('2026-09-29T14:01:00Z', 26_000, 4)],
        [candlesPath('NQH7')]: [],
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

  it('a failed contract list in the flow pass reports status error with a Sentry exception, still answering 200', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
      ]);
    routeUwWithTrades(
      { [CONTRACTS_PATH]: new Error('UW API 500: upstream down') },
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

  it('a malformed print withholds its minute and surfaces as a Sentry warning, while the rest of the range is written', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 5, false),
      ])
      .mockResolvedValueOnce([{ ts: 'x' }]);
    routeUwWithTrades(
      { [CONTRACTS_PATH]: CONTRACTS, ...ES_CANDLES },
      {
        ESZ6: [
          [
            print(5, '2026-09-29T14:02:40.000000Z', 3, 'up'), // unknown side
            print(4, '2026-09-29T14:02:10.000000Z', 2, 'sell'),
            ...ES_1401_PAGE,
          ],
        ],
      },
    );

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
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        nullFlowRow('ES', '2026-09-29T14:01:00Z', 10, true),
        nullFlowRow('ES', '2026-09-29T14:02:00Z', 10, false),
      ]);
    let id = 1;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path === CONTRACTS_PATH) return CONTRACTS;
      // ESZ6 leads 14:01; ESH7 overtakes at 14:02 (a roll mid-range).
      if (path === candlesPath('ESZ6')) {
        return [candle('2026-09-29T14:01:00Z', 7740, 100)];
      }
      if (path === candlesPath('ESH7')) {
        return [candle('2026-09-29T14:02:00Z', 7790, 1_000)];
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
  });
});
