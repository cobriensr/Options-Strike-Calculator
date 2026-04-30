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

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import handler from '../whale-anomalies.js';

const ROW = {
  id: 1,
  ticker: 'SPXW',
  option_chain: 'SPXW260429P07150000',
  strike: 7150,
  option_type: 'put',
  expiry: '2026-04-29',
  first_ts: '2026-04-29T16:56:52Z',
  last_ts: '2026-04-29T19:33:07Z',
  detected_at: '2026-04-29T16:57:00Z',
  side: 'BID',
  ask_pct: 0.05,
  total_premium: 12_037_400,
  trade_count: 5,
  vol_oi_ratio: 10.2,
  underlying_price: 7120.12,
  moneyness: 0.0042,
  dte: 0,
  whale_type: 1,
  direction: 'bullish',
  pairing_status: 'sequential',
  source: 'eod_backfill',
  resolved_at: null,
  hit_target: null,
  pct_to_target: null,
};

describe('whale-anomalies endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false); // not blocked = passed auth
    mockSql.mockResolvedValue([]);
  });

  it('returns 200 with whales for the date', async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      date: '2026-04-29',
      whales: [
        expect.objectContaining({
          ticker: 'SPXW',
          whale_type: 1,
          direction: 'bullish',
          side: 'BID',
        }),
      ],
    });
  });

  it('rejects invalid date format', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026/04/29' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects invalid ticker', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29', ticker: 'TSLA' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects invalid at timestamp', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29', at: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('passes the at timestamp into the SQL upper bound', async () => {
    const at = '2026-04-29T17:00:00Z';
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29', at },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json.asOf).toBe(at);
    const args = mockSql.mock.calls[0]!.slice(1);
    expect(args).toContain(at);
  });

  it('filters by ticker when provided', async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29', ticker: 'SPXW' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const args = mockSql.mock.calls[0]!.slice(1);
    // Both filter clauses bind the ticker — once for null check, once for equality.
    expect(args.filter((v: unknown) => v === 'SPXW').length).toBeGreaterThan(0);
  });

  it('returns empty array when no whales for the date', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.whales).toEqual([]);
  });

  it('returns 401-equivalent when guard rejects', async () => {
    mockGuard.mockResolvedValueOnce(true); // blocked
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-29' },
    });
    const res = mockResponse();
    await handler(req, res);
    // Guard sets its own response, so handler exits early without calling SQL.
    expect(mockSql).not.toHaveBeenCalled();
  });
});
