// @vitest-environment node

/**
 * reconcile-zero-dte-greek-flow re-reads the closed SPX 0DTE greek flow session
 * once after the close and upserts it, so a value UW restated after the live
 * cron's last run (16:08 ET) lands in flow_data. It shares its fetch, parse and
 * store path with fetch-greek-flow (api/_lib/spx-greek-flow.ts), so the rules
 * themselves are tested there and in closed-buckets.test.ts; this file covers
 * what is the reconcile's own: the gate, the pinned date, the whole-session
 * re-send, its counts, an empty session as a failed run, and each failure
 * surfaced by name (R4).
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (P0.2, F4).
 *
 * 2026-03-24 is on EDT (UTC-4): 16:00 ET is 20:00Z, and 22:05Z is 18:05 ET.
 * 2026-11-27 is a half day on EST (UTC-5): 13:00 ET is 18:00Z.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

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
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/reconcile-zero-dte-greek-flow.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  OUTCOME_ROWS,
  at,
  bucketValues,
  makeGreekFlowTick,
  stubFetch,
  tickGrid,
  uwFetchCalls,
  withMinute,
  type Outcome,
} from './spx-greek-flow-fixtures';

// Tuesday 22:05Z, 18:05 ET: the reconcile's tick, after the close.
const RECONCILE_TIME = new Date('2026-03-24T22:05:00.000Z');
// Saturday, and Thanksgiving (a Thursday market holiday): no session to read.
const WEEKEND_TIME = new Date('2026-03-28T22:05:00.000Z');
const HOLIDAY_TIME = new Date('2026-11-26T22:05:00.000Z');

/** A finished session as UW answers it: 405 minutes, 09:30 to 16:14 ET. */
const fullSession = () => tickGrid('2026-03-24', at('20:15'));

/**
 * Replace the batch transaction with a recorder: each upsert's bound values
 * (date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp) and SQL
 * text are pushed to the returned arrays, and each is answered with
 * `outcome(values, index)` (default: a new row).
 */
function recordInserts(
  outcome: (values: unknown[], index: number) => Outcome = () => 'inserted',
) {
  const inserts: unknown[][] = [];
  const texts: string[] = [];
  mockTransaction.mockImplementation(
    async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
      const bound: unknown[][] = [];
      const queries = fn((strings: unknown, ...values: unknown[]) => {
        texts.push((strings as string[]).join('?'));
        bound.push(values);
        return {};
      });
      inserts.push(...bound);
      return queries.map((_q, i) => OUTCOME_ROWS[outcome(bound[i]!, i)]);
    },
  );
  return { inserts, texts };
}

async function runCron() {
  const req = mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
  const res = mockResponse();
  await handler(req, res);
  return res;
}

