// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../darkpool-levels.js';
import { rejectIfNotOwner } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeDbRow(overrides = {}) {
  return {
    spx_approx: 6575,
    spy_price_low: '657.00',
    spy_price_high: '658.00',
    total_premium: '1300000000',
    trade_count: 13,
    total_shares: 2000000,
    buyer_initiated: 9,
    seller_initiated: 3,
    neutral: 1,
    latest_time: '2026-04-02T16:30:00Z',
    updated_at: '2026-04-02T16:35:00Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('GET /api/darkpool-levels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    mockSql.mockReset();
  });

  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 405 for PUT', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns levels sorted by premium with computed direction', async () => {
    const rows = [
      makeDbRow({
        spx_approx: 6575,
        total_premium: '1300000000',
        buyer_initiated: 9,
        seller_initiated: 3,
      }),
      makeDbRow({
        spx_approx: 6555,
        total_premium: '248000000',
        buyer_initiated: 1,
        seller_initiated: 4,
      }),
    ];
    mockSql.mockResolvedValue(rows);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      levels: Array<Record<string, unknown>>;
      date: string;
    };
    expect(body.levels).toHaveLength(2);
    expect(body.date).toBeDefined();

    // First level — buyer dominated → BUY
    expect(body.levels[0]).toMatchObject({
      spxApprox: 6575,
      totalPremium: 1_300_000_000,
      direction: 'BUY',
      tradeCount: 13,
    });

    // Second level — seller dominated → SELL
    expect(body.levels[1]).toMatchObject({
      spxApprox: 6555,
      totalPremium: 248_000_000,
      direction: 'SELL',
    });
  });

  it('returns MIXED direction when buyer === seller', async () => {
    mockSql.mockResolvedValue([
      makeDbRow({ buyer_initiated: 3, seller_initiated: 3 }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { levels: Array<{ direction: string }> };
    expect(body.levels[0]!.direction).toBe('MIXED');
  });

  it('converts string DB values to numbers', async () => {
    mockSql.mockResolvedValue([
      makeDbRow({
        spx_approx: 6600,
        spy_price_low: '660.00',
        spy_price_high: '660.50',
        total_premium: '500000000',
        trade_count: 7,
        total_shares: 800000,
        buyer_initiated: 4,
        seller_initiated: 2,
        neutral: 1,
      }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const level = (res._json as { levels: Array<Record<string, unknown>> })
      .levels[0]!;
    expect(typeof level.spxApprox).toBe('number');
    expect(typeof level.spyPriceLow).toBe('number');
    expect(typeof level.spyPriceHigh).toBe('number');
    expect(typeof level.totalPremium).toBe('number');
    expect(typeof level.tradeCount).toBe('number');
    expect(typeof level.totalShares).toBe('number');
    expect(typeof level.buyerInitiated).toBe('number');
    expect(typeof level.sellerInitiated).toBe('number');
    expect(typeof level.neutral).toBe('number');
  });

  it('returns empty levels when no data for today', async () => {
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { levels: unknown[] };
    expect(body.levels).toEqual([]);
  });

  it('sets Cache-Control: no-store header', async () => {
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 500 and captures exception on DB error', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValue(dbError);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('calls scope.setTransactionName', async () => {
    const setTransactionName = vi.fn();
    (Sentry.withIsolationScope as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cb: (scope: {
          setTransactionName: typeof setTransactionName;
        }) => unknown,
      ) => cb({ setTransactionName }),
    );
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(setTransactionName).toHaveBeenCalledWith('GET /api/darkpool-levels');
  });

  it('includes latestTime and updatedAt in response', async () => {
    mockSql.mockResolvedValue([
      makeDbRow({
        latest_time: '2026-04-02T18:00:00Z',
        updated_at: '2026-04-02T18:05:00Z',
      }),
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const level = (res._json as { levels: Array<Record<string, unknown>> })
      .levels[0]!;
    expect(level.latestTime).toBe('2026-04-02T18:00:00Z');
    expect(level.updatedAt).toBe('2026-04-02T18:05:00Z');
  });
});
