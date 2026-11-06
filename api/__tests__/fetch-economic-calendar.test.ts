// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The INSERT loop now uses bulkUpsert, which calls sql.query() internally.
// The data-quality SELECT still uses the tagged-template `mockSql`. We keep
// `mockSql` callable AND give it a `.query` method so both paths are covered.
const mockQuery = vi.fn().mockResolvedValue([]);
const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
  query: mockQuery,
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The cron raises its own warning through Sentry.captureMessage and metrics,
// and uwFetch / the wrapper call setTag, uwRateLimit and uwBudget.
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: { increment: vi.fn(), uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));

import logger from '../_lib/logger.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import handler from '../cron/fetch-economic-calendar.js';

// Fixed times — 2026-03-25 is a Wednesday
// 9:15 AM ET = 13:15 UTC (inside pre-market window)
const PREMARKET_TIME = new Date('2026-03-25T13:15:00.000Z');
// 11:00 AM ET = 15:00 UTC (outside pre-market window)
const MARKET_TIME = new Date('2026-03-25T15:00:00.000Z');
// Saturday 2026-03-28 at 9:15 AM ET
const WEEKEND_TIME = new Date('2026-03-28T13:15:00.000Z');

function makeCalendarEvent(overrides = {}) {
  return {
    event: 'Consumer Price Index',
    forecast: '0.3%',
    prev: '0.2%',
    reported_period: 'February',
    time: '2026-03-25T13:30:00Z',
    type: 'report',
    ...overrides,
  };
}

function stubFetch(events: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: events }),
    }),
  );
}

