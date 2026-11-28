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
import { reportCronRun } from '../_lib/axiom.js';

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

function makeCronReq(query: Record<string, unknown> = {}) {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
    query: query as never,
  });
}

/** A complete regular session of SPX bars, ready for the cron to label. */
function fullDay() {
  mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 390 });
}

describe('fetch-day-ohlc handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockFetch.mockReset();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    // Tuesday (ET) — the run labels Monday 2026-04-20.
    runOn('2026-04-21');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('bails when cronGuard rejects, ?date= or not', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    // A valid past date: were it acted on before the guard, the read below
    // would be called with it.
    await handler(makeCronReq({ date: '2026-04-14' }), res);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedReadOhlcPg).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
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
    fullDay();
    mockSql.mockResolvedValueOnce([{ date: expected }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith(expected);
    expect(res._json).toMatchObject({ targetDate: expected, updated: 1 });
  });

  // ── ?date= override: rebuild a given past day ─────────────────────
  // A day the nightly run labelled from placeholder bars, since repaired:
  // nothing else ever targets it again.

  describe('?date= override', () => {
    const OVERRIDE = '2026-04-14'; // a Tuesday; the run is on 2026-04-21

    it('targets the given date: the Postgres read and the UPDATE get it', async () => {
      fullDay();
      mockSql.mockResolvedValueOnce([{ date: OVERRIDE }]);

      const res = mockResponse();
      await handler(makeCronReq({ date: OVERRIDE }), res);

      expect(mockedReadOhlcPg).toHaveBeenCalledOnce();
      expect(mockedReadOhlcPg).toHaveBeenCalledWith(OVERRIDE);
      expect(mockSql).toHaveBeenCalledOnce();
      expect(mockSql.mock.calls[0]?.slice(1)).toEqual([
        5300,
        5320,
        5285,
        5310,
        35,
        20,
        15,
        OVERRIDE,
      ]);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        job: 'fetch-day-ohlc',
        status: 'success',
        targetDate: OVERRIDE,
        source: 'postgres',
        updated: 1,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps the prior trading day when no date is given, whatever else is in the query', async () => {
      fullDay();
      mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

      const res = mockResponse();
      await handler(makeCronReq({ force: '1' }), res);

      expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-04-20');
      expect(res._json).toMatchObject({
        status: 'success',
        targetDate: '2026-04-20',
      });
    });

    // A day is labelled once it is over, the same as the nightly run:
    // today (ET) and anything later are refused, and so is a malformed date.
    const BAD_FORMAT =
      'fetch-day-ohlc: invalid date param (expected YYYY-MM-DD)';
    it.each([
      ['a non-padded date', '2026-4-14', BAD_FORMAT],
      ['an impossible calendar date', '2026-02-30', BAD_FORMAT],
      ['garbage', 'yesterday', BAD_FORMAT],
      ['a timestamp', '2026-04-14T00:00:00Z', BAD_FORMAT],
      ['an empty string', '', BAD_FORMAT],
      ['a repeated param', ['2026-04-14', '2026-04-13'], BAD_FORMAT],
      ['an array holding one date', ['2026-04-14'], BAD_FORMAT],
      [
        'today',
        '2026-04-21',
        'fetch-day-ohlc: date 2026-04-21 is not before today (2026-04-21)',
      ],
      [
        'a future date',
        '2026-04-22',
        'fetch-day-ohlc: date 2026-04-22 is not before today (2026-04-21)',
      ],
    ])(
      'rejects %s with 500 and names the cause, before any source is read',
      async (_label, date, message) => {
        const res = mockResponse();
        await handler(makeCronReq({ date }), res);

        expect(res._status).toBe(500);
        expect(res._json).toEqual({ error: message });
        expect(Sentry.captureException).toHaveBeenCalledOnce();
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'InvalidDateParamError' }),
        );
        expect(reportCronRun).toHaveBeenCalledWith(
          'fetch-day-ohlc',
          expect.objectContaining({ status: 'error' }),
        );
        expect(mockedReadOhlcPg).not.toHaveBeenCalled();
        expect(mockSql).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a market holiday (Good Friday)', '2026-04-03'],
      ['a weekend day', '2026-04-18'],
    ])(
      'skips %s as not_trading_day without a feed-failure warning',
      async (_label, date) => {
        const res = mockResponse();
        await handler(makeCronReq({ date }), res);

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'skipped',
          skipped: true,
          reason: 'not_trading_day',
          targetDate: date,
        });
        expect(mockedReadOhlcPg).not.toHaveBeenCalled();
        expect(mockSql).not.toHaveBeenCalled();
        // A day with no session is not a feed outage.
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
        expect(metrics.increment).toHaveBeenCalledWith(
          'fetch_day_ohlc.not_trading_day',
        );
      },
    );

    it('still skips a partial day as incomplete_day: no forcing past the guard', async () => {
      mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 169 });

      const res = mockResponse();
      await handler(makeCronReq({ date: OVERRIDE }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'skipped',
        reason: 'incomplete_day',
        targetDate: OVERRIDE,
        barCount: 169,
        expectedBars: 390,
      });
      expect(mockSql).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'fetch-day-ohlc: incomplete_day, day not labelled',
        expect.objectContaining({ level: 'warning' }),
      );
    });

    it('reports a skip when the given date has no day_embeddings row', async () => {
      fullDay();
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(makeCronReq({ date: OVERRIDE }), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'skipped',
        reason: 'no_day_embeddings_row',
        targetDate: OVERRIDE,
        updated: 0,
      });
    });

    it('fails the run when the Postgres read of the given date is rejected', async () => {
      mockedReadOhlcPg.mockRejectedValueOnce(new Error('pg down'));

      const res = mockResponse();
      await handler(makeCronReq({ date: OVERRIDE }), res);

      // Not an InvalidDateParamError: the target was valid, so the body is
      // the generic one, not a date message.
      expect(res._status).toBe(500);
      expect(res._json).toEqual({
        job: 'fetch-day-ohlc',
        error: 'Internal error',
      });
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'pg down' }),
      );
    });
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
      mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

      const res = mockResponse();
      await handler(makeCronReq(), res);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        job: 'fetch-day-ohlc',
        status: 'success',
        source: 'postgres',
        updated: 1,
      });
    },
  );

  it('updates the day_embeddings row with the Postgres OHLC', async () => {
    fullDay();
    // UPDATE ... RETURNING date → one row returned
    mockSql.mockResolvedValueOnce([{ date: '2026-04-20' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-04-20');
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-day-ohlc',
      status: 'success',
      targetDate: '2026-04-20',
      updated: 1,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Tagged template: args are (strings, ...values) in column order.
    expect(mockSql.mock.calls[0]?.slice(1)).toEqual([
      5300,
      5320,
      5285,
      5310,
      35,
      20,
      15,
      '2026-04-20',
    ]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('accepts a complete early-close half day (210 bars)', async () => {
    runOn('2026-11-28'); // Sat after Black Friday
    mockedReadOhlcPg.mockResolvedValueOnce({ ohlc: PG_OHLC, barCount: 210 });
    mockSql.mockResolvedValueOnce([{ date: '2026-11-27' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(mockedReadOhlcPg).toHaveBeenCalledWith('2026-11-27');
    expect(res._json).toMatchObject({ status: 'success', updated: 1 });
  });

  it('reports a skip, not a success, when no day_embeddings row matched', async () => {
    fullDay();
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

  // ── Feed failures skip loudly ─────────────────────────────────────

  it('warns and skips a trading day with no bars at all (feed down)', async () => {
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

  it('refuses to label a partial day and warns', async () => {
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

  // ── Failure modes surface (R4) ────────────────────────────────────

  it('fails the run when the Postgres OHLC read is rejected', async () => {
    mockedReadOhlcPg.mockRejectedValueOnce(new Error('pg down'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).not.toMatchObject({ status: 'success' });
    // Any failure but a rejected ?date= keeps the wrapper's own body.
    expect(res._json).toEqual({
      job: 'fetch-day-ohlc',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pg down' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-day-ohlc',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails the run when the day_embeddings UPDATE is rejected', async () => {
    fullDay();
    mockSql.mockRejectedValueOnce(new Error('update rejected'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).not.toMatchObject({ status: 'success' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'update rejected' }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'fetch-day-ohlc',
      expect.objectContaining({ status: 'error' }),
    );
  });
});
