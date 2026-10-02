// @vitest-environment node

/**
 * getSchwabAuthStatus — the non-secret, read-only view of the Schwab login
 * that drives the header countdown and the re-auth reminder cron.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRedisGet, mockRedisSet, mockRedisDel, mockRedisEval } = vi.hoisted(
  () => ({
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn(),
    mockRedisDel: vi.fn(),
    mockRedisEval: vi.fn(),
  }),
);

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockSentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: { increment: vi.fn() },
}));

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    get = mockRedisGet;
    set = mockRedisSet;
    del = mockRedisDel;
    eval = mockRedisEval;
  },
}));

import { getSchwabAuthStatus } from '../_lib/schwab.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T15:00:00Z');

function storedTokens(refreshExpiresAt: unknown) {
  return {
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    expiresAt: NOW + 20 * 60 * 1000,
    refreshExpiresAt,
  };
}

describe('getSchwabAuthStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockRedisEval.mockReset();
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
    // Without this, the malformed-record test's `warn` assertion passes on
    // the warning left behind by the preceding Redis-error test.
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the schwab:tokens record', async () => {
    mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 5 * 24 * HOUR_MS));
    await getSchwabAuthStatus();
    expect(mockRedisGet).toHaveBeenCalledWith('schwab:tokens');
  });

  it('is active with the expiry when more than 24 h remain', async () => {
    const refreshExpiresAt = NOW + 5 * 24 * HOUR_MS;
    mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));
    expect(await getSchwabAuthStatus()).toEqual({
      state: 'active',
      refreshExpiresAt,
    });
  });

  it('is expiring when exactly 24 h remain', async () => {
    const refreshExpiresAt = NOW + 24 * HOUR_MS;
    mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));
    expect(await getSchwabAuthStatus()).toEqual({
      state: 'expiring',
      refreshExpiresAt,
    });
  });

  it('is expiring with 90 minutes left', async () => {
    const refreshExpiresAt = NOW + 90 * 60 * 1000;
    mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));
    expect(await getSchwabAuthStatus()).toEqual({
      state: 'expiring',
      refreshExpiresAt,
    });
  });

  it('is expired (record still stored) once refreshExpiresAt has passed', async () => {
    const refreshExpiresAt = NOW - HOUR_MS;
    mockRedisGet.mockResolvedValueOnce(storedTokens(refreshExpiresAt));
    expect(await getSchwabAuthStatus()).toEqual({
      state: 'expired',
      refreshExpiresAt,
    });
  });

  it('is logged_out when no record is stored', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    expect(await getSchwabAuthStatus()).toEqual({ state: 'logged_out' });
  });

  it("is 'unknown' — never 'logged_out' — when the Redis read fails", async () => {
    mockRedisGet.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await getSchwabAuthStatus()).toEqual({ state: 'unknown' });
    // Logged (and metered) by the token read, not captured: the badge polls
    // this every 5 minutes, and the reminder cron is the loud path.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Redis getStoredTokens failed',
    );
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it("is 'unknown' when the stored record has no usable refreshExpiresAt", async () => {
    mockRedisGet.mockResolvedValueOnce(storedTokens(undefined));
    expect(await getSchwabAuthStatus()).toEqual({ state: 'unknown' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { invalid: ['refreshExpiresAt'] },
      expect.stringContaining('no usable refreshExpiresAt'),
    );
    // Only the bad field's name is logged — never the record's token values.
    const logged = JSON.stringify(mockLogger.warn.mock.calls);
    expect(logged).not.toContain('secret-access-token');
    expect(logged).not.toContain('secret-refresh-token');
  });

  it.each([
    ['a non-JSON string record', 'not-json', '(record)'],
    [
      'a string refreshExpiresAt',
      storedTokens('1727000000000'),
      'refreshExpiresAt',
    ],
  ])("is 'unknown' for %s", async (_label, record, invalidField) => {
    mockRedisGet.mockResolvedValueOnce(record);
    expect(await getSchwabAuthStatus()).toEqual({ state: 'unknown' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { invalid: [invalidField] },
      expect.any(String),
    );
  });

  it('never returns token values', async () => {
    mockRedisGet.mockResolvedValueOnce(storedTokens(NOW + 2 * HOUR_MS));
    const serialized = JSON.stringify(await getSchwabAuthStatus());
    expect(serialized).not.toContain('secret-access-token');
    expect(serialized).not.toContain('secret-refresh-token');
  });

  it('is read-only: never refreshes, writes, or clears the record', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      mockRedisGet.mockResolvedValueOnce(storedTokens(NOW - HOUR_MS));
      await getSchwabAuthStatus();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockRedisDel).not.toHaveBeenCalled();
      expect(mockRedisEval).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
