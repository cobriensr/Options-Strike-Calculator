// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

const {
  mockGetLatest,
  mockGetTrend,
  mockGetMax,
  mockGetSibling,
  mockGetVelocity,
} = vi.hoisted(() => ({
  mockGetLatest: vi.fn(),
  mockGetTrend: vi.fn(),
  mockGetMax: vi.fn(),
  mockGetSibling: vi.fn(),
  mockGetVelocity: vi.fn(),
}));

vi.mock('../_lib/gexbot-queries.js', () => ({
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
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

describe('GET /api/gexbot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockGetLatest.mockResolvedValue([]);
    mockGetTrend.mockResolvedValue([]);
    mockGetMax.mockResolvedValue([]);
    mockGetSibling.mockResolvedValue([]);
    mockGetVelocity.mockResolvedValue([]);
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
    expect(res._json).toEqual({ rows: [row] });
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
});
