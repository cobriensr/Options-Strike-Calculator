// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The handler issues ONE tagged-template SELECT (the per-symbol high-water
// mark), plus a COUNT for the data-quality check when a symbol writes more
// than 10 rows, and writes through the real bulkUpsert, which calls
// `sql.query()` for a single chunk and `sql.transaction()` past 500 rows.
const mockQuery = vi.fn();
const mockTransaction = vi.fn();
const mockSql = Object.assign(vi.fn(), {
  query: mockQuery,
  transaction: mockTransaction,
});

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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const {
  mockUwFetch,
  mockSchwabFetch,
  mockCronGuard,
  mockWithRetry,
  mockCheckDataQuality,
} = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockSchwabFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
  mockCheckDataQuality: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  schwabFetch: mockSchwabFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  checkDataQuality: mockCheckDataQuality,
  withRetry: mockWithRetry,
}));

import handler from '../cron/fetch-spx-candles-1m.js';
import { _resetDsnCacheForTest } from '../_lib/cron-instrumentation.js';
import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Fixtures ──────────────────────────────────────────────────

const JOB = 'fetch-spx-candles-1m';
const TODAY = '2026-03-24';
const GUARD = { apiKey: 'uwkey', today: TODAY };

// Tuesday 10:40:30 ET. Every fixture candle below starts before this, so
// none is the still-forming minute unless a test moves the clock.
const NOW = '2026-03-24T14:40:30.000Z';

// UW's newest bucket at NOW. UW always returns the forming bar on top, and
// the handler never writes the newest bar, so every payload that should
// write something carries this as its newest candle.
const FORMING_AT_NOW = '2026-03-24T14:40:00.000Z';

// The minute that closed just before NOW: the row the Schwab anchor lands on.
const JUST_CLOSED = '2026-03-24T14:39:00.000Z';

const SPX_PRICE = 6817.43;
const SPY_PRICE = 585.0;
const NDX_PRICE = 24500.0;
const QQQ_PRICE = 510.0;
const SPX_RATIO = SPX_PRICE / SPY_PRICE;
const NDX_RATIO = NDX_PRICE / QQQ_PRICE;

function makeCandle(overrides: Record<string, unknown> = {}) {
  return {
    open: '580.00',
    high: '580.25',
    low: '579.90',
    close: '580.10',
    volume: 2480,
    total_volume: 93553050,
    start_time: '2026-03-24T14:32:00.000Z',
    end_time: '2026-03-24T14:33:00.000Z',
    market_time: 'r',
    ...overrides,
  };
}

/** UW returns intraday candles newest first; mirror that in fixtures. */
function candlesAt(...isoTimes: string[]) {
  return isoTimes.map((start_time) => makeCandle({ start_time }));
}

/** The still-forming bar UW puts on top of a live payload. */
const forming = () => makeCandle({ start_time: FORMING_AT_NOW });

/** `count` consecutive closed candles from 14:20, newest first. */
function closedRun(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeCandle({
      start_time: `2026-03-24T14:${String(20 + i).padStart(2, '0')}:00.000Z`,
    }),
  ).reverse();
}

/** Schwab quotes for all four symbols, so both legs have a ratio. */
function schwabQuotes(
  overrides: Partial<Record<'$SPX' | 'SPY' | '$NDX' | 'QQQ', unknown>> = {},
) {
  return {
    ok: true as const,
    data: {
      $SPX: { quote: { lastPrice: SPX_PRICE } },
      SPY: { quote: { lastPrice: SPY_PRICE } },
      $NDX: { quote: { lastPrice: NDX_PRICE } },
      QQQ: { quote: { lastPrice: QQQ_PRICE } },
      ...overrides,
    },
  };
}

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/**
 * Route each UW fetch by ETF ticker so tests don't depend on call order. A
 * ticker left out gets a healthy payload: the forming bar plus one closed
 * candle (an empty payload is a failure, so it has to be asked for).
 */
function uwReturns(byTicker: Partial<Record<'SPY' | 'QQQ', unknown[]>>) {
  mockUwFetch.mockImplementation((_key: string, path: string) => {
    const ticker = /\/stock\/([A-Z]+)\//.exec(path)?.[1] as 'SPY' | 'QQQ';
    return Promise.resolve(byTicker[ticker] ?? [forming(), makeCandle()]);
  });
}

interface WriteCall {
  stmt: string;
  params: unknown[];
}

/** INSERTs bulkUpsert issued inside `sql.transaction` (multi-chunk path). */
let txnWrites: WriteCall[] = [];

