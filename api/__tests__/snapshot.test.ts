// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  rejectIfRateLimited: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  saveSnapshot: vi.fn(),
}));

import handler from '../snapshot.js';
import { rejectIfNotOwner, rejectIfRateLimited } from '../_lib/api-helpers.js';
import { saveSnapshot } from '../_lib/db.js';

describe('POST /api/snapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  });

  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(401);
  });

  it('returns early when rate limited', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'Rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(429);
  });

  it('returns 400 when date is missing', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { entryTime: '09:35' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date and entryTime are required' });
  });

  it('returns 400 when entryTime is missing', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { date: '2026-03-10' } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: 'date and entryTime are required' });
  });

  it('saves snapshot and returns id', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(saveSnapshot).mockResolvedValue(123);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: 123, saved: true });
    expect(saveSnapshot).toHaveBeenCalledWith({
      date: '2026-03-10',
      entryTime: '09:35',
    });
  });

  it('returns saved:false when saveSnapshot returns null', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(saveSnapshot).mockResolvedValue(null);

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: null, saved: false });
  });

  it('returns 200 with saved:false on database error', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(saveSnapshot).mockRejectedValue(new Error('DB error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { date: '2026-03-10', entryTime: '09:35' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: null, saved: false });

    consoleSpy.mockRestore();
  });
});
