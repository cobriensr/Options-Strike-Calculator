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

// cronGuard reports a failed secret check through this module; its own
// test covers what it reports.
vi.mock('../_lib/auth-failure.js', () => ({ reportSecretMismatch: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { uwRateLimit: vi.fn() },
}));

vi.mock('../_lib/gexbot-archive-dates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/gexbot-archive-dates.js')>()),
  listUnarchivedDates: vi.fn(),
}));

import logger from '../_lib/logger.js';
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

/**
 * Scripts the (yesterday, gate_cutoff, newest_cutoff) SELECT that follows each
 * helper call. `newest` is NULL (an empty table) unless a case sets it.
 */
const scriptDates = (
  yesterday: string,
  gate: string | null,
  newest: string | null = null,
) =>
  mockSql.mockResolvedValueOnce([
    { yesterday, gate_cutoff: gate, newest_cutoff: newest },
  ]);

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
    vi.setSystemTime(new Date('2026-10-02T12:15:00.000Z'));
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
    // gate is the first un-archived day itself, not the day before.
    expect(json.results.map((r) => r.gate)).toEqual([
      '2026-09-08',
      '2026-09-08',
    ]);
    expect(deleteCutoffs()).toEqual(['2026-09-07', '2026-09-07']);
    // The dates SELECT receives today and the first pending date.
    expect(mockSql.mock.calls[0]?.slice(1)).toEqual([
      '2026-10-02',
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

  describe("the newest session's bound", () => {
    // Every case runs both tables through the same scripted row. `gate` and
    // `newest` are the SQL's gate_cutoff and newest_cutoff, already minus one
    // day; the cutoff is the lowest of yesterday, gate and newest.
    it.each([
      {
        label: 'Monday keeps Friday',
        now: '2026-11-23T12:15:00.000Z',
        yesterday: '2026-11-22',
        gate: null,
        newest: '2026-11-19',
        cutoff: '2026-11-19',
      },
      {
        label: 'Tuesday removes Friday',
        now: '2026-11-24T12:15:00.000Z',
        yesterday: '2026-11-23',
        gate: '2026-11-22',
        newest: '2026-11-22',
        cutoff: '2026-11-22',
      },
      {
        label: "an archived newest session that is yesterday's is still kept",
        now: '2026-11-21T12:15:00.000Z',
        yesterday: '2026-11-20',
        gate: null,
        newest: '2026-11-19',
        cutoff: '2026-11-19',
      },
      {
        label: 'the archive gate wins when it is lower',
        now: '2026-11-23T12:15:00.000Z',
        yesterday: '2026-11-22',
        gate: '2026-11-17',
        newest: '2026-11-19',
        cutoff: '2026-11-17',
      },
      {
        label: 'the Friday after Thanksgiving keeps Wednesday',
        now: '2026-11-27T12:15:00.000Z',
        yesterday: '2026-11-26',
        gate: null,
        newest: '2026-11-24',
        cutoff: '2026-11-24',
      },
      {
        label: 'a newest bound above yesterday never raises the cutoff',
        now: '2026-11-24T12:15:00.000Z',
        yesterday: '2026-11-23',
        gate: null,
        newest: '2026-11-30',
        cutoff: '2026-11-23',
      },
      {
        label: 'an empty table (NULL newest bound) falls back to yesterday',
        now: '2026-11-24T12:15:00.000Z',
        yesterday: '2026-11-23',
        gate: null,
        newest: null,
        cutoff: '2026-11-23',
      },
    ])('$label', async ({ now, yesterday, gate, newest, cutoff }) => {
      vi.setSystemTime(new Date(now));
      scriptDates(yesterday, gate, newest);
      mockSql.mockResolvedValueOnce([]); // snapshots DELETE
      scriptDates(yesterday, gate, newest);
      mockSql.mockResolvedValueOnce([]); // captures DELETE

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      const json = res._json as Json;
      expect(json.results.map((r) => r.cutoff)).toEqual([cutoff, cutoff]);
      expect(deleteCutoffs()).toEqual([cutoff, cutoff]);
    });

    it("reads each table's own newest row", async () => {
      scriptDates('2026-03-23', null, '2026-03-20');
      mockSql.mockResolvedValueOnce([]); // snapshots DELETE
      scriptDates('2026-03-23', null, '2026-03-20');
      mockSql.mockResolvedValueOnce([]); // captures DELETE

      await handler(authedReq(), mockResponse());

      const datesQueries = mockSql.mock.calls
        .map(([strings]) => strings.join(''))
        .filter((text) => text.includes('newest_cutoff'));
      expect(datesQueries).toHaveLength(2);
      expect(datesQueries[0]).toContain('FROM gexbot_snapshots');
      expect(datesQueries[0]).not.toContain('gexbot_api_capture');
      expect(datesQueries[1]).toContain('FROM gexbot_api_capture');
      expect(datesQueries[1]).not.toContain('gexbot_snapshots');
    });

    // R4: a bound the SQL did not return as a date must stop that table's
    // delete and surface by name. Falling back to yesterday's cutoff would
    // delete the newest session, which is the bug this bound exists to stop.
    it.each([
      { label: 'missing', row: { yesterday: '2026-03-23', gate_cutoff: null } },
      {
        label: 'not a date',
        row: {
          yesterday: '2026-03-23',
          gate_cutoff: null,
          newest_cutoff: 'garbage',
        },
      },
      {
        label: 'an empty string',
        row: { yesterday: '2026-03-23', gate_cutoff: null, newest_cutoff: '' },
      },
      {
        label: 'a Date object',
        row: {
          yesterday: '2026-03-23',
          gate_cutoff: null,
          newest_cutoff: new Date('2026-03-20T00:00:00Z'),
        },
      },
    ])(
      'deletes nothing from the table and fails it by name when the bound is $label',
      async ({ row }) => {
        mockSql.mockResolvedValueOnce([row]); // snapshots dates
        scriptDates('2026-03-23', null, '2026-03-20'); // captures dates
        mockSql.mockResolvedValueOnce([]); // captures DELETE

        const res = mockResponse();
        await handler(authedReq(), res);

        // Never reported as success.
        expect(res._status).toBe(500);
        // No DELETE for the failed table; the other table still ran.
        expect(deleteCutoffs()).toEqual(['2026-03-20']);
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            results: [
              expect.objectContaining({
                table: 'gexbot_snapshots',
                cutoff: null,
                deleted: 0,
                error: expect.stringContaining('newest_cutoff'),
              }),
              expect.objectContaining({
                table: 'gexbot_api_capture',
                cutoff: '2026-03-20',
              }),
            ],
          }),
          'cleanup-gexbot finished with failures',
        );
        const messages = vi
          .mocked(Sentry.captureException)
          .mock.calls.map(([e]) => String((e as Error).message));
        expect(
          messages.some(
            (m) =>
              m.includes('gexbot_snapshots') && m.includes('newest_cutoff'),
          ),
        ).toBe(true);
      },
    );
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
    scriptDates('2026-03-23', null);
    // Batch 1 (full) takes the clock just past the 255 s budget, measured
    // from wrapper entry, so the loop stops after it and table 2 never runs.
    mockSql.mockImplementationOnce(async () => {
      vi.setSystemTime(PRE_MARKET.getTime() + 256_000);
      return Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Json & {
      skippedTables: Array<{ table: string; reason: string }>;
    };
    expect(json.results[0]?.stopReason).toBe('wall_budget');
    expect(json.results[0]?.deleted).toBe(50_000);
    // Table 2 never ran: surfaced as skipped, run is partial, not success.
    expect(json.status).toBe('partial');
    expect(json.skippedTables).toEqual([
      { table: 'gexbot_api_capture', reason: 'wall_budget' },
    ]);
    expect(listUnarchivedDates).toHaveBeenCalledTimes(1);
    expect(deleteCutoffs()).toHaveLength(1);
  });

  it('keeps deleting while the clock is still inside the budget', async () => {
    scriptDates('2026-03-23', null);
    // Batch 1 (full) lands at 254 s: under the 255 s budget, so batch 2
    // runs and drains, and table 2 still starts.
    mockSql.mockImplementationOnce(async () => {
      vi.setSystemTime(PRE_MARKET.getTime() + 254_000);
      return Array.from({ length: 50_000 }, (_, i) => ({ id: i }));
    });
    mockSql.mockResolvedValueOnce([]); // snapshots batch 2 drains
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce([]); // captures DELETE

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Json & {
      skippedTables: Array<{ table: string; reason: string }>;
    };
    expect(json.status).toBe('success');
    expect(json.results.map((r) => r.stopReason)).toEqual([
      'drained',
      'drained',
    ]);
    expect(deleteCutoffs()).toHaveLength(3);
    expect(json.skippedTables).toEqual([]);
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

  it('reports partial progress and names the table when a DELETE fails mid-loop', async () => {
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({ id: i })),
    ); // snapshots batch 1
    mockSql.mockRejectedValueOnce(new Error('delete boom')); // batch 2
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce([]); // captures DELETE still runs

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(deleteCutoffs()).toHaveLength(3);
    const messages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([e]) => String((e as Error).message));
    expect(
      messages.some(
        (m) =>
          m.includes('gexbot_snapshots') &&
          m.includes('delete boom') &&
          m.includes('deleted 10'),
      ),
    ).toBe(true);
  });

  it('still reports the stalled gate when the dates SELECT rejects', async () => {
    vi.mocked(listUnarchivedDates).mockResolvedValue(['2026-03-20']);
    mockSql.mockRejectedValueOnce(new Error('dates down')); // snapshots dates
    scriptDates('2026-03-23', '2026-03-19'); // captures dates
    mockSql.mockResolvedValueOnce([]); // captures DELETE

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [
          expect.objectContaining({
            table: 'gexbot_snapshots',
            gate: '2026-03-20',
            cutoff: null,
            error: 'dates down',
          }),
          expect.objectContaining({
            table: 'gexbot_api_capture',
            gate: '2026-03-20',
            cutoff: '2026-03-19',
          }),
        ],
      }),
      'cleanup-gexbot finished with failures',
    );
    expect(deleteCutoffs()).toEqual(['2026-03-19']);
  });

  it('fails with a named error when the dates row is missing', async () => {
    mockSql.mockResolvedValueOnce([]); // snapshots dates SELECT: no row
    scriptDates('2026-03-23', null);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    const messages = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([e]) => String((e as Error).message));
    expect(
      messages.some(
        (m) => m.includes('gexbot_snapshots') && m.includes('no date row'),
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
