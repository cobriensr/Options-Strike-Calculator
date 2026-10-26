// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The handler issues ONE tagged-template SELECT (the per-ticker high-water
// mark) and writes through the real bulkUpsert, which calls `sql.query()`
// for a single chunk and `sql.transaction()` past 500 rows.
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

const { mockUwFetch, mockCronGuard, mockWithRetry } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  cronJitter: vi.fn(() => Promise.resolve()),
  withRetry: mockWithRetry,
}));

import handler from '../cron/fetch-etf-candles-1m.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Fixtures ──────────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-27' };

// Every fixture candle below starts before this, so none is the
// still-forming minute unless a test moves the clock.
const NOW = '2026-04-27T14:40:30.000Z';

function makeCandle(overrides: Record<string, unknown> = {}) {
  return {
    start_time: '2026-04-27T14:32:00.000Z',
    open: '527.50',
    high: '528.10',
    low: '527.20',
    close: '527.85',
    volume: 345678,
    ...overrides,
  };
}

/** UW returns intraday candles newest first; mirror that in fixtures. */
function candlesAt(...isoTimes: string[]) {
  return isoTimes.map((start_time) => makeCandle({ start_time }));
}

const AUTHORIZED_REQ = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/**
 * Route each UW fetch by ticker so tests don't depend on call order. A
 * ticker left out gets one healthy closed candle (an empty payload is a
 * failure, so it has to be asked for explicitly).
 */
function uwReturns(byTicker: Partial<Record<'SPY' | 'QQQ', unknown[]>>) {
  mockUwFetch.mockImplementation((_key: string, path: string) => {
    const ticker = /\/stock\/([A-Z]+)\//.exec(path)?.[1] as 'SPY' | 'QQQ';
    return Promise.resolve(byTicker[ticker] ?? [makeCandle()]);
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
  const cols = /INSERT INTO etf_candles_1m \(([^)]+)\)/
    .exec(stmt)![1]!
    .split(',')
    .map((c) => c.trim());
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < params.length; i += cols.length) {
    rows.push(Object.fromEntries(cols.map((c, j) => [c, params[i + j]])));
  }
  return rows;
}

/** Timestamps written for one ticker, in the order they were sent. */
function sentTimestamps(ticker: string): unknown[] {
  return writeCalls()
    .flatMap(decodeRows)
    .filter((r) => r.ticker === ticker)
    .map((r) => r.timestamp);
}

/** The single high-water-mark SELECT (tagged template on mockSql). */
function hwmQuery() {
  expect(mockSql).toHaveBeenCalledTimes(1);
  const [strings, ...values] = mockSql.mock.calls[0]!;
  return { text: (strings as readonly string[]).join('?'), values };
}

