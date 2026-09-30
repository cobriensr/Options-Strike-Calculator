// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const mockCronGuard = vi.hoisted(() => vi.fn());
vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/enrich-periscope-lottery-outcomes.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { mockRequest, mockResponse } from './helpers';

/**
 * Split a tagged-template mockSql call into its template strings and bound
 * values. strings[i + 1] is the SQL text right after values[i], so tests
 * can assert on the cast applied to a given parameter.
 */
function sqlCall(callIndex: number): { strings: string[]; values: unknown[] } {
  const call = mockSql.mock.calls[callIndex] ?? [];
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { strings: [...strings], values };
}

/** Join template strings into one SQL string with `$n` placeholders. */
function renderSql(strings: string[]): string {
  return strings
    .map((s, i) => (i === 0 ? s : `$${i}${s}`))
    .join('')
    .replaceAll(/\s+/g, ' ');
}

const SAMPLE_FIRE = {
  id: 1,
  fire_type: 'call_lottery',
  fire_time: '2026-05-18T18:43:12Z',
  expiry: '2026-05-18',
  trade_strike: 7430,
  entry_px: '0.10',
};

/** Pin the handler's run-time clock (only Date is faked). */
function runAt(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

/** Call fire on the 2026-05-18 0DTE (CDT: 15:00 CT close = 20:00 UTC). */
function callFire(id: number, fireTime: string) {
  return { ...SAMPLE_FIRE, id, fire_time: fireTime };
}

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(Sentry.captureException).mockReset();
  vi.mocked(Sentry.captureMessage).mockReset();
  vi.mocked(logger.warn).mockReset();
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-05-18' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enrich-periscope-lottery-outcomes cron', () => {
  it('returns rows=0 when no unenriched fires', async () => {
    // 1: SELECT unenriched fires
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 0 });
  });

  it('enriches a call_lottery fire with peak + EOD outcomes (5/18 7430 reproduction)', async () => {
    const fire = {
      id: 1,
      fire_type: 'call_lottery',
      fire_time: '2026-05-18T18:43:12Z',
      expiry: '2026-05-18',
      trade_strike: 7430,
      entry_px: '0.10',
    };
    // Batched read returns one row per (fire_id, tick), ordered by id then
    // executed_at. Peak hits $25 within the 120m hold window; the last
    // print at or before the 20:00 UTC close cutoff is $0.05.
    const tradeRows = [
      { fire_id: 1, executed_at: '2026-05-18T18:45:00Z', price: '0.50' },
      { fire_id: 1, executed_at: '2026-05-18T19:01:47Z', price: '25.00' },
      { fire_id: 1, executed_at: '2026-05-18T20:00:00Z', price: '0.05' },
    ];

    mockSql.mockResolvedValueOnce([fire]); // 1: SELECT unenriched
    mockSql.mockResolvedValueOnce(tradeRows); // 2: batched LATERAL read
    mockSql.mockResolvedValueOnce([]); // 3: batched UPDATE

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      updated: 1,
    });

    // Exactly three SQL calls: SELECT, batched read, batched UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(3);

    // Verify the batched UPDATE was issued with the correct realized values.
    // mockSql.mock.calls[2] = the UPDATE call. Params are the unnest arrays:
    // ids, peak_px[], peak_pct[], peak_time[], eod_close_px[],
    // realized_r_peak[], realized_r_eod[].
    const updateArgs = mockSql.mock.calls[2];
    expect(updateArgs).toBeDefined();
    const params = (updateArgs ?? []).slice(1);
    // ids = [1]
    expect(params[0]).toEqual([1]);
    // peak_px = [25.00]
    expect(params[1]).toEqual([25]);
    // peak_pct = [25 / 0.10 = 250]
    expect(params[2]).toEqual([250]);
    // peak_time = [ISO string]
    expect(Array.isArray(params[3])).toBe(true);
    expect(typeof params[3][0]).toBe('string');
    // eod_close_px = [0.05]
    expect(params[4]).toEqual([0.05]);
    // realized_r_peak = [(25 - 0.10) / 0.10 = 249]
    expect(params[5][0]).toBeCloseTo(249, 2);
    // realized_r_eod = [(0.05 - 0.10) / 0.10 = -0.5]
    expect(params[6][0]).toBeCloseTo(-0.5, 2);
  });

  it('uses 180m horizon for put_lottery (vs 120m for call)', async () => {
    const putFire = {
      id: 2,
      fire_type: 'put_lottery',
      fire_time: '2026-04-23T15:00:00Z',
      expiry: '2026-04-23',
      trade_strike: 7055,
      entry_px: '0.42',
    };
    const tradeRows = [
      { fire_id: 2, executed_at: '2026-04-23T17:00:00Z', price: '24.50' },
    ];

    mockSql.mockResolvedValueOnce([putFire]);
    mockSql.mockResolvedValueOnce(tradeRows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // The 2nd call (batched read) binds the per-fire read_end array. For
    // put_lottery (180m horizon), fire_time + 180min = 2026-04-23T18:00:00Z;
    // the close cutoff (20:00 UTC) is later, so read_end = GREATEST = the
    // close cutoff. The horizonEnd is used for the in-JS peak partition, so
    // assert the read window extends at least to the close cutoff.
    const readParams = (mockSql.mock.calls[1] ?? []).slice(1);
    // read_end array is the last timestamptz[] param — find the array whose
    // single entry is the 20:00 UTC close cutoff for 2026-04-23.
    const readEndArr = readParams.find(
      (v): v is string[] =>
        Array.isArray(v) &&
        v.length === 1 &&
        v[0] === '2026-04-23T20:00:00.000Z',
    );
    expect(readEndArr).toBeDefined();

    // The single hold-window trade ($24.50) is the peak. EOD print: the
    // 17:00 trade is at/before the 20:00 cutoff, so eod_close_px = 24.50.
    const updateParams = (mockSql.mock.calls[2] ?? []).slice(1);
    // realized_r_peak = (24.50 - 0.42) / 0.42
    expect(updateParams[5][0]).toBeCloseTo((24.5 - 0.42) / 0.42, 2);
  });

  it('locks rows with no trades observed at realized_r = -1', async () => {
    const fire = {
      id: 3,
      fire_type: 'call_lottery',
      fire_time: '2026-05-15T16:00:00Z',
      expiry: '2026-05-15',
      trade_strike: 7400,
      entry_px: '0.05',
    };
    mockSql.mockResolvedValueOnce([fire]);
    mockSql.mockResolvedValueOnce([]); // batched read: no trades for this fire
    mockSql.mockResolvedValueOnce([]); // batched UPDATE

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    const updateArgs = mockSql.mock.calls[2];
    const params = (updateArgs ?? []).slice(1);
    // ids, peak_px[null], peak_pct[null], peak_time[null], eod_close_px[null],
    // realized_r_peak[-1], realized_r_eod[-1]
    expect(params[0]).toEqual([3]);
    expect(params[1]).toEqual([null]);
    expect(params[2]).toEqual([null]);
    expect(params[3]).toEqual([null]);
    expect(params[4]).toEqual([null]);
    expect(params[5]).toEqual([-1]);
    expect(params[6]).toEqual([-1]);
  });

  it('skips fires with zero entry_px (in-loop guard, since SELECT only filters NULL)', async () => {
    // The SELECT in the handler filters `entry_px IS NOT NULL`, so the
    // null branch never fires in production. The in-loop guard catches
    // entry_px = 0 (which would divide-by-zero into R = -Infinity).
    const zeroEntryFire = {
      id: 4,
      fire_type: 'call_lottery',
      fire_time: '2026-05-15T16:00:00Z',
      expiry: '2026-05-15',
      trade_strike: 7400,
      entry_px: '0',
    };
    mockSql.mockResolvedValueOnce([zeroEntryFire]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // No further SQL calls — the only candidate was skipped by the in-loop
    // guard, so neither the batched read nor the batched UPDATE runs.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      updated: 0,
      skipped: 1,
    });
  });

  it('batches multiple fires into one read and one UPDATE', async () => {
    const fires = [
      {
        id: 10,
        fire_type: 'call_lottery',
        fire_time: '2026-05-18T18:43:12Z',
        expiry: '2026-05-18',
        trade_strike: 7430,
        entry_px: '0.10',
      },
      {
        id: 11,
        fire_type: 'put_lottery',
        fire_time: '2026-05-18T15:00:00Z',
        expiry: '2026-05-18',
        trade_strike: 7055,
        entry_px: '0.20',
      },
    ];
    // Interleaved-by-id batched read.
    const tradeRows = [
      { fire_id: 10, executed_at: '2026-05-18T19:01:47Z', price: '25.00' },
      { fire_id: 11, executed_at: '2026-05-18T16:30:00Z', price: '1.00' },
    ];

    mockSql.mockResolvedValueOnce(fires);
    mockSql.mockResolvedValueOnce(tradeRows);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // One SELECT + one batched read + one batched UPDATE = 3 total.
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2,
      updated: 2,
    });

    // The UPDATE binds both ids in a single unnest array.
    const updateParams = (mockSql.mock.calls[2] ?? []).slice(1);
    expect(updateParams[0]).toEqual([10, 11]);
    // peak_px: fire 10 = 25, fire 11 = 1.00
    expect(updateParams[1]).toEqual([25, 1]);
  });

  it('binds the trade-query expiry array as date[] to match the DATE column', async () => {
    // ws_option_trades.expiry is DATE. Binding the unnest array as text[]
    // made `expiry = u.expiry` a date = text comparison, which Postgres
    // rejects ("operator does not exist: date = text", Sentry F0).
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    const { strings, values } = sqlCall(1);
    // The expiry values are plain YYYY-MM-DD strings (SELECT expiry::text),
    // which cast cleanly to date.
    const expiryIdx = values.findIndex(
      (v) => Array.isArray(v) && v.length === 1 && v[0] === '2026-05-18',
    );
    expect(expiryIdx).toBeGreaterThanOrEqual(0);
    // strings[i + 1] is the SQL text immediately after the i-th value.
    expect(strings[expiryIdx + 1]).toMatch(/^::date\[\]/);
    expect(renderSql(strings)).toContain('AND expiry = u.expiry');
  });

  it('only selects candidate fires still inside the ws_option_trades retention window, newest first', async () => {
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    const { strings, values } = sqlCall(0);
    const text = renderSql(strings);
    // Older fires have had their trades pruned by cleanup-ws-option-trades;
    // enriching them would falsely lock realized R = -1.
    expect(text).toMatch(
      /fire_time >= NOW\(\) - make_interval\(days => \$1::int\)/,
    );
    expect(values).toEqual([WS_OPTION_TRADES_RETENTION_DAYS]);
    expect(text).toContain('ORDER BY fire_time DESC');
    expect(text).not.toContain('ORDER BY fire_time ASC');
    expect(text).toContain('LIMIT 500');
  });

  it('surfaces a trade-query DB error as a 500 without locking any fires', async () => {
    const dbError = new Error('operator does not exist: date = text');
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]); // 1: SELECT unenriched
    mockSql.mockRejectedValueOnce(dbError); // 2: batched read rejects

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'enrich-periscope-lottery-outcomes',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    // No third call — the batched UPDATE that sets outcome_locked = TRUE
    // must never run when the trade read failed.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected locking UPDATE as a 500, never as success', async () => {
    const dbError = new Error('connection terminated');
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]); // 1: SELECT unenriched
    mockSql.mockResolvedValueOnce([
      { fire_id: 1, executed_at: '2026-05-18T19:00:00Z', price: '0.50' },
    ]); // 2: batched read
    mockSql.mockRejectedValueOnce(dbError); // 3: batched UPDATE rejects

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(res._json).not.toMatchObject({ status: 'success' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  describe('malformed ticks', () => {
    it('ignores a non-numeric price and computes R from the valid ticks', async () => {
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([
        { fire_id: 1, executed_at: '2026-05-18T18:50:00Z', price: 'garbage' },
        { fire_id: 1, executed_at: '2026-05-18T19:00:00Z', price: '2.00' },
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // UPDATE params: every value is an unnest array.
      const params = sqlCall(2).values as unknown[][];
      expect(params[0]).toEqual([1]);
      expect(params[1]).toEqual([2]); // peak_px from the valid tick only
      expect(params[5]?.[0]).toBeCloseTo((2 - 0.1) / 0.1, 6);
      // No NaN reaches any numeric column.
      for (const arr of params.slice(1)) {
        expect(arr.some((v) => Number.isNaN(v))).toBe(false);
      }
      // The dropped tick is surfaced, not silently swallowed.
      expect(res._json).toMatchObject({
        status: 'partial',
        malformedTicks: 1,
      });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not lock a fire whose ticks are all unreadable', async () => {
      // Prints exist but none parse — "no trades → R = -1" does not apply,
      // so locking would write a fabricated total loss.
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([
        { fire_id: 1, executed_at: '2026-05-18T18:50:00Z', price: 'NaN' },
        { fire_id: 1, executed_at: '2026-05-18T19:00:00Z', price: 'garbage' },
      ]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // SELECT + read only — no locking UPDATE.
      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 0,
        updated: 0,
        unreadable: 1,
        malformedTicks: 2,
      });
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('hold-window guard', () => {
    it('does not lock a fire whose window has not elapsed yet (mid-session run)', async () => {
      // 14:00 CDT on the fire's 0DTE — the contract still trades until
      // 15:00 CT, so the outcome is not final.
      runAt('2026-05-18T19:00:00Z');
      mockSql.mockResolvedValueOnce([callFire(1, '2026-05-18T18:43:12Z')]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // No trade read and no UPDATE — the in-flight fire is left unlocked.
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 0,
        updated: 0,
        inFlight: 1,
      });
    });

    it('locks a settled fire and skips an in-flight one in the same run', async () => {
      runAt('2026-05-18T19:00:00Z');
      const settled = callFire(1, '2026-05-15T18:00:00Z'); // prior session
      const inFlight = callFire(2, '2026-05-18T18:43:12Z'); // today, open
      mockSql.mockResolvedValueOnce([inFlight, settled]);
      mockSql.mockResolvedValueOnce([
        { fire_id: 1, executed_at: '2026-05-15T18:30:00Z', price: '0.40' },
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // Only the settled fire is read and locked.
      expect(sqlCall(1).values[0]).toEqual([1]);
      expect(sqlCall(2).values[0]).toEqual([1]);
      expect(res._json).toMatchObject({ updated: 1, inFlight: 1 });
    });

    it('treats a late fire as settled once its 0DTE contract has expired', async () => {
      // Put fired 14:30 CDT: its 180m horizon runs to 17:30 CDT, but a
      // 0DTE SPXW stops trading at 15:00 CT, so no print can land after
      // the close. The 21:50 UTC scheduled run must lock it.
      runAt('2026-05-18T21:50:00Z');
      const latePut = {
        ...SAMPLE_FIRE,
        id: 7,
        fire_type: 'put_lottery',
        fire_time: '2026-05-18T19:30:00Z',
      };
      mockSql.mockResolvedValueOnce([latePut]);
      mockSql.mockResolvedValueOnce([
        { fire_id: 7, executed_at: '2026-05-18T19:45:00Z', price: '0.30' },
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(sqlCall(2).values[0]).toEqual([7]);
      expect(res._json).toMatchObject({ updated: 1, inFlight: 0 });
    });
  });

  describe('all-empty tape guard', () => {
    const threeFires = [
      callFire(21, '2026-05-18T15:00:00Z'),
      callFire(22, '2026-05-18T16:00:00Z'),
      callFire(23, '2026-05-18T17:00:00Z'),
    ];

    it('does not lock anything and alerts when every settled fire has zero ticks', async () => {
      // 3+ fires with not one print between them means the tape is missing
      // (e.g. uw-stream down), not that every option died untraded.
      mockSql.mockResolvedValueOnce(threeFires);
      mockSql.mockResolvedValueOnce([]); // batched read: nothing at all

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(mockSql).toHaveBeenCalledTimes(2); // no locking UPDATE
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 0,
        updated: 0,
        emptyFires: 3,
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no ws_option_trades ticks'),
        expect.objectContaining({
          level: 'warning',
          fingerprint: [
            'enrich-periscope-lottery-outcomes',
            'all-windows-empty',
          ],
        }),
      );
    });

    it('still locks zero-tick fires at R = -1 when other fires have ticks', async () => {
      mockSql.mockResolvedValueOnce(threeFires);
      mockSql.mockResolvedValueOnce([
        { fire_id: 22, executed_at: '2026-05-18T16:30:00Z', price: '0.50' },
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      const params = sqlCall(2).values;
      expect(params[0]).toEqual([21, 22, 23]);
      expect(params[5]).toEqual([-1, 4, -1]); // (0.50 - 0.10) / 0.10 = 4
      expect(res._json).toMatchObject({ status: 'success', updated: 3 });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('keeps the per-strategy lock below the threshold (2 empty fires)', async () => {
      mockSql.mockResolvedValueOnce(threeFires.slice(0, 2));
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(sqlCall(2).values[0]).toEqual([21, 22]);
      expect(res._json).toMatchObject({ status: 'success', updated: 2 });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });
});
