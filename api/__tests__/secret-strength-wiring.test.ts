// @vitest-environment node

/**
 * The request path (`isOwner`) and the cron path (`cronGuard`) both run the
 * short-secret check. `secret-strength` is replaced at its module boundary, so
 * these tests pin only that each guard calls it, on every outcome; what the
 * check reports is covered in secret-strength.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockWarnWeakSecretsOnce } = vi.hoisted(() => ({
  mockWarnWeakSecretsOnce: vi.fn(),
}));

vi.mock('../_lib/secret-strength.js', () => ({
  warnWeakSecretsOnce: mockWarnWeakSecretsOnce,
}));
import { OWNER_COOKIE, isOwner } from '../_lib/auth-helpers.js';
import { cronGuard } from '../_lib/cron-helpers.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OWNER_SECRET', 'owner-secret-for-the-wiring-test');
  vi.stubEnv('CRON_SECRET', 'cron-secret-for-the-wiring-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isOwner', () => {
  it('runs the check when the owner cookie matches', () => {
    const req = mockRequest({
      headers: { cookie: `${OWNER_COOKIE}=owner-secret-for-the-wiring-test` },
    });

    expect(isOwner(req)).toBe(true);
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });

  it('runs the check when the owner cookie does not match', () => {
    const req = mockRequest({
      headers: { cookie: `${OWNER_COOKIE}=something-else` },
    });

    expect(isOwner(req)).toBe(false);
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });

  it('runs the check when OWNER_SECRET is unset', () => {
    vi.stubEnv('OWNER_SECRET', undefined);

    expect(isOwner(mockRequest({ headers: {} }))).toBe(false);
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });
});

describe('cronGuard', () => {
  it('runs the check on a request it rejects for its method', () => {
    const res = mockResponse();

    expect(cronGuard(mockRequest({ method: 'POST' }), res)).toBeNull();
    expect(res._status).toBe(405);
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });

  it('runs the check on a request it rejects for its bearer token', () => {
    const res = mockResponse();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });

    expect(cronGuard(req, res)).toBeNull();
    expect(res._status).toBe(401);
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });

  it('runs the check on a request it accepts', () => {
    const res = mockResponse();
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret-for-the-wiring-test' },
    });

    expect(
      cronGuard(req, res, { marketHours: false, requireApiKey: false }),
    ).not.toBeNull();
    expect(mockWarnWeakSecretsOnce).toHaveBeenCalledTimes(1);
  });
});
