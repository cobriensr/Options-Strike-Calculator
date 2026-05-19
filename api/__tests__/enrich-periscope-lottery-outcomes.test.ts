// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
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
    // Hold-window trades: peak hits $25 (R=249 — the Wonce outcome)
    const holdTrades = [
      { executed_at: '2026-05-18T18:45:00Z', price: '0.50' },
      { executed_at: '2026-05-18T19:01:47Z', price: '25.00' },
      { executed_at: '2026-05-18T20:00:00Z', price: '0.05' },
    ];
    // EOD last trade
    const eodTrades = [{ price: '0.05' }];

    mockSql.mockResolvedValueOnce([fire]); // SELECT unenriched
    mockSql.mockResolvedValueOnce(holdTrades); // hold-window SELECT
    mockSql.mockResolvedValueOnce(eodTrades); // EOD SELECT
    mockSql.mockResolvedValueOnce([]); // UPDATE

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      updated: 1,
    });

    // Verify UPDATE was issued with the correct realized values.
    // mockSql.mock.calls[3] = the UPDATE call.
    const updateArgs = mockSql.mock.calls[3];
    expect(updateArgs).toBeDefined();
    // SQL template params order: peak_px, peak_pct, peak_time, eod_close_px,
    // realized_r_peak, realized_r_eod, id
    // (each param is a position in the tagged-template call)
    const params = (updateArgs ?? []).slice(1);
    // peak_px = 25.00
    expect(params[0]).toBe(25);
    // peak_pct = 25 / 0.10 = 250
    expect(params[1]).toBe(250);
    // peak_time is an ISO string
    expect(typeof params[2]).toBe('string');
    // eod_close_px = 0.05
    expect(params[3]).toBe(0.05);
    // realized_r_peak = (25 - 0.10) / 0.10 = 249
    expect(params[4]).toBeCloseTo(249, 2);
    // realized_r_eod = (0.05 - 0.10) / 0.10 = -0.5
    expect(params[5]).toBeCloseTo(-0.5, 2);
    // id
    expect(params[6]).toBe(1);
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
    const holdTrades = [
      { executed_at: '2026-04-23T17:00:00Z', price: '24.50' },
    ];
    const eodTrades = [{ price: '0.05' }];

    mockSql.mockResolvedValueOnce([putFire]);
    mockSql.mockResolvedValueOnce(holdTrades);
    mockSql.mockResolvedValueOnce(eodTrades);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    // The 2nd call (hold-window SELECT) bound the horizonEnd. For put_lottery
    // (180m), fire_time + 180min = 2026-04-23T18:00:00Z.
    const holdSelectParams = (mockSql.mock.calls[1] ?? []).slice(1);
    const horizonEndArg = holdSelectParams.find(
      (v) =>
        v instanceof Date && v.toISOString() === '2026-04-23T18:00:00.000Z',
    );
    expect(horizonEndArg).toBeDefined();
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
    mockSql.mockResolvedValueOnce([]); // no hold trades
    mockSql.mockResolvedValueOnce([]); // no EOD trades
    mockSql.mockResolvedValueOnce([]); // UPDATE

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ status: 'success', rows: 1 });

    const updateArgs = mockSql.mock.calls[3];
    const params = (updateArgs ?? []).slice(1);
    // peak_px null, peak_pct null, peak_time null, eod_close_px null,
    // realized_r_peak = -1, realized_r_eod = -1
    expect(params[0]).toBeNull();
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(-1);
    expect(params[5]).toBe(-1);
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

    // No further SQL calls — fire was skipped by the in-loop guard
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      updated: 0,
      skipped: 1,
    });
  });
});