/** Every INSERT bulkUpsert issued, direct and inside a transaction. */
function writeCalls(): WriteCall[] {
  const direct = mockQuery.mock.calls.map(([stmt, params]) => ({
    stmt: stmt as string,
    params: params as unknown[],
  }));
  return [...direct, ...txnWrites];
}

/** Decode the flat bulkUpsert params back into row objects. */
function decodeRows({ stmt, params }: WriteCall) {
  const cols = /INSERT INTO index_candles_1m \(([^)]+)\)/
    .exec(stmt)![1]!
    .split(',')
    .map((c) => c.trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < params.length; i += cols.length) {
    rows.push(Object.fromEntries(cols.map((c, j) => [c, params[i + j]])));
  }
  return rows;
}

/** Every row written for one index symbol, in the order sent. */
function sentRows(symbol: 'SPX' | 'NDX') {
  return writeCalls()
    .flatMap(decodeRows)
    .filter((r) => r.symbol === symbol);
}

/** Timestamps written for one index symbol, in the order sent. */
function sentTimestamps(symbol: 'SPX' | 'NDX'): unknown[] {
  return sentRows(symbol).map((r) => r.timestamp);
}

/** The high-water-mark SELECT (the first tagged template on mockSql). */
function hwmQuery() {
  const [strings, ...values] = mockSql.mock.calls[0]!;
  return { text: (strings as readonly string[]).join('?'), values };
}

/** The single Axiom event the run sent. */
function axiomEvent(): Record<string, unknown> {
  expect(reportCronRun).toHaveBeenCalledTimes(1);
  const [job, payload] = vi.mocked(reportCronRun).mock.calls[0]!;
  expect(job).toBe(JOB);
  return payload;
}

