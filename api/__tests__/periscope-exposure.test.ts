// @vitest-environment node

/**
 * Tests for /api/periscope-exposure handler.
 *
 * Covers the three response shapes the frontend hook depends on:
 *   - 200 with data when a slot exists
 *   - 200 with data:null + reason:'no_slot' when no slot ingested yet
 *   - 200 with data:null + reason:'no_spot' when neither query nor DB
 *     can produce an SPX spot
 *   - 500 on internal error
 *
 * The DB layer is mocked because the periscope-format module's pure
 * `computePeriscopeView` logic is already exercised by
 * periscope-format.test.ts. Here we only verify the handler contract.
 */

import { vi, beforeEach, describe, it, expect } from 'vitest';

const { mockSql, mockGuard, mockSetCacheHeaders, mockIsMarketOpen } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockGuard: vi.fn(),
    mockSetCacheHeaders: vi.fn(),
    mockIsMarketOpen: vi.fn(),
  }));

vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCacheHeaders,
  isMarketOpen: mockIsMarketOpen,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: (fn: (s: { setTransactionName: (n: string) => void }) => unknown) =>
      fn({ setTransactionName: () => undefined }),
  },
  metrics: { request: () => () => undefined },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../periscope-exposure.js';

function makeReqRes(query: Record<string, string> = {}) {
  const req = { query, method: 'GET', headers: {} } as never;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader: vi.fn(),
  };
  return { req, res };
}

beforeEach(() => {
  mockSql.mockReset();
  mockGuard.mockReset();
  mockGuard.mockResolvedValue(false);
  mockSetCacheHeaders.mockReset();
  mockIsMarketOpen.mockReset();
  mockIsMarketOpen.mockReturnValue(true);
});

describe('GET /api/periscope-exposure', () => {
  it('returns no_spot when neither query nor DB yields a spot', async () => {
    // No spot in query. fetchLatestSpxSpot returns []
    mockSql.mockResolvedValueOnce([]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_spot',
    });
  });

  it('returns no_slot when spot is available but no periscope rows exist', async () => {
    mockSql
      // fetchLatestSpxSpot — spot from index_candles_1m
      .mockResolvedValueOnce([{ close: '7337.07' }])
      // fetchLatestPeriscopeSlot — no captured_at
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_slot',
    });
  });

  it('returns full view when slot + cone exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }])
      // fetchLatestPeriscopeSlot — captured_at
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T13:50:00Z' }])
      // loadSlot — gamma + charm + vanna rows
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '3187.00' },
        { panel: 'charm', strike: 7350, value: '-401000.00' },
        { panel: 'vanna', strike: 7375, value: '-109000.00' },
      ])
      // fetchPriorPeriscopeSlot — no prior
      .mockResolvedValueOnce([{ captured_at: null }])
      // fetchConeLevels
      .mockResolvedValueOnce([
        {
          cone_upper: '7395.00',
          cone_lower: '7280.00',
          cone_width: '115.00',
          asymmetry_pts: '0',
          spot_at_calc: '7337.50',
        },
      ])
      // fetchConeBreaches
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
    });
    const body = res.body as {
      data: {
        spot: number;
        gamma: { ceiling: { strike: number } | null };
        cone: { coneUpper: number } | null;
      };
    };
    expect(body.data.spot).toBe(7337);
    expect(body.data.gamma.ceiling?.strike).toBe(7350);
    expect(body.data.cone?.coneUpper).toBe(7395);
  });

  it('honors the spot query param over the DB value', async () => {
    mockSql
      // fetchLatestPeriscopeSlot — no slot, short-circuit before cone fetches
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes({ spot: '7400' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { reason: string }).reason).toBe('no_slot');
    // Critical: only ONE sql call (the slot lookup). The spot query
    // param short-circuited the index_candles_1m lookup entirely.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns 500 on unhandled error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('returns nothing extra when guard rejects', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    // Guard short-circuits with its own response; handler does not
    // touch res.status / res.json after guard returns true.
    expect(res.statusCode).toBe(0);
  });
});
