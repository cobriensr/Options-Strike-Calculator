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

/**
 * Bound-array positions in the per-fire aggregate read (unnest order):
 * ids, expiries, strikes, option types, fire_time, horizon_end,
 * close_cutoff, tail_start, tail_end.
 */
const READ = {
  ids: 0,
  expiries: 1,
  optionTypes: 3,
  horizonEnds: 5,
  closeCutoffs: 6,
  tailStarts: 7,
  tailEnds: 8,
} as const;

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
function callFire(id: number | string, fireTime: string) {
  return { ...SAMPLE_FIRE, id, fire_time: fireTime };
}

interface AggOverrides {
  tape_live?: boolean;
  horizon_ticks?: number;
  peak_px?: string | null;
  peak_time?: string | Date | null;
  eod_close_px?: string | null;
}

/**
 * One per-fire aggregate row as the Neon driver returns it: the bigint
 * fire_id and numeric prices arrive as strings. Default = no prints in the
 * window while the SPXW tape was live through the tail.
 */
function agg(fireId: number, o: AggOverrides = {}) {
  return {
    fire_id: String(fireId),
    tape_live: true,
    horizon_ticks: 0,
    peak_px: null,
    peak_time: null,
    eod_close_px: null,
    ...o,
  };
}

/** A fire whose contract printed: peak inside the horizon plus an EOD print. */
function traded(
  fireId: number,
  peakPx: string,
  peakTime: string,
  eodClosePx: string,
  horizonTicks = 3,
) {
  return agg(fireId, {
    horizon_ticks: horizonTicks,
    peak_px: peakPx,
    peak_time: peakTime,
    eod_close_px: eodClosePx,
  });
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
    // Per-fire aggregates: peak $25 at 19:01:47 inside the 120m hold window;
    // the last print at or before the 20:00 UTC close cutoff is $0.05.
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]); // 1: SELECT unenriched
    mockSql.mockResolvedValueOnce([
      traded(1, '25.0000', '2026-05-18T19:01:47Z', '0.0500'),
    ]); // 2: per-fire aggregate read
    mockSql.mockResolvedValueOnce([]); // 3: batched UPDATE

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      updated: 1,
    });

    // Exactly three SQL calls: SELECT, aggregate read, batched UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(3);

    // UPDATE params are the unnest arrays: ids, peak_px[], peak_pct[],
    // peak_time[], eod_close_px[], realized_r_peak[], realized_r_eod[].
    const params = sqlCall(2).values as unknown[][];
    expect(params[0]).toEqual([1]);
    expect(params[1]).toEqual([25]);
    expect(params[2]).toEqual([250]); // 25 / 0.10
    expect(params[3]).toEqual(['2026-05-18T19:01:47.000Z']);
    expect(params[4]).toEqual([0.05]);
    expect(params[5]?.[0]).toBeCloseTo(249, 2); // (25 - 0.10) / 0.10
    expect(params[6]?.[0]).toBeCloseTo(-0.5, 2); // (0.05 - 0.10) / 0.10
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
    mockSql.mockResolvedValueOnce([putFire]);
    mockSql.mockResolvedValueOnce([
      traded(2, '24.5000', '2026-04-23T17:00:00Z', '24.5000', 1),
    ]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    // The peak aggregate is bounded by horizon_end = fire + 180 min; the
    // EOD lookup by the 15:00 CDT close cutoff (20:00 UTC).
    const { values } = sqlCall(1);
    expect(values[READ.horizonEnds]).toEqual(['2026-04-23T18:00:00.000Z']);
    expect(values[READ.closeCutoffs]).toEqual(['2026-04-23T20:00:00.000Z']);

    const updateParams = sqlCall(2).values as unknown[][];
    expect(updateParams[5]?.[0]).toBeCloseTo((24.5 - 0.42) / 0.42, 2);
  });

  it('locks a zero-tick fire at realized_r = -1 when SPXW tape was flowing in its window tail', async () => {
    const fire = {
      id: 3,
      fire_type: 'call_lottery',
      fire_time: '2026-05-15T16:00:00Z',
      expiry: '2026-05-15',
      trade_strike: 7400,
      entry_px: '0.05',
    };
    mockSql.mockResolvedValueOnce([fire]);
    // No prints for this contract, but the SPXW tape was live through the
    // end of the window, so the option genuinely died.
    mockSql.mockResolvedValueOnce([agg(3)]);
    mockSql.mockResolvedValueOnce([]); // batched UPDATE

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();

    const params = sqlCall(2).values;
    // ids, peak_px[null], peak_pct[null], peak_time[null], eod_close_px[null],
    // realized_r_peak[-1], realized_r_eod[-1]
    expect(params).toEqual([[3], [null], [null], [null], [null], [-1], [-1]]);
  });

  it('keeps R peak at -1 but prices the EOD print when the only prints fall after the horizon', async () => {
    // Morning fire: nothing traded in the 120m hold window, but the
    // contract printed later, before the close.
    mockSql.mockResolvedValueOnce([callFire(6, '2026-05-18T14:00:00Z')]);
    mockSql.mockResolvedValueOnce([agg(6, { eod_close_px: '0.2000' })]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    const params = sqlCall(2).values as unknown[][];
    expect(params[1]).toEqual([null]); // peak_px
    expect(params[4]).toEqual([0.2]); // eod_close_px
    expect(params[5]).toEqual([-1]); // no print in the hold window
    expect(params[6]?.[0]).toBeCloseTo(1, 6); // (0.20 - 0.10) / 0.10
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

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    // No further SQL calls — the only candidate was skipped by the in-loop
    // guard, so neither the read nor the UPDATE runs.
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
      callFire(10, '2026-05-18T18:43:12Z'),
      {
        id: 11,
        fire_type: 'put_lottery',
        fire_time: '2026-05-18T15:00:00Z',
        expiry: '2026-05-18',
        trade_strike: 7055,
        entry_px: '0.20',
      },
    ];
    mockSql.mockResolvedValueOnce(fires);
    mockSql.mockResolvedValueOnce([
      traded(10, '25.0000', '2026-05-18T19:01:47Z', '0.0500'),
      traded(11, '1.0000', '2026-05-18T16:30:00Z', '0.0500'),
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    // One SELECT + one read + one UPDATE = 3 total.
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 2,
      updated: 2,
    });

    const updateParams = sqlCall(2).values;
    expect(updateParams[0]).toEqual([10, 11]);
    expect(updateParams[1]).toEqual([25, 1]);
  });

  it('matches aggregates to fires whatever JS type the driver gives the bigint id', async () => {
    // The Neon HTTP driver parses int8 (BIGSERIAL) as a STRING. The
    // candidate id and the read's fire_id are both normalized to numbers,
    // so a string on one side and a number on the other still match.
    mockSql.mockResolvedValueOnce([callFire('101', '2026-05-18T18:43:12Z')]);
    mockSql.mockResolvedValueOnce([
      {
        ...traded(101, '0.5000', '2026-05-18T19:00:00Z', '0.0500'),
        fire_id: 101,
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const params = sqlCall(2).values as unknown[][];
    expect(params[0]).toEqual([101]);
    expect(params[1]).toEqual([0.5]);
    expect(res._json).toMatchObject({
      status: 'success',
      updated: 1,
      tapeGap: 0,
    });
  });

  it('binds the read expiry array as date[] to match the DATE column', async () => {
    // ws_option_trades.expiry is DATE. Binding the unnest array as text[]
    // made `expiry = u.expiry` a date = text comparison, which Postgres
    // rejects ("operator does not exist: date = text", Sentry F0).
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
    mockSql.mockResolvedValueOnce([agg(1)]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    const { strings, values } = sqlCall(1);
    expect(values[READ.expiries]).toEqual(['2026-05-18']);
    // strings[i + 1] is the SQL text immediately after the i-th value.
    expect(strings[READ.expiries + 1]).toMatch(/^::date\[\]/);
    expect(renderSql(strings)).toContain('AND t.expiry = u.expiry');
  });

  it('binds option types as bpchar[] so the chain index covers option_type', async () => {
    // ws_option_trades.option_type is CHAR(1). A text[] binding casts the
    // COLUMN to text, which drops option_type from the index condition and
    // forces the EOD LIMIT 1 into a sort (measured on prod: ~3.5x slower).
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
    mockSql.mockResolvedValueOnce([agg(1)]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    const { strings, values } = sqlCall(1);
    expect(values[READ.optionTypes]).toEqual(['C']);
    expect(strings[READ.optionTypes + 1]).toMatch(/^::bpchar\[\]/);
  });

  it('binds fire ids as bigint[] in both the read and the UPDATE', async () => {
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
    mockSql.mockResolvedValueOnce([agg(1)]);
    mockSql.mockResolvedValueOnce([]);

    await handler(mockRequest({ method: 'GET' }), mockResponse());

    expect(sqlCall(1).strings[READ.ids + 1]).toMatch(/^::bigint\[\]/);
    expect(sqlCall(2).strings[1]).toMatch(/^::bigint\[\]/);
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

  describe('per-fire aggregate read', () => {
    it('returns one aggregated row per fire instead of every tick', async () => {
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([agg(1)]);
      mockSql.mockResolvedValueOnce([]);

      await handler(mockRequest({ method: 'GET' }), mockResponse());

      const text = renderSql(sqlCall(1).strings);
      // Peak over the hold window, reduced in SQL (earliest time at the max).
      expect(text).toContain('count(*)::int AS horizon_ticks');
      expect(text).toContain('max(t.price) AS peak_px');
      expect(text).toContain(
        '(array_agg(t.executed_at ORDER BY t.price DESC, t.executed_at ASC))[1] AS peak_time',
      );
      expect(text).toContain('AND t.executed_at <= u.horizon_end');
      // EOD = the last print at or before the close cutoff, index-ordered.
      expect(text).toContain('AND t.executed_at <= u.close_cutoff');
      expect(text).toContain('ORDER BY t.executed_at DESC LIMIT 1');
      // No per-tick result set and no global per-tick sort.
      expect(text).not.toContain('t.executed_at, t.price::numeric AS price');
      expect(text).not.toContain('ORDER BY u.id, t.executed_at');
    });

    it('reads in chunks of 100 fires, locking each chunk before reading the next', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => 1000 + i);
      const fires = ids.map((id) => callFire(id, '2026-05-18T15:00:00Z'));
      const rowsFor = (chunk: number[]) =>
        chunk.map((id) =>
          traded(id, '0.5000', '2026-05-18T15:30:00Z', '0.0500'),
        );
      const firstIds = ids.slice(0, 100);
      const secondIds = ids.slice(100);
      mockSql.mockResolvedValueOnce(fires); // SELECT
      mockSql.mockResolvedValueOnce(rowsFor(firstIds)); // read chunk 1
      mockSql.mockResolvedValueOnce([]); // UPDATE chunk 1
      mockSql.mockResolvedValueOnce(rowsFor(secondIds)); // read chunk 2
      mockSql.mockResolvedValueOnce([]); // UPDATE chunk 2

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(mockSql).toHaveBeenCalledTimes(5);
      expect(sqlCall(1).values[READ.ids]).toEqual(firstIds);
      expect(sqlCall(2).values[0]).toEqual(firstIds);
      expect(sqlCall(3).values[READ.ids]).toEqual(secondIds);
      expect(sqlCall(4).values[0]).toEqual(secondIds);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 150,
        updated: 150,
      });
    });

    it('keeps an earlier chunk locked when a later chunk read fails, and surfaces the error', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => 2000 + i);
      const fires = ids.map((id) => callFire(id, '2026-05-18T15:00:00Z'));
      const firstIds = ids.slice(0, 100);
      const dbError = new Error('statement timeout');
      mockSql.mockResolvedValueOnce(fires);
      mockSql.mockResolvedValueOnce(
        firstIds.map((id) =>
          traded(id, '0.5000', '2026-05-18T15:30:00Z', '0.0500'),
        ),
      );
      mockSql.mockResolvedValueOnce([]); // UPDATE chunk 1 lands
      mockSql.mockRejectedValueOnce(dbError); // read chunk 2 fails

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(sqlCall(2).values[0]).toEqual(firstIds); // progress kept
      expect(mockSql).toHaveBeenCalledTimes(4);
      expect(res._status).toBe(500);
      expect(res._json).not.toMatchObject({ status: 'success' });
      expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    });
  });

  it('surfaces a read DB error as a 500 without locking any fires', async () => {
    const dbError = new Error('operator does not exist: date = text');
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]); // 1: SELECT unenriched
    mockSql.mockRejectedValueOnce(dbError); // 2: aggregate read rejects

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'enrich-periscope-lottery-outcomes',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
    // No third call — the UPDATE that sets outcome_locked = TRUE must never
    // run when the read failed.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected locking UPDATE as a 500, never as success', async () => {
    const dbError = new Error('connection terminated');
    mockSql.mockResolvedValueOnce([SAMPLE_FIRE]); // 1: SELECT unenriched
    mockSql.mockResolvedValueOnce([
      traded(1, '0.5000', '2026-05-18T19:00:00Z', '0.0500'),
    ]); // 2: aggregate read
    mockSql.mockRejectedValueOnce(dbError); // 3: batched UPDATE rejects

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(res._json).not.toMatchObject({ status: 'success' });
    expect(Sentry.captureException).toHaveBeenCalledWith(dbError);
  });

  describe('unparseable aggregates', () => {
    it('does not lock a fire whose aggregate price does not parse, and surfaces it', async () => {
      // price is NUMERIC, so this cannot happen from Postgres; the guard
      // keeps a garbage value from ever becoming a locked R.
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([
        traded(1, 'garbage', '2026-05-18T19:00:00Z', '0.0500'),
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
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ unreadable: 1, unreadableFireIds: [1] }),
        'enrich-periscope-lottery-outcomes: unreadable aggregates; fires left unlocked',
      );
    });

    it('does not lock a fire whose peak time does not parse', async () => {
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([
        traded(1, '0.5000', 'not-a-time', '0.0500'),
      ]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(res._json).toMatchObject({ status: 'partial', unreadable: 1 });
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

      // No read and no UPDATE — the in-flight fire is left unlocked.
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
        traded(1, '0.4000', '2026-05-15T18:30:00Z', '0.0500'),
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // Only the settled fire is read and locked.
      expect(sqlCall(1).values[READ.ids]).toEqual([1]);
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
        traded(7, '0.3000', '2026-05-18T19:45:00Z', '0.3000'),
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(sqlCall(2).values[0]).toEqual([7]);
      expect(res._json).toMatchObject({ updated: 1, inFlight: 0 });
    });

    describe('CST (January) — 15:00 CT close is 21:00 UTC, not 20:00', () => {
      // Put fired 14:00 CST: horizon runs to 17:00 CST (23:00 UTC); the
      // 0DTE contract stops trading at 15:00 CST = 21:00 UTC.
      const januaryLatePut = {
        ...SAMPLE_FIRE,
        id: 8,
        fire_type: 'put_lottery',
        fire_time: '2026-01-15T20:00:00Z',
        expiry: '2026-01-15',
      };

      it('is still in flight at 14:30 CST (20:30 UTC)', async () => {
        // A CDT-anchored close (20:00 UTC) would wrongly call this settled.
        runAt('2026-01-15T20:30:00Z');
        mockSql.mockResolvedValueOnce([januaryLatePut]);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET' }), res);

        expect(mockSql).toHaveBeenCalledTimes(1);
        expect(res._json).toMatchObject({ updated: 0, inFlight: 1 });
      });

      it('is settled once the 21:00 UTC close has passed', async () => {
        runAt('2026-01-15T21:05:00Z');
        mockSql.mockResolvedValueOnce([januaryLatePut]);
        mockSql.mockResolvedValueOnce([
          traded(8, '0.3000', '2026-01-15T20:40:00Z', '0.3000'),
        ]);
        mockSql.mockResolvedValueOnce([]);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET' }), res);

        expect(sqlCall(1).values[READ.tailEnds]).toEqual([
          '2026-01-15T21:00:00.000Z',
        ]);
        expect(sqlCall(2).values[0]).toEqual([8]);
        expect(res._json).toMatchObject({ updated: 1, inFlight: 0 });
      });
    });

    describe('early-close day (2026-11-27, 13:00 ET = 12:00 CST = 18:00 UTC)', () => {
      // Call fired 11:00 CST. SPXW stops trading at the 12:00 CST early
      // close, so the settle/tail anchor must be 18:00 UTC, not 15:00 CT.
      const halfDayCall = {
        ...SAMPLE_FIRE,
        id: 9,
        fire_time: '2026-11-27T17:00:00Z',
        expiry: '2026-11-27',
      };

      it('is in flight before the early close', async () => {
        runAt('2026-11-27T17:55:00Z');
        mockSql.mockResolvedValueOnce([halfDayCall]);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET' }), res);

        expect(mockSql).toHaveBeenCalledTimes(1);
        expect(res._json).toMatchObject({ inFlight: 1 });
      });

      it('settles at the early close and probes the tape tail before it, not a dead 14:50-15:00 CT window', async () => {
        runAt('2026-11-27T18:30:00Z');
        mockSql.mockResolvedValueOnce([halfDayCall]);
        // No prints, tape live through 11:50-12:00 CST → genuine zero.
        mockSql.mockResolvedValueOnce([agg(9)]);
        mockSql.mockResolvedValueOnce([]);

        const res = mockResponse();
        await handler(mockRequest({ method: 'GET' }), res);

        const { values } = sqlCall(1);
        expect(values[READ.tailStarts]).toEqual(['2026-11-27T17:50:00.000Z']);
        expect(values[READ.tailEnds]).toEqual(['2026-11-27T18:00:00.000Z']);
        expect(sqlCall(2).values[0]).toEqual([9]);
        expect(res._json).toMatchObject({
          status: 'success',
          updated: 1,
          tapeGap: 0,
        });
      });
    });
  });

  describe('per-fire tape-gap guard', () => {
    const TAPE_GAP_FINGERPRINT = [
      'enrich-periscope-lottery-outcomes',
      'tape-gap',
    ];
    /** No prints; tapeLive says whether SPXW printed in the window tail. */
    const noPrints = (fireId: number, tapeLive: boolean) =>
      agg(fireId, { tape_live: tapeLive });

    it('probes SPXW tape in the tail of each fire’s settled window, once per fire', async () => {
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([noPrints(1, true)]);
      mockSql.mockResolvedValueOnce([]);

      await handler(mockRequest({ method: 'GET' }), mockResponse());

      const { strings, values } = sqlCall(1);
      const text = renderSql(strings);
      expect(text).toContain(
        'AS u(id, expiry, strike, option_type, fire_time, horizon_end, ' +
          'close_cutoff, tail_start, tail_end)',
      );
      // Served by ws_option_trades_ticker_executed_idx (ticker,
      // executed_at). OFFSET 0 keeps the planner from pulling the scalar
      // lateral up and re-running the EXISTS per joined row.
      expect(text).toContain(
        "EXISTS ( SELECT 1 FROM ws_option_trades WHERE ticker = 'SPXW' " +
          'AND executed_at >= u.tail_start AND executed_at <= u.tail_end ' +
          ') AS tape_live OFFSET 0',
      );
      // Call fired 13:43 CDT: settledAt = the 15:00 CDT 0DTE close
      // (20:00 UTC), so the tail is the last 10 minutes, 14:50-15:00 CDT.
      expect(values[READ.tailStarts]).toEqual(['2026-05-18T19:50:00.000Z']);
      expect(values[READ.tailEnds]).toEqual(['2026-05-18T20:00:00.000Z']);
      expect(mockSql).toHaveBeenCalledTimes(3);
    });

    it('clamps the tape tail to start no earlier than the fire', async () => {
      // Fired 14:55 CDT: settledAt - 10 min (14:50) precedes the fire, so
      // the tail is [fire_time, close].
      mockSql.mockResolvedValueOnce([callFire(5, '2026-05-18T19:55:00Z')]);
      mockSql.mockResolvedValueOnce([noPrints(5, true)]);
      mockSql.mockResolvedValueOnce([]);

      await handler(mockRequest({ method: 'GET' }), mockResponse());

      const { values } = sqlCall(1);
      expect(values[READ.tailStarts]).toEqual(['2026-05-18T19:55:00.000Z']);
      expect(values[READ.tailEnds]).toEqual(['2026-05-18T20:00:00.000Z']);
    });

    it('leaves a zero-print fire unlocked when its window tail had no SPXW tape, with a backfill hint', async () => {
      // tape_live is computed over the tail only, so a feed that died
      // mid-window reads as dead even if it printed early in the window.
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([noPrints(1, false)]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(mockSql).toHaveBeenCalledTimes(2); // no locking UPDATE
      expect(res._json).toMatchObject({ status: 'error', tapeGap: 1 });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no SPXW tape'),
        expect.objectContaining({ fingerprint: TAPE_GAP_FINGERPRINT }),
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          'scripts/backfill_periscope_lottery_outcomes.py',
        ),
        expect.anything(),
      );
    });

    it('leaves fires from an outage day unlocked while locking the next day’s fires', async () => {
      // uw-stream died on 05-18 and was redeployed 05-19. The 05-19 run
      // re-selects the 05-18 fires (still inside the retention window)
      // alongside the 05-19 fire. The 05-19 fire has prints, but that must
      // not license locking the 05-18 fires at R = -1: their own window
      // tails had no SPXW tape.
      const day1 = [
        callFire(31, '2026-05-18T15:00:00Z'),
        callFire(32, '2026-05-18T16:00:00Z'),
        callFire(33, '2026-05-18T17:00:00Z'),
      ];
      const day2 = callFire(34, '2026-05-19T15:00:00Z');
      mockSql.mockResolvedValueOnce([day2, ...day1]);
      mockSql.mockResolvedValueOnce([
        noPrints(31, false),
        noPrints(32, false),
        noPrints(33, false),
        traded(34, '0.5000', '2026-05-19T15:30:00Z', '0.0500'),
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      // Only the day-2 fire is locked.
      expect(sqlCall(2).values[0]).toEqual([34]);
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 1,
        updated: 1,
        tapeGap: 3,
      });
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no SPXW tape'),
        expect.objectContaining({
          level: 'warning',
          fingerprint: TAPE_GAP_FINGERPRINT,
          extra: expect.objectContaining({ tapeGapFireIds: [31, 32, 33] }),
        }),
      );
    });

    it('handles a tape gap, a genuine zero-print fire, and a traded fire in one run', async () => {
      const tradedFire = callFire(41, '2026-05-18T15:00:00Z');
      const diedUntraded = callFire(42, '2026-05-18T16:00:00Z');
      const inGap = callFire(43, '2026-05-18T17:00:00Z');
      mockSql.mockResolvedValueOnce([inGap, diedUntraded, tradedFire]);
      mockSql.mockResolvedValueOnce([
        traded(41, '0.5000', '2026-05-18T15:30:00Z', '0.0500'),
        noPrints(42, true),
        noPrints(43, false),
      ]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      const params = sqlCall(2).values;
      // The traded fire and the genuinely-untraded fire are locked (in
      // candidate order, newest first); the fire whose tail had no tape is
      // not.
      expect(params[0]).toEqual([42, 41]);
      expect(params[5]).toEqual([-1, 4]); // (0.50 - 0.10) / 0.10 = 4
      expect(res._json).toMatchObject({
        status: 'error',
        updated: 2,
        tapeGap: 1,
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no SPXW tape'),
        expect.objectContaining({
          fingerprint: TAPE_GAP_FINGERPRINT,
          extra: expect.objectContaining({ tapeGapFireIds: [43] }),
        }),
      );
    });

    it('treats a fire missing from the read as a tape gap, never as a total loss', async () => {
      // The read returns exactly one row per fire; a missing fire means
      // the read is not trustworthy, so it must not fall into the R = -1
      // lock.
      mockSql.mockResolvedValueOnce([SAMPLE_FIRE]);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(mockRequest({ method: 'GET' }), res);

      expect(mockSql).toHaveBeenCalledTimes(2); // no locking UPDATE
      expect(res._json).toMatchObject({
        status: 'error',
        updated: 0,
        tapeGap: 1,
      });
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
