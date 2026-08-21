// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// Mock auth-helpers so the rate-limit guard passes by default; keep the real
// cookie constants. timingSafeEqual is imported from node:crypto in the
// handler (not from here), so the secret comparison runs for real. No
// checkBot: the endpoint deliberately omits BotID (its form is served
// standalone, outside the SPA that mints BotID proof).
vi.mock('../_lib/auth-helpers.js', () => ({
  OWNER_COOKIE: 'sc-owner',
  OWNER_COOKIE_MAX_AGE: 604800,
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

// The GET form conditionally renders a "Connect Schwab account instead" link
// when Schwab OAuth creds are present. Mock the predicate so the test doesn't
// depend on the real env-group parser (and doesn't pull in the Redis client).
vi.mock('../_lib/schwab.js', () => ({
  isSchwabConfigured: vi.fn().mockReturnValue(false),
}));

import handler from '../auth/login.js';
import { rejectIfRateLimited } from '../_lib/auth-helpers.js';
import { isSchwabConfigured } from '../_lib/schwab.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  vi.mocked(isSchwabConfigured).mockReturnValue(false);
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OWNER_SECRET;
  delete process.env.VERCEL;
  delete process.env.APP_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function cookieArray(res: ReturnType<typeof mockResponse>): string[] {
  const raw = res._headers['Set-Cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

describe('POST /api/auth/login', () => {
  it('sets sc-owner + sc-hint cookies on the correct secret (JSON path)', async () => {
    process.env.OWNER_SECRET = 'right-secret-123';
    process.env.APP_URL = 'http://localhost:3000';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { secret: 'right-secret-123' },
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });

    const cookies = cookieArray(res);
    const ownerCookie = cookies.find((c) => c.startsWith('sc-owner='));
    const hintCookie = cookies.find((c) => c.startsWith('sc-hint='));
    expect(ownerCookie).toContain('sc-owner=right-secret-123');
    expect(ownerCookie).toContain('HttpOnly');
    expect(ownerCookie).toContain('SameSite=Strict');
    expect(ownerCookie).toContain('Max-Age=604800');
    // localhost APP_URL → no Secure flag
    expect(ownerCookie).not.toContain('Secure');
    expect(hintCookie).toContain('sc-hint=1');
    expect(hintCookie).not.toContain('HttpOnly');
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('redirects to / on the correct secret (form-encoded browser path)', async () => {
    process.env.OWNER_SECRET = 'right-secret-123';
    process.env.APP_URL = 'https://app.example.com';
    process.env.VERCEL = '1';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html,application/xhtml+xml',
        },
        body: { secret: 'right-secret-123' },
      }),
      res,
    );

    expect(res._redirectStatus).toBe(302);
    expect(res._redirectUrl).toBe('/');
    const cookies = cookieArray(res);
    const ownerCookie = cookies.find((c) => c.startsWith('sc-owner='));
    expect(ownerCookie).toContain('sc-owner=right-secret-123');
    // production (VERCEL set, https APP_URL) → Secure flag present
    expect(ownerCookie).toContain('Secure');
  });

  it('returns 401 and sets NO cookie on a wrong secret', async () => {
    process.env.OWNER_SECRET = 'right-secret-123';
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { secret: 'wrong-secret-123' },
      }),
      res,
    );

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid access key' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('returns 401 and NO cookie when OWNER_SECRET is unset (no crash, no leak)', async () => {
    delete process.env.OWNER_SECRET;
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { secret: 'anything-at-all' },
      }),
      res,
    );

    expect(res._status).toBe(401);
    // Identical response to a wrong secret — must not reveal unset-vs-mismatch.
    expect(res._json).toEqual({ error: 'Invalid access key' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('does not throw when the provided secret differs in length (timingSafeEqual guard)', async () => {
    process.env.OWNER_SECRET = 'short';
    const res = mockResponse();
    await expect(
      handler(
        mockRequest({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: { secret: 'a-much-longer-provided-secret-value' },
        }),
        res,
      ),
    ).resolves.not.toThrow();

    expect(res._status).toBe(401);
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { secret: 'right-secret-123' },
      }),
      res,
    );
    expect(res._status).toBe(429);
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });
});

describe('GET /api/auth/login', () => {
  it('returns a dark-themed HTML form with a password input', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/html');
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(res._body).toContain('type="password"');
    expect(res._body).toContain('name="secret"');
    expect(res._body).toContain('/api/auth/login');
  });

  it('omits the Connect-Schwab link when Schwab is not configured', async () => {
    vi.mocked(isSchwabConfigured).mockReturnValue(false);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._body).not.toContain('/api/auth/init');
    expect(res._body).not.toContain('Connect Schwab account instead');
  });

  it('renders the Connect-Schwab link + note when Schwab is configured', async () => {
    vi.mocked(isSchwabConfigured).mockReturnValue(true);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    expect(res._body).toContain(
      '<a href="/api/auth/init">Connect Schwab account instead</a>',
    );
    // One-line note that Schwab is only needed for positions + breadth.
    expect(res._body).toMatch(/positions/i);
    expect(res._body).toMatch(/breadth/i);
    // The owner login form itself is unchanged.
    expect(res._body).toContain('type="password"');
    expect(res._body).toContain('name="secret"');
  });
});

describe('/api/auth/login method guard', () => {
  it('returns 405 for methods other than GET/POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'DELETE' }), res);
    expect(res._status).toBe(405);
  });
});
