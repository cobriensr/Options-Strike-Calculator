// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  respondIfInvalid: vi.fn().mockReturnValue(false),
}));

import handler from '../auth/guest-key.js';
import { rejectIfRateLimited, respondIfInvalid } from '../_lib/api-helpers.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  vi.mocked(respondIfInvalid).mockReturnValue(false);
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GUEST_ACCESS_KEYS;
  delete process.env.VERCEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/guest-key', () => {
  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { key: 'something' } }),
      res,
    );
    expect(res._status).toBe(429);
  });

  it('returns 400 for invalid body', async () => {
    vi.mocked(respondIfInvalid).mockImplementation((_parsed, res) => {
      res.status(400).json({ error: 'bad body' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST', body: { key: 'short' } }), res);
    expect(res._status).toBe(400);
  });

  it('returns 401 when env keys are unset', async () => {
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { key: 'unconfigured-key-123' },
      }),
      res,
    );
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid access key' });
  });

  it('returns 401 for a bad key', async () => {
    process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { key: 'wrong-key-12345678' } }),
      res,
    );
    expect(res._status).toBe(401);
  });

  it('sets sc-guest + sc-guest-hint cookies on a valid key', async () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-key-12345678';
    process.env.APP_URL = 'http://localhost:3000';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        body: { key: 'shared-key-12345678' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    const setCookie = res._headers['Set-Cookie'];
    // We use setHeader with an array; when re-asserted as string it serializes.
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(' | ')
      : String(setCookie);
    expect(cookieStr).toContain('sc-guest=shared-key-12345678');
    expect(cookieStr).toContain('sc-guest-hint=1');
    expect(cookieStr).toContain('HttpOnly');
  });

  it('matches against any entry in a comma-separated list', async () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-12345678,bravo-12345678';
    const res = mockResponse();
    await handler(
      mockRequest({ method: 'POST', body: { key: 'bravo-12345678' } }),
      res,
    );
    expect(res._status).toBe(200);
  });
});
