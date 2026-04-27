// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

import handler from '../auth/guest-logout.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
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
});
