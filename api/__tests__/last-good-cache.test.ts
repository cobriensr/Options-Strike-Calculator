// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the redis mock is available when the vi.mock factory
// runs (hoisted above imports). last-good-cache imports the shared `redis`
// singleton from schwab.ts; we stub schwab.ts here rather than the upstash
// client so the test is decoupled from schwab's own init path.
const { mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
}));

const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/schwab.js', () => ({
  redis: { get: mockRedisGet, set: mockRedisSet },
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readLastGood, writeLastGood } from '../_lib/last-good-cache.js';

describe('last-good-cache', () => {
  beforeEach(() => {
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockIncrement.mockReset();
  });

  describe('readLastGood', () => {
    it('returns the cached value on a hit', async () => {
      const cached = [{ id: 1 }, { id: 2 }];
      mockRedisGet.mockResolvedValueOnce(cached);
      const result = await readLastGood<typeof cached>('lf:lg:chainExtras:x');
      expect(result).toEqual(cached);
      expect(mockRedisGet).toHaveBeenCalledWith('lf:lg:chainExtras:x');
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns null on a miss (redis returns null)', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      const result = await readLastGood('lf:lg:cluster:x');
      expect(result).toBeNull();
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns null and increments redis.error when redis.get throws', async () => {
      mockRedisGet.mockRejectedValueOnce(new Error('KV unavailable'));
      const result = await readLastGood('lf:lg:sbChains:x');
      expect(result).toBeNull();
      expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    });
  });

  describe('writeLastGood', () => {
    it('calls redis.set with the ex TTL and swallows nothing on success', async () => {
      mockRedisSet.mockResolvedValueOnce('OK');
      await writeLastGood('lf:lg:chainExtras:x', [{ id: 1 }], 3600);
      expect(mockRedisSet).toHaveBeenCalledWith(
        'lf:lg:chainExtras:x',
        [{ id: 1 }],
        { ex: 3600 },
      );
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('never throws and increments redis.error when redis.set throws', async () => {
      mockRedisSet.mockRejectedValueOnce(new Error('quota exceeded'));
      await expect(
        writeLastGood('lf:lg:cluster:x', [], 3600),
      ).resolves.toBeUndefined();
      expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    });
  });
});
