// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// last-good-cache pattern: stub schwab.ts's shared `redis` singleton so the
// test is decoupled from the upstash init path. kept-tickers uses set
// operations (smembers / sadd / expire) rather than get/set.
const { mockSmembers, mockSadd, mockExpire } = vi.hoisted(() => ({
  mockSmembers: vi.fn(),
  mockSadd: vi.fn(),
  mockExpire: vi.fn(),
}));

const { mockIncrement } = vi.hoisted(() => ({ mockIncrement: vi.fn() }));

vi.mock('../_lib/schwab.js', () => ({
  redis: { smembers: mockSmembers, sadd: mockSadd, expire: mockExpire },
}));

vi.mock('../_lib/sentry.js', () => ({
  metrics: { increment: mockIncrement },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readKeptTickers, addKeptTickers } from '../_lib/kept-tickers.js';

describe('kept-tickers', () => {
  beforeEach(() => {
    mockSmembers.mockReset();
    mockSadd.mockReset();
    mockExpire.mockReset();
    mockIncrement.mockReset();
  });

  describe('readKeptTickers', () => {
    it('returns the day-scoped set members on a hit', async () => {
      mockSmembers.mockResolvedValueOnce(['SNDK', 'TSLA']);
      const result = await readKeptTickers('2026-05-01');
      expect(result).toEqual(['SNDK', 'TSLA']);
      expect(mockSmembers).toHaveBeenCalledWith('lf:kept:2026-05-01');
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns [] when the set is empty (no tickers shown yet)', async () => {
      mockSmembers.mockResolvedValueOnce([]);
      const result = await readKeptTickers('2026-05-01');
      expect(result).toEqual([]);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('returns [] and increments redis.error when smembers throws (KV down)', async () => {
      mockSmembers.mockRejectedValueOnce(new Error('KV unavailable'));
      const result = await readKeptTickers('2026-05-01');
      expect(result).toEqual([]);
      expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    });
  });

  describe('addKeptTickers', () => {
    it('sadds the tickers and sets a 6h TTL on the day key', async () => {
      mockSadd.mockResolvedValueOnce(2);
      mockExpire.mockResolvedValueOnce(1);
      await addKeptTickers('2026-05-01', ['SNDK', 'TSLA']);
      expect(mockSadd).toHaveBeenCalledWith(
        'lf:kept:2026-05-01',
        'SNDK',
        'TSLA',
      );
      expect(mockExpire).toHaveBeenCalledWith('lf:kept:2026-05-01', 6 * 3600);
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('is a no-op on empty input (no redis calls)', async () => {
      await addKeptTickers('2026-05-01', []);
      expect(mockSadd).not.toHaveBeenCalled();
      expect(mockExpire).not.toHaveBeenCalled();
      expect(mockIncrement).not.toHaveBeenCalled();
    });

    it('never throws and increments redis.error when sadd throws', async () => {
      mockSadd.mockRejectedValueOnce(new Error('quota exceeded'));
      await expect(
        addKeptTickers('2026-05-01', ['SNDK']),
      ).resolves.toBeUndefined();
      expect(mockIncrement).toHaveBeenCalledWith('redis.error');
    });

    it('deduplicates input before sadd', async () => {
      mockSadd.mockResolvedValueOnce(1);
      mockExpire.mockResolvedValueOnce(1);
      await addKeptTickers('2026-05-01', ['SNDK', 'SNDK', 'TSLA', 'TSLA']);
      expect(mockSadd).toHaveBeenCalledWith(
        'lf:kept:2026-05-01',
        'SNDK',
        'TSLA',
      );
    });
  });
});