describe('fetch-spx-candles-1m handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    txnWrites = [];
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    mockSchwabFetch.mockResolvedValue(schwabQuotes());
    // Default: the forming bar plus one closed candle per ticker.
    mockUwFetch.mockResolvedValue([forming(), makeCandle()]);
    // Default: no rows stored yet today → no high-water mark.
    mockSql.mockResolvedValue([]);
    mockQuery.mockResolvedValue([]);
    mockTransaction.mockImplementation(
      async (fn: (txn: { query: typeof mockQuery }) => unknown[]) => {
        const txn = {
          query: vi.fn((stmt: string, params: unknown[]) => {
            txnWrites.push({ stmt, params });
            return Promise.resolve([]);
          }),
        };
        return Promise.all(fn(txn));
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guard (unchanged: cronGuard's defaults) ───────────────

  it('returns 401 without fetching when CRON_SECRET is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);

    expect(res._status).toBe(401);
    expect(mockSchwabFetch).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(reportCronRun).not.toHaveBeenCalled();
  });

  it('uses cronGuard with its default gate (CRON_SECRET, market hours, UW key)', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    // No options: the default isMarketHours() window (09:25 ET to close + 5).
    expect(mockCronGuard).toHaveBeenCalledTimes(1);
    expect(mockCronGuard.mock.calls[0]).toEqual([req, res]);
  });

  it('does nothing when cronGuard skips outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toEqual({ skipped: true, reason: 'Outside time window' });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────

  it('translates SPY→SPX and QQQ→NDX by the live ratio and writes each in one batched INSERT', async () => {
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:33:00.000Z',
        '2026-03-24T14:32:00.000Z',
      ),
      QQQ: [
        forming(),
        makeCandle({
          open: '510.50',
          high: '511.00',
          low: '510.20',
          close: '510.85',
        }),
      ],
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: JOB,
      status: 'ok',
      success: true,
      failureCount: 0,
      totalStored: 3,
      spx: {
        symbol: 'SPX',
        fetched: 3,
        new: 2,
        stored: 2,
        skipped: 1,
        malformed: 0,
        ratio: SPX_RATIO,
        indexPrice: SPX_PRICE,
      },
      ndx: {
        symbol: 'NDX',
        fetched: 2,
        new: 1,
        stored: 1,
        skipped: 1,
        malformed: 0,
        ratio: NDX_RATIO,
        indexPrice: NDX_PRICE,
      },
    });
    // One INSERT statement per symbol, not one per candle, and no
    // transaction for a single chunk.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockTransaction).not.toHaveBeenCalled();

    const [ndxRow] = sentRows('NDX');
    expect(ndxRow!.open).toBeCloseTo(510.5 * NDX_RATIO, 6);
    expect(ndxRow!.high).toBeCloseTo(511.0 * NDX_RATIO, 6);
    expect(ndxRow!.low).toBeCloseTo(510.2 * NDX_RATIO, 6);
    expect(ndxRow!.close).toBeCloseTo(510.85 * NDX_RATIO, 6);
  });

  it('keeps the top-level SPX mirror fields in the response', async () => {
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      job: JOB,
      success: true,
      stored: 1,
      skipped: 1,
      ratio: Math.round(SPX_RATIO * 10000) / 10000,
      spxPrice: SPX_PRICE,
      totalStored: 2,
      durationMs: expect.any(Number),
    });
    expect((res._json as { reason?: string }).reason).toBeUndefined();
  });

  it('sends Axiom the same job and top-level keys as before; per-symbol detail stays nested', async () => {
    await handler(AUTHORIZED_REQ(), mockResponse());

    const event = axiomEvent();
    // Only status, totalStored and durationMs are primitives (existing
    // columns); spx / ndx are objects, which reportCronRun puts in `meta`.
    expect(Object.keys(event).sort()).toEqual([
      'durationMs',
      'ndx',
      'spx',
      'status',
      'totalStored',
    ]);
    expect(event).toMatchObject({
      status: 'ok',
      totalStored: 2,
      spx: { symbol: 'SPX', stored: 1 },
      ndx: { symbol: 'NDX', stored: 1 },
    });
  });

  it('fetches SPY before QQQ, one UW request at a time, for today with limit 500', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockUwFetch.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return [forming(), makeCandle()];
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    // Sequential so this cron never holds two UW concurrency slots.
    expect(maxInFlight).toBe(1);
    expect(mockUwFetch.mock.calls.map((c) => c[1])).toEqual([
      `/stock/SPY/ohlc/1m?date=${TODAY}&limit=500`,
      `/stock/QQQ/ohlc/1m?date=${TODAY}&limit=500`,
    ]);
    expect(mockSchwabFetch).toHaveBeenCalledTimes(1);
    expect(mockSchwabFetch).toHaveBeenCalledWith(
      '/quotes?symbols=SPY%2C%24SPX%2CQQQ%2C%24NDX&fields=quote',
    );
  });

  it('writes every column with the SPX-scaled OHLC, the date and market_time, and ON CONFLICT DO NOTHING', async () => {
    uwReturns({
      SPY: [
        forming(),
        makeCandle({
          start_time: '2026-03-24T14:32:00.000Z',
          open: '580.00',
          high: '581.50',
          low: '579.25',
          close: '580.90',
        }),
      ],
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    const call = writeCalls().find(({ params }) => params[0] === 'SPX')!;
    expect(call.stmt).toMatch(
      /ON CONFLICT \(symbol, date, timestamp\) DO NOTHING/,
    );
    const [row] = decodeRows(call);
    expect(row).toEqual({
      symbol: 'SPX',
      date: TODAY,
      timestamp: '2026-03-24T14:32:00.000Z',
      open: expect.closeTo(580.0 * SPX_RATIO, 6),
      high: expect.closeTo(581.5 * SPX_RATIO, 6),
      low: expect.closeTo(579.25 * SPX_RATIO, 6),
      close: expect.closeTo(580.9 * SPX_RATIO, 6),
      volume: 2480,
      market_time: 'r',
      spx_schwab_price: null,
      ndx_schwab_price: null,
    });
    expect(call.params).not.toContain(undefined);
  });

  it('keeps pre-market and post-market candles with their market_time', async () => {
    vi.setSystemTime(new Date('2026-03-24T20:04:30.000Z'));
    uwReturns({
      SPY: [
        makeCandle({
          start_time: '2026-03-24T20:04:00.000Z',
          market_time: 'po',
        }),
        makeCandle({
          start_time: '2026-03-24T20:01:00.000Z',
          market_time: 'po',
        }),
        makeCandle({
          start_time: '2026-03-24T14:30:00.000Z',
          market_time: 'r',
        }),
        makeCandle({
          start_time: '2026-03-24T13:00:00.000Z',
          market_time: 'pr',
        }),
      ],
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(sentRows('SPX').map((r) => [r.timestamp, r.market_time])).toEqual([
      ['2026-03-24T13:00:00.000Z', 'pr'],
      ['2026-03-24T14:30:00.000Z', 'r'],
      ['2026-03-24T20:01:00.000Z', 'po'],
    ]);
  });

  // ── High-water mark ───────────────────────────────────────

  it('reads the high-water mark once per run, bounded at ET midnight of today', async () => {
    await handler(AUTHORIZED_REQ(), mockResponse());

    // Only the HWM SELECT: no anchor UPDATE, no QC COUNT on a small run.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const { text, values } = hwmQuery();
    expect(text).toMatch(/MAX\(timestamp\)/);
    expect(text).toMatch(/FROM index_candles_1m/);
    expect(text).toMatch(/GROUP BY symbol/);
    // A bare date compares as UTC midnight (4–5 h early) and
    // `::date AT TIME ZONE` without `::timestamp` lands 8–10 h early; the
    // bound must be ET midnight of the trading day.
    expect(text).toMatch(
      /\?::date::timestamp AT TIME ZONE 'America\/New_York'/,
    );
    expect(values).toContain(TODAY);
    expect(values).toContainEqual(['SPX', 'NDX']);
  });

  it('sends only candles after the per-symbol high-water mark, oldest first', async () => {
    // Neon returns TIMESTAMPTZ as a Date; accept an ISO string too.
    mockSql.mockResolvedValueOnce([
      { symbol: 'SPX', hwm: new Date('2026-03-24T14:32:00.000Z') },
      { symbol: 'NDX', hwm: '2026-03-24T14:33:00.000Z' },
    ]);
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:34:00.000Z',
        '2026-03-24T14:33:00.000Z',
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
      QQQ: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:34:00.000Z',
        '2026-03-24T14:33:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPX')).toEqual([
      '2026-03-24T14:33:00.000Z',
      '2026-03-24T14:34:00.000Z',
    ]);
    expect(sentTimestamps('NDX')).toEqual(['2026-03-24T14:34:00.000Z']);
    expect(res._json).toMatchObject({
      status: 'ok',
      spx: { fetched: 5, new: 2, stored: 2, skipped: 3 },
      ndx: { fetched: 3, new: 1, stored: 1, skipped: 2 },
    });
  });

  it('sends every closed candle when a symbol has no high-water mark yet', async () => {
    // Only NDX has rows today; SPX's absence from the GROUP BY = null HWM.
    mockSql.mockResolvedValueOnce([
      { symbol: 'NDX', hwm: new Date('2026-03-24T14:38:00.000Z') },
    ]);
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:33:00.000Z',
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
      QQQ: candlesAt(FORMING_AT_NOW, '2026-03-24T14:33:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPX')).toEqual([
      '2026-03-24T14:31:00.000Z',
      '2026-03-24T14:32:00.000Z',
      '2026-03-24T14:33:00.000Z',
    ]);
    expect(sentTimestamps('NDX')).toEqual([]);
    expect(res._json).toMatchObject({
      spx: { fetched: 4, new: 3, stored: 3, skipped: 1 },
      ndx: { fetched: 2, new: 0, stored: 0, skipped: 2 },
    });
  });

  it('skips the write entirely when nothing is newer than the high-water mark', async () => {
    mockSql.mockResolvedValueOnce([
      { symbol: 'SPX', hwm: new Date('2026-03-24T14:32:00.000Z') },
      { symbol: 'NDX', hwm: new Date('2026-03-24T14:32:00.000Z') },
    ]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'ok',
      success: true,
      totalStored: 0,
      spx: { fetched: 2, new: 0, stored: 0, skipped: 2 },
      ndx: { fetched: 2, new: 0, stored: 0, skipped: 2 },
    });
  });

  // ── Still-forming bar ─────────────────────────────────────

  it('never writes the candle for the minute the clock is still in', async () => {
    // UW docs: "The most recent intraday candle is still forming, and its
    // start_time is the start of the current bucket." Writing it would let
    // DO NOTHING + the HWM freeze a partial bar forever.
    vi.setSystemTime(new Date('2026-03-24T14:33:30.000Z'));
    uwReturns({
      SPY: candlesAt(
        '2026-03-24T14:33:00.000Z', // forming
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPX')).toEqual([
      '2026-03-24T14:31:00.000Z',
      '2026-03-24T14:32:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      spx: { fetched: 3, new: 2, stored: 2, skipped: 1 },
    });
  });

  it('holds back the clock minute even when UW is already a minute ahead (clock skew)', async () => {
    // UW has opened 14:34 while our clock still reads 14:33: the clock is
    // the binding bound, so 14:33 waits for the next run.
    vi.setSystemTime(new Date('2026-03-24T14:33:30.000Z'));
    uwReturns({
      SPY: candlesAt(
        '2026-03-24T14:34:00.000Z',
        '2026-03-24T14:33:00.000Z',
        '2026-03-24T14:32:00.000Z',
      ),
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(sentTimestamps('SPX')).toEqual(['2026-03-24T14:32:00.000Z']);
  });

  it('never writes the newest UW candle, even when the clock says its minute closed', async () => {
    // cronJitter fires 0–8 s past the minute. If UW hasn't opened the
    // 14:33 bucket yet, 14:32 is still its newest (forming) bar: the clock
    // alone would write it and DO NOTHING + the HWM would freeze it.
    vi.setSystemTime(new Date('2026-03-24T14:33:02.000Z'));
    uwReturns({
      SPY: candlesAt('2026-03-24T14:32:00.000Z', '2026-03-24T14:31:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPX')).toEqual(['2026-03-24T14:31:00.000Z']);
    expect(res._json).toMatchObject({
      spx: { fetched: 2, new: 1, stored: 1, skipped: 1 },
    });
  });

  it('de-duplicates repeated start_times before writing', async () => {
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(sentTimestamps('SPX')).toEqual([
      '2026-03-24T14:31:00.000Z',
      '2026-03-24T14:32:00.000Z',
    ]);
  });

  it('writes more than 500 new candles through one transaction', async () => {
    // A null HWM at the first run of the day can mean a whole pre-market
    // plus session of minutes: past bulkUpsert's 500-row chunk.
    const base = Date.parse('2026-03-24T08:00:00.000Z');
    const spy = Array.from({ length: 501 }, (_, i) =>
      makeCandle({ start_time: new Date(base + i * 60_000).toISOString() }),
    ).reverse();
    vi.setSystemTime(new Date('2026-03-24T20:00:30.000Z'));
    const formingAt20 = makeCandle({ start_time: '2026-03-24T20:00:00.000Z' });
    uwReturns({ SPY: [formingAt20, ...spy] });
    // HWM, then the QC COUNT that a >10-row write triggers.
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 501, nonzero: 501 }]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(txnWrites).toHaveLength(2); // 500 + 1
    expect(txnWrites.every(({ params }) => params[0] === 'SPX')).toBe(true);
    // The only direct single-statement write is NDX's one candle.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0]![1][0]).toBe('NDX');
    const sent = sentTimestamps('SPX');
    expect(sent).toHaveLength(501);
    expect(sent[0]).toBe('2026-03-24T08:00:00.000Z');
    expect(sent.at(-1)).toBe('2026-03-24T16:20:00.000Z');
    expect(res._json).toMatchObject({
      status: 'ok',
      spx: { fetched: 502, new: 501, stored: 501 },
    });
  });

  // ── Schwab anchor (spx_schwab_price / ndx_schwab_price) ───

  it('stamps the Schwab price on the minute that just closed, in its own symbol column', async () => {
    // The quote is read seconds after JUST_CLOSED ended, so it is that
    // minute's close; the forming minute is never written to carry it.
    uwReturns({
      SPY: candlesAt(FORMING_AT_NOW, JUST_CLOSED, '2026-03-24T14:38:00.000Z'),
      QQQ: candlesAt(FORMING_AT_NOW, JUST_CLOSED),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(
      sentRows('SPX').map((r) => [
        r.timestamp,
        r.spx_schwab_price,
        r.ndx_schwab_price,
      ]),
    ).toEqual([
      ['2026-03-24T14:38:00.000Z', null, null],
      [JUST_CLOSED, SPX_PRICE, null],
    ]);
    expect(
      sentRows('NDX').map((r) => [
        r.timestamp,
        r.spx_schwab_price,
        r.ndx_schwab_price,
      ]),
    ).toEqual([[JUST_CLOSED, null, NDX_PRICE]]);
    expect(res._json).toMatchObject({
      spx: { anchored: true },
      ndx: { anchored: true },
    });
    // Folded into the INSERT: no separate anchor UPDATE round trip.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('stamps no anchor when the just-closed minute is held back as UW’s newest bar', async () => {
    // UW hasn't opened 14:40 yet, so 14:39 is still forming and waits for
    // the next run; a quote taken now is a minute late for 14:38.
    uwReturns({
      SPY: candlesAt(JUST_CLOSED, '2026-03-24T14:38:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentRows('SPX')).toEqual([
      expect.objectContaining({
        timestamp: '2026-03-24T14:38:00.000Z',
        spx_schwab_price: null,
      }),
    ]);
    expect(res._json).toMatchObject({ spx: { anchored: false } });
  });

  it('reports anchored false when the anchored row’s write fails', async () => {
    mockQuery.mockRejectedValue(new Error('Neon outage'));
    uwReturns({ SPY: candlesAt(FORMING_AT_NOW, JUST_CLOSED) });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      spx: { new: 1, stored: 0, anchored: false },
    });
  });

  // ── Data quality check ────────────────────────────────────

  it('runs the data quality check for a symbol that wrote more than 10 rows', async () => {
    uwReturns({ SPY: [forming(), ...closedRun(11)] });
    mockSql
      .mockResolvedValueOnce([]) // HWM
      .mockResolvedValueOnce([{ total: '11', nonzero: '11' }]); // QC

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({ status: 'ok', spx: { stored: 11 } });
    expect(mockSql).toHaveBeenCalledTimes(2);
    const [strings, ...values] = mockSql.mock.calls[1]!;
    expect((strings as readonly string[]).join('?')).toMatch(/SELECT COUNT/);
    expect(values).toEqual(['SPX', TODAY]);
    expect(mockCheckDataQuality).toHaveBeenCalledTimes(1);
    expect(mockCheckDataQuality).toHaveBeenCalledWith({
      job: JOB,
      table: 'index_candles_1m',
      date: TODAY,
      sourceFilter: '1-minute SPY candles translated to SPX',
      total: 11,
      nonzero: 11,
    });
  });

  it('skips the data quality check when a symbol wrote 10 rows or fewer', async () => {
    uwReturns({ SPY: [forming(), ...closedRun(10)] });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({ spx: { stored: 10 } });
    expect(mockCheckDataQuality).not.toHaveBeenCalled();
  });

  // ── Failure modes (R4) ────────────────────────────────────

  it('high-water-mark SELECT rejects → 500, status error, Sentry, nothing fetched or written', async () => {
    const neonDown = new Error('Neon: connection terminated');
    mockSql.mockRejectedValueOnce(neonDown);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(axiomEvent()).toEqual({
      status: 'error',
      error: 'Neon: connection terminated',
      durationMs: expect.any(Number),
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(neonDown);
    expect(mockSchwabFetch).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('SPX insert rejects → status partial, success false, NDX still stored, one Sentry event tagged SPX', async () => {
    const spxWriteErr = new Error('DB insert failed: SPX');
    mockQuery.mockImplementation((_stmt: string, params: unknown[]) =>
      params[0] === 'SPX' ? Promise.reject(spxWriteErr) : Promise.resolve([]),
    );
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    // Partial keeps HTTP 200, so the Sentry cron monitor stays green.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      success: false,
      failureCount: 1,
      totalStored: 1,
      stored: false,
      reason: 'DB insert failed: SPX',
      spx: {
        fetched: 3,
        new: 2,
        stored: 0,
        reason: 'DB insert failed: SPX',
      },
      ndx: { fetched: 2, new: 1, stored: 1 },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(spxWriteErr, {
      tags: { symbol: 'SPX' },
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.store_error',
    );
    expect(axiomEvent()).toMatchObject({ status: 'partial', totalStored: 1 });
  });

  it('both inserts reject → 500, status error, one Sentry event per symbol (not per row)', async () => {
    const writeErr = {
      SPX: new Error('Neon outage: SPX'),
      NDX: new Error('Neon outage: NDX'),
    };
    mockQuery.mockImplementation((_stmt: string, params: unknown[]) =>
      Promise.reject(writeErr[params[0] as 'SPX' | 'NDX']),
    );
    uwReturns({
      SPY: candlesAt(
        FORMING_AT_NOW,
        '2026-03-24T14:33:00.000Z',
        '2026-03-24T14:32:00.000Z',
        '2026-03-24T14:31:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    // 500 is what turns the Sentry cron monitor red (withCronCheckin
    // keys the check-in on statusCode >= 400).
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      status: 'error',
      success: false,
      failureCount: 2,
      totalStored: 0,
      spx: { stored: 0 },
      ndx: { stored: 0 },
    });
    expect(axiomEvent()).toMatchObject({ status: 'error', totalStored: 0 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(writeErr.SPX, {
      tags: { symbol: 'SPX' },
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(writeErr.NDX, {
      tags: { symbol: 'NDX' },
    });
    const storeErrors = vi
      .mocked(metrics.increment)
      .mock.calls.filter(([m]) => m === 'fetch_spx_candles_1m.store_error');
    expect(storeErrors).toHaveLength(2);
  });

  it('Schwab quote fetch fails → status error, both symbols fail, nothing fetched or written', async () => {
    mockSchwabFetch.mockResolvedValue({
      ok: false as const,
      status: 503,
      error: 'Service unavailable',
      code: 'SCHWAB_API_503',
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      status: 'error',
      success: false,
      failureCount: 2,
      stored: false,
      reason: 'fetch-spx-candles-1m: SPX/SPY ratio unavailable from Schwab',
      spx: { stored: 0 },
      ndx: {
        stored: 0,
        reason: 'fetch-spx-candles-1m: NDX/QQQ ratio unavailable from Schwab',
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-spx-candles-1m: SPX/SPY ratio unavailable from Schwab',
      }),
      { tags: { symbol: 'SPX' } },
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.ratio_unavailable_spx',
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.ratio_unavailable_ndx',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { status: 503 },
      'fetch-spx-candles-1m: Schwab quote fetch failed',
    );
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Schwab omits the NDX price → status partial, SPX still stored', async () => {
    mockSchwabFetch.mockResolvedValue(schwabQuotes({ $NDX: { quote: {} } }));

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      stored: 1,
      spx: { stored: 1, ratio: SPX_RATIO },
      ndx: {
        stored: 0,
        reason: 'fetch-spx-candles-1m: NDX/QQQ ratio unavailable from Schwab',
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-spx-candles-1m: NDX/QQQ ratio unavailable from Schwab',
      }),
      { tags: { symbol: 'NDX' } },
    );
    // The NDX leg never asks UW for QQQ.
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(sentTimestamps('NDX')).toEqual([]);
  });

  it('a non-positive Schwab price is treated as unavailable', async () => {
    mockSchwabFetch.mockResolvedValue(
      schwabQuotes({ SPY: { quote: { lastPrice: 0 } } }),
    );

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      stored: false,
      spx: { stored: 0 },
      ndx: { stored: 1 },
    });
  });

  it('UW fetch fails for SPY → status partial, NDX still stored, Sentry tagged SPX', async () => {
    const spyFetchErr = new Error('UW API 500: SPY');
    mockUwFetch.mockImplementation((_key: string, path: string) =>
      path.includes('/SPY/')
        ? Promise.reject(spyFetchErr)
        : Promise.resolve([forming(), makeCandle()]),
    );

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      spx: { fetched: 0, stored: 0, reason: 'UW API 500: SPY' },
      ndx: { fetched: 2, stored: 1 },
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(spyFetchErr, {
      tags: { symbol: 'SPX' },
    });
    // A UW failure is not a write failure.
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'fetch_spx_candles_1m.store_error',
    );
    expect(sentTimestamps('NDX')).toEqual(['2026-03-24T14:32:00.000Z']);
  });

  it('UW fetch fails for both → 500, status error, Sentry per symbol, nothing written', async () => {
    mockWithRetry.mockRejectedValue(new Error('UW total outage'));

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ status: 'error', failureCount: 2 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('empty UW payload for both → status error, Sentry per symbol, nothing written', async () => {
    // Inside the gated window `date=today` always carries pre-market bars
    // from 04:00 ET, so `data: []` means UW is broken, not a quiet market.
    mockUwFetch.mockResolvedValue([]);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      status: 'error',
      failureCount: 2,
      spx: { fetched: 0, new: 0, stored: 0, skipped: 0 },
      ndx: { fetched: 0, new: 0, stored: 0, skipped: 0 },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-spx-candles-1m: UW returned no 1m SPY candles for SPX',
      }),
      { tags: { symbol: 'SPX' } },
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-spx-candles-1m: UW returned no 1m QQQ candles for NDX',
      }),
      { tags: { symbol: 'NDX' } },
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.empty_payload',
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('empty UW payload for QQQ only → status partial, SPX still stored', async () => {
    uwReturns({ QQQ: [] });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      spx: { fetched: 2, stored: 1 },
      ndx: { fetched: 0, stored: 0 },
    });
    expect(sentTimestamps('SPX')).toEqual(['2026-03-24T14:32:00.000Z']);
  });

  it('a data quality COUNT failure after a good write fails the symbol but keeps its stored count', async () => {
    uwReturns({ SPY: [forming(), ...closedRun(11)] });
    const qcErr = new Error('Neon: QC count timed out');
    mockSql.mockResolvedValueOnce([]).mockRejectedValueOnce(qcErr);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      totalStored: 12,
      spx: { stored: 11, reason: 'Neon: QC count timed out' },
      ndx: { stored: 1 },
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(qcErr, {
      tags: { symbol: 'SPX' },
    });
  });

  // ── Malformed payload ─────────────────────────────────────

  it('drops malformed candles, counts them and raises one Sentry warning per symbol', async () => {
    // One bad row must not poison the whole batch: the HWM would never
    // advance past it and the symbol would fail every minute all day.
    mockSql.mockResolvedValueOnce([
      { symbol: 'SPX', hwm: new Date('2026-03-24T14:30:00.000Z') },
    ]);
    uwReturns({
      SPY: [
        forming(),
        makeCandle({ start_time: 'not-a-time' }),
        makeCandle({ start_time: '2026-03-24T14:38:00.000Z', open: 'n/a' }),
        makeCandle({ start_time: '2026-03-24T14:37:00.000Z', close: null }),
        // BIGINT NOT NULL rejects a fraction or a missing volume, and the
        // CHECK rejects an unknown session: either fails the whole INSERT.
        makeCandle({ start_time: '2026-03-24T14:36:00.000Z', volume: 12.5 }),
        makeCandle({ start_time: '2026-03-24T14:35:00.000Z', volume: null }),
        makeCandle({
          start_time: '2026-03-24T14:34:00.000Z',
          market_time: 'x',
        }),
        makeCandle({ start_time: '2026-03-24T14:31:00.000Z' }),
        // Already behind the HWM: skipped, not re-counted as malformed.
        makeCandle({ start_time: '2026-03-24T14:29:00.000Z', open: 'bad' }),
      ],
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPX')).toEqual(['2026-03-24T14:31:00.000Z']);
    expect(res._json).toMatchObject({
      status: 'ok',
      spx: { fetched: 9, new: 1, stored: 1, skipped: 8, malformed: 6 },
      ndx: { malformed: 0 },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-spx-candles-1m: malformed UW candles dropped',
      { level: 'warning', extra: { symbol: 'SPX', malformed: 6 } },
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_spx_candles_1m.malformed',
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('writes the integer it validated when UW sends volume as a string', async () => {
    // Off-contract (UW documents an integer), but Postgres BIGINT rejects
    // '1.0' and '1e3' even though both validate as safe integers.
    uwReturns({
      SPY: [
        forming(),
        makeCandle({ start_time: '2026-03-24T14:32:00.000Z', volume: '1.0' }),
        makeCandle({ start_time: '2026-03-24T14:31:00.000Z', volume: '1e3' }),
      ],
    });

    await handler(AUTHORIZED_REQ(), mockResponse());

    expect(sentRows('SPX').map((r) => r.volume)).toEqual([1000, 1]);
  });

  // ── Sentry cron monitor (withCronCheckin, slug unchanged) ─

  describe('Sentry cron check-ins', () => {
    const originalDsn = process.env.SENTRY_DSN;
    const originalSecret = process.env.CRON_SECRET;
    const fetchMock = vi.fn();

    beforeEach(() => {
      process.env.SENTRY_DSN = 'https://pubkey@o1.ingest.us.sentry.io/42';
      process.env.CRON_SECRET = 'test-secret';
      _resetDsnCacheForTest();
      fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (originalDsn === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = originalDsn;
      if (originalSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalSecret;
      _resetDsnCacheForTest();
    });

    /** The check-in POSTs, in order: [url, body]. */
    async function checkIns(count: number) {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(count));
      return fetchMock.mock.calls.map(([url, init]) => ({
        url: url as string,
        body: JSON.parse((init as { body: string }).body) as {
          monitor_slug: string;
          status: string;
        },
      }));
    }

    it('checks in under the fetch-spx-candles-1m slug and stays ok on a partial run', async () => {
      uwReturns({ QQQ: [] });

      await handler(AUTHORIZED_REQ(), mockResponse());

      const calls = await checkIns(2);
      expect(calls.map((c) => c.body.monitor_slug)).toEqual([JOB, JOB]);
      expect(calls[0]!.url).toContain(`/cron/${JOB}/`);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'ok']);
    });

    it('sends an error check-in when every symbol fails', async () => {
      mockUwFetch.mockResolvedValue([]);

      await handler(AUTHORIZED_REQ(), mockResponse());

      const calls = await checkIns(2);
      expect(calls.map((c) => c.body.status)).toEqual(['in_progress', 'error']);
    });
  });
});
