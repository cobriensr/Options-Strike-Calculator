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

import handler from '../cron/detect-whales.js';

const GUARD = { apiKey: '', today: '2026-04-29' };

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
  });

  it('returns 200 with 0 inserts when no new candidates', async () => {
    mockSql
      .mockResolvedValueOnce([{ max_detected_at: null }]) // cursor
      .mockResolvedValueOnce([]); // candidates SELECT

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
      .mockResolvedValueOnce([{ max_detected_at: null }]) // cursor
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
    mockSql
      .mockResolvedValueOnce([{ max_detected_at: null }])
      .mockResolvedValueOnce([SMALL_NON_WHALE_ROW]);

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
      .mockResolvedValueOnce([{ max_detected_at: null }])
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
      .mockResolvedValueOnce([{ max_detected_at: null }])
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

  it('passes the cursor timestamp into the candidates SELECT when prior runs exist', async () => {
    const lastSeen = new Date('2026-04-29T16:00:00Z');
    mockSql
      .mockResolvedValueOnce([{ max_detected_at: lastSeen }])
      .mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The 2nd db call is the candidates SELECT. Its bound parameters should
    // include the cursor's ISO string.
    const candidatesCallArgs = mockSql.mock.calls[1]!.slice(1);
    expect(candidatesCallArgs).toContain(lastSeen.toISOString());
  });

  it('uses the epoch sentinel when no prior runs exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ max_detected_at: null }])
      .mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const candidatesCallArgs = mockSql.mock.calls[1]!.slice(1);
    expect(candidatesCallArgs).toContain('1970-01-01T00:00:00Z');
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
});
