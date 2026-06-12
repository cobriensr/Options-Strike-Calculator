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

    const expectedTypes = [
      'CPI',
      'FOMC',
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

  // ── Error handling ────────────────────────────────────────

  it('handles fetch failure gracefully', async () => {
    process.env.UW_API_KEY = 'uwkey';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      error: 'Internal error',
    });
  });
});
