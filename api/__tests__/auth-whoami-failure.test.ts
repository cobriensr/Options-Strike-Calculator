// @vitest-environment node

/**
 * GET /api/auth/whoami when a step it depends on fails: the renewal cookies
 * cannot be built, or the rate limiter itself throws.
 *
 * Kept apart from auth-whoami.test.ts because it replaces the api-helpers
 * boundary: the request carries an owner cookie, the limiter lets it through,
 * the owner check passes, then `buildOwnerSessionCookies` throws (or the
 * limiter throws first). The endpoint must answer 500 with one Sentry capture
 * of that error, set no cookie, and still tell caches not to store the
 * failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCaptureException, mockBuildCookies, mockLimiter } = vi.hoisted(
  () => ({
    mockCaptureException: vi.fn(),
    mockBuildCookies: vi.fn(),
    mockLimiter: vi.fn(),
  }),
);

vi.mock('../_lib/api-helpers.js', () => ({
  isOwner: vi.fn(() => true),
  isLocalDeployment: vi.fn(() => false),
  buildOwnerSessionCookies: mockBuildCookies,
  OWNER_COOKIE: 'sc-owner',
  parseCookies: vi.fn(() => ({ 'sc-owner': 'presented-value' })),
  rejectIfRateLimited: mockLimiter,
}));

vi.mock('../_lib/guest-auth.js', () => ({
  GUEST_COOKIE: 'sc-guest',
  isGuest: vi.fn(() => false),
}));

// Spy on the capture only; the isolation scope and metrics stay real.
vi.mock('../_lib/sentry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/sentry.js')>();
  return {
    ...actual,
    Sentry: { ...actual.Sentry, captureException: mockCaptureException },
  };
});

import handler from '../auth/whoami.js';

describe('GET /api/auth/whoami renewal failure', () => {
  const failure = new Error('OWNER_SECRET is not set');

  beforeEach(() => {
    mockCaptureException.mockClear();
    mockLimiter.mockReset().mockResolvedValue(false);
    mockBuildCookies.mockReset().mockImplementation(() => {
      throw failure;
    });
  });

  it('answers 500, captures the error once, and sets no cookie', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(failure);
  });

  it('marks the failed response no-store', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('answers 500 and captures once when the limiter throws, before any cookie is built', async () => {
    const limiterFailure = new Error('limiter unavailable');
    mockLimiter.mockRejectedValueOnce(limiterFailure);
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(mockBuildCookies).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(limiterFailure);
  });
});
