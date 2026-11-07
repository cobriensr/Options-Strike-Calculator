// @vitest-environment node

/**
 * Unit tests for api/_lib/uw-spot.ts.
 *
 * Mocks uwFetch at its module boundary (R3) and asserts the request path,
 * the newest-row pick, and each way the helper reports "no usable spot".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUwFetch = vi.hoisted(() => vi.fn());
vi.mock('../_lib/uw-fetch.js', () => ({ uwFetch: mockUwFetch }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

import { fetchUwSpot } from '../_lib/uw-spot.js';

describe('fetchUwSpot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requests the per-minute spot-exposures path without a date by default', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { price: '5800.5', time: '2026-11-09T15:00:00Z' },
    ]);

    await fetchUwSpot('key', 'SPX');

    expect(mockUwFetch).toHaveBeenCalledTimes(1);
    expect(mockUwFetch).toHaveBeenCalledWith(
      'key',
      '/stock/SPX/spot-exposures',
    );
  });

  it('appends ?date= when a date is given', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { price: '5800.5', time: '2026-10-22T20:00:00Z' },
    ]);

    await fetchUwSpot('key', 'SPY', '2026-10-22');

    expect(mockUwFetch).toHaveBeenCalledWith(
      'key',
      '/stock/SPY/spot-exposures?date=2026-10-22',
    );
  });

  it('returns the newest row by time when rows arrive out of order', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { price: '5801', time: '2026-11-09T15:02:00Z' },
      { price: '5790', time: '2026-11-09T14:30:00Z' },
      { price: '5805.25', time: '2026-11-09T15:10:00Z' },
      { price: '5795', time: '2026-11-09T14:55:00Z' },
    ]);

    const spot = await fetchUwSpot('key', 'SPX');

    expect(spot).toEqual({ price: 5805.25, time: '2026-11-09T15:10:00Z' });
  });

  it('orders by start_time when a row carries one, ahead of time', async () => {
    // start_time ?? time, the convention in fetch-spot-gex.ts. The first row's
    // start_time is the newest even though its `time` is the oldest.
    mockUwFetch.mockResolvedValueOnce([
      {
        price: '5810',
        start_time: '2026-11-09T15:20:00Z',
        time: '2026-11-09T14:00:00Z',
      },
      { price: '5800', time: '2026-11-09T15:10:00Z' },
    ]);

    const spot = await fetchUwSpot('key', 'SPX');

    expect(spot).toEqual({ price: 5810, time: '2026-11-09T15:20:00Z' });
  });

  it('returns null with a warning when UW returns no rows', async () => {
    mockUwFetch.mockResolvedValueOnce([]);

    await expect(fetchUwSpot('key', 'SPX')).resolves.toBeNull();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'SPX' }),
      'fetchUwSpot: no usable spot row',
    );
  });

  it.each([
    ['NaN', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-5800'],
    ['missing', undefined],
  ])(
    'returns null with a warning when the newest price is %s',
    async (_n, price) => {
      mockUwFetch.mockResolvedValueOnce([
        { price: '5700', time: '2026-11-09T14:00:00Z' },
        { price, time: '2026-11-09T15:00:00Z' },
      ]);

      await expect(fetchUwSpot('key', 'SPX')).resolves.toBeNull();

      // The newest row decides: an older valid price is not a current spot.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ ticker: 'SPX' }),
        'fetchUwSpot: newest spot price is not a positive number',
      );
    },
  );

  it('skips rows with an unparseable timestamp when picking the newest', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { price: '1', time: 'garbage' },
      { price: '5800', time: '2026-11-09T15:00:00Z' },
    ]);

    const spot = await fetchUwSpot('key', 'SPX');

    expect(spot).toEqual({ price: 5800, time: '2026-11-09T15:00:00Z' });
  });

  it('returns null with a warning when no row has a parseable timestamp', async () => {
    mockUwFetch.mockResolvedValueOnce([
      { price: '5800', time: 'garbage' },
      { price: '5801' },
    ]);

    await expect(fetchUwSpot('key', 'SPX')).resolves.toBeNull();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'SPX', rows: 2 }),
      'fetchUwSpot: no usable spot row',
    );
  });

  it('lets a uwFetch rejection propagate (the caller owns retry and surfacing)', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 503: unavailable'));

    await expect(fetchUwSpot('key', 'SPX')).rejects.toThrow(
      'UW API 503: unavailable',
    );
  });
});
