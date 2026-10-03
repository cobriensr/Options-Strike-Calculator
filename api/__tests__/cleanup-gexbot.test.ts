// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
}));

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

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

vi.mock('../_lib/gexbot-archive-dates.js', () => ({
  GEXBOT_ARCHIVE_TABLES: ['gexbot_snapshots', 'gexbot_api_capture'] as const,
  listUnarchivedDates: vi.fn(),
}));

import { Sentry } from '../_lib/sentry.js';
import { listUnarchivedDates } from '../_lib/gexbot-archive-dates.js';
import handler from '../cron/cleanup-gexbot.js';

// Pre-market: Tuesday 12:15 UTC == 7:15am ET
const PRE_MARKET = new Date('2026-03-24T12:15:00.000Z');

type Json = {
  status: string;
  rows: number;
  results: Array<{
    table: string;
    gate: string | null;
    cutoff: string;
    deleted: number;
    stopReason: string;
  }>;
};

const authedReq = () =>
  mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });

/** Scripts the (yesterday, gate) SELECT that follows each helper call. */
const scriptDates = (yesterday: string, gate: string | null) =>
  mockSql.mockResolvedValueOnce([{ yesterday, gate }]);

/** First interpolated value of every DELETE call, i.e. the cutoff. */
const deleteCutoffs = (): unknown[] =>
  mockSql.mock.calls
    .filter(([strings]) => strings.join('').includes('DELETE FROM'))
    .map(([, cutoff]) => cutoff);

describe('cleanup-gexbot handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.mocked(listUnarchivedDates).mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(PRE_MARKET);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('with nothing pending, deletes through yesterday for each table', async () => {
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({ id: i })),
    ); // snapshots batch 1
    mockSql.mockResolvedValueOnce([]); // snapshots drain
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: i })),
    ); // captures batch 1
    mockSql.mockResolvedValueOnce([]); // captures drain

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    expect(json.rows).toBe(150);
    expect(json.results.map((r) => r.cutoff)).toEqual([
      '2026-03-23',
      '2026-03-23',
    ]);
    expect(json.results.map((r) => r.gate)).toEqual([null, null]);
    expect(listUnarchivedDates).toHaveBeenCalledWith(
      mockSql,
      'gexbot_snapshots',
      '2026-03-24',
    );
    expect(listUnarchivedDates).toHaveBeenCalledWith(
      mockSql,
      'gexbot_api_capture',
      '2026-03-24',
    );
    expect(deleteCutoffs()).toEqual([
      '2026-03-23',
      '2026-03-23',
      '2026-03-23',
      '2026-03-23',
    ]);
  });

  it('stalls the cutoff the day before the first un-archived session', async () => {
    vi.mocked(listUnarchivedDates).mockResolvedValue(['2026-09-08']);
    scriptDates('2026-10-01', '2026-09-07');
    mockSql.mockResolvedValueOnce([]); // snapshots DELETE
    scriptDates('2026-10-01', '2026-09-07');
    mockSql.mockResolvedValueOnce([]); // captures DELETE

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Json;
    expect(json.results.map((r) => r.cutoff)).toEqual([
      '2026-09-07',
      '2026-09-07',
    ]);
    expect(json.results.map((r) => r.gate)).toEqual([
      '2026-09-07',
      '2026-09-07',
    ]);
    expect(deleteCutoffs()).toEqual(['2026-09-07', '2026-09-07']);
    // The dates SELECT receives today and the first pending date.
    expect(mockSql.mock.calls[0]?.slice(1)).toEqual([
      '2026-03-24',
      '2026-09-08',
    ]);
  });

  it('never raises the cutoff above yesterday when the gate is later', async () => {
    vi.mocked(listUnarchivedDates).mockResolvedValue(['2026-03-25']);
    scriptDates('2026-03-23', '2026-03-24');
    mockSql.mockResolvedValueOnce([]);
    scriptDates('2026-03-23', '2026-03-24');
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Json;
    expect(json.results.map((r) => r.cutoff)).toEqual([
      '2026-03-23',
      '2026-03-23',
    ]);
    expect(deleteCutoffs()).toEqual(['2026-03-23', '2026-03-23']);
  });

  it('deletes nothing when every live day is pending (no audit rows)', async () => {
    // First live day 2026-03-01 pending, gate 2026-02-28, DELETE matches 0.
    vi.mocked(listUnarchivedDates).mockResolvedValue([
      '2026-03-01',
      '2026-03-02',
    ]);
    scriptDates('2026-03-23', '2026-02-28');
    mockSql.mockResolvedValueOnce([]);
    scriptDates('2026-03-23', '2026-02-28');
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json;
    expect(json.rows).toBe(0);
    for (const r of json.results) {
      expect(r).toMatchObject({
        cutoff: '2026-02-28',
        deleted: 0,
        stopReason: 'drained',
      });
    }
    expect(deleteCutoffs()).toEqual(['2026-02-28', '2026-02-28']);
  });

  it('reports stopReason: wall_budget when the budget is exhausted mid-loop', async () => {
    const realNow = Date.now;
    let nowCalls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      // startedAt, then in-budget, then 5 minutes ahead (> 295s budget).
      if (nowCalls >= 3) return realNow() + 300_000;
      return realNow();
    });

    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 50_000 }, (_, i) => ({ id: i })),
    ); // batch 1 (full)

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as Json).results[0]?.stopReason).toBe('wall_budget');
  });

  it('reports stopReason: drained when the first batch is empty', async () => {
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce([]); // snapshots empty DELETE
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce([]); // captures empty DELETE

    const res = mockResponse();
    await handler(authedReq(), res);

    const snaps = (res._json as Json).results.find(
      (r) => r.table === 'gexbot_snapshots',
    );
    expect(snaps?.stopReason).toBe('drained');
    expect(snaps?.deleted).toBe(0);
  });

  it('still processes the second table when the first gate query rejects, then fails by name', async () => {
    vi.mocked(listUnarchivedDates)
      .mockRejectedValueOnce(new Error('gate down'))
      .mockResolvedValueOnce([]);
    scriptDates('2026-03-23', null); // captures dates
    mockSql.mockResolvedValueOnce([]); // captures DELETE

    const res = mockResponse();
    await handler(authedReq(), res);

    // Never reported as success.
    expect(res._status).toBe(500);
    // The second table was still processed.
    expect(listUnarchivedDates).toHaveBeenCalledTimes(2);
    expect(deleteCutoffs()).toEqual(['2026-03-23']);
    // The failure is surfaced by table name and cause.
    const messages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([e]) => String((e as Error).message));
    expect(
      messages.some(
        (m) => m.includes('gexbot_snapshots') && m.includes('gate down'),
      ),
    ).toBe(true);
  });

  it('returns 500 when a DB call throws', async () => {
    mockSql.mockRejectedValue(new Error('db down'));
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(500);
  });
});
