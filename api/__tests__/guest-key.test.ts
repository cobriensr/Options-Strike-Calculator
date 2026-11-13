// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// The limiter and body check are stubbed; the local-deployment rule stays
// real so the Secure flag tests below pin the handler's actual output.
vi.mock('../_lib/api-helpers.js', async () => {
  const { isLocalDeployment } = await vi.importActual<
    typeof import('../_lib/auth-helpers.js')
  >('../_lib/auth-helpers.js');
  return {
    isLocalDeployment,
    rejectIfRateLimited: vi.fn().mockResolvedValue(false),
    respondIfInvalid: vi.fn().mockReturnValue(false),
  };
});

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
  delete process.env.VERCEL_ENV;
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

  // Both guest cookies carry Secure except on a local deployment, by the same
  // rule as the owner cookies (`isLocalDeployment`).
  it.each<[string, Record<string, string>, boolean]>([
    [
      'a production URL on Vercel',
      { APP_URL: 'https://example.com', VERCEL: '1', VERCEL_ENV: 'production' },
      true,
    ],
    // VERCEL is unset here: that alone no longer counts as local.
    ['a production URL', { APP_URL: 'https://example.com' }, true],
    ['an unset APP_URL', {}, true],
    ['a localhost URL', { APP_URL: 'http://localhost:3000' }, false],
    ['a 127.0.0.1 URL', { APP_URL: 'http://127.0.0.1:3000' }, false],
    [
      'a localhost URL on a production deploy',
      { APP_URL: 'http://localhost:3000', VERCEL_ENV: 'production' },
      true,
    ],
  ])(
    'sets Secure on both cookies only off localhost: %s',
    async (_label, env, secure) => {
      process.env.GUEST_ACCESS_KEYS = 'shared-key-12345678';
      delete process.env.APP_URL;
      Object.assign(process.env, env);
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'POST', body: { key: 'shared-key-12345678' } }),
        res,
      );
      expect(res._status).toBe(200);
      const cookies = res._headers['Set-Cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie.split('; ').includes('Secure')).toBe(secure);
      }
    },
  );

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
