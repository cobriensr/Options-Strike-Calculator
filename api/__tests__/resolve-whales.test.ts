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

const { mockCronGuard } = vi.hoisted(() => ({ mockCronGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({ cronGuard: mockCronGuard }));

import handler from '../cron/resolve-whales.js';

const GUARD = { apiKey: '', today: '2026-04-30' };

const unresolvedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  ticker: 'SPXW',
  strike: 7150,
  whale_type: 1,
  underlying_price: 7120,
  first_ts: new Date('2026-04-29T16:56:52Z'),
  trade_date: '2026-04-29',
  ...overrides,
});

describe('resolve-whales handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
  });

  it('returns 200 with 0 resolved when nothing pending', async () => {
    mockSql.mockResolvedValueOnce([]); // unresolved SELECT

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'resolve-whales',
      unresolved: 0,
      resolved: 0,
    });
  });

  it('marks Type 1 floor as hit when low stayed above strike', async () => {
    mockSql
      .mockResolvedValueOnce([unresolvedRow({ whale_type: 1, strike: 7150 })])
      .mockResolvedValueOnce([{ hi: 7180, lo: 7155, last: 7170, n: 10 }])
      .mockResolvedValueOnce([]); // UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ resolved: 1 });
    // The UPDATE call should have included hit=true.
    const updateCall = mockSql.mock.calls[2]!;
    expect(updateCall.slice(1)).toContain(true);
  });

  it('marks Type 1 floor as miss when low broke strike', async () => {
    mockSql
      .mockResolvedValueOnce([unresolvedRow({ whale_type: 1, strike: 7150 })])
      .mockResolvedValueOnce([{ hi: 7160, lo: 7100, last: 7140, n: 10 }])
      .mockResolvedValueOnce([]); // UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ resolved: 1 });
    const updateCall = mockSql.mock.calls[2]!;
    expect(updateCall.slice(1)).toContain(false);
  });

  it('marks Type 4 ceiling break as hit when high broke through strike', async () => {
    mockSql
      .mockResolvedValueOnce([unresolvedRow({ whale_type: 4, strike: 7155 })])
      .mockResolvedValueOnce([{ hi: 7170, lo: 7140, last: 7165, n: 10 }])
      .mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ resolved: 1 });
    const updateCall = mockSql.mock.calls[2]!;
    expect(updateCall.slice(1)).toContain(true);
  });

  it('skips when no underlying-price data is available yet', async () => {
    mockSql
      .mockResolvedValueOnce([unresolvedRow()])
      .mockResolvedValueOnce([{ hi: null, lo: null, last: null, n: 0 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ resolved: 0, skipped: 1 });
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
