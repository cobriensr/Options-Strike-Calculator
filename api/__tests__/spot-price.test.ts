// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUwFetch } = vi.hoisted(() => ({ mockUwFetch: vi.fn() }));
vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
}));

import { getSpotPrice, _resetSpotCache } from '../_lib/spot-price.js';

describe('getSpotPrice', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockUwFetch.mockReset();
    _resetSpotCache();
  });

  it('returns the close from the most recent OHLC candle', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { close: '7100.50', end_time: '2026-04-29T15:30:00Z' },
      { close: '7120.12', end_time: '2026-04-29T15:31:00Z' },
    ]);
    const spot = await getSpotPrice('NDX', 'test-key');
    expect(spot).toBe(7120.12);
  });

  it('returns null on empty candle response', async () => {
    mockUwFetch.mockResolvedValueOnce([]);
    expect(await getSpotPrice('NDX', 'test-key')).toBeNull();
  });

  it('returns null when uwFetch throws', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW 500'));
    expect(await getSpotPrice('NDX', 'test-key')).toBeNull();
  });

  it('returns null on non-numeric close', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { close: 'NaN', end_time: '2026-04-29T15:30:00Z' },
    ]);
    expect(await getSpotPrice('NDX', 'test-key')).toBeNull();
  });

  it('returns null on zero or negative close', async () => {
    mockUwFetch.mockResolvedValueOnce([{ close: 0 }]);
    expect(await getSpotPrice('NDX', 'test-key')).toBeNull();
  });

  it('returns null when apiKey is empty', async () => {
    expect(await getSpotPrice('NDX', '')).toBeNull();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('memoizes the last fetched value for 60s per ticker', async () => {
    mockUwFetch.mockResolvedValueOnce([{ close: 7100 }]);

    const first = await getSpotPrice('NDX', 'test-key');
    const second = await getSpotPrice('NDX', 'test-key');

    expect(first).toBe(7100);
    expect(second).toBe(7100);
    // Second call hits the cache, no additional UW fetch.
    expect(mockUwFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps cache per-ticker (different tickers fetch independently)', async () => {
    mockUwFetch
      .mockResolvedValueOnce([{ close: 7100 }])
      .mockResolvedValueOnce([{ close: 24500 }]);

    expect(await getSpotPrice('NDX', 'test-key')).toBe(7100);
    expect(await getSpotPrice('NDXP', 'test-key')).toBe(24500);
    expect(mockUwFetch).toHaveBeenCalledTimes(2);
  });

  it('expires cache after 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T15:30:00Z'));

    mockUwFetch
      .mockResolvedValueOnce([{ close: 7100 }])
      .mockResolvedValueOnce([{ close: 7110 }]);

    expect(await getSpotPrice('NDX', 'test-key')).toBe(7100);
    vi.advanceTimersByTime(61_000);
    expect(await getSpotPrice('NDX', 'test-key')).toBe(7110);
    expect(mockUwFetch).toHaveBeenCalledTimes(2);
  });
});
