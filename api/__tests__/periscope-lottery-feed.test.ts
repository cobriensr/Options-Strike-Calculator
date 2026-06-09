// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    TransientDbError: actual.TransientDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import { TransientDbError } from '../_lib/db.js';
import handler from '../periscope-lottery-feed.js';

const ROW = {
  id: 1,
  fire_type: 'call_lottery',
  fire_time: '2026-05-18T18:43:12Z',
  expiry: '2026-05-18',
  event_strike: 7380,
  trade_strike: 7430,
  spot_at_event: '7362.1400',
  strike_dist: '17.8600',
  greek_post: '-7403.4000',
  greek_delta: '-4513.3000',
  greek_lvl_rank: 0.95,
  greek_chg_rank: 0.999,
  gex_dollars: '-974008661.0000',
  call_ratio: -3.58,
  qqq_net_prem_balance_30m: 0.6,
  entry_px: '0.1000',
  vix: '18.31',
  v3_strict_pass: true,
  v4_badge: true,
  peak_px: '25.0000',
  peak_pct: '250.0000',
  peak_time: '2026-05-18T19:01:47Z',
  eod_close_px: '0.0500',
  realized_r_peak: '249.0000',
  realized_r_eod: '-0.5000',
  outcome_locked: true,
  created_at: '2026-05-18T18:43:50Z',
};

beforeEach(() => {
  mockSql.mockReset();
  mockGuard.mockReset();
  // guardOwnerOrGuestEndpoint returns boolean — `false` = auth passed,
  // request proceeds; `true` = rejected, response already sent.
  mockGuard.mockResolvedValue(false);
});

describe('GET /api/periscope-lottery-feed', () => {
  it('returns fires for fire_type=both with default date', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({ query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(res._json).toMatchObject({
      fireType: 'both',
      count: 1,
      fires: [
        expect.objectContaining({
          fireType: 'call_lottery',
          eventStrike: 7380,
          tradeStrike: 7430,
          v3StrictPass: true,
          v4Badge: true,
          peakPct: 250,
          realizedRPeak: 249,
        }),
      ],
    });
  });

  it('filters to call_lottery when fire_type=call_lottery', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({
      query: { fire_type: 'call_lottery', date: '2026-05-18' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      date: '2026-05-18',
      fireType: 'call_lottery',
      count: 1,
    });
  });

  it('rejects invalid fire_type with 400', async () => {
    const req = mockRequest({ query: { fire_type: 'foo' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({
      error: expect.stringContaining('fire_type must be'),
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('serializes NUMERIC columns to JS numbers', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    const req = mockRequest({ query: { fire_type: 'call_lottery' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<Record<string, unknown>>;
    };
    const fire = body.fires[0]!;
    expect(typeof fire.spotAtEvent).toBe('number');
    expect(typeof fire.greekPost).toBe('number');
    expect(typeof fire.gexDollars).toBe('number');
    expect(typeof fire.peakPx).toBe('number');
    expect(typeof fire.realizedRPeak).toBe('number');
  });

  it('clamps limit to [1, 500]', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ query: { limit: '9999' } });
    const res = mockResponse();
    await handler(req, res);

    // The handler clamps to 500; verify the bound parameter
    const callArgs = mockSql.mock.calls[0];
    expect(callArgs).toBeDefined();
    // LIMIT is the last bind param in the SQL template
    const lastParam = (callArgs ?? []).at(-1);
    expect(lastParam).toBe(500);
  });

  it('returns empty fires array when no rows', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ query: { fire_type: 'put_lottery' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({ count: 0, fires: [] });
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));

    const req = mockRequest({ query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'internal_error' });
  });

  it('soft-degrades to 503 + Retry-After on a transient DB blip', async () => {
    mockSql.mockRejectedValueOnce(
      new TransientDbError(new Error('db attempt timeout')),
    );

    const req = mockRequest({ query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
  });

  it('bails out without DB call when guard rejects (auth-fail regression)', async () => {
    // Simulate guard rejecting (it would have already sent the 401).
    // The handler must NOT issue a SQL query nor write a second response.
    mockGuard.mockResolvedValueOnce(true);

    const req = mockRequest({ query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
    // Handler did not overwrite _json (guard would have done it, but we
    // mock the guard so _json stays at its default null).
    expect(res._json).toBeNull();
  });
});
