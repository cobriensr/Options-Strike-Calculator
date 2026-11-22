// @vitest-environment node

/**
 * Tests for /api/periscope-strikes handler.
 *
 * Covers the response shapes the GEX Landscape hook depends on:
 *   - 200 with merged strikes + capturedAt when a slot exists
 *   - 200 with capturedAt:null + strikes:[] when no slot ingested yet
 *   - 200 with the ?spot query param honored over the DB value
 *   - 400 on malformed query params
 *   - 500 on unhandled error
 *   - guard short-circuit
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

import handler, { mergeStrikes } from '../periscope-strikes.js';

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

describe('mergeStrikes', () => {
  it('joins gamma + charm by strike, sorted ascending', () => {
    const out = mergeStrikes(
      [
        { strike: 7375, value: 3000 },
        { strike: 7350, value: 5000 },
      ],
      [
        { strike: 7350, value: -400000 },
        { strike: 7375, value: 33000 },
      ],
    );
    expect(out).toEqual([
      { strike: 7350, gamma: 5000, charm: -400000 },
      { strike: 7375, gamma: 3000, charm: 33000 },
    ]);
  });

  it('fills 0 when a strike is missing from one panel', () => {
    const out = mergeStrikes(
      [{ strike: 7400, value: 100 }],
      [{ strike: 7350, value: -200 }],
    );
    expect(out).toEqual([
      { strike: 7350, gamma: 0, charm: -200 },
      { strike: 7400, gamma: 100, charm: 0 },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(mergeStrikes([], [])).toEqual([]);
  });
});

describe('GET /api/periscope-strikes', () => {
  it('returns empty strikes + null capturedAt when no slot exists yet', async () => {
    mockSql
      // fetchSpxSpot — spot from DB
      .mockResolvedValueOnce([{ close: '7337.07' }])
      // fetchAvailableSlots — no slots yet
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — MAX returns null
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      capturedAt: null,
      priorCapturedAt: null,
      spot: 7337.07,
      strikes: [],
      availableSlots: [],
    });
    // Lock the contract: when latest slot is null, fetchPriorPeriscopeSlot
    // must NOT run — its loadSlot would crash on null capturedAt.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('returns merged strikes when slot + prior exist', async () => {
    mockSql
      // fetchSpxSpot
      .mockResolvedValueOnce([{ close: '7337' }])
      // fetchAvailableSlots
      .mockResolvedValueOnce([
        { captured_at: '2026-05-12T18:30:00Z' },
        { captured_at: '2026-05-12T18:40:00Z' },
      ])
      // fetchLatestPeriscopeSlot — MAX
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:40:00Z' }])
      // loadSlot — gamma + charm rows for the latest slot
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '5000.00' },
        { panel: 'gamma', strike: 7375, value: '3000.00' },
        { panel: 'charm', strike: 7350, value: '-400000.00' },
        { panel: 'charm', strike: 7375, value: '33000.00' },
      ])
      // fetchPriorPeriscopeSlot — MAX
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:30:00Z' }])
      // loadSlot for prior (used only for capturedAt — body still parses)
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '4500.00' },
      ]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      capturedAt: string;
      priorCapturedAt: string | null;
      spot: number;
      strikes: Array<{ strike: number; gamma: number; charm: number }>;
      availableSlots: string[];
    };
    expect(body.capturedAt).toBe('2026-05-12T18:40:00Z');
    expect(body.priorCapturedAt).toBe('2026-05-12T18:30:00Z');
    expect(body.spot).toBe(7337);
    expect(body.strikes).toEqual([
      { strike: 7350, gamma: 5000, charm: -400000 },
      { strike: 7375, gamma: 3000, charm: 33000 },
    ]);
    expect(body.availableSlots).toHaveLength(2);
    // 6 SQL calls: spot + slots + (latest MAX + loadSlot) + (prior MAX + loadSlot).
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('returns priorCapturedAt:null when only one slot exists', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '7340' }])
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:30:00Z' }])
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:30:00Z' }])
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '5000.00' },
      ])
      // fetchPriorPeriscopeSlot — MAX returns null (first slot of the day)
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      capturedAt: '2026-05-12T18:30:00Z',
      priorCapturedAt: null,
    });
    // 5 SQL calls: spot + slots + (latest MAX + loadSlot) + prior MAX.
    // The loadSlot for prior is NOT called when MAX returns null — locks
    // the contract that loadSlot never runs against a null capturedAt.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('honors the spot query param over the DB value', async () => {
    mockSql
      // fetchAvailableSlots (no fetchSpxSpot — short-circuited by ?spot)
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — no slot
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes({ spot: '7400' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { spot: number }).spot).toBe(7400);
    // 2 SQL calls — fetchSpxSpot was skipped.
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
      date: '2026-05-12',
      time: '25:99',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'time must be HH:MM (CT)' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 500 on unhandled error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('short-circuits when guard rejects', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('GET /api/periscope-strikes cache headers', () => {
  // A live (no date/time) response that carries a slot, or any live response
  // during the session, is cached 10 s with no stale reuse. A no-slot live
  // response while the market is closed, and every historical read (a past
  // slot is immutable), keep 300 s + 60 s. An error sets no cache header.
  const LIVE_SHORT: [number, number] = [10, 0];
  const LONG: [number, number] = [300, 60];

  /** Queue the reads for a slot with strikes and no prior. */
  function queueSlot(): void {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }]) // fetchSpxSpot
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:40:00Z' }]) // slots
      .mockResolvedValueOnce([{ captured_at: '2026-05-12T18:40:00Z' }]) // latest
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '5000.00' },
      ]) // loadSlot
      .mockResolvedValueOnce([{ captured_at: null }]); // prior
  }

  /** Queue the reads for no periscope slot (capturedAt: null, strikes: []). */
  function queueNoSlot(): void {
    mockSql
      .mockResolvedValueOnce([{ close: '7337.07' }]) // fetchSpxSpot
      .mockResolvedValueOnce([]) // fetchAvailableSlots
      .mockResolvedValueOnce([{ captured_at: null }]); // latest slot
  }

  it.each([
    ['in session', true],
    ['pre-open', false],
  ])(
    'caches a live response that carries a slot for 10 s with no stale reuse (%s)',
    async (_label, open) => {
      mockIsMarketOpen.mockReturnValue(open);
      queueSlot();
      const { req, res } = makeReqRes();
      await handler(req, res as never);
      expect((res.body as { strikes: unknown[] }).strikes).toHaveLength(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LIVE_SHORT);
    },
  );

  it.each([
    ['in session', true, LIVE_SHORT],
    ['closed', false, LONG],
  ] as const)(
    'a live no-slot response uses the right cache (%s)',
    async (_label, open, expected) => {
      mockIsMarketOpen.mockReturnValue(open);
      queueNoSlot();
      const { req, res } = makeReqRes();
      await handler(req, res as never);
      expect(res.body).toMatchObject({ capturedAt: null, strikes: [] });
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...expected);
    },
  );

  it.each([
    ['date only', { date: '2026-05-12' }],
    ['time only', { time: '13:40' }],
    ['date and time', { date: '2026-05-12', time: '13:40' }],
  ])(
    'keeps 300 s + 60 s for a historical read with a slot, even in session (%s)',
    async (_label, query) => {
      mockIsMarketOpen.mockReturnValue(true);
      queueSlot();
      const { req, res } = makeReqRes(query);
      await handler(req, res as never);
      expect((res.body as { strikes: unknown[] }).strikes).toHaveLength(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
      expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
    },
  );

  it('keeps 300 s + 60 s for a historical no-slot response, even in session', async () => {
    mockIsMarketOpen.mockReturnValue(true);
    queueNoSlot();
    const { req, res } = makeReqRes({ date: '2026-05-12' });
    await handler(req, res as never);
    expect(res.body).toMatchObject({ capturedAt: null, strikes: [] });
    expect(mockSetCacheHeaders).toHaveBeenCalledTimes(1);
    expect(mockSetCacheHeaders).toHaveBeenCalledWith(res, ...LONG);
  });

  it('sets no cache header on a DB error (500), live or historical', async () => {
    mockSql.mockRejectedValue(new Error('connection refused'));
    const live = makeReqRes();
    await handler(live.req, live.res as never);
    const historical = makeReqRes({ date: '2026-05-12' });
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
    const badTime = makeReqRes({ date: '2026-05-12', time: '25:99' });
    await handler(badTime.req, badTime.res as never);
    expect(badDate.res.statusCode).toBe(400);
    expect(badTime.res.statusCode).toBe(400);
    expect(mockSetCacheHeaders).not.toHaveBeenCalled();
  });
});