describe('fetch-economic-calendar handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: return a row satisfying data-quality SELECT shapes
    mockSql.mockResolvedValue([{ total: 0, has_name: 0 }]);
    mockQuery.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(PREMARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is set and header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  // ── Time window guard ─────────────────────────────────────

  it('skips when outside pre-market window', async () => {
    vi.setSystemTime(MARKET_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  it('skips on weekends', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    process.env.UW_API_KEY = 'uwkey';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  it('runs when force=true despite being outside window', async () => {
    vi.setSystemTime(MARKET_TIME);
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeCalendarEvent()]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: { force: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).not.toHaveProperty('skipped');
    expect(res._json).toHaveProperty('eventsStored');
  });

  // ── Missing API key ───────────────────────────────────────

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  // ── Happy path ────────────────────────────────────────────

  it('handles empty calendar data', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([]);
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      date: '2026-03-25',
      eventsStored: 0,
      events: [],
      invalidTimeSkipped: 0,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('stores events and categorizes types correctly', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const events = [
      makeCalendarEvent({
        event: 'Consumer Price Index',
        time: '2026-03-25T13:30:00Z',
      }),
      makeCalendarEvent({
        event: 'FOMC Meeting Minutes',
        time: '2026-03-25T19:00:00Z',
      }),
      makeCalendarEvent({
        event: 'PCE Price Index',
        time: '2026-03-25T13:30:00Z',
      }),
      makeCalendarEvent({
        event: 'Nonfarm Payrolls',
        time: '2026-03-25T13:30:00Z',
      }),
      makeCalendarEvent({
        event: 'GDP Growth Rate',
        time: '2026-03-25T13:30:00Z',
      }),
      makeCalendarEvent({
        event: 'ISM Manufacturing PMI',
        time: '2026-03-25T15:00:00Z',
      }),
      makeCalendarEvent({
        event: 'Retail Sales',
        time: '2026-03-25T13:30:00Z',
      }),
      makeCalendarEvent({
        event: 'Michigan Consumer Sentiment',
        time: '2026-03-25T15:00:00Z',
      }),
      makeCalendarEvent({
        event: 'Initial Jobless Claims',
        time: '2026-03-25T13:30:00Z',
      }),
    ];
    stubFetch(events);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ eventsStored: 9 });

    // bulkUpsert collapses all 9 inserts into a single sql.query() call.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Data-quality SELECT still uses the tagged-template form.
    expect(mockSql).toHaveBeenCalledTimes(1);

    // "FOMC Meeting Minutes" is a Fed mention, not the decision day: FED.
    const expectedTypes = [
      'CPI',
      'FED',
      'PCE',
      'JOBS',
      'GDP',
      'PMI',
      'RETAIL',
      'SENTIMENT',
      'OTHER',
    ];

    // bulkUpsert builds one INSERT...VALUES(...) with a flat params array.
    // Column order: date, event_name, event_time, event_type, forecast,
    // previous, reported_period — so event_type is the 4th param of each
    // 7-column tuple (0-indexed offset 3).
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    for (let i = 0; i < expectedTypes.length; i++) {
      const eventType = params[i * 7 + 3];
      expect(eventType).toBe(expectedTypes[i]);
    }
  });

  it('filters events to today only', async () => {
    process.env.UW_API_KEY = 'uwkey';

    const events = [
      makeCalendarEvent({ event: 'CPI', time: '2026-03-25T13:30:00Z' }),
      makeCalendarEvent({ event: 'GDP', time: '2026-03-26T13:30:00Z' }),
      makeCalendarEvent({ event: 'PMI', time: '2026-03-24T13:30:00Z' }),
    ];
    stubFetch(events);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      date: '2026-03-25',
      eventsStored: 1,
      events: ['CPI'],
    });
    // 1 bulk insert (sql.query) + 1 data-quality SELECT (tagged template).
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Events with an unparseable time ───────────────────────

  const SKIP_MESSAGE =
    'fetch-economic-calendar: events with unparseable time skipped';

  async function runCron() {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      }),
      res,
    );
    return res;
  }

  it('skips an event with an unparseable time, alerts, and reports partial', async () => {
    process.env.UW_API_KEY = 'uwkey';

    stubFetch([
      makeCalendarEvent({ event: 'CPI', time: '2026-03-25T13:30:00Z' }),
      makeCalendarEvent({ event: 'Broken Event', time: 'not-a-date' }),
      makeCalendarEvent({
        event: 'Retail Sales',
        time: '2026-03-25T13:30:00Z',
      }),
    ]);

    const res = await runCron();

    // The bad row doesn't fail the run (200, no error body), but the run is
    // not clean either: partial, with the good rows stored.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      date: '2026-03-25',
      eventsStored: 2,
      events: ['CPI', 'Retail Sales'],
      invalidTimeSkipped: 1,
    });
    expect(res._json).not.toHaveProperty('error');

    // The bad event is named in the log, and only the 2 good rows are stored
    // (event_name is the 2nd param of each 7-column tuple).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'Broken Event', time: 'not-a-date' }),
      expect.stringContaining('unparseable time'),
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params).toHaveLength(2 * 7);
    expect(params[1]).toBe('CPI');
    expect(params[8]).toBe('Retail Sales');
    expect(params).not.toContain('Broken Event');

    // One Sentry warning per run, naming the skipped event, plus a counter.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(SKIP_MESSAGE, {
      level: 'warning',
      extra: { skipped: [{ event: 'Broken Event', time: 'not-a-date' }] },
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_economic_calendar.invalid_time',
    );
  });

  it('counts an event with a null time as skipped', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // new Date(null) is the epoch, so without an explicit null check this
    // event would be dropped by the today filter without being counted.
    stubFetch([
      makeCalendarEvent({ event: 'CPI', time: '2026-03-25T13:30:00Z' }),
      makeCalendarEvent({ event: 'No Time Event', time: null }),
    ]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      eventsStored: 1,
      events: ['CPI'],
      invalidTimeSkipped: 1,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(SKIP_MESSAGE, {
      level: 'warning',
      extra: { skipped: [{ event: 'No Time Event', time: null }] },
    });
  });

  it('counts a bad event once when UW returns every row twice', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // UW's feed lists every event twice (68 rows, 34 unique).
    const cpi = makeCalendarEvent({
      event: 'CPI',
      time: '2026-03-25T13:30:00Z',
    });
    const broken = makeCalendarEvent({
      event: 'Broken Event',
      time: 'not-a-date',
    });
    stubFetch([cpi, broken, { ...cpi }, { ...broken }]);

    const res = await runCron();

    expect(res._json).toMatchObject({
      status: 'partial',
      eventsStored: 1,
      events: ['CPI'],
      invalidTimeSkipped: 1,
    });
    // One warning, one entry: not two for the duplicate row.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(SKIP_MESSAGE, {
      level: 'warning',
      extra: { skipped: [{ event: 'Broken Event', time: 'not-a-date' }] },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('stores two events with the same name at different times', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // A name alone is not an event: the table's unique key is (date, name,
    // time), and the Fed speaks more than once a day. UW also lists every
    // row twice, so each speech appears twice here and is stored once.
    const morning = makeCalendarEvent({
      event: 'Fed speech',
      time: '2026-03-25T13:30:00Z',
    });
    const afternoon = makeCalendarEvent({
      event: 'Fed speech',
      time: '2026-03-25T19:00:00Z',
    });
    stubFetch([morning, afternoon, { ...morning }, { ...afternoon }]);

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      eventsStored: 2,
      events: ['Fed speech', 'Fed speech'],
    });
    // One bulk insert; each 7-column tuple is date, name, time, type, ...
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params).toHaveLength(14);
    expect([params[2], params[9]]).toEqual([
      '2026-03-25T13:30:00Z',
      '2026-03-25T19:00:00Z',
    ]);
    expect([params[1], params[8]]).toEqual(['Fed speech', 'Fed speech']);
  });

  it('reports error and stores nothing when every event has a bad time', async () => {
    process.env.UW_API_KEY = 'uwkey';

    // Duplicated rows: 4 rows, 2 distinct events, so "all 2 events".
    const a = makeCalendarEvent({ event: 'Event A', time: 'not-a-date' });
    const b = makeCalendarEvent({ event: 'Event B', time: null });
    stubFetch([a, b, { ...a }, { ...b }]);

    const res = await runCron();

    // HTTP 200 (the wrapper's contract for a returned status), but the run
    // reads as failed and says why.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'error',
      message: expect.stringContaining('all 2 events had unparseable times'),
      eventsStored: 0,
      invalidTimeSkipped: 2,
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(SKIP_MESSAGE, {
      level: 'warning',
      extra: {
        skipped: [
          { event: 'Event A', time: 'not-a-date' },
          { event: 'Event B', time: null },
        ],
      },
    });
    expect(metrics.increment).toHaveBeenCalledWith(
      'fetch_economic_calendar.invalid_time',
    );
  });

  it('stays success and silent when every time parses', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeCalendarEvent()]);

    const res = await runCron();

    expect(res._json).toMatchObject({ status: 'success' });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(metrics.increment).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────

  it('surfaces a UW 429 as a 500 and sends the exception to Sentry', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 429'),
      }),
    );
  });

  it('surfaces a DB insert failure as a 500 and sends it to Sentry', async () => {
    process.env.UW_API_KEY = 'uwkey';
    stubFetch([makeCalendarEvent()]);
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = await runCron();

    // A failed write is never a success run.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(res._json).not.toHaveProperty('status', 'success');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection lost' }),
    );
  });

  it('fails the run when a 2xx response has no data field', async () => {
    process.env.UW_API_KEY = 'uwkey';
    // uwFetch alone would turn this into [] (plus a Sentry warning of its
    // own), which the cron would report as a clean day with no events.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: 'upstream hiccup' }),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('no data array'),
      }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    // A malformed body is not transient: it must not be retried.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('fails the run when the data field is not an array', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: null }),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('no data array'),
      }),
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('fails the run when a 2xx response body is not JSON', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
