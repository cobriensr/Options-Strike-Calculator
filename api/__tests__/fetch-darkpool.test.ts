// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/darkpool.js', () => ({
  fetchDarkPoolBlocks: vi.fn(),
  clusterDarkPoolTrades: vi.fn(),
}));

import handler from '../cron/fetch-darkpool.js';
import { cronGuard } from '../_lib/api-helpers.js';
import {
  fetchDarkPoolBlocks,
  clusterDarkPoolTrades,
} from '../_lib/darkpool.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function makeCluster(overrides = {}) {
  return {
    spyPriceLow: 655.0,
    spyPriceHigh: 655.5,
    spxApprox: 6550,
    totalPremium: 250_000_000,
    tradeCount: 5,
    totalShares: 500_000,
    buyerInitiated: 3,
    sellerInitiated: 2,
    neutral: 0,
    latestTime: '2026-04-02T16:00:00Z',
    ...overrides,
  };
}

function makeTrade(overrides = {}) {
  return {
    canceled: false,
    executed_at: '2026-04-02T16:00:00Z',
    ext_hour_sold_codes: null,
    market_center: 'D',
    nbbo_ask: '655.50',
    nbbo_bid: '655.00',
    nbbo_ask_quantity: 100,
    nbbo_bid_quantity: 200,
    premium: '10000000',
    price: '655.25',
    sale_cond_codes: null,
    size: 15000,
    ticker: 'SPY',
    tracking_id: 1,
    trade_code: null,
    trade_settlement: 'regular',
    volume: 1000000,
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

describe('fetch-darkpool cron handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };

    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-04-02',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── Guard ────────────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(fetchDarkPoolBlocks)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── No data ──────────────────────────────────────────────

  it('returns skipped when no trades returned', async () => {
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-darkpool',
      skipped: true,
      reason: 'no trades',
    });
    expect(logger.info).toHaveBeenCalled();
  });

  it('returns skipped when trades exist but no clusters produced', async () => {
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([makeTrade()]);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-darkpool',
      skipped: true,
      reason: 'no clusters',
    });
  });

  // ── Success ──────────────────────────────────────────────

  it('deletes old rows and inserts new clusters', async () => {
    const trades = [makeTrade(), makeTrade({ tracking_id: 2 })];
    const clusters = [
      makeCluster({ spxApprox: 6550, totalPremium: 500_000_000 }),
      makeCluster({ spxApprox: 6575, totalPremium: 200_000_000 }),
    ];

    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue(trades);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue(clusters);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-darkpool',
      clusters: 2,
      trades: 2,
      topPremium: 500_000_000,
    });
    expect(res._json).toHaveProperty('durationMs');

    // DELETE + 2 INSERTs = 3 SQL calls
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalled();
  });

  it('passes apiKey to fetchDarkPoolBlocks', async () => {
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(fetchDarkPoolBlocks).toHaveBeenCalledWith('test-uw-key');
  });

  it('passes trades to clusterDarkPoolTrades', async () => {
    const trades = [makeTrade()];
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue(trades);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue([makeCluster()]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(clusterDarkPoolTrades).toHaveBeenCalledWith(trades);
  });

  it('inserts clusters with correct field values', async () => {
    const cluster = makeCluster({
      spxApprox: 6600,
      spyPriceLow: 660.0,
      spyPriceHigh: 660.5,
      totalPremium: 1_500_000_000,
      tradeCount: 13,
      totalShares: 2_000_000,
      buyerInitiated: 9,
      sellerInitiated: 3,
      neutral: 1,
      latestTime: '2026-04-02T18:30:00Z',
    });

    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([makeTrade()]);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue([cluster]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._json).toMatchObject({
      clusters: 1,
      topPremium: 1_500_000_000,
    });
    // DELETE + 1 INSERT = 2 calls
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('handles cluster with null latestTime', async () => {
    const cluster = makeCluster({ latestTime: '' });

    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([makeTrade()]);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue([cluster]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ clusters: 1 });
  });

  // ── Error handling ───────────────────────────────────────

  it('returns 500 and captures exception on fetch error', async () => {
    const err = new Error('UW API timeout');
    vi.mocked(fetchDarkPoolBlocks).mockRejectedValue(err);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'fetch-darkpool');
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns 500 on DB write error', async () => {
    vi.mocked(fetchDarkPoolBlocks).mockResolvedValue([makeTrade()]);
    vi.mocked(clusterDarkPoolTrades).mockReturnValue([makeCluster()]);
    mockSql.mockRejectedValue(new Error('connection refused'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
