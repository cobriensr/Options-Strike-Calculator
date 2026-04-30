// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

const { mockGetSpotPrice } = vi.hoisted(() => ({
  mockGetSpotPrice: vi.fn(),
}));
vi.mock('../_lib/spot-price.js', () => ({
  getSpotPrice: mockGetSpotPrice,
}));

import handler from '../cron/detect-whales.js';

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-29' };

const SPXW_FLOOR_ROW = {
  id: 100,
  ticker: 'SPXW',
  option_chain: 'SPXW260429P07150000',
  strike: 7150,
  option_type: 'put',
  expiry: '2026-04-29',
  created_at: '2026-04-29T16:56:52Z',
  total_premium: 12_037_400,
  total_ask_side_prem: 600_000,
  total_bid_side_prem: 11_400_000,
  trade_count: 5,
  underlying_price: 7120.12,
  volume_oi_ratio: 10.2,
  dte_at_alert: 0,
};

const SMALL_NON_WHALE_ROW = {
  id: 200,
  ticker: 'SPXW',
  option_chain: 'SPXW260429C07150000',
  strike: 7150,
  option_type: 'call',
  expiry: '2026-04-29',
  created_at: '2026-04-29T14:39:31Z',
  total_premium: 2_675_540, // below SPXW p95 ($6.84M)
  total_ask_side_prem: 1_815_000,
  total_bid_side_prem: 853_000,
  trade_count: 7,
  underlying_price: 7143.76,
  volume_oi_ratio: 20.7,
  dte_at_alert: 0,
};

describe('detect-whales handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    mockGetSpotPrice.mockResolvedValue(null);
  });

  it('returns 200 with 0 inserts when no new candidates', async () => {
    mockSql.mockResolvedValueOnce([]); // candidates SELECT (trailing 15-min window)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'detect-whales',
      candidates: 0,
      inserted: 0,
    });
  });

  it('classifies and inserts a Type 1 floor whale (no paired leg)', async () => {
    mockSql
      .mockResolvedValueOnce([SPXW_FLOOR_ROW]) // candidates
      .mockResolvedValueOnce([]) // peers (none)
      .mockResolvedValueOnce([{ id: 5 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'detect-whales',
      candidates: 1,
      classified: 1,
      inserted: 1,
    });
  });

  it('skips candidates that fail the checklist (premium below threshold)', async () => {
    mockSql.mockResolvedValueOnce([SMALL_NON_WHALE_ROW]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      candidates: 1,
      classified: 0,
      inserted: 0,
    });
  });

  it('filters out simultaneous synthetics', async () => {
    // Peer call leg overlaps the put leg's window > 60s.
    const overlappingPeer = {
      option_type: 'call',
      first_ts: '2026-04-29T16:55:00Z',
      last_ts: '2026-04-29T17:30:00Z',
    };
    mockSql
      .mockResolvedValueOnce([SPXW_FLOOR_ROW])
      .mockResolvedValueOnce([overlappingPeer]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      candidates: 1,
      classified: 1,
      simultaneousFiltered: 1,
      inserted: 0,
    });
  });

  it('classifies as sequential roll when peer leg closed before this leg opened', async () => {
    // Peer call leg closes at 16:56:52, candidate put leg starts at 16:56:52.
    // Overlap = 0 → sequential, not simultaneous.
    const sequentialPeer = {
      option_type: 'call',
      first_ts: '2026-04-29T14:39:31Z',
      last_ts: '2026-04-29T16:56:52Z',
    };
    mockSql
      .mockResolvedValueOnce([SPXW_FLOOR_ROW])
      .mockResolvedValueOnce([sequentialPeer])
      .mockResolvedValueOnce([{ id: 7 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      candidates: 1,
      classified: 1,
      simultaneousFiltered: 0,
      inserted: 1,
    });
  });

  it('uses a trailing-window SELECT (no separate cursor query)', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Only ONE SQL call should fire when no candidates exist — the
    // candidates SELECT itself. There is no cursor pre-query anymore.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const sqlText = (mockSql.mock.calls[0]![0] as readonly string[]).join(' ');
    expect(sqlText).toContain('FROM whale_alerts');
    expect(sqlText).toContain("INTERVAL '15 minutes'");
  });

  it('bails when cronGuard returns null', async () => {
    mockCronGuard.mockReturnValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('fetches spot via UW when an NDX/NDXP candidate has null underlying_price', async () => {
    const NDXP_NULL_UNDERLYING = {
      id: 300,
      ticker: 'NDXP',
      option_chain: 'NDXP260505C24500000',
      strike: 24500,
      option_type: 'call',
      expiry: '2026-05-05',
      created_at: '2026-04-29T13:40:00Z',
      total_premium: 4_200_000,
      total_ask_side_prem: 4_200_000,
      total_bid_side_prem: 0,
      trade_count: 14,
      underlying_price: null,
      volume_oi_ratio: null,
      dte_at_alert: 5,
    };
    mockSql
      .mockResolvedValueOnce([NDXP_NULL_UNDERLYING])
      .mockResolvedValueOnce([]) // peers
      .mockResolvedValueOnce([{ id: 9 }]); // insert
    mockGetSpotPrice.mockResolvedValueOnce(24500);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockGetSpotPrice).toHaveBeenCalledWith('NDXP', 'test-uw-key');
    expect(res._json).toMatchObject({
      candidates: 1,
      classified: 1,
      spotFetchedCount: 1,
    });
  });

  it('does NOT call getSpotPrice when underlying_price is already populated', async () => {
    mockSql
      .mockResolvedValueOnce([SPXW_FLOOR_ROW])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 11 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockGetSpotPrice).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ spotFetchedCount: 0 });
  });

  it('does NOT call getSpotPrice for non-cash-index tickers (e.g. SPY)', async () => {
    const SPY_NULL_UNDERLYING = {
      id: 400,
      ticker: 'SPY',
      option_chain: 'SPY260429P00700000',
      strike: 700,
      option_type: 'put',
      expiry: '2026-04-29',
      created_at: '2026-04-29T15:00:00Z',
      total_premium: 7_000_000,
      total_ask_side_prem: 6_650_000,
      total_bid_side_prem: 350_000,
      trade_count: 10,
      underlying_price: null,
      volume_oi_ratio: 5,
      dte_at_alert: 0,
    };
    mockSql.mockResolvedValueOnce([SPY_NULL_UNDERLYING]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockGetSpotPrice).not.toHaveBeenCalled();
  });
});
