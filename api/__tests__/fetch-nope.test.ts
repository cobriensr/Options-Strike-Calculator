// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler, { type UwNopeRow } from '../cron/fetch-nope.js';

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ROW: UwNopeRow = {
  timestamp: '2026-04-14T18:46:00Z',
  call_vol: 23421,
  put_vol: 20012,
  stock_vol: 1000000,
  call_delta: '-21257.36',
  put_delta: '-43593.96',
  call_fill_delta: '-28564.02',
  put_fill_delta: '-14947.51',
  nope: '-0.000648',
  nope_fill: '-0.000434',
};

const makeRow = (overrides: Partial<UwNopeRow> = {}): UwNopeRow => ({
  ...SAMPLE_ROW,
  ...overrides,
});

const GUARD = { apiKey: 'test-uw-key', today: '2026-04-14' };

describe('fetch-nope handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockUwFetch.mockResolvedValue([]);
  });

  // ── Happy path ─────────────────────────────────────────────

  it('upserts 3 rows and returns 200 with upserted:3', async () => {
    const rows = [
      makeRow({ timestamp: '2026-04-14T18:45:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
      makeRow({ timestamp: '2026-04-14T18:47:00Z' }),
    ];
    mockUwFetch.mockResolvedValueOnce(rows);
    mockSql
      .mockResolvedValueOnce([{ ticker: 'SPY' }])
      .mockResolvedValueOnce([{ ticker: 'SPY' }])
      .mockResolvedValueOnce([{ ticker: 'SPY' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      fetched: 3,
      upserted: 3,
    });
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Empty UW response ──────────────────────────────────────

  it('returns 200 with upserted:0 when UW returns no rows', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      fetched: 0,
      upserted: 0,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Rule 2 guard: skip rows with zero stock_vol ────────────

  it('skips rows where stock_vol is 0 (undefined NOPE denominator)', async () => {
    const rows = [
      makeRow({ timestamp: '2026-04-14T18:45:00Z', stock_vol: 0 }),
      makeRow({ timestamp: '2026-04-14T18:46:00Z' }),
    ];
    mockUwFetch.mockResolvedValueOnce(rows);
    mockSql.mockResolvedValueOnce([{ ticker: 'SPY' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, upserted: 1 });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── Fetches SPY, not SPX ───────────────────────────────────

  it('calls UW for SPY (not SPX)', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    const calledPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(calledPath).toBe('/stock/SPY/nope');
  });

  // ── Guard rejected ─────────────────────────────────────────

  it('does nothing when cronGuard returns undefined', async () => {
    mockCronGuard.mockReturnValueOnce(undefined);

    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);

    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Error handling ─────────────────────────────────────────

  it('returns 500 and reports to Sentry on UW failure', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW 500'));

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'fetch-nope',
      error: 'UW 500',
    });
  });
});
