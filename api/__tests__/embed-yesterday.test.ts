// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/postgres-day-summary.js', () => ({
  fetchDaySummaryFromPostgres: vi.fn(),
  fetchVixCloseFromPostgres: vi.fn(),
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

// cronGuard reports a failed secret check through this module; its own
// test covers what it reports.
vi.mock('../_lib/auth-failure.js', () => ({ reportSecretMismatch: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: vi.fn() },
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../cron/embed-yesterday.js';
import { upsertDayEmbedding } from '../_lib/day-embeddings.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchDaySummaryFromPostgres,
  fetchVixCloseFromPostgres,
} from '../_lib/postgres-day-summary.js';
import { Sentry, metrics } from '../_lib/sentry.js';

const mockedFetchSummaryPg = vi.mocked(fetchDaySummaryFromPostgres);
const mockedFetchVix = vi.mocked(fetchVixCloseFromPostgres);
const mockedEmbed = vi.mocked(generateEmbedding);
const mockedUpsert = vi.mocked(upsertDayEmbedding);

// Wednesday 07:00 UTC — cron fires, yesterday was Tuesday.
const WED = new Date('2026-04-22T07:00:00.000Z');
// Monday 07:00 UTC — cron fires, yesterday was Friday (weekend skip).
const MON = new Date('2026-04-20T07:00:00.000Z');
// Tuesday after Memorial Day (2026-05-25, NYSE closed).
const TUE_AFTER_HOLIDAY = new Date('2026-05-26T07:00:00.000Z');
// Saturday after Black Friday (2026-11-27, 13:00 ET early close).
const SAT_AFTER_HALF_DAY = new Date('2026-11-28T07:00:00.000Z');

const VALID_EMBED = Array.from({ length: 2000 }, () => 0.001);
const PG_SUMMARY = '2026-04-21 SPX | open 5700.00 | ...';

function cronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/** A complete regular session of SPX bars, ready to embed. */
function fullDay() {
  mockedFetchSummaryPg.mockResolvedValueOnce({
    summary: PG_SUMMARY,
    barCount: 390,
  });
}

describe('embed-yesterday handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    vi.setSystemTime(WED);
    mockedFetchVix.mockResolvedValue(null);
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

  it('embeds + upserts the Postgres summary for the prior trading day (Tue from Wed)', async () => {
    fullDay();
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedFetchSummaryPg).toHaveBeenCalledWith('2026-04-21');
    expect(mockedEmbed).toHaveBeenCalledWith(PG_SUMMARY);
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-04-21',
        symbol: 'SPX',
        summary: PG_SUMMARY,
        embedding: VALID_EMBED,
      }),
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', source: 'postgres' });
    expect(metrics.increment).toHaveBeenCalledWith('embed_yesterday.success');
    // Postgres is the only source now, so there is no fallback to count.
    expect(metrics.increment).not.toHaveBeenCalledWith(
      'embed_yesterday.postgres_fallback',
    );
  });

  it('defaults the symbol to SPX when the summary has no second token', async () => {
    // Postgres builds every summary as "YYYY-MM-DD SPX | ...". If that
    // format ever changes, the row must still be labelled SPX, not ES.
    mockedFetchSummaryPg.mockResolvedValueOnce({
      summary: 'malformed',
      barCount: 390,
    });
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'malformed', symbol: 'SPX' }),
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', symbol: 'SPX' });
  });

  it('skips back to Friday when invoked on Monday', async () => {
    vi.setSystemTime(MON);
    fullDay();
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedFetchSummaryPg).toHaveBeenCalledWith('2026-04-17');
  });

  // ── Postgres is the only source ───────────────────────────────────

  it.each([
    ['both set', 'http://sidecar.local', 's3cret'],
    ['both unset', undefined, undefined],
  ] as const)(
    'never calls fetch, whatever the sidecar env holds (%s)',
    async (_label, url, secret) => {
      // The runner's own shell may export either variable, so unset them
      // here rather than assume the copy made in beforeEach lacks them.
      if (url === undefined) delete process.env.SIDECAR_URL;
      else process.env.SIDECAR_URL = url;
      if (secret === undefined) delete process.env.SIDECAR_TAKEIT_SECRET;
      else process.env.SIDECAR_TAKEIT_SECRET = secret;
      // Keeps the row's label true.
      expect(process.env.SIDECAR_URL).toBe(url);
      expect(process.env.SIDECAR_TAKEIT_SECRET).toBe(secret);
      fullDay();
      mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
      mockedUpsert.mockResolvedValueOnce(true);

      const res = mockResponse();
      await handler(cronReq(), res);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        job: 'embed-yesterday',
        status: 'success',
        source: 'postgres',
      });
    },
  );

  it('warns and skips a trading day with no bars in Postgres', async () => {
    mockedFetchSummaryPg.mockResolvedValueOnce(null);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'no_summary',
      barCount: 0,
      expectedBars: 390,
    });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
    // A trading day with no bars is a feed outage (the 07-23 → 09-07 SPX
    // hole) — surfaced, not an info-level skip.
    expect(metrics.increment).toHaveBeenCalledWith(
      'embed_yesterday.no_summary',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'embed-yesterday: no_summary, day not embedded',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  // ── Completeness guard ────────────────────────────────────────────

  it('never writes a partial day: skips it and raises a Sentry warning', async () => {
    // 2026-09-21 shape: the SPX feed died after 169 of 390 bars.
    mockedFetchSummaryPg.mockResolvedValueOnce({
      summary: PG_SUMMARY,
      barCount: 169,
    });

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      skipped: true,
      reason: 'incomplete_day',
      date: '2026-04-21',
      barCount: 169,
      expectedBars: 390,
    });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith(
      'embed_yesterday.incomplete_day',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'embed-yesterday: incomplete_day, day not embedded',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('holds an early-close half day to 210 bars, not 390', async () => {
    vi.setSystemTime(SAT_AFTER_HALF_DAY);
    mockedFetchSummaryPg.mockResolvedValueOnce({
      summary: '2026-11-27 SPX | open 7000.00 | ...',
      barCount: 210,
    });
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedFetchSummaryPg).toHaveBeenCalledWith('2026-11-27');
    expect(mockedUpsert).toHaveBeenCalledOnce();
    expect(res._json).toMatchObject({ status: 'success', date: '2026-11-27' });
  });

  it('skips a half day that is one bar short', async () => {
    vi.setSystemTime(SAT_AFTER_HALF_DAY);
    mockedFetchSummaryPg.mockResolvedValueOnce({
      summary: '2026-11-27 SPX | open 7000.00 | ...',
      barCount: 209,
    });

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._json).toMatchObject({
      reason: 'incomplete_day',
      expectedBars: 210,
    });
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('skips a market holiday before reading Postgres', async () => {
    vi.setSystemTime(TUE_AFTER_HOLIDAY);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'not_trading_day',
      date: '2026-05-25',
    });
    expect(mockedFetchSummaryPg).not.toHaveBeenCalled();
    expect(mockedEmbed).not.toHaveBeenCalled();
    // A holiday is expected, not a feed failure.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── Failure modes surface (R4) ────────────────────────────────────

  it('fails the run when the Postgres summary read is rejected', async () => {
    mockedFetchSummaryPg.mockRejectedValueOnce(new Error('pg down'));

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ date: '2026-04-21', error: 'pg down' });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('fails the run when the VIX read is rejected, before embedding', async () => {
    fullDay();
    mockedFetchVix.mockRejectedValueOnce(new Error('outcomes read failed'));

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('returns 500 on embedding failure and reports to Sentry', async () => {
    fullDay();
    mockedEmbed.mockResolvedValueOnce(null);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(500);
    // Post-wrapper adoption (Phase 3a Wave 3): the embed-failure path
    // throws an `EmbedYesterdayError` sentinel that the cron-
    // instrumentation wrapper routes through Sentry.captureException.
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 when upsert fails', async () => {
    fullDay();
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(false);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'upsert_failed' });
  });

  // ── VIX regime tag ────────────────────────────────────────────────

  it('tags the row with the VIX bucket of the day’s close', async () => {
    fullDay();
    mockedFetchVix.mockResolvedValueOnce(23.1);
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedFetchVix).toHaveBeenCalledWith('2026-04-21');
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-04-21', vixBucket: 'elevated' }),
    );
    expect(res._json).toMatchObject({ vixBucket: 'elevated' });
  });

  it('writes a null bucket when the day has no VIX close yet', async () => {
    fullDay();
    mockedEmbed.mockResolvedValueOnce(VALID_EMBED);
    mockedUpsert.mockResolvedValueOnce(true);

    const res = mockResponse();
    await handler(cronReq(), res);

    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ vixBucket: null }),
    );
    expect(res._status).toBe(200);
  });
});