describe('fetch-etf-candles-1m handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    txnWrites = [];
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    // Default: one closed candle per ticker.
    mockUwFetch.mockResolvedValue([makeCandle()]);
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

  // ── Guard delegation ───────────────────────────────────────

  it('exits early without fetching when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValue(null);
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('passes auth when CRON_SECRET matches', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Market hours gate ─────────────────────────────────────

  it('skips when outside market hours', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('skips on weekends', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(500).json({ error: 'UW_API_KEY not configured' });
      return null;
    });
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('fetches both tickers and writes each in one batched INSERT', async () => {
    uwReturns({
      SPY: candlesAt('2026-04-27T14:33:00.000Z', '2026-04-27T14:32:00.000Z'),
      QQQ: candlesAt('2026-04-27T14:32:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-etf-candles-1m',
      status: 'success',
      failureCount: 0,
      tickers: {
        SPY: { fetched: 2, new: 2, stored: 2, skipped: 0, malformed: 0 },
        QQQ: { fetched: 1, new: 1, stored: 1, skipped: 0, malformed: 0 },
      },
      spy_candles: 2,
      spy_stored: 2,
      spy_skipped: 0,
      qqq_candles: 1,
      qqq_stored: 1,
      qqq_skipped: 0,
    });
    // One INSERT statement per ticker, not one per candle.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('calls both /stock/SPY/ohlc/1m and /stock/QQQ/ohlc/1m endpoints', async () => {
    const req = AUTHORIZED_REQ();
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    const urls = mockUwFetch.mock.calls.map((c) => c[1] as string);
    expect(urls).toContain('/stock/SPY/ohlc/1m?date=2026-04-27');
    expect(urls).toContain('/stock/QQQ/ohlc/1m?date=2026-04-27');
  });

  it('empty UW payload for both tickers → status error, Sentry per ticker, nothing written', async () => {
    // Inside the gated window `date=today` always carries pre-market bars
    // from 04:00 ET, so `data: []` means UW is broken, not a quiet market.
    mockUwFetch.mockResolvedValue([]);
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      failureCount: 2,
      tickers: {
        SPY: { fetched: 0, new: 0, stored: 0, skipped: 0 },
        QQQ: { fetched: 0, new: 0, stored: 0, skipped: 0 },
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-etf-candles-1m: UW returned no 1m candles for SPY',
      }),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_candles_1m.empty_payload',
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('empty UW payload for SPY only → status partial, QQQ still stored', async () => {
    uwReturns({ SPY: [], QQQ: [makeCandle()] });
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      tickers: {
        SPY: { fetched: 0, stored: 0 },
        QQQ: { fetched: 1, stored: 1 },
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'fetch-etf-candles-1m: UW returned no 1m candles for SPY',
      }),
    );
    expect(sentTimestamps('QQQ')).toEqual(['2026-04-27T14:32:00.000Z']);
  });

  // ── High-water mark ───────────────────────────────────────

  it('reads the high-water mark once per run, bounded at ET midnight of today', async () => {
    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    const { text, values } = hwmQuery();
    expect(text).toMatch(/MAX\(timestamp\)/);
    expect(text).toMatch(/FROM etf_candles_1m/);
    expect(text).toMatch(/GROUP BY ticker/);
    // A bare date compares as UTC midnight (4–5 h early) and
    // `::date AT TIME ZONE` without `::timestamp` lands 8–10 h early; the
    // bound must be ET midnight of the trading day.
    expect(text).toMatch(
      /\?::date::timestamp AT TIME ZONE 'America\/New_York'/,
    );
    expect(values).toContain('2026-04-27');
    expect(values).toContainEqual(['SPY', 'QQQ']);
  });

  it('sends only candles after the per-ticker high-water mark, oldest first', async () => {
    // Neon returns TIMESTAMPTZ as a Date; accept an ISO string too.
    mockSql.mockResolvedValueOnce([
      { ticker: 'SPY', hwm: new Date('2026-04-27T14:32:00.000Z') },
      { ticker: 'QQQ', hwm: '2026-04-27T14:33:00.000Z' },
    ]);
    uwReturns({
      SPY: candlesAt(
        '2026-04-27T14:34:00.000Z',
        '2026-04-27T14:33:00.000Z',
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:31:00.000Z',
      ),
      QQQ: candlesAt('2026-04-27T14:34:00.000Z', '2026-04-27T14:33:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPY')).toEqual([
      '2026-04-27T14:33:00.000Z',
      '2026-04-27T14:34:00.000Z',
    ]);
    expect(sentTimestamps('QQQ')).toEqual(['2026-04-27T14:34:00.000Z']);
    expect(res._json).toMatchObject({
      status: 'success',
      tickers: {
        SPY: { fetched: 4, new: 2, stored: 2, skipped: 2 },
        QQQ: { fetched: 2, new: 1, stored: 1, skipped: 1 },
      },
    });
  });

  it('sends every closed candle when a ticker has no high-water mark yet', async () => {
    // Only QQQ has rows today; SPY's absence from the GROUP BY = null HWM.
    mockSql.mockResolvedValueOnce([
      { ticker: 'QQQ', hwm: new Date('2026-04-27T14:39:00.000Z') },
    ]);
    uwReturns({
      SPY: candlesAt(
        '2026-04-27T14:33:00.000Z',
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:31:00.000Z',
      ),
      QQQ: candlesAt('2026-04-27T14:33:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPY')).toEqual([
      '2026-04-27T14:31:00.000Z',
      '2026-04-27T14:32:00.000Z',
      '2026-04-27T14:33:00.000Z',
    ]);
    expect(sentTimestamps('QQQ')).toEqual([]);
    expect(res._json).toMatchObject({
      tickers: {
        SPY: { fetched: 3, new: 3, stored: 3, skipped: 0 },
        QQQ: { fetched: 1, new: 0, stored: 0, skipped: 1 },
      },
    });
  });

  it('skips the write entirely when nothing is newer than the high-water mark', async () => {
    mockSql.mockResolvedValueOnce([
      { ticker: 'SPY', hwm: new Date('2026-04-27T14:32:00.000Z') },
      { ticker: 'QQQ', hwm: new Date('2026-04-27T14:32:00.000Z') },
    ]);
    uwReturns({
      SPY: candlesAt('2026-04-27T14:32:00.000Z', '2026-04-27T14:31:00.000Z'),
      QQQ: candlesAt('2026-04-27T14:32:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'success',
      tickers: {
        SPY: { fetched: 2, new: 0, stored: 0, skipped: 2 },
        QQQ: { fetched: 1, new: 0, stored: 0, skipped: 1 },
      },
    });
  });

  it('never writes the still-forming minute UW returns as its newest candle', async () => {
    // UW docs: "The most recent intraday candle is still forming, and its
    // start_time is the start of the current bucket." Writing it would let
    // DO NOTHING + the HWM freeze a partial bar forever.
    vi.setSystemTime(new Date('2026-04-27T14:33:30.000Z'));
    uwReturns({
      SPY: candlesAt(
        '2026-04-27T14:33:00.000Z', // forming
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:31:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPY')).toEqual([
      '2026-04-27T14:31:00.000Z',
      '2026-04-27T14:32:00.000Z',
    ]);
    expect(res._json).toMatchObject({
      tickers: { SPY: { fetched: 3, new: 2, stored: 2, skipped: 1 } },
    });
  });

  it('de-duplicates repeated start_times before writing', async () => {
    uwReturns({
      SPY: candlesAt(
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:31:00.000Z',
      ),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPY')).toEqual([
      '2026-04-27T14:31:00.000Z',
      '2026-04-27T14:32:00.000Z',
    ]);
  });

  it('writes more than 500 new candles through one transaction', async () => {
    // A null HWM at the first run of the day can mean a whole pre-market
    // plus session of minutes: past bulkUpsert's 500-row chunk.
    const base = Date.parse('2026-04-27T04:00:00.000Z');
    const spy = Array.from({ length: 501 }, (_, i) =>
      makeCandle({ start_time: new Date(base + i * 60_000).toISOString() }),
    ).reverse();
    vi.setSystemTime(new Date('2026-04-27T20:00:00.000Z'));
    uwReturns({ SPY: spy });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(txnWrites).toHaveLength(2); // 500 + 1
    expect(txnWrites.every(({ params }) => params[0] === 'SPY')).toBe(true);
    // The only direct single-statement write is QQQ's one candle.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0]![1][0]).toBe('QQQ');
    const sent = sentTimestamps('SPY');
    expect(sent).toHaveLength(501);
    expect(sent[0]).toBe('2026-04-27T04:00:00.000Z');
    expect(sent.at(-1)).toBe('2026-04-27T12:20:00.000Z');
    expect(res._json).toMatchObject({
      status: 'success',
      tickers: { SPY: { fetched: 501, new: 501, stored: 501 } },
    });
  });

  // ── Failure modes (R4) ────────────────────────────────────

  it('high-water-mark SELECT rejects → run errors, Sentry captures, nothing fetched or written', async () => {
    const neonDown = new Error('Neon: connection terminated');
    mockSql.mockRejectedValueOnce(neonDown);

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(500);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-etf-candles-1m',
      expect.objectContaining({ status: 'error' }),
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(neonDown);
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('SPY insert rejects → status partial, QQQ still stored, one Sentry event', async () => {
    const spyWriteErr = new Error('DB insert failed: SPY');
    mockQuery.mockImplementation((_stmt: string, params: unknown[]) =>
      params[0] === 'SPY' ? Promise.reject(spyWriteErr) : Promise.resolve([]),
    );
    uwReturns({
      SPY: candlesAt('2026-04-27T14:32:00.000Z', '2026-04-27T14:31:00.000Z'),
      QQQ: candlesAt('2026-04-27T14:32:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      tickers: {
        SPY: { fetched: 2, new: 2, stored: 0 },
        QQQ: { fetched: 1, new: 1, stored: 1 },
      },
      spy_stored: 0,
      qqq_stored: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(spyWriteErr);
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_candles_1m.store_error',
    );
  });

  it('both inserts reject → status error, one Sentry event per ticker (not per row)', async () => {
    mockQuery.mockRejectedValue(new Error('Neon outage'));
    uwReturns({
      SPY: candlesAt(
        '2026-04-27T14:33:00.000Z',
        '2026-04-27T14:32:00.000Z',
        '2026-04-27T14:31:00.000Z',
      ),
      QQQ: candlesAt('2026-04-27T14:32:00.000Z', '2026-04-27T14:31:00.000Z'),
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect((res._json as { status: string }).status).toBe('error');
    expect(res._json).toMatchObject({
      failureCount: 2,
      tickers: {
        SPY: { stored: 0 },
        QQQ: { stored: 0 },
      },
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-etf-candles-1m',
      expect.objectContaining({ status: 'error' }),
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  // ── UW API errors → per-leg isolation (BE-CRON-H4) ────────

  it('partial: SPY fetch fails → status partial, QQQ candle still stored', async () => {
    const spyFetchErr = new Error('UW API 500: SPY');
    mockUwFetch.mockImplementation((_key: string, path: string) =>
      path.includes('/SPY/')
        ? Promise.reject(spyFetchErr)
        : Promise.resolve([makeCandle()]),
    );

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      tickers: {
        SPY: { fetched: 0, stored: 0 },
        QQQ: { fetched: 1, stored: 1 },
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(spyFetchErr);
    // A UW failure is not a write failure.
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'fetch_etf_candles_1m.store_error',
    );
    // The healthy QQQ leg still wrote its candle.
    expect(sentTimestamps('QQQ')).toEqual(['2026-04-27T14:32:00.000Z']);
    expect(sentTimestamps('SPY')).toEqual([]);
  });

  it('error: both ticker fetches fail → status error, Sentry per ticker, nothing written', async () => {
    mockWithRetry.mockRejectedValue(new Error('UW total outage'));

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    // HTTP stays 200 (wrapper only 500s on a thrown exception) but the
    // cron status is 'error' so the monitor doesn't stay green.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      failureCount: 2,
      tickers: {
        SPY: { fetched: 0, stored: 0 },
        QQQ: { fetched: 0, stored: 0 },
      },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-etf-candles-1m',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  // ── Status derivation regression (BE-CRON #8) ─────────────
  //
  // Status is `deriveCronStatus(failureCount, TICKERS.length)`, not a
  // hand-rolled `failureCount === 2`: all N tickers failing → 'error', a
  // strict subset failing → 'partial'. Holds structurally if a third ticker
  // is added.

  it('derives partial from the ticker count: a single ticker failing → partial (not error)', async () => {
    mockWithRetry
      .mockImplementationOnce(() => Promise.reject(new Error('SPY 429')))
      .mockImplementationOnce((fn: () => unknown) => fn());

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(res._json).toMatchObject({
      status: 'partial',
      failureCount: 1,
      tickers: { SPY: { fetched: 0, stored: 0 }, QQQ: { stored: 1 } },
    });
  });

  // ── Malformed payload ─────────────────────────────────────

  it('drops malformed candles, counts them and raises one Sentry warning', async () => {
    // One bad row must not poison the whole batch: the HWM would never
    // advance past it and the ticker would fail every minute all day.
    mockSql.mockResolvedValueOnce([
      { ticker: 'SPY', hwm: new Date('2026-04-27T14:30:00.000Z') },
    ]);
    uwReturns({
      SPY: [
        makeCandle({ start_time: 'not-a-time' }),
        makeCandle({ start_time: '2026-04-27T14:34:00.000Z', open: 'n/a' }),
        makeCandle({ start_time: '2026-04-27T14:33:00.000Z', close: null }),
        // BIGINT rejects a fraction, which would fail the whole INSERT.
        makeCandle({ start_time: '2026-04-27T14:32:00.000Z', volume: 12.5 }),
        makeCandle({ start_time: '2026-04-27T14:31:00.000Z' }),
        // Already behind the HWM: skipped, not re-counted as malformed.
        makeCandle({ start_time: '2026-04-27T14:29:00.000Z', open: 'bad' }),
      ],
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(sentTimestamps('SPY')).toEqual(['2026-04-27T14:31:00.000Z']);
    expect(res._json).toMatchObject({
      status: 'success',
      tickers: {
        SPY: { fetched: 6, new: 1, stored: 1, skipped: 5, malformed: 4 },
        QQQ: { malformed: 0 },
      },
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-etf-candles-1m: malformed UW candles dropped',
      { level: 'warning', extra: { ticker: 'SPY', malformed: 4 } },
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_etf_candles_1m.malformed',
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── INSERT shape ──────────────────────────────────────────

  /** The one INSERT that carried SPY rows. */
  function spyWrite(): WriteCall {
    const call = writeCalls().find(({ params }) => params[0] === 'SPY');
    expect(call).toBeDefined();
    return call!;
  }

  it('writes every OHLC + volume column with ON CONFLICT DO NOTHING', async () => {
    uwReturns({ SPY: [makeCandle()] });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    const call = spyWrite();
    expect(call.stmt).toMatch(/ON CONFLICT \(ticker, timestamp\) DO NOTHING/);
    expect(decodeRows(call)).toEqual([
      {
        ticker: 'SPY',
        timestamp: '2026-04-27T14:32:00.000Z',
        open: '527.50',
        high: '528.10',
        low: '527.20',
        close: '527.85',
        volume: 345678,
      },
    ]);
  });

  it('writes volume as null (never undefined) when UW omits it', async () => {
    uwReturns({ SPY: [makeCandle({ volume: undefined })] });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    const call = spyWrite();
    expect(decodeRows(call)[0]!.volume).toBeNull();
    expect(call.params).not.toContain(undefined);
  });

  it('writes the integer it validated when UW sends volume as a string', async () => {
    // Off-contract (UW documents an integer), but Postgres BIGINT rejects
    // '1.0' and '1e3' even though both validate as safe integers.
    uwReturns({
      SPY: [
        makeCandle({ start_time: '2026-04-27T14:32:00.000Z', volume: '1.0' }),
        makeCandle({ start_time: '2026-04-27T14:31:00.000Z', volume: '1e3' }),
      ],
    });

    const res = mockResponse();
    await handler(AUTHORIZED_REQ(), res);

    expect(decodeRows(spyWrite()).map((r) => r.volume)).toEqual([1000, 1]);
  });
});
