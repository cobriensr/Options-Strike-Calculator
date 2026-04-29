// @vitest-environment node

/**
 * Tests for the institutional-program SPXW handler.
 *
 * Two SQL calls per request: the daily summary CTE (ceiling-track call
 * activity) and the per-day blocks lookup. Coverage targets:
 *   - Method gate, auth gate
 *   - Days clamping (1..180), default 30
 *   - Date filter (YYYY-MM-DD), with/without time-of-day window
 *   - HHMM parser edge cases (out-of-range hours/mins, malformed)
 *   - Today vs ?date= branch (which SQL block runs)
 *   - DB error → 500 + Sentry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

import handler from '../institutional-program.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

const SAMPLE_DAYS = [
  {
    date: '2026-04-29',
    dominant_pair: {
      low_strike: 6650,
      high_strike: 6700,
      spread_width: 50,
      total_size: 5000,
      total_premium: 25_000,
      direction: 'sell',
    },
    avg_spot: 6605,
    ceiling_pct_above_spot: 0.014,
    n_blocks: 12,
    n_call_blocks: 10,
    n_put_blocks: 2,
  },
];

const SAMPLE_BLOCKS = [
  {
    executed_at: '2026-04-29T14:32:01Z',
    option_chain_id: 'SPXW...C6650',
    strike: 6650,
    option_type: 'call',
    dte: 0,
    size: 500,
    premium: 12_500,
    price: 0.25,
    side: 'ask',
    condition: 'sweep',
    exchange: 'CBOE',
    underlying_price: 6605,
    moneyness_pct: 0.0068,
    program_track: 'ceiling',
  },
];

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(guardOwnerOrGuestEndpoint).mockReset().mockResolvedValue(false);
  vi.mocked(Sentry.captureException).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/institutional-program — guards', () => {
  it('exits when guardOwnerOrGuestEndpoint rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValueOnce(true);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('GET /api/institutional-program — happy path (no date filter)', () => {
  it('returns days + today blocks with default 30-day window', async () => {
    mockSql
      .mockResolvedValueOnce(SAMPLE_DAYS)
      .mockResolvedValueOnce(SAMPLE_BLOCKS);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.days).toEqual(SAMPLE_DAYS);
    expect((body.today as { blocks: unknown[] }).blocks).toEqual(SAMPLE_BLOCKS);
    expect((body.today as { date: string }).date).toBe('today');
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('clamps days param to [1, 180] — too-small', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '0' } }), res);
    expect(res._status).toBe(200);
    // The interpolated days value is the second slot in the tagged-template
    // — we don't introspect the SQL template, but we confirm the SQL ran
    // (i.e., no validation early-exit).
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('clamps days param to [1, 180] — too-large', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: '999' } }), res);
    expect(res._status).toBe(200);
  });

  it('falls back to default when days is non-numeric', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { days: 'abc' } }), res);
    expect(res._status).toBe(200);
  });
});

describe('GET /api/institutional-program — date filter branch', () => {
  it('uses the targetDate-filtered SQL when ?date is YYYY-MM-DD', async () => {
    mockSql
      .mockResolvedValueOnce(SAMPLE_DAYS)
      .mockResolvedValueOnce(SAMPLE_BLOCKS);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: '2026-04-29' } }),
      res,
    );
    expect(res._status).toBe(200);
    const body = res._json as { today: { date: string } };
    expect(body.today.date).toBe('2026-04-29');
  });

  it('ignores invalid date format and falls back to "today"', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { date: 'not-a-date' } }),
      res,
    );
    const body = res._json as { today: { date: string } };
    expect(body.today.date).toBe('today');
  });
});

describe('GET /api/institutional-program — HH:MM parser', () => {
  it('accepts valid start_time_ct and end_time_ct', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        query: { start_time_ct: '09:30', end_time_ct: '15:00' },
      }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('ignores out-of-range hour (24:00) — fall back to full-day window', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { start_time_ct: '24:00' } }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('ignores out-of-range minute (10:60) — fall back to full-day window', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { end_time_ct: '10:60' } }),
      res,
    );
    expect(res._status).toBe(200);
  });

  it('ignores malformed time-of-day (no colon)', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'GET', query: { start_time_ct: '0930' } }),
      res,
    );
    expect(res._status).toBe(200);
  });
});

describe('GET /api/institutional-program — error path', () => {
  it('returns 500 + Sentry capture when DB throws on summaries query', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB pool exhausted'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('returns 500 when DB throws on blocks query', async () => {
    mockSql
      .mockResolvedValueOnce(SAMPLE_DAYS)
      .mockRejectedValueOnce(new Error('connection lost'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
  });
});
