// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../_lib/axiom.js', () => ({ reportCronRun: vi.fn() }));

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

import handler from '../cron/repair-futures-blocks.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import { formatMicrosIso, parseUwTimeMicros } from '../_lib/uw-time.js';

// ── Fixtures ──────────────────────────────────────────────

const GUARD = { apiKey: 'test-uw-key', today: '2026-10-29' };
// Thursday 22:15 UTC run → pages back to Monday 00:00 UTC.
const NOW = '2026-10-29T22:15:00Z';

/** A REST /futures/flow?blocks_only=true row (probe 0a shape). */
function block(over: Record<string, unknown> = {}) {
  return {
    action: 'new',
    clr_sym: 'ES',
    exchange: 'XCME',
    executed_at: '2026-10-29T15:27:26Z',
    is_block: true,
    is_spread: false,
    legs: [],
    price: '6612.25',
    product: 'ES',
    qty: '250',
    quote_ask: null,
    quote_bid: null,
    quote_ts: null,
    reported_at: '2026-10-29T15:27:54.060Z',
    sec_type: 'FUT',
    strategy: null,
    strategy_link_id: null,
    sym: 'ESZ6',
    tick_size: '0.250000000000000000',
    trade_date: '2026-10-29',
    trade_id: 84_213_907,
    ...over,
  };
}

/** A multi-leg block: price and product null, prices on the legs. */
const MLEG = block({
  trade_id: 22_883_287,
  exchange: 'XNYM',
  executed_at: '2026-10-28T10:00:00Z',
  reported_at: '2026-10-28T10:00:43.297Z',
  sym: 'S5M:S5O:GN',
  product: null,
  price: null,
  qty: '1',
  sec_type: 'MLEG',
  is_spread: true,
  strategy_link_id: 22_883_287,
  legs: [
    {
      leg_side: 'BUY',
      price: '772.75',
      qty: '3.0',
      sec_type: 'FUT',
      sym: 'S5MG7',
    },
    {
      leg_side: 'BUY',
      price: '772.75',
      qty: '5.0',
      sec_type: 'FUT',
      sym: 'S5OG7',
    },
  ],
  trade_date: '2026-10-28',
});

/** Before the window start: ends the paging. */
const OLD = block({
  trade_id: 1,
  executed_at: '2026-10-25T23:00:00Z',
  reported_at: '2026-10-25T23:00:30Z',
  trade_date: '2026-10-26',
});

function flowPath(olderThan?: string): string {
  const q = new URLSearchParams({ blocks_only: 'true', limit: '500' });
  if (olderThan) q.set('older_than', olderThan);
  return `/futures/flow?${q}`;
}

function sqlText(idx: number): string {
  return (mockSql.mock.calls[idx]![0] as readonly string[]).join('?');
}

function sqlValues(idx: number): unknown[] {
  return mockSql.mock.calls[idx]!.slice(1);
}

