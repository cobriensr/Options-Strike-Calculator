// @vitest-environment node

/**
 * GET /api/auth/whoami when the renewal cookies cannot be built.
 *
 * Kept apart from auth-whoami.test.ts because it replaces the api-helpers
 * boundary: the owner check passes, then `buildOwnerSessionCookies` throws.
 * The endpoint must answer 500 with one Sentry capture of that error, set no
 * cookie, and still tell caches not to store the failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCaptureException, mockBuildCookies } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockBuildCookies: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  isOwner: vi.fn(() => true),
  isLocalDeployment: vi.fn(() => false),
  buildOwnerSessionCookies: mockBuildCookies,
}));

vi.mock('../_lib/guest-auth.js', () => ({
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
});
