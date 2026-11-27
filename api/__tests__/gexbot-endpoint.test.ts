// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  isMarketOpen: vi.fn().mockReturnValue(true),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/live-read-cache.js', () => ({
  setClosedReadCache: vi.fn(),
}));

const {
  mockGetAnchors,
  mockGetExpectedMove,
  mockGetLatest,
  mockGetTrend,
  mockGetMax,
  mockGetSibling,
  mockGetVelocity,
} = vi.hoisted(() => ({
  mockGetAnchors: vi.fn(),
  mockGetExpectedMove: vi.fn(),
  mockGetLatest: vi.fn(),
  mockGetTrend: vi.fn(),
  mockGetMax: vi.fn(),
  mockGetSibling: vi.fn(),
  mockGetVelocity: vi.fn(),
}));

vi.mock('../_lib/gexbot-queries.js', () => ({
  getClosedAnchors: mockGetAnchors,
  getExpectedMove: mockGetExpectedMove,
  getVelocityTape: mockGetVelocity,
  getLatestSnapshots: mockGetLatest,
  getConvexityTrend: mockGetTrend,
  getMaxchangeWinners: mockGetMax,
  getSiblingConfirmation: mockGetSibling,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../gexbot.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from '../_lib/api-helpers.js';
import { setClosedReadCache } from '../_lib/live-read-cache.js';
import { Sentry } from '../_lib/sentry.js';

/** GET one view with no other query and return the response. */
async function get(view: string) {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET', query: { view } }), res);
  return res;
}

describe('GET /api/gexbot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    // resetAllMocks wipes the factory value, and undefined would read as closed.
    vi.mocked(isMarketOpen).mockReturnValue(true);
    mockGetAnchors.mockResolvedValue(null);
    mockGetLatest.mockResolvedValue([]);
    mockGetTrend.mockResolvedValue([]);
    mockGetMax.mockResolvedValue([]);
    mockGetSibling.mockResolvedValue([]);
    mockGetVelocity.mockResolvedValue([]);
    mockGetExpectedMove.mockResolvedValue([]);
  });

  it('returns 405 for non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 400 when view is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 when view is unknown', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'unknown-view' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 400 when sibling-confirm is missing ticker/side/at', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'sibling-confirm' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockGetSibling).not.toHaveBeenCalled();
  });

  it.each([
    ['no fire time', { ticker: 'SPY', side: 'call' }],
    ['a non-date fire time', { ticker: 'SPY', side: 'call', at: 'yesterday' }],
    [
      'a date-only fire time',
      { ticker: 'SPY', side: 'call', at: '2026-10-29' },
    ],
    ['no side', { ticker: 'SPY', at: '2026-10-29T14:00:10.000Z' }],
    ['no ticker', { side: 'call', at: '2026-10-29T14:00:10.000Z' }],
    [
      'a lowercase ticker',
      { ticker: 'spy', side: 'call', at: '2026-10-29T14:00:10.000Z' },
    ],
  ])('returns 400 for sibling-confirm with %s', async (_label, extra) => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { view: 'sibling-confirm', ...extra },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockGetSibling).not.toHaveBeenCalled();
  });

  it('returns 200 with rows for snapshots-latest', async () => {
    mockGetLatest.mockResolvedValue([
      { ticker: 'HYG', capturedAt: '2026-05-19T14:00:00Z', minDte: 2 },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'snapshots-latest' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      rows: [{ ticker: 'HYG', capturedAt: '2026-05-19T14:00:00Z', minDte: 2 }],
      asOf: '2026-05-19T14:00:00Z',
    });
    expect(mockGetLatest).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with rows for velocity', async () => {
    const row = {
      ticker: 'SPX',
      capturedAt: '2026-10-29T14:04:00.000Z',
      minDte: 0,
      dAggDex: 40,
      dZgr: null,
      dZcvr: null,
      typicalAbsDAggDex: 10,
    };
    mockGetVelocity.mockResolvedValue([row]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'velocity' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ rows: [row], asOf: row.capturedAt });
    expect(mockGetVelocity).toHaveBeenCalledTimes(1);
  });

  it('surfaces a velocity DB failure as 500 and a Sentry capture', async () => {
    mockGetVelocity.mockRejectedValue(new Error('connection lost'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'velocity' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection lost' }),
      expect.objectContaining({
        tags: { route: '/api/gexbot', view: 'velocity' },
      }),
    );
  });

  it('returns 200 with rows for expected-move', async () => {
    const row = {
      ticker: 'SPX',
      capturedAt: '2025-07-23T15:13:14.000Z',
      asOf: '2025-07-23T15:13:12.000Z',
      spot: 6326.27,
      minDte: 0,
      atmStrike: 6325,
      atmIv: 0.11,
      dteFraction: 0.19916666666666666,
      expectedMove: 16.25557378390728,
      lower: 6310.014426216093,
      upper: 6342.525573783908,
      unavailable: null,
    };
    mockGetExpectedMove.mockResolvedValue([row]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'expected-move' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ rows: [row] });
    expect(mockGetExpectedMove).toHaveBeenCalledTimes(1);
  });

  it('surfaces an expected-move DB failure as 500 and a Sentry capture', async () => {
    mockGetExpectedMove.mockRejectedValue(new Error('connection lost'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'expected-move' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection lost' }),
      expect.objectContaining({
        tags: { route: '/api/gexbot', view: 'expected-move' },
      }),
    );
  });

  it('keeps expected-move behind the owner-or-guest guard', async () => {
    // GEXBot-derived values are licensed data: never served unguarded.
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(true);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'expected-move' } }),
      res,
    );
    expect(mockGetExpectedMove).not.toHaveBeenCalled();
  });

  it('returns 200 with rows for convexity-trend', async () => {
    mockGetTrend.mockResolvedValue([
      { ticker: 'SPX', series: [['2026-05-19T13:00:00Z', 1.1]] },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'convexity-trend' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      rows: [{ ticker: 'SPX', series: [['2026-05-19T13:00:00Z', 1.1]] }],
      asOf: '2026-05-19T13:00:00Z',
    });
    expect(mockGetTrend).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with rows for maxchange-winners', async () => {
    mockGetMax.mockResolvedValue([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'maxchange-winners' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ rows: [], asOf: null });
    expect(mockGetMax).toHaveBeenCalledTimes(1);
  });

  it('returns 200 for sibling-confirm and passes the fire time through', async () => {
    const row = {
      ticker: 'QQQ',
      verdict: 'agree',
      netDex: 1_200_000,
      zgr: 0.8,
      capturedAt: '2026-10-29T14:00:00.000Z',
    };
    mockGetSibling.mockResolvedValue([row]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          view: 'sibling-confirm',
          ticker: 'SPY',
          side: 'call',
          at: '2026-10-29T14:00:10.000Z',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ rows: [row] });
    expect(mockGetSibling).toHaveBeenCalledWith(
      'SPY',
      'call',
      new Date('2026-10-29T14:00:10.000Z'),
    );
  });

  it('surfaces a sibling-confirm DB failure as 500 and a Sentry capture', async () => {
    mockGetSibling.mockRejectedValue(new Error('connection lost'));
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: {
          view: 'sibling-confirm',
          ticker: 'SPY',
          side: 'put',
          at: '2026-10-29T14:00:10.000Z',
        },
      }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection lost' }),
      expect.objectContaining({
        tags: { route: '/api/gexbot', view: 'sibling-confirm' },
      }),
    );
  });

  it('rejects via guard when not authorized', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementation(
      async (_req, res) => {
        res.status(401).json({ error: 'Not authenticated' });
        return true;
      },
    );
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'snapshots-latest' } }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it('returns 500 when query helper throws', async () => {
    mockGetLatest.mockRejectedValue(new Error('db down'));
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'snapshots-latest' } }),
      res,
    );
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
  });

  // ── live (market open): today's behavior, plus asOf ─────────────

  describe('while the market is open', () => {
    it.each([
      ['snapshots-latest', mockGetLatest],
      ['convexity-trend', mockGetTrend],
      ['maxchange-winners', mockGetMax],
      ['velocity', mockGetVelocity],
    ])(
      'reads %s from the clock: no anchor probe, no anchors',
      async (view, reader) => {
        await get(view);
        expect(mockGetAnchors).not.toHaveBeenCalled();
        expect(reader).toHaveBeenCalledTimes(1);
        expect(reader).toHaveBeenCalledWith();
      },
    );

    it.each([
      'snapshots-latest',
      'convexity-trend',
      'maxchange-winners',
      'velocity',
    ])('caches %s for 15 s and never uses the closed rule', async (view) => {
      const res = await get(view);
      expect(setCacheHeaders).toHaveBeenCalledWith(res, 15);
      expect(setClosedReadCache).not.toHaveBeenCalled();
    });

    it('sets asOf to the newest capture time among the rows, whatever their order', async () => {
      mockGetLatest.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T20:59:49.000Z' },
        { ticker: 'NDX', capturedAt: '2026-11-20T21:00:50.000Z' },
        { ticker: 'IWM', capturedAt: '2026-11-20T21:00:30.000Z' },
      ]);
      const res = await get('snapshots-latest');
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:00:50.000Z' });
    });

    it('sets asOf for maxchange-winners from capturedAt', async () => {
      mockGetMax.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' },
        { ticker: 'NDX', capturedAt: '2026-11-20T20:58:10.000Z' },
      ]);
      const res = await get('maxchange-winners');
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:00:49.000Z' });
    });

    it('sets asOf for convexity-trend to the newest series point of any ticker', async () => {
      mockGetTrend.mockResolvedValue([
        {
          ticker: 'SPX',
          series: [
            ['2026-11-20T20:59:49.000Z', 1],
            ['2026-11-20T21:00:49.000Z', 2],
          ],
        },
        {
          ticker: 'NDX',
          series: [['2026-11-20T21:00:50.000Z', 3]],
        },
        { ticker: 'IWM', series: [] },
      ]);
      const res = await get('convexity-trend');
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:00:50.000Z' });
    });

    it('compares capture times as instants, not as text', async () => {
      // 14:00 at -05:00 is 19:00Z, later than 18:30Z although "14" < "18".
      mockGetLatest.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T18:30:00.000Z' },
        { ticker: 'NDX', capturedAt: '2026-11-20T14:00:00.000-05:00' },
      ]);
      const res = await get('snapshots-latest');
      expect(res._json).toMatchObject({
        asOf: '2026-11-20T14:00:00.000-05:00',
      });
    });

    it('sets asOf to null when the payload is empty', async () => {
      const res = await get('snapshots-latest');
      expect(res._json).toEqual({ rows: [], asOf: null });
    });

    it('sets asOf for velocity to the newest capture time among the rows', async () => {
      mockGetVelocity.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' },
        { ticker: 'ES_SPX', capturedAt: '2026-11-20T21:01:55.000Z' },
      ]);
      const res = await get('velocity');
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:01:55.000Z' });
    });

    it('adds no asOf to expected-move', async () => {
      mockGetExpectedMove.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' },
      ]);
      const res = await get('expected-move');
      expect(res._json).not.toHaveProperty('asOf');
    });
  });

  // ── closed (market closed): anchored on each ticker's last capture ──

  describe('while the market is closed', () => {
    const ANCHORS = {
      sessionDate: '2026-11-20',
      byTicker: new Map([['SPX', '2026-11-20T21:00:49.000Z']]),
    };
    const CLOSED_NOW = new Date('2026-11-20T22:00:00.000Z');

    beforeEach(() => {
      vi.mocked(isMarketOpen).mockReturnValue(false);
      mockGetAnchors.mockResolvedValue(ANCHORS);
    });

    it('anchors snapshots-latest on the snapshots table and passes the anchors through', async () => {
      mockGetLatest.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' },
      ]);
      const res = await get('snapshots-latest');
      expect(mockGetAnchors).toHaveBeenCalledTimes(1);
      expect(mockGetAnchors).toHaveBeenCalledWith('gexbot_snapshots');
      expect(mockGetLatest).toHaveBeenCalledWith(ANCHORS);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        rows: [{ ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' }],
        asOf: '2026-11-20T21:00:49.000Z',
      });
    });

    it('anchors convexity-trend on the snapshots table, with the default window', async () => {
      mockGetTrend.mockResolvedValue([
        { ticker: 'SPX', series: [['2026-11-20T21:00:49.000Z', 1.5]] },
      ]);
      const res = await get('convexity-trend');
      expect(mockGetAnchors).toHaveBeenCalledWith('gexbot_snapshots');
      expect(mockGetTrend).toHaveBeenCalledWith(undefined, ANCHORS);
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:00:49.000Z' });
    });

    it('anchors maxchange-winners on the capture table', async () => {
      mockGetMax.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z' },
      ]);
      const res = await get('maxchange-winners');
      expect(mockGetAnchors).toHaveBeenCalledTimes(1);
      expect(mockGetAnchors).toHaveBeenCalledWith('gexbot_api_capture');
      expect(mockGetMax).toHaveBeenCalledWith(ANCHORS);
      expect(res._json).toMatchObject({ asOf: '2026-11-20T21:00:49.000Z' });
    });

    it('anchors velocity on the snapshots table and passes the anchors through', async () => {
      mockGetVelocity.mockResolvedValue([
        { ticker: 'SPX', capturedAt: '2026-11-20T21:00:49.000Z', dAggDex: 30 },
      ]);
      const res = await get('velocity');
      expect(mockGetAnchors).toHaveBeenCalledTimes(1);
      expect(mockGetAnchors).toHaveBeenCalledWith('gexbot_snapshots');
      expect(mockGetVelocity).toHaveBeenCalledTimes(1);
      expect(mockGetVelocity).toHaveBeenCalledWith(ANCHORS);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        rows: [
          {
            ticker: 'SPX',
            capturedAt: '2026-11-20T21:00:49.000Z',
            dAggDex: 30,
          },
        ],
        asOf: '2026-11-20T21:00:49.000Z',
      });
    });

    const ANCHORED_READERS = [
      ['snapshots-latest', mockGetLatest],
      ['convexity-trend', mockGetTrend],
      ['maxchange-winners', mockGetMax],
      ['velocity', mockGetVelocity],
    ] as const;

    it.each(ANCHORED_READERS)(
      'answers %s with no rows and a null asOf when the table is empty',
      async (view, reader) => {
        mockGetAnchors.mockResolvedValue(null);
        const res = await get(view);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ rows: [], asOf: null });
        expect(reader).not.toHaveBeenCalled();
        expect(setClosedReadCache).toHaveBeenCalledTimes(1);
      },
    );

    it.each(ANCHORED_READERS)(
      'answers %s with no rows, without calling the reader, when no ticker has an anchor',
      async (view, reader) => {
        // A table whose rows all lack a vendor stamp has a session date and
        // no tickers: the reader would only join an empty list.
        mockGetAnchors.mockResolvedValue({
          sessionDate: '2026-11-20',
          byTicker: new Map(),
        });
        const res = await get(view);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ rows: [], asOf: null });
        expect(reader).not.toHaveBeenCalled();
        expect(setClosedReadCache).toHaveBeenCalledTimes(1);
      },
    );

    it('sets asOf to null when the anchored read returns nothing', async () => {
      const res = await get('snapshots-latest');
      expect(res._json).toEqual({ rows: [], asOf: null });
    });

    it.each([
      'snapshots-latest',
      'convexity-trend',
      'maxchange-winners',
      'velocity',
      'expected-move',
    ])(
      'caches %s with the closed rule, built from one clock reading',
      async (view) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(CLOSED_NOW);
        try {
          const res = await get(view);
          expect(setClosedReadCache).toHaveBeenCalledTimes(1);
          expect(setClosedReadCache).toHaveBeenCalledWith(res, CLOSED_NOW);
          expect(setCacheHeaders).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('leaves expected-move and sibling-confirm unanchored', async () => {
      await get('expected-move');
      await handler(
        mockRequest({
          method: 'GET',
          query: {
            view: 'sibling-confirm',
            ticker: 'SPY',
            side: 'call',
            at: '2026-11-20T20:59:00.000Z',
          },
        }),
        mockResponse(),
      );
      expect(mockGetAnchors).not.toHaveBeenCalled();
      expect(mockGetExpectedMove).toHaveBeenCalledWith();
      expect(mockGetSibling).toHaveBeenCalledTimes(1);
    });

    it.each(ANCHORED_READERS)(
      'surfaces an anchor-probe failure on %s as 500 and a Sentry capture',
      async (view, reader) => {
        mockGetAnchors.mockRejectedValue(new Error('connection lost'));
        const res = await get(view);
        expect(res._status).toBe(500);
        expect(res._json).toEqual({ error: 'Internal error' });
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'connection lost' }),
          expect.objectContaining({ tags: { route: '/api/gexbot', view } }),
        );
        expect(reader).not.toHaveBeenCalled();
        expect(setClosedReadCache).not.toHaveBeenCalled();
        expect(setCacheHeaders).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['snapshots-latest', mockGetLatest],
      ['velocity', mockGetVelocity],
    ])(
      'surfaces an anchored-read failure on %s as 500 and a Sentry capture',
      async (view, reader) => {
        reader.mockRejectedValue(new Error('db down'));
        const res = await get(view);
        expect(res._status).toBe(500);
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'db down' }),
          expect.objectContaining({ tags: { route: '/api/gexbot', view } }),
        );
        expect(setClosedReadCache).not.toHaveBeenCalled();
      },
    );

    it.each(ANCHORED_READERS)(
      'keeps %s behind the owner-or-guest guard',
      async (view, reader) => {
        vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(true);
        await get(view);
        expect(mockGetAnchors).not.toHaveBeenCalled();
        expect(reader).not.toHaveBeenCalled();
      },
    );
  });
});
