// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { mockRequest, mockResponse } from './helpers';

beforeEach(() => {
  mockSql.mockReset();
  mockCronGuard.mockReset();
  mockCronGuard.mockReturnValue({ apiKey: '', today: '2026-05-18' });
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
});
