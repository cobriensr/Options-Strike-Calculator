// @vitest-environment node

/**
 * Unit tests for `safeDb` / `safeDbVoid` in `api/_lib/db.ts` — the DB-side
 * mirror of `safeRedis` / `safeRedisVoid`. They run a best-effort DB op,
 * swallowing ANY throw, incrementing the `db.error` metric, and returning the
 * fallback. Mirrors `redis.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `safeDb` increments the `db.error` metric on throw. Stub sentry so we can
// assert on it. neon is stubbed so importing db.ts opens no connection.
const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => vi.fn()),
}));

import { safeDb, safeDbVoid } from '../_lib/db.js';

describe('safeDb', () => {
  beforeEach(() => {
    mockIncrement.mockReset();
  });

  it('returns the op result on success and does not increment db.error', async () => {
    const result = await safeDb(async () => 42, -1);
    expect(result).toBe(42);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('returns the resolved value even when it is falsy/null', async () => {
    const result = await safeDb<string | null>(async () => null, 'fallback');
    expect(result).toBeNull();
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('returns the resolved empty array verbatim (not the fallback)', async () => {
    const sentinel = ['fallback'];
    const result = await safeDb<string[]>(async () => [], sentinel);
    expect(result).toEqual([]);
    expect(result).not.toBe(sentinel);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('returns the fallback and increments db.error when op throws', async () => {
    const result = await safeDb(async () => {
      throw new Error('connection timeout');
    }, 'fallback');
    expect(result).toBe('fallback');
    expect(mockIncrement).toHaveBeenCalledWith('db.error');
  });

  it('returns the fallback and increments db.error when op rejects', async () => {
    const result = await safeDb(
      () => Promise.reject(new Error('db unavailable')),
      [] as number[],
    );
    expect(result).toEqual([]);
    expect(mockIncrement).toHaveBeenCalledWith('db.error');
  });
});

describe('safeDbVoid', () => {
  beforeEach(() => {
    mockIncrement.mockReset();
  });

  it('resolves to undefined on success without incrementing db.error', async () => {
    const op = vi.fn(async () => {});
    await expect(safeDbVoid(op)).resolves.toBeUndefined();
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('swallows a throw, resolves undefined, and increments db.error', async () => {
    await expect(
      safeDbVoid(async () => {
        throw new Error('write failed');
      }),
    ).resolves.toBeUndefined();
    expect(mockIncrement).toHaveBeenCalledWith('db.error');
  });
});