/** The column arrays of upsert call `idx`, in INSERT column order. */
function upsertColumns(idx: number) {
  const [
    tradeId,
    exchange,
    tradeDate,
    sym,
    product,
    secType,
    action,
    price,
    qty,
    executedAt,
    reportedAt,
    strategyLinkId,
    legs,
    quoteBid,
    quoteAsk,
    quoteTs,
    raw,
  ] = sqlValues(idx) as unknown[][];
  return {
    tradeId,
    exchange,
    tradeDate,
    sym,
    product,
    secType,
    action,
    price,
    qty,
    executedAt,
    reportedAt,
    strategyLinkId,
    legs,
    quoteBid,
    quoteAsk,
    quoteTs,
    raw,
  };
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

function pages(...list: unknown[]) {
  for (const p of list) {
    if (p instanceof Error) mockUwFetch.mockRejectedValueOnce(p);
    else mockUwFetch.mockResolvedValueOnce(p);
  }
}

describe('repair-futures-blocks handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    mockCronGuard.mockReturnValue(GUARD);
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guard + wiring ────────────────────────────────────

  it('exits without touching UW or the DB when cronGuard rejects', async () => {
    mockCronGuard.mockReturnValue(null);
    await run();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('runs outside market hours (nightly 22:15 UTC schedule)', async () => {
    pages([block()], [OLD]);
    mockSql.mockResolvedValueOnce([{}, {}]);
    await run();
    expect(mockCronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ marketHours: false }),
    );
  });

  // ── Happy path ────────────────────────────────────────

  it('pages blocks back past the 3-UTC-day window and upserts them in one newest-wins batch', async () => {
    pages([block(), MLEG], [OLD]);
    mockSql.mockResolvedValueOnce([{}, {}, {}]);

    const res = await run();

    expect(mockUwFetch.mock.calls.map((c) => c[1])).toEqual([
      flowPath(),
      // +1 µs past the oldest block on page 1: the cursor is strict.
      flowPath('2026-10-28T10:00:00.000001Z'),
    ]);
    expect(mockUwFetch.mock.calls.every((c) => c[0] === 'test-uw-key')).toBe(
      true,
    );
    expect(mockWithRetry).toHaveBeenCalledTimes(2);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const text = sqlText(0);
    expect(text).toContain('INSERT INTO futures_blocks');
    expect(text).toContain('FROM unnest(');
    expect(text).toContain(
      'ON CONFLICT (trade_id, exchange, trade_date) DO UPDATE SET',
    );
    expect(text).toContain('updated_at = now()');
    // Strictly newer only: on a tie the websocket's copy (with quotes) stays.
    expect(text).toContain(
      'WHERE EXCLUDED.reported_at > futures_blocks.reported_at',
    );
    expect(text).toContain(
      'OR (futures_blocks.reported_at IS NULL AND EXCLUDED.reported_at IS NOT NULL)',
    );
    for (const col of ['quote_bid', 'quote_ask', 'quote_ts']) {
      expect(text).toContain(
        `${col} = COALESCE(EXCLUDED.${col}, futures_blocks.${col})`,
      );
    }

    const cols = upsertColumns(0);
    expect(cols.tradeId).toEqual(['84213907', '22883287', '1']);
    expect(cols.exchange).toEqual(['XCME', 'XNYM', 'XCME']);
    expect(cols.tradeDate).toEqual(['2026-10-29', '2026-10-28', '2026-10-26']);
    expect(cols.product).toEqual(['ES', null, 'ES']);
    expect(cols.secType).toEqual(['FUT', 'MLEG', 'FUT']);
    expect(cols.price).toEqual(['6612.25', null, '6612.25']);
    expect(cols.qty).toEqual(['250', '1', '250']);
    expect(cols.executedAt).toEqual([
      '2026-10-29T15:27:26.000000Z',
      '2026-10-28T10:00:00.000000Z',
      '2026-10-25T23:00:00.000000Z',
    ]);
    expect(cols.reportedAt![0]).toBe('2026-10-29T15:27:54.060000Z');
    expect(cols.strategyLinkId).toEqual([null, '22883287', null]);
    expect(JSON.parse(cols.legs![1] as string)).toHaveLength(2);
    expect(cols.legs![0]).toBe('[]');
    // raw_payload is the row as UW sent it, fields we don't store included.
    expect(JSON.parse(cols.raw![0] as string)).toMatchObject({
      clr_sym: 'ES',
      tick_size: '0.250000000000000000',
    });

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 3 });
    expect(reportCronRun).toHaveBeenCalledWith(
      'repair-futures-blocks',
      expect.objectContaining({ status: 'success', rows: 3 }),
    );
  });

  it('an empty page is the edge of UW history: stops paging, still a success', async () => {
    pages([block()], []);
    mockSql.mockResolvedValueOnce([{}]);

    const res = await run();

    expect(mockUwFetch).toHaveBeenCalledTimes(2);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
  });

  it('parses defensively: epoch-ms times (websocket form) and an empty product store as time / NULL', async () => {
    pages(
      [
        block({
          executed_at: Date.parse('2026-10-29T15:27:26.120Z'),
          reported_at: String(Date.parse('2026-10-29T15:28:00Z')),
          quote_ts: Date.parse('2026-10-29T15:27:25Z'),
          quote_bid: '6612.00',
          quote_ask: 6612.25,
          product: '',
          sym: '',
        }),
      ],
      [OLD],
    );
    mockSql.mockResolvedValueOnce([{}, {}]);

    await run();

    const cols = upsertColumns(0);
    expect(cols.executedAt![0]).toBe('2026-10-29T15:27:26.120000Z');
    expect(cols.reportedAt![0]).toBe('2026-10-29T15:28:00.000000Z');
    expect(cols.quoteTs![0]).toBe('2026-10-29T15:27:25.000000Z');
    expect(cols.quoteBid![0]).toBe('6612.00');
    expect(cols.quoteAsk![0]).toBe('6612.25');
    expect(cols.product![0]).toBeNull();
    expect(cols.sym![0]).toBeNull();
  });

  it('collapses repeated keys in the batch to the message the SQL guard would keep (newest reported_at; NULL loses)', async () => {
    const key = { trade_id: 5, exchange: 'XCME', trade_date: '2026-10-29' };
    pages(
      [
        block({
          ...key,
          action: 'update',
          reported_at: '2026-10-29T15:05:00Z',
        }),
        block({ ...key, action: 'new', reported_at: '2026-10-29T15:00:00Z' }),
        block({ ...key, action: 'delete', reported_at: null }),
        // Same key on another exchange: a different block.
        block({
          ...key,
          exchange: 'XCBT',
          reported_at: '2026-10-29T15:01:00Z',
        }),
      ],
      [OLD],
    );
    mockSql.mockResolvedValueOnce([{}, {}, {}]);

    await run();

    const cols = upsertColumns(0);
    expect(cols.tradeId).toEqual(['5', '5', '1']);
    expect(cols.exchange).toEqual(['XCME', 'XCBT', 'XCME']);
    expect(cols.action).toEqual(['update', 'new', 'new']);
    expect(cols.reportedAt![0]).toBe('2026-10-29T15:05:00.000000Z');
  });

  it('a later copy with the same reported_at wins the collapse (a replay), and a delete is kept as a row state', async () => {
    const key = { trade_id: 6, exchange: 'XCME', trade_date: '2026-10-29' };
    pages(
      [
        block({
          ...key,
          action: 'update',
          reported_at: '2026-10-29T16:00:00Z',
        }),
        block({
          ...key,
          action: 'delete',
          reported_at: '2026-10-29T16:00:00Z',
        }),
      ],
      [OLD],
    );
    mockSql.mockResolvedValueOnce([{}, {}]);

    await run();

    expect(upsertColumns(0).action).toEqual(['delete', 'new']);
  });

  // ── Failure modes (R4) ────────────────────────────────

  it('skips invalid rows (non-finite numbers, unknown action, bad date or time), warns, and reports partial', async () => {
    pages(
      [
        block({ trade_id: 10, price: 'NaN' }),
        block({ trade_id: 11, qty: 'Infinity' }),
        block({ trade_id: 12, price: '1e400' }),
        block({ trade_id: 13, action: 'cancel' }),
        block({ trade_id: 14, trade_date: '2026-13-01' }),
        block({ trade_id: 15, reported_at: 'garbage' }),
        block({ trade_id: 16, price: '99999999999' }), // past NUMERIC(18,8)
        block({ trade_id: 17 }),
      ],
      [OLD],
    );
    mockSql.mockResolvedValueOnce([{}, {}]);

    const res = await run();

    expect(upsertColumns(0).tradeId).toEqual(['17', '1']);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('invalid'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ invalid: 7 }),
      }),
    );
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 2,
      invalidRows: 7,
    });
  });

  it('an upstream 5xx → 500, Sentry exception, error reported, nothing written', async () => {
    pages(new Error('UW API 503: unavailable'));

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UW API 503: unavailable' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'repair-futures-blocks',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a non-array page → 500 and error reported', async () => {
    pages({ unexpected: 'shape' });

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/non-array/) }),
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a page of only invalid rows → 500: a format change, not data', async () => {
    pages([block({ trade_id: null }), block({ action: 42 })]);

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/all 2/) }),
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('a rejected upsert → 500 and error reported, never success', async () => {
    pages([block()], [OLD]);
    mockSql.mockRejectedValueOnce(new Error('numeric field overflow'));

    const res = await run();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'numeric field overflow' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'repair-futures-blocks',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('no blocks at all in three days is an upstream fault, not a quiet market → error status', async () => {
    pages([]);

    const res = await run();

    expect(mockSql).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ status: 'error', rows: 0 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no block trades'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('stops at the page cap, writes what it fetched, and reports partial with a warning', async () => {
    let id = 1_000;
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      const cursor = new URL(`https://uw.test${path}`).searchParams.get(
        'older_than',
      );
      // One block a second older than the cursor: never reaches the start.
      const us = cursor
        ? parseUwTimeMicros(cursor)! - 1_000_000n
        : parseUwTimeMicros(NOW)!;
      const at = formatMicrosIso(us);
      return [block({ trade_id: id++, executed_at: at, reported_at: at })];
    });
    mockSql.mockResolvedValueOnce(Array.from({ length: 100 }, () => ({})));

    const res = await run();

    expect(mockUwFetch).toHaveBeenCalledTimes(100);
    expect((upsertColumns(0).tradeId as unknown[]).length).toBe(100);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('page cap'),
      expect.objectContaining({ level: 'warning' }),
    );
    expect(res._json).toMatchObject({ status: 'partial', rows: 100 });
  });
});
