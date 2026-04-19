// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/archive-sidecar.js', () => ({
  fetchDaySummary: vi.fn(),
  fetchDayFeatures: vi.fn(),
}));
vi.mock('../_lib/current-snapshot.js', () => ({
  upsertCurrentSnapshot: vi.fn(),
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import handler from '../cron/refresh-current-snapshot.js';
import { fetchDayFeatures, fetchDaySummary } from '../_lib/archive-sidecar.js';
import { upsertCurrentSnapshot } from '../_lib/current-snapshot.js';

const mockedFetchSummary = vi.mocked(fetchDaySummary);
const mockedFetchFeatures = vi.mocked(fetchDayFeatures);
const mockedUpsert = vi.mocked(upsertCurrentSnapshot);

// Wednesday 14:00 UTC = 9:00 AM CT — squarely in market hours.
const DURING_MARKET = new Date('2026-04-22T14:00:00.000Z');
const FEATURES = Array.from({ length: 60 }, () => 0.001);
const SUMMARY = '2026-04-22 ESM6 | open 5700.00 | ...';

describe('refresh-current-snapshot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    vi.setSystemTime(DURING_MARKET);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('rejects non-GET with 405', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects missing auth with 401', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('upserts snapshot when both fetches succeed', async () => {
    mockedFetchSummary.mockResolvedValueOnce(SUMMARY);
    mockedFetchFeatures.mockResolvedValueOnce(FEATURES);
    mockedUpsert.mockResolvedValueOnce(true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-04-22',
        symbol: 'ESM6',
        summary: SUMMARY,
        features: FEATURES,
      }),
    );
    expect(res._status).toBe(200);
  });

  it('returns 200 skipped when summary unavailable (sidecar down)', async () => {
    mockedFetchSummary.mockResolvedValueOnce(null);
    mockedFetchFeatures.mockResolvedValueOnce(FEATURES);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('returns 500 on upsert failure', async () => {
    mockedFetchSummary.mockResolvedValueOnce(SUMMARY);
    mockedFetchFeatures.mockResolvedValueOnce(FEATURES);
    mockedUpsert.mockResolvedValueOnce(false);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'upsert_failed' });
  });
});
