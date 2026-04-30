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

import handler from '../trace-live-calibration.js';

describe('trace-live-calibration endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
  });

  it('returns rows + scatter as JSON', async () => {
    mockSql
      .mockResolvedValueOnce([
        {
          regime: 'trending_negative_gamma',
          ttc_bucket: '0-15min',
          n: 12,
          residual_mean: 11.2,
          residual_median: 12.5,
          residual_p25: 5,
          residual_p75: 20,
          updated_at: '2026-04-30T02:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 88,
          captured_at: '2026-04-29T19:52:45Z',
          regime: 'trending_negative_gamma',
          predicted: 7125,
          actual: 7137.56,
        },
      ]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { rows: unknown[]; scatter: unknown[] };
    expect(body.rows).toHaveLength(1);
    expect(body.scatter).toHaveLength(1);
    expect((body.scatter[0] as { residual: number }).residual).toBeCloseTo(
      12.56,
      2,
    );
  });

  it('returns empty arrays when there is no data yet', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rows: [], scatter: [] });
  });

  it('exits early when guard rejects', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
