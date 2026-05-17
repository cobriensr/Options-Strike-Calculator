// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

const { mockGetLatest, mockGetTrend, mockGetMax, mockGetSibling } = vi.hoisted(
  () => ({
    mockGetLatest: vi.fn(),
    mockGetTrend: vi.fn(),
    mockGetMax: vi.fn(),
    mockGetSibling: vi.fn(),
  }),
);

vi.mock('../_lib/gexbot-queries.js', () => ({
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

describe('GET /api/gexbot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
    mockGetLatest.mockResolvedValue([]);
    mockGetTrend.mockResolvedValue([]);
    mockGetMax.mockResolvedValue([]);
    mockGetSibling.mockResolvedValue([]);
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

  it('returns 400 when sibling-confirm is missing ticker/side', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'sibling-confirm' } }),
      res,
    );
    expect(res._status).toBe(400);
  });

  it('returns 200 with rows for snapshots-latest', async () => {
    mockGetLatest.mockResolvedValue([
      { ticker: 'SPX', capturedAt: '2026-05-19T14:00:00Z' },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { view: 'snapshots-latest' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      rows: [{ ticker: 'SPX', capturedAt: '2026-05-19T14:00:00Z' }],
    });
    expect(mockGetLatest).toHaveBeenCalledTimes(1);
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

  it('returns 200 for sibling-confirm with valid ticker + side', async () => {
    mockGetSibling.mockResolvedValue([
      { ticker: 'QQQ', verdict: 'confirm', zcvr: 1.2, deltaRiskReversal: 0.02 },
    ]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { view: 'sibling-confirm', ticker: 'SPY', side: 'call' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(mockGetSibling).toHaveBeenCalledWith('SPY', 'call');
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
