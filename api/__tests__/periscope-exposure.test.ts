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
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCacheHeaders,
  isMarketOpen: mockIsMarketOpen,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: (
      fn: (s: { setTransactionName: (n: string) => void }) => unknown,
    ) => fn({ setTransactionName: () => undefined }),
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
    // fetchSpxSpot returns []. fetchAvailableSlots returns [].
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_spot',
      availableSlots: [],
    });
  });

  it('returns no_slot when spot is available but no periscope rows exist', async () => {
    mockSql
      // fetchSpxSpot — spot from index_candles_1m
      .mockResolvedValueOnce([{ close: '7337.07' }])
      // fetchAvailableSlots — no slots yet
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — no captured_at
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_slot',
      availableSlots: [],
    });
  });

  it('returns full view when slot + cone exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }])
      // fetchAvailableSlots — two slots
      .mockResolvedValueOnce([
        { captured_at: '2026-05-08T13:40:00Z' },
        { captured_at: '2026-05-08T13:50:00Z' },
      ])
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
      availableSlots: string[];
    };
    expect(body.data.spot).toBe(7337);
    expect(body.data.gamma.ceiling?.strike).toBe(7350);
    expect(body.data.cone?.coneUpper).toBe(7395);
    expect(body.availableSlots).toHaveLength(2);
  });

  it('honors the spot query param over the DB value', async () => {
    mockSql
      // fetchAvailableSlots
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — no slot, short-circuit before cone fetches
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes({ spot: '7400' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { reason: string }).reason).toBe('no_slot');
    // 2 calls: availableSlots + slot lookup. The spot query param
    // short-circuited the index_candles_1m lookup.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('rejects ?date with non-YYYY-MM-DD format', async () => {
    const { req, res } = makeReqRes({ date: 'not-a-date' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'date must be YYYY-MM-DD' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects ?time with out-of-range value', async () => {
    const { req, res } = makeReqRes({
      date: '2026-05-08',
      time: '25:99',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'time must be HH:MM (CT)' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('resolves picked (date, time) → asOf rounded to end-of-minute (catches HH:MM:XX slots)', async () => {
    // 2026-05-08 14:30 CT (CDT = UTC-5) → asOf rounds UP to
    // 19:30:59.999Z so a slot captured at 19:30:48.478Z is INCLUDED
    // (the prev/next stepper depends on this — HH:MM truncates seconds
    // and at-or-before would otherwise skip the intended slot).
    mockSql
      // fetchSpxSpot — at-or-before asOf
      .mockResolvedValueOnce([{ close: '7388.07' }])
      // fetchAvailableSlots
      .mockResolvedValueOnce([
        { captured_at: '2026-05-08T19:20:48.478Z' },
        { captured_at: '2026-05-08T19:30:48.478Z' },
      ])
      // fetchLatestPeriscopeSlot at-or-before asOf
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T19:30:48.478Z' }])
      // loadSlot
      .mockResolvedValueOnce([{ panel: 'gamma', strike: 7390, value: '5000' }])
      // fetchPriorPeriscopeSlot
      .mockResolvedValueOnce([{ captured_at: null }])
      // fetchConeLevels
      .mockResolvedValueOnce([])
      // fetchConeBreaches
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes({
      date: '2026-05-08',
      time: '14:30',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      data: { capturedAt: string; spot: number };
      availableSlots: string[];
    };
    expect(body.data.capturedAt).toBe('2026-05-08T19:30:48.478Z');
    expect(body.data.spot).toBe(7388.07);
    expect(body.availableSlots).toEqual([
      '2026-05-08T19:20:48.478Z',
      '2026-05-08T19:30:48.478Z',
    ]);
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

describe('GET /api/periscope-exposure cache headers', () => {
  // A live (no date/time) response that carries data, or any live response
  // during the session, is cached 10 s with no stale reuse. A no-data live
  // response while the market is closed, and every historical read (a past
  // slot is immutable), keep 300 s + 60 s. An error sets no cache header.
  const LIVE_SHORT: [number, number] = [10, 0];
  const LONG: [number, number] = [300, 60];

  /** Queue the reads for a complete view: spot, slots, latest, rows, cone. */
  function queueFullView(): void {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }]) // fetchSpxSpot
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T13:50:00Z' }]) // slots
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T13:50:00Z' }]) // latest
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '3187.00' },
      ]) // loadSlot
      .mockResolvedValueOnce([{ captured_at: null }]) // prior
      .mockResolvedValueOnce([]) // cone levels
      .mockResolvedValueOnce([]); // cone breaches
  }

  /** Queue the reads for a spot but no periscope slot (reason: no_slot). */
  function queueNoSlot(): void {
    mockSql
      .mockResolvedValueOnce([{ close: '7337.07' }]) // fetchSpxSpot
      .mockResolvedValueOnce([]) // fetchAvailableSlots
      .mockResolvedValueOnce([{ captured_at: null }]); // latest slot
  }

  /** Queue the reads for no SPX spot at all (reason: no_spot). */
  function queueNoSpot(): void {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  }

  it.each([
    ['in session', true],
    ['pre-open', false],
  ])(
    'caches a live response that carries data for 10 s with no stale reuse (%s)',
    async (_label, open) => {
      mockIsMarketOpen.mockReturnValue(open);
      queueFullView();
      const { req, res } = makeReqRes();
      await handler(req, res as never);
      expect((res.body as { data: unknown }).data).not.toBeNull();
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
    },
  );

  it.each([
    ['no_slot', true, LIVE_SHORT],
    ['no_slot', false, LONG],
    ['no_spot', true, LIVE_SHORT],
    ['no_spot', false, LONG],
  ] as const)(
    'a live %s response uses the right cache (marketOpen: %s)',
    async (reason, open, expected) => {
      mockIsMarketOpen.mockReturnValue(open);
      if (reason === 'no_slot') queueNoSlot();
      else queueNoSpot();
      const { req, res } = makeReqRes();
      await handler(req, res as never);
      expect(res.body).toMatchObject({ data: null, reason });
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...expected);
    },
  );

  it.each([
    ['date only', { date: '2026-05-08' }],
    ['time only', { time: '08:50' }],
    ['date and time', { date: '2026-05-08', time: '08:50' }],
  ])(
    'keeps 300 s + 60 s for a historical read with data, even in session (%s)',
    async (_label, query) => {
      mockIsMarketOpen.mockReturnValue(true);
      queueFullView();
      const { req, res } = makeReqRes(query);
      await handler(req, res as never);
      expect((res.body as { data: unknown }).data).not.toBeNull();
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
    },
  );

  it.each([
    ['no_slot', queueNoSlot],
    ['no_spot', queueNoSpot],
  ])(
    'keeps 300 s + 60 s for a historical %s response, even in session',
    async (reason, queue) => {
      mockIsMarketOpen.mockReturnValue(true);
      queue();
      const { req, res } = makeReqRes({ date: '2026-05-08' });
      await handler(req, res as never);
      expect(res.body).toMatchObject({ data: null, reason });
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
    },
  );

  it('sets no cache header on a DB error (500), live or historical', async () => {
    mockSql.mockRejectedValue(new Error('connection refused'));
    const live = makeReqRes();
    await handler(live.req, live.res as never);
    const historical = makeReqRes({ date: '2026-05-08' });
    await handler(historical.req, historical.res as never);
    expect(live.res.statusCode).toBe(500);
    expect(historical.res.statusCode).toBe(500);
    expect(mockSetCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header when a later read fails after the spot loaded', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }]) // fetchSpxSpot
      .mockRejectedValueOnce(new Error('slots read failed')); // fetchAvailableSlots
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(500);
    expect(mockSetCacheHeaders).not.toHaveBeenCalled();
  });

  it('sets no cache header on a 400 for a malformed date or time', async () => {
    const badDate = makeReqRes({ date: 'not-a-date' });
    await handler(badDate.req, badDate.res as never);
    const badTime = makeReqRes({ date: '2026-05-08', time: '25:99' });
    await handler(badTime.req, badTime.res as never);
    expect(badDate.res.statusCode).toBe(400);
    expect(badTime.res.statusCode).toBe(400);
    expect(mockSetCacheHeaders).not.toHaveBeenCalled();
  });
});