describe('reconcile-zero-dte-greek-flow handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // The data-quality COUNT always answers one row.
    mockSql.mockResolvedValue([{ total: 78, nonzero: 78 }]);
    mockSql.transaction = mockTransaction;
    recordInserts();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    process.env.UW_API_KEY = 'uwkey';
    vi.setSystemTime(RECONCILE_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Guards ────────────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  it.each([
    ['no authorization header', {}],
    ['a wrong secret', { authorization: 'Bearer wrongsecret' }],
  ])('returns 401 with %s', async (_label, headers) => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers }), res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 500 when UW_API_KEY is not set', async () => {
    delete process.env.UW_API_KEY;
    const res = await runCron();
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'UW_API_KEY not configured' });
  });

  it.each([
    ['a weekend', WEEKEND_TIME],
    ['a market holiday (Thanksgiving)', HOLIDAY_TIME],
  ])('skips on %s without reading a session', async (_label, when) => {
    vi.setSystemTime(when);
    stubFetch(fullSession());

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(uwFetchCalls()).toHaveLength(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ── The fetch ─────────────────────────────────────────────

  it('asks UW for the finished session: SPX greek flow with today as the expiry and ?date=today', async () => {
    stubFetch(fullSession());

    await runCron();

    expect(uwFetchCalls()).toHaveLength(1);
    const url = String(uwFetchCalls()[0]![0]);
    expect(url).toContain('/stock/SPX/greek-flow/2026-03-24?date=2026-03-24');
  });

  // ── Re-sending the whole session ──────────────────────────

  it('re-sends every closed bucket of the session under its END time and reports inserted, updated and unchanged', async () => {
    const { inserts } = recordInserts((_values, i) => {
      if (i === 0) return 'inserted';
      if (i === 1) return 'updated';
      return 'unchanged';
    });
    stubFetch(fullSession());

    const res = await runCron();

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'reconcile-zero-dte-greek-flow',
      status: 'success',
      date: '2026-03-24',
      ticks: 405,
      stored: 2,
      inserted: 1,
      updated: 1,
      skipped: 76,
      pending: 0,
      stuck: 0,
    });
    // 78 buckets, one transaction; the ticks after the 16:00 close are not one.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(78);
    expect(inserts[0]).toEqual(bucketValues(0));
    expect(inserts.at(-1)).toEqual(bucketValues(77));
    expect(inserts.at(-1)?.[1]).toBe('2026-03-24T20:00:00.000Z');
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({
        status: 'success',
        inserted: 1,
        updated: 1,
        skipped: 76,
      }),
    );
  });

  it('a value UW restated after the live runs updates the row, wings included', async () => {
    // UW's current figures for the 09:30-09:35 bucket's last minute (13:34Z)
    // differ from what the live cron stored: the upsert sends them and the
    // database reports the row as updated.
    const restated = withMinute(fullSession(), '13:34', {
      total_delta_flow: '-14505',
      dir_delta_flow: '-9000',
      otm_total_delta_flow: '-7000',
      otm_dir_delta_flow: '-6500',
    });
    const { inserts, texts } = recordInserts((_v, i) =>
      i === 0 ? 'updated' : 'unchanged',
    );
    stubFetch(restated);

    const res = await runCron();

    expect(res._json).toMatchObject({ stored: 1, updated: 1, inserted: 0 });
    expect(inserts[0]).toEqual([
      '2026-03-24',
      '2026-03-24T13:35:00.000Z',
      'zero_dte_greek_flow',
      -14505,
      -9000,
      54,
      -7000,
      -6500,
    ]);
    expect(texts[0]).toContain(
      'ON CONFLICT (date, timestamp, source) DO UPDATE',
    );
    expect(texts[0]).toContain('IS DISTINCT FROM');
    expect(texts[0]).toContain('otm_ncp = EXCLUDED.otm_ncp');
    expect(texts[0]).not.toContain('DO NOTHING');
    // A row was written, so the session was counted once.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("leaves rows that already hold UW's final values untouched and does not count the session", async () => {
    recordInserts(() => 'unchanged');
    stubFetch(fullSession());

    const res = await runCron();

    expect(res._json).toMatchObject({
      status: 'success',
      stored: 0,
      inserted: 0,
      updated: 0,
      skipped: 78,
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('stops the session at 13:00 ET on an early-close day', async () => {
    // 2026-11-27 (EST): 13:00 ET is 18:00Z. The reconcile tick is 22:05Z.
    vi.setSystemTime(at('22:05', '2026-11-27'));
    const { inserts } = recordInserts();
    stubFetch(
      tickGrid('2026-11-27', at('18:15', '2026-11-27'), {
        openZ: '14:30',
        minutes: 225,
      }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({ status: 'success', stored: 42 });
    expect(inserts.at(-1)).toEqual(bucketValues(41, '2026-11-27', '14:30'));
    expect(inserts.at(-1)?.[1]).toBe('2026-11-27T18:00:00.000Z');
  });

  // ── What it cannot settle is reported, not lost in silence ─

  it('reports a final bucket whose last minute never arrived as stuck: the session is over', async () => {
    const { inserts } = recordInserts();
    stubFetch(
      withMinute(fullSession(), '19:59', { otm_total_delta_flow: null }),
    );

    const res = await runCron();

    expect(res._json).toMatchObject({
      status: 'success',
      stored: 77,
      stuck: 1,
      pending: 0,
    });
    expect(inserts.map((v) => v[1])).not.toContain('2026-03-24T20:00:00.000Z');
    expect(metrics.increment).toHaveBeenCalledWith(
      'reconcile_zero_dte_greek_flow.invalid_candle',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('stuck'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          cron: 'reconcile-zero-dte-greek-flow',
          stage: 'stuck_bucket',
        }),
        extra: expect.objectContaining({
          oldest: '2026-03-24T20:00:00.000Z',
        }),
      }),
    );
  });

  it('reports an all-zero session as a failed run: a Sentry error, status error, nothing written', async () => {
    stubFetch(
      fullSession().map((tick) => ({
        ...tick,
        total_delta_flow: '0',
        dir_delta_flow: '0',
      })),
    );

    const res = await runCron();

    // At 22:05 UTC this is the day's last attempt, so the reconcile did not
    // happen: `error`, not the live cron's `success` (its next tick retries).
    expect(res._json).toMatchObject({
      status: 'error',
      message: 'Rejected an all-zero/unusable greek flow snapshot',
      stored: 0,
      rejected: true,
    });
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'error', rejected: true }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'success' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          cron: 'reconcile-zero-dte-greek-flow',
          stage: 'degenerate_snapshot',
        }),
      }),
    );
  });

  // ── An empty session after the close is a failed run ──────

  it.each([
    ['an empty payload', []],
    [
      "a payload of yesterday's session",
      tickGrid('2026-03-23', at('20:15', '2026-03-23')),
    ],
  ])(
    'reports %s as a failed run, not a skip: status error, a Sentry error, nothing stored',
    async (_label, payload) => {
      stubFetch(payload);

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        message: "No rows for today's session in the UW payload",
        reason: 'no_rows_today',
        stored: 0,
      });
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(reportCronRun).toHaveBeenCalledWith(
        'reconcile-zero-dte-greek-flow',
        expect.objectContaining({ status: 'error' }),
      );
      expect(reportCronRun).not.toHaveBeenCalledWith(
        'reconcile-zero-dte-greek-flow',
        expect.objectContaining({ status: 'success' }),
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no rows for today'),
        expect.objectContaining({
          level: 'error',
          tags: expect.objectContaining({
            cron: 'reconcile-zero-dte-greek-flow',
            stage: 'feed_stalled',
          }),
        }),
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        'reconcile_zero_dte_greek_flow.no_rows_today',
      );
    },
  );

  // ── Failures are surfaced by name, never as success (R4) ──

  it('returns 500 and reports error when UW answers non-ok', async () => {
    // The mocked 500 is retried by withRetry (1 s + 2 s backoff). Fake
    // setTimeout so the retries don't burn wall time; Date is faked too so
    // the clock stays pinned.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(RECONCILE_TIME);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }),
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    const run = handler(req, res);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'reconcile-zero-dte-greek-flow',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('UW API 500'),
      }),
    );
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 500 and captures the error when fetch throws', async () => {
    const networkError = new Error('Network error');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(networkError);
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'error', message: 'Network error' }),
    );
  });

  it('returns 500 and captures once when a 2xx response does not parse as JSON', async () => {
    const parseError = new SyntaxError('Unexpected token <');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(parseError),
      }),
    );

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'reconcile-zero-dte-greek-flow',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(parseError);
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an object instead of a list', { not: 'a list' }],
    ['null', null],
  ])(
    'returns 500 and names the malformed payload when `data` is %s',
    async (_label, data) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }),
      );

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(
            /reconcile-zero-dte-greek-flow: .*is not a list/,
          ),
        }),
      );
      expect(reportCronRun).toHaveBeenCalledWith(
        'reconcile-zero-dte-greek-flow',
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockTransaction).not.toHaveBeenCalled();
    },
  );

  it('a rejected upsert fails the run and is captured by name, never reported as success', async () => {
    const dbError = new Error('DB batch insert failed');
    mockTransaction.mockRejectedValue(dbError);
    stubFetch(fullSession());

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'reconcile-zero-dte-greek-flow',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).toHaveBeenCalledTimes(1);
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({
        status: 'error',
        message: 'DB batch insert failed',
      }),
    );
    expect(reportCronRun).not.toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('a rejected data quality query fails the run too', async () => {
    const dbError = new Error('DB connection lost');
    mockSql.mockRejectedValue(dbError);
    stubFetch(fullSession());

    const res = await runCron();

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    expect(reportCronRun).toHaveBeenCalledWith(
      'reconcile-zero-dte-greek-flow',
      expect.objectContaining({
        status: 'error',
        message: 'DB connection lost',
      }),
    );
  });

  it('counts a session whose written rows are all zero as a data quality warning', async () => {
    mockSql.mockResolvedValue([{ total: 78, nonzero: 0 }]);
    stubFetch([makeGreekFlowTick({ timestamp: '2026-03-24T13:34:00Z' })]);

    await runCron();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ALL values are zero'),
      'warning',
    );
  });
});
