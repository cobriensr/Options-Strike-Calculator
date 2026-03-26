// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/db.js', () => ({
  getVixOhlcFromSnapshots: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) =>
      cb({ setTransactionName: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
  },
}));

import handler from '../vix-ohlc.js';
import { checkBot } from '../_lib/api-helpers.js';
import { getVixOhlcFromSnapshots } from '../_lib/db.js';

describe('GET /api/vix-ohlc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
  });

  it('returns 405 for non-GET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 403 for bots', async () => {
    vi.mocked(checkBot).mockResolvedValue({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: '2026-03-10' } }), res);
    expect(res._status).toBe(403);
  });

  it('returns 400 for missing date', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toMatch(/date/i);
  });

  it('returns 400 for invalid date format', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: 'not-a-date' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns OHLC data when snapshots exist', async () => {
    vi.mocked(getVixOhlcFromSnapshots).mockResolvedValue({
      open: 17.80,
      high: 19.20,
      low: 17.80,
      close: 19.20,
      count: 3,
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: '2026-03-10' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      open: 17.80,
      high: 19.20,
      low: 17.80,
      close: 19.20,
      count: 3,
    });
  });

  it('returns null fields and count 0 when no snapshots exist', async () => {
    vi.mocked(getVixOhlcFromSnapshots).mockResolvedValue(null);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: '2026-03-10' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      open: null,
      high: null,
      low: null,
      close: null,
      count: 0,
    });
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getVixOhlcFromSnapshots).mockRejectedValue(new Error('DB down'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', query: { date: '2026-03-10' } }), res);
    expect(res._status).toBe(500);
  });
});
