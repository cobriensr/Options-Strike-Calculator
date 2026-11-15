// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockSet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock('../_lib/redis.js', () => ({
  limiterRedis: { get: mockGet, set: mockSet },
}));
vi.mock('../_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import logger from '../_lib/logger.js';
import {
  readWinRateCache,
  winRateCacheKey,
  writeWinRateCache,
} from '../_lib/takeit-winrate-cache.js';

const ROWS = [
  { underlying_symbol: 'NVDA', win_rate: 0.5 },
  { underlying_symbol: 'TSLA', win_rate: null },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('winRateCacheKey', () => {
  it('names the alert type and the ET date, under a version', () => {
    expect(winRateCacheKey('lottery', '2026-11-13')).toBe(
      'takeit:winrates:v1:lottery:2026-11-13',
    );
    expect(winRateCacheKey('silentboom', '2026-11-13')).toBe(
      'takeit:winrates:v1:silentboom:2026-11-13',
    );
  });
});

describe('readWinRateCache', () => {
  it('returns the cached rows on a hit', async () => {
    mockGet.mockResolvedValueOnce(ROWS);

    await expect(readWinRateCache('lottery', '2026-11-13')).resolves.toEqual(
      ROWS,
    );
    expect(mockGet).toHaveBeenCalledExactlyOnceWith(
      'takeit:winrates:v1:lottery:2026-11-13',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null on a miss, without a warning', async () => {
    mockGet.mockResolvedValueOnce(null);

    await expect(readWinRateCache('lottery', '2026-11-13')).resolves.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a win rate of exactly 0 or 1, and a null one', async () => {
    const edges = [
      { underlying_symbol: 'A', win_rate: 0 },
      { underlying_symbol: 'B', win_rate: 1 },
      { underlying_symbol: 'C', win_rate: null },
    ];
    mockGet.mockResolvedValueOnce(edges);

    await expect(readWinRateCache('lottery', '2026-11-13')).resolves.toEqual(
      edges,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'not json rows'],
    ['an object, not a list', { underlying_symbol: 'NVDA' }],
    ['a row with no symbol', [{ win_rate: 0.5 }]],
    [
      'a win rate that is a string',
      [{ underlying_symbol: 'A', win_rate: '1' }],
    ],
    // A rate is a share of winning fires, so outside 0-1 is a corrupt row
    // (the same bound as the weights schema's win_rate): it would feed
    // Take-It a value the model never saw, for the whole day.
    [
      'a win rate above 1',
      [
        { underlying_symbol: 'A', win_rate: 0.4 },
        { underlying_symbol: 'B', win_rate: 5 },
      ],
    ],
    ['a negative win rate', [{ underlying_symbol: 'A', win_rate: -0.2 }]],
    ['an empty list', []],
  ])(
    'treats %s as a miss and warns, so the load repairs the key',
    async (_, payload) => {
      mockGet.mockResolvedValueOnce(payload);

      await expect(
        readWinRateCache('lottery', '2026-11-13'),
      ).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          key: 'takeit:winrates:v1:lottery:2026-11-13',
        }),
        'takeit win-rate cache: unusable payload; loading from Neon',
      );
    },
  );

  it('falls back to a miss with a warning when Redis rejects', async () => {
    const down = new Error('connect ETIMEDOUT');
    mockGet.mockRejectedValueOnce(down);

    await expect(readWinRateCache('lottery', '2026-11-13')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { err: down, key: 'takeit:winrates:v1:lottery:2026-11-13' },
      'takeit win-rate cache: read failed; loading from Neon',
    );
  });
});

describe('writeWinRateCache', () => {
  it('stores the rows under the day key for 26 hours', async () => {
    mockSet.mockResolvedValueOnce('OK');

    await writeWinRateCache('lottery', '2026-11-13', ROWS);

    expect(mockSet).toHaveBeenCalledExactlyOnceWith(
      'takeit:winrates:v1:lottery:2026-11-13',
      ROWS,
      { ex: 26 * 60 * 60 },
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never stores an empty answer: a gap would otherwise stand for the whole day', async () => {
    await writeWinRateCache('lottery', '2026-11-13', []);

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('warns and resolves when Redis rejects, so the run keeps its rows', async () => {
    const down = new Error('connect ETIMEDOUT');
    mockSet.mockRejectedValueOnce(down);

    await expect(
      writeWinRateCache('lottery', '2026-11-13', ROWS),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { err: down, key: 'takeit:winrates:v1:lottery:2026-11-13' },
      'takeit win-rate cache: write failed; the next instance will load from Neon',
    );
  });
});
