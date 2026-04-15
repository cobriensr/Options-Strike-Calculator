// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

const { mockCheckBot, mockRejectIfNotOwner, mockBuildFeaturesHandler } =
  vi.hoisted(() => ({
    mockCheckBot: vi.fn(),
    mockRejectIfNotOwner: vi.fn(),
    mockBuildFeaturesHandler: vi.fn(),
  }));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: mockCheckBot,
  rejectIfNotOwner: mockRejectIfNotOwner,
}));

vi.mock('../cron/build-features.js', () => ({
  default: mockBuildFeaturesHandler,
}));

import handler from '../journal/backfill-features';

describe('POST /api/journal/backfill-features', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    mockCheckBot.mockResolvedValue({ isBot: false });
    mockRejectIfNotOwner.mockReturnValue(false);
    mockBuildFeaturesHandler.mockImplementation(async (_req, res) => {
      res.status(200).json({ dates: 5, featuresBuilt: 5, errors: 0 });
    });
  });

  it('rejects non-POST methods with 405', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects bots with 403', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(mockBuildFeaturesHandler).not.toHaveBeenCalled();
  });

  it('rejects non-owner with 401 (via rejectIfNotOwner)', async () => {
    mockRejectIfNotOwner.mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Not owner' });
      return true;
    });
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockBuildFeaturesHandler).not.toHaveBeenCalled();
  });

  it('returns 500 when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'CRON_SECRET not configured' });
  });

  it('forwards a synthetic GET request with backfill=true and bearer auth to the cron handler', async () => {
    const req = mockRequest({ method: 'POST', headers: { foo: 'bar' } });
    const res = mockResponse();
    await handler(req, res);

    expect(mockBuildFeaturesHandler).toHaveBeenCalledTimes(1);
    const forwardedReq = mockBuildFeaturesHandler.mock.calls[0]![0];
    expect(forwardedReq.method).toBe('GET');
    expect(forwardedReq.query.backfill).toBe('true');
    expect(forwardedReq.headers.authorization).toBe('Bearer test-secret');
    // Original headers preserved
    expect(forwardedReq.headers.foo).toBe('bar');
  });

  it('passes the cron handler response straight through', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ dates: 5, featuresBuilt: 5 });
  });

  it('returns 500 if the cron handler throws after headers sent', async () => {
    mockBuildFeaturesHandler.mockRejectedValueOnce(new Error('downstream'));
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    // headersSent is false in our mock res, so the catch should set 500.
    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'downstream' });
  });
});
