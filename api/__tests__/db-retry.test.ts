// @vitest-environment node

/**
 * Unit tests for `withDbRetry` and `isRetryableDbError` in
 * `api/_lib/db.ts`. The retry path uses `setTimeout` for linear
 * backoff (1s, 2s); fake timers keep the suite fast.
 *
 * The driver behavior we're modeling:
 *   - On a transient HTTP failure, Neon's serverless driver throws a
 *     `NeonDbError` whose `.message` reads "Error connecting to
 *     database: <inner cause>" and whose `.sourceError` carries the
 *     underlying `TypeError: fetch failed` (or similar).
 *   - On deterministic SQL failures (syntax, constraint), the same
 *     error class is thrown but the message is the Postgres-side
 *     reason, with no transient marker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withDbRetry, isRetryableDbError, TransientDbError } from '../_lib/db.js';
import { DB_RETRY_ATTEMPTS } from '../_lib/constants.js';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isRetryableDbError', () => {
  it('matches NeonDbError-shaped errors with "fetch failed" cause', () => {
    const err = new Error('Error connecting to database: fetch failed');
    err.name = 'NeonDbError';
    expect(isRetryableDbError(err)).toBe(true);
  });

  it('matches errors carrying transient cause on sourceError', () => {
    const inner = new TypeError('fetch failed');
    const err = Object.assign(new Error('Error connecting to database'), {
      name: 'NeonDbError',
      sourceError: inner,
    });
    expect(isRetryableDbError(err)).toBe(true);
  });

  it.each([
    'socket hang up',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN getaddrinfo failed',
    'Request timeout',
    'TLS connection error',
  ])('matches %s', (msg) => {
    expect(isRetryableDbError(new Error(msg))).toBe(true);
  });

  it('does not match deterministic Postgres errors', () => {
    expect(isRetryableDbError(new Error('column "bogus" does not exist'))).toBe(
      false,
    );
    expect(
      isRetryableDbError(
        new Error('duplicate key value violates unique constraint'),
      ),
    ).toBe(false);
  });

  it('does not match non-Error throwables', () => {
    expect(isRetryableDbError('fetch failed')).toBe(false);
    expect(isRetryableDbError(null)).toBe(false);
    expect(isRetryableDbError(undefined)).toBe(false);
  });
});

describe('withDbRetry', () => {
  function transientError(): Error {
    const err = new Error('Error connecting to database: fetch failed');
    err.name = 'NeonDbError';
    return err;
  }

  it('returns the value when fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withDbRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on transient failure and resolves', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce('ok');

    const promise = withDbRetry(fn);
    // Drain the 1s backoff before the second attempt.
    await vi.advanceTimersByTimeAsync(1100);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries twice with linear backoff before giving up', async () => {
    // Async function so the rejection is produced INSIDE the await
    // pipeline — avoids the brief "unhandled" window that appears when
    // returning Promise.reject() from a sync callback under
    // useFakeTimers + shouldAdvanceTime.
    const fn = vi.fn(async () => {
      throw transientError();
    });

    let caught: unknown = null;
    const promise = withDbRetry(fn, 2).catch((err: unknown) => {
      caught = err;
    });
    // Backoff schedule: 1s after attempt 0 fails, 2s after attempt 1.
    await vi.advanceTimersByTimeAsync(3500);
    await promise;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/fetch failed/);
    // Initial + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('defaults its retry budget to DB_RETRY_ATTEMPTS (single source of truth)', async () => {
    // No explicit `retries` arg → the default must come from the shared
    // constant, so total attempts == 1 initial + DB_RETRY_ATTEMPTS retries.
    const fn = vi.fn(async () => {
      throw transientError();
    });

    let caught: unknown = null;
    const promise = withDbRetry(fn).catch((err: unknown) => {
      caught = err;
    });
    // Drain the full linear backoff schedule (1s, 2s, … up to the budget).
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(caught).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(DB_RETRY_ATTEMPTS + 1);
  });

  it('does not retry deterministic errors (re-throws on first attempt)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error('column "bogus" does not exist'));

    await expect(withDbRetry(fn)).rejects.toThrow(/bogus/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wraps the exhausted transient error in TransientDbError, preserving the cause', async () => {
    const original = transientError();
    const fn = vi.fn(async () => {
      throw original;
    });

    let caught: unknown = null;
    const promise = withDbRetry(fn, 1).catch((err: unknown) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(1100);
    await promise;

    // A retryable error that exhausts its retries is now rethrown as a
    // typed TransientDbError so HTTP handlers can distinguish a real Neon
    // blip from a genuine bug. The original error is preserved on `.cause`
    // and its message is forwarded, so caller logging/triage is unchanged.
    expect(caught).toBeInstanceOf(TransientDbError);
    expect((caught as TransientDbError).cause).toBe(original);
    expect((caught as Error).message).toBe(original.message);
  });
});
