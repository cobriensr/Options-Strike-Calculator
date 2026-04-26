// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/archive-sidecar.js', () => ({
  fetchDaySummary: vi.fn(),
}));
vi.mock('../_lib/postgres-day-summary.js', () => ({
  fetchDaySummaryFromPostgres: vi.fn(),
}));
vi.mock('../_lib/day-embeddings.js', () => ({
  DAY_EMBEDDING_DIMS: 2000,
  upsertDayEmbedding: vi.fn(),
}));
vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
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

import handler from '../cron/embed-yesterday.js';
import { fetchDaySummary } from '../_lib/archive-sidecar.js';
import { upsertDayEmbedding } from '../_lib/day-embeddings.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import { fetchDaySummaryFromPostgres } from '../_lib/postgres-day-summary.js';
import { Sentry } from '../_lib/sentry.js';

const mockedFetchSummary = vi.mocked(fetchDaySummary);
const mockedFetchSummaryPg = vi.mocked(fetchDaySummaryFromPostgres);
const mockedEmbed = vi.mocked(generateEmbedding);
const mockedUpsert = vi.mocked(upsertDayEmbedding);

// Wednesday 07:00 UTC — cron fires, yesterday was Tuesday.
const WED = new Date('2026-04-22T07:00:00.000Z');
// Monday 07:00 UTC — cron fires, yesterday was Friday (weekend skip).
const MON = new Date('2026-04-20T07:00:00.000Z');

const VALID_EMBED = Array.from({ length: 2000 }, () => 0.001);
const VALID_SUMMARY = '2026-04-21 ESM6 | open 5700.00 | ...';

describe('embed-yesterday handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    vi.setSystemTime(WED);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('rejects non-GET requests with 405', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects missing Authorization with 401', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('embeds + upserts for the prior trading day (Tue from Wed)', async () => {
    mockedFetchSummary.mockResolvedValueOnce(VALID_SUMMARY);
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockedFetchSummary).toHaveBeenCalledWith('2026-04-21');
    expect(mockedEmbed).toHaveBeenCalledWith(VALID_SUMMARY);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-04-21',
        symbol: 'ESM6',
        summary: VALID_SUMMARY,
        embedding: VALID_EMBED,
      }),
    );
    expect(res._status).toBe(200);
  });

  it('skips back to Friday when invoked on Monday', async () => {
    vi.setSystemTime(MON);
    mockedFetchSummary.mockResolvedValueOnce(VALID_SUMMARY);
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockedFetchSummary).toHaveBeenCalledWith('2026-04-17');
  });

  it('falls back to Postgres when sidecar has no summary', async () => {
    const PG_SUMMARY = '2026-04-21 SPX | open 5700.00 | ...';
    mockedFetchSummary.mockResolvedValueOnce(null);
    mockedFetchSummaryPg.mockResolvedValueOnce(PG_SUMMARY);
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockedFetchSummaryPg).toHaveBeenCalledWith('2026-04-21');
    expect(mockedEmbed).toHaveBeenCalledWith(PG_SUMMARY);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-04-21',
        symbol: 'SPX',
        summary: PG_SUMMARY,
      }),
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ source: 'postgres' });
  });

  it('returns 200 + skipped:true when both sidecar and Postgres are empty', async () => {
    mockedFetchSummary.mockResolvedValueOnce(null);
    mockedFetchSummaryPg.mockResolvedValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true, reason: 'no_summary' });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('returns 500 on embedding failure and reports to Sentry', async () => {
    mockedFetchSummary.mockResolvedValueOnce(VALID_SUMMARY);
    mockedEmbed.mockResolvedValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('returns 500 when upsert fails', async () => {
    mockedFetchSummary.mockResolvedValueOnce(VALID_SUMMARY);
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
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
