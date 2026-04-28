// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: vi.fn(
      async (
        cb: (scope: { setTransactionName: (n: string) => void }) => unknown,
      ) => cb({ setTransactionName: vi.fn() }),
    ),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

const { mockCheckBot, mockIsMarketOpen, mockSetCacheHeaders } = vi.hoisted(
  () => ({
    mockCheckBot: vi.fn(),
    mockIsMarketOpen: vi.fn(),
    mockSetCacheHeaders: vi.fn(),
  }),
);

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: mockCheckBot,
  isMarketOpen: mockIsMarketOpen,
  setCacheHeaders: mockSetCacheHeaders,
}));

import handler from '../market-internals/history.js';

const MARKET_TIME = new Date('2026-03-24T14:00:00.000Z');

function makeRow(
  overrides: Partial<{
    ts: string;
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }> = {},
) {
  return {
    ts: '2026-03-24T14:30:00.000Z',
    symbol: '$TICK',
    open: 250,
    high: 350,
    low: 100,
    close: 280,
    ...overrides,
  };
}

describe('GET /api/market-internals/history', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    mockCheckBot.mockResolvedValue({ isBot: false });
    mockIsMarketOpen.mockReturnValue(true);
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Happy path ─────────────────────────────────────────────

  it('returns bars sorted by ts ascending', async () => {
    const rows = [
      makeRow({ ts: '2026-03-24T14:30:00.000Z', symbol: '$TICK' }),
      makeRow({ ts: '2026-03-24T14:30:00.000Z', symbol: '$ADD', close: 1500 }),
      makeRow({ ts: '2026-03-24T14:31:00.000Z', symbol: '$TICK', close: 310 }),
    ];
    mockSql.mockResolvedValueOnce(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      bars: Array<{ ts: string; symbol: string; close: number }>;
      asOf: string;
      marketOpen: boolean;
    };
    expect(body.bars).toHaveLength(3);
    expect(body.bars[0]?.ts).toBe('2026-03-24T14:30:00.000Z');
    expect(body.bars[2]?.ts).toBe('2026-03-24T14:31:00.000Z');
    expect(body.marketOpen).toBe(true);
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, 30, 30);
  });

  it('normalizes NUMERIC string values to numbers', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ts: '2026-03-24T14:30:00.000Z',
        symbol: '$TRIN',
        open: '0.9876',
        high: '1.1234',
        low: '0.8500',
        close: '1.0000',
      },
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      bars: Array<{
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
    };
    expect(body.bars[0]?.open).toBeCloseTo(0.9876, 4);
    expect(body.bars[0]?.high).toBeCloseTo(1.1234, 4);
    expect(body.bars[0]?.low).toBeCloseTo(0.85, 4);
    expect(body.bars[0]?.close).toBeCloseTo(1.0, 4);
  });

  // ── Empty result ───────────────────────────────────────────

  it('returns an empty array (not 404) when the table has no rows for today', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { bars: unknown[] };
    expect(body.bars).toEqual([]);
  });

  // ── ?since= filter ─────────────────────────────────────────

  it('filters by ?since= when provided (uses > comparison)', async () => {
    const since = '2026-03-24T14:30:00.000Z';
    mockSql.mockResolvedValueOnce([
      makeRow({ ts: '2026-03-24T14:31:00.000Z' }),
    ]);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { since },
      }),
      res,
    );

    expect(res._status).toBe(200);
    // Inspect the SQL template & bound value
    const call = mockSql.mock.calls[0]!;
    const strings = call[0] as TemplateStringsArray;
    expect(strings.some((s: string) => s.includes('ts >'))).toBe(true);
    expect(call[1]).toBe(since);
  });

  it('uses today-ET date filter when ?since= is omitted', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const call = mockSql.mock.calls[0]!;
    const strings = call[0] as TemplateStringsArray;
    const combined = strings.join(' ');
    expect(combined).toContain('ts::date');
  });

  it('returns 400 for a malformed ?since= value', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { since: 'not-a-timestamp' },
      }),
      res,
    );

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Method guard ───────────────────────────────────────────

  it('rejects non-GET methods with 405', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Bot rejection ──────────────────────────────────────────

  it('returns 403 when checkBot flags the request', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── marketOpen reflects the helper ─────────────────────────

  it('passes through isMarketOpen() in the response', async () => {
    mockIsMarketOpen.mockReturnValue(false);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { marketOpen: boolean };
    expect(body.marketOpen).toBe(false);
  });

  // ── Error handling ─────────────────────────────────────────

  it('returns 500 when the DB query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB offline'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
  });
});
