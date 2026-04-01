// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn().mockReturnValue(false),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
  setCacheHeaders: vi.fn(),
}));

const mockDbFn = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockDbFn),
}));

import handler from '../pre-market.js';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  checkBot,
} from '../_lib/api-helpers.js';

describe('GET /api/pre-market', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for PUT', async () => {
    const req = mockRequest({ method: 'PUT' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET or POST only' });
  });

  it('returns 405 for DELETE', async () => {
    const req = mockRequest({ method: 'DELETE' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  // ── Auth guards ───────────────────────────────────────────

  it('returns 403 when bot detected', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('returns 401 when not owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(429);
  });

  // ── GET success ───────────────────────────────────────────

  it('returns saved pre-market data for a given date', async () => {
    const preMarketData = {
      globexHigh: 5710,
      globexLow: 5690,
      globexClose: 5705,
      globexVwap: 5700,
      straddleConeUpper: 5750,
      straddleConeLower: 5650,
      savedAt: '2026-03-28T12:00:00Z',
    };
    mockDbFn.mockResolvedValueOnce([{ pre_market_data: preMarketData }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-28' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: preMarketData });
  });

  it('returns null when no data exists for date', async () => {
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-28' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: null });
  });

  it('returns null when pre_market_data column is null', async () => {
    mockDbFn.mockResolvedValueOnce([{ pre_market_data: null }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-28' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: null });
  });

  it('defaults to today ET when no date param', async () => {
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: null });
  });

  it('returns 500 on DB error', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('DB down'));

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-03-28' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to fetch' });
  });
});

describe('POST /api/pre-market', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbFn.mockReset();
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
    vi.mocked(checkBot).mockResolvedValue({ isBot: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── Validation ────────────────────────────────────────────

  it('returns 400 when date is missing', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { globexHigh: 5710, globexLow: 5690, globexClose: 5705 },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toBeDefined();
  });

  it('returns 400 when globexHigh is missing', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { date: '2026-03-28', globexLow: 5690, globexClose: 5705 },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toBeDefined();
  });

  it('returns 400 when globexLow is missing', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { date: '2026-03-28', globexHigh: 5710, globexClose: 5705 },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('returns 400 when globexClose is missing', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { date: '2026-03-28', globexHigh: 5710, globexLow: 5690 },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  // ── Upsert: update existing ───────────────────────────────

  it('updates existing snapshot on POST', async () => {
    // SELECT returns existing snapshot
    mockDbFn.mockResolvedValueOnce([{ id: 42 }]);
    // UPDATE
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'POST',
      body: {
        date: '2026-03-28',
        globexHigh: 5710,
        globexLow: 5690,
        globexClose: 5705,
        globexVwap: 5700,
        straddleConeUpper: 5750,
        straddleConeLower: 5650,
        savedAt: '2026-03-28T12:00:00Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ saved: true });
    expect(mockDbFn).toHaveBeenCalledTimes(2);
  });

  // ── Upsert: insert new ────────────────────────────────────

  it('inserts new snapshot when none exists', async () => {
    // SELECT returns empty
    mockDbFn.mockResolvedValueOnce([]);
    // INSERT
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'POST',
      body: {
        date: '2026-03-28',
        globexHigh: 5710,
        globexLow: 5690,
        globexClose: 5705,
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ saved: true });
    expect(mockDbFn).toHaveBeenCalledTimes(2);
  });

  // ── Optional fields default to null ───────────────────────

  it('defaults optional fields to null', async () => {
    mockDbFn.mockResolvedValueOnce([]);
    mockDbFn.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'POST',
      body: {
        date: '2026-03-28',
        globexHigh: 5710,
        globexLow: 5690,
        globexClose: 5705,
        // no globexVwap, straddleConeUpper, straddleConeLower, savedAt
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ saved: true });
  });

  // ── DB error on POST ──────────────────────────────────────

  it('returns 500 on DB error during save', async () => {
    mockDbFn.mockRejectedValueOnce(new Error('DB write failed'));

    const req = mockRequest({
      method: 'POST',
      body: {
        date: '2026-03-28',
        globexHigh: 5710,
        globexLow: 5690,
        globexClose: 5705,
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Failed to save' });
  });
});
