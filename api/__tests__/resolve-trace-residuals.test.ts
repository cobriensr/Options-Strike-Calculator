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
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/resolve-trace-residuals.js';

const GUARD = { apiKey: '', today: '2026-04-30' };

describe('resolve-trace-residuals handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
  });

  it('returns 0 buckets when there are no resolved rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'resolve-trace-residuals',
      rows: 0,
      buckets: 0,
    });
  });

  it('groups rows by (regime, ttc_bucket) and UPSERTs each bucket', async () => {
    const baseRow = {
      regime: 'trending_negative_gamma',
      predicted_close: 7125,
    };
    mockSql.mockResolvedValueOnce([
      // Three rows in 0-15min bucket — actuals all > predicted (residual ~+12).
      {
        ...baseRow,
        captured_at: new Date('2026-04-29T20:55:00Z'), // 5 min to close
        actual_close: 7137,
      },
      {
        ...baseRow,
        captured_at: new Date('2026-04-29T20:50:00Z'), // 10 min to close
        actual_close: 7135,
      },
      {
        ...baseRow,
        captured_at: new Date('2026-04-29T20:45:00Z'), // 15 min to close
        actual_close: 7140,
      },
    ]);
    // Three INSERTs would fire — we don't strictly need to count them,
    // just verify the response.
    mockSql.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'resolve-trace-residuals',
      rows: 3,
      buckets: 1, // all three rows fall into the 0-15min bucket
    });

    // Verify the UPSERT carried the right values. The 2nd SQL call after
    // the SELECT is the first INSERT.
    const insertCall = mockSql.mock.calls[1];
    expect(insertCall).toBeDefined();
    const args = insertCall!.slice(1);
    // Must include the regime and the bucket label.
    expect(args).toContain('trending_negative_gamma');
    expect(args).toContain('0-15min');
    // Sample count of 3.
    expect(args).toContain(3);
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

  it('routes rows of different regimes to different bucket UPSERTs', async () => {
    mockSql.mockResolvedValueOnce([
      // 3 rows in trending_negative_gamma + 0-15min
      {
        regime: 'trending_negative_gamma',
        predicted_close: 7125,
        captured_at: new Date('2026-04-29T20:50:00Z'),
        actual_close: 7137,
      },
      {
        regime: 'trending_negative_gamma',
        predicted_close: 7120,
        captured_at: new Date('2026-04-29T20:45:00Z'),
        actual_close: 7137,
      },
      {
        regime: 'trending_negative_gamma',
        predicted_close: 7100,
        captured_at: new Date('2026-04-29T20:55:00Z'),
        actual_close: 7137,
      },
      // 3 rows in range_bound_positive_gamma + 0-15min — different regime,
      // different bucket key.
      {
        regime: 'range_bound_positive_gamma',
        predicted_close: 7175,
        captured_at: new Date('2026-04-27T20:55:00Z'),
        actual_close: 7174,
      },
      {
        regime: 'range_bound_positive_gamma',
        predicted_close: 7175,
        captured_at: new Date('2026-04-27T20:50:00Z'),
        actual_close: 7174,
      },
      {
        regime: 'range_bound_positive_gamma',
        predicted_close: 7175,
        captured_at: new Date('2026-04-27T20:45:00Z'),
        actual_close: 7174,
      },
    ]);
    mockSql.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      rows: 6,
      buckets: 2,
    });
  });
});
