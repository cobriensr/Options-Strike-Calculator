// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

import handler from '../auth/guest-logout.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.APP_URL;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/guest-logout', () => {
  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('clears sc-guest + sc-guest-hint cookies', async () => {
    process.env.APP_URL = 'http://localhost:3000';
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    const setCookie = res._headers['Set-Cookie'];
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(' | ')
      : String(setCookie);
    expect(cookieStr).toContain('sc-guest=');
    expect(cookieStr).toContain('sc-guest-hint=');
    expect(cookieStr).toContain('Max-Age=0');
  });

  // Both clearing cookies carry Secure except on a local deployment, by the
  // same rule as the owner cookies (`isLocalDeployment`).
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
      Object.assign(process.env, env);
      const res = mockResponse();
      await handler(mockRequest({ method: 'POST' }), res);
      expect(res._status).toBe(200);
      const cookies = res._headers['Set-Cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie.split('; ').includes('Secure')).toBe(secure);
      }
    },
  );
});
