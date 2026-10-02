// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/postgres-day-summary.js', () => ({
  readDayOhlcFromPostgres: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../cron/fetch-day-ohlc.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { readDayOhlcFromPostgres } from '../_lib/postgres-day-summary.js';
import { Sentry, metrics } from '../_lib/sentry.js';

/** cronGuard hands the handler its ET "today" (ctx.today). */
function runOn(etToday: string) {
  vi.mocked(cronGuard).mockReturnValue({ apiKey: '', today: etToday });
}

const mockedReadOhlcPg = vi.mocked(readDayOhlcFromPostgres);

const PG_OHLC = {
  open: 5300,
  high: 5320,
  low: 5285,
  close: 5310,
  range: 35,
  up_excursion: 20,
  down_excursion: 15,
};

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function sidecarEmpty() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ rows: [] }),
  });
}

function sidecarRow(date: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      rows: [
        {
          date,
          symbol: 'ESM6',
          summary: '…',
          open: 5300,
          high: 5320,
          low: 5285,
          close: 5310,
          range: 35,
          up_excursion: 20,
          down_excursion: 15,
        },
      ],
    }),
  });
}

function targetFromSidecarUrl(): string {
  const url = String(mockFetch.mock.calls[0]?.[0] ?? '');
  return /from=([\d-]+)/.exec(url)?.[1] ?? '';
}

describe('fetch-day-ohlc handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockFetch.mockReset();
    process.env = {
      ...originalEnv,
      CRON_SECRET: 'test-secret',
      SIDECAR_URL: 'http://sidecar.local',
    };
    // Tuesday (ET) — the run labels Monday 2026-04-20.
    runOn('2026-04-21');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('bails when cronGuard rejects', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips when SIDECAR_URL is unset', async () => {
    process.env.SIDECAR_URL = '';
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'SIDECAR_URL missing',
    });
  });

  // ── Target date: prior trading day, Tue–Sat schedule ─────────────

  it.each([
    ['Tuesday run labels Monday', '2026-04-21', '2026-04-20'],
    [
      'Saturday run labels Friday (Fridays used to be skipped)',
      '2026-04-25',
      '2026-04-24',
    ],
    [
      'Tuesday after Memorial Day labels the Friday before',
      '2026-05-26',
      '2026-05-22',
    ],
    ['Saturday after Good Friday labels Thursday', '2026-04-04', '2026-04-02'],
  ])('%s', async (_label, etToday, expected) => {
    runOn(etToday);
    sidecarRow(expected);
    mockSql.mockResolvedValueOnce([{ date: expected }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(targetFromSidecarUrl()).toBe(expected);
    expect(res._json).toMatchObject({ targetDate: expected, updated: 1 });
  });

  it('warns and skips a trading day with no bars at all (feed down)', async () => {
    sidecarEmpty();
    mockedReadOhlcPg.mockResolvedValueOnce(null);

    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      reason: 'no_bars',
      targetDate: '2026-04-20',
      barCount: 0,
      expectedBars: 390,
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('fetch_day_ohlc.no_bars');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-day-ohlc: no_bars, day not labelled',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('falls through to Postgres when the sidecar row is malformed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [{ date: '2026-04-20', open: '5300', high: '5320', low: 5285 }],
      }),
    });
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 390 });
    mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-04-20');
    expect(res._json).toMatchObject({ source: 'postgres', updated: 1 });
  });

  it('fails the run when the sidecar body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockedReadOhlcPg).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('falls back to Postgres OHLC when sidecar returns no rows', async () => {
    sidecarEmpty();
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 390 });
    mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-04-20');
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-day-ohlc',
      status: 'success',
      source: 'postgres',
      updated: 1,
    });
  });

  // ── Completeness guard ────────────────────────────────────────────

  it('refuses to label a partial Postgres day and warns', async () => {
    sidecarEmpty();
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 82 });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      reason: 'incomplete_day',
      targetDate: '2026-04-20',
      barCount: 82,
      expectedBars: 390,
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_day_ohlc.incomplete_day',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'fetch-day-ohlc: incomplete_day, day not labelled',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('accepts a complete early-close half day (210 bars)', async () => {
    runOn('2026-11-28'); // Sat after Black Friday
    sidecarEmpty();
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 210 });
    mockSql.mockResolvedValueOnce([{ date: '2026-11-27' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-11-27');
    expect(res._json).toMatchObject({ status: 'success', updated: 1 });
  });

  // ── Failure modes surface (R4) ────────────────────────────────────

  it('fails the run when the Postgres OHLC read is rejected', async () => {
    sidecarEmpty();
    mockedReadOhlcPg.mockRejectedValueOnce(new Error('pg down'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('fails the run when the day_embeddings UPDATE is rejected', async () => {
    sidecarRow('2026-04-20');
    mockSql.mockRejectedValueOnce(new Error('update rejected'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('updates day_embeddings row with structured OHLC', async () => {
    sidecarRow('2026-04-20');
    // UPDATE ... RETURNING date → one row returned
    mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-day-ohlc',
      status: 'success',
      updated: 1,
    });
    const fetchUrl = String(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(fetchUrl).toContain('from=2026-04-20');
    expect(fetchUrl).toContain('to=2026-04-20');
  });

  it('reports a skip, not a success, when no day_embeddings row matched', async () => {
    sidecarRow('2026-04-20');
    mockSql.mockResolvedValueOnce([]); // no row matched

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      reason: 'no_day_embeddings_row',
      updated: 0,
    });
  });

  it('500s and reports to Sentry on sidecar HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('500s and reports to Sentry when the sidecar fetch rejects (timeout)', async () => {
    // AbortSignal.timeout(15_000) rejects the fetch with a TimeoutError.
    mockFetch.mockRejectedValueOnce(
      new DOMException('timeout', 'TimeoutError'),
    );

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockedReadOhlcPg).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // 404 means "not in the (frozen) archive" — same semantic as rows:[]
  // — fall through to Postgres rather than 500-ing the cron.
  it('falls back to Postgres OHLC when sidecar returns 404 (not in archive)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 390 });
    mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-day-ohlc',
      source: 'postgres',
      updated: 1,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
