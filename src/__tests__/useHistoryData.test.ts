import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useHistoryData } from '../hooks/useHistoryData';
import type { HistoryResponse } from '../types/api';

// ============================================================
// MOCK DATA
// ============================================================

/** Build a candle at a given ET hour:minute on 2024-03-04 */
function makeCandle(
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
) {
  // Build a Date in America/New_York for 2024-03-04 at the given time
  // March 2024 is EST (UTC-5)
  const dt = new Date(Date.UTC(2024, 2, 4, hour + 5, minute, 0));
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const mm = String(minute).padStart(2, '0');
  return {
    datetime: dt.getTime(),
    time: `${h12}:${mm} ${ampm}`,
    open,
    high,
    low,
    close,
  };
}

const mockHistory: HistoryResponse = {
  date: '2024-03-04',
  candles: [
    makeCandle(9, 30, 5100, 5110, 5095, 5105), // 0: open
    makeCandle(9, 35, 5105, 5115, 5100, 5112), // 1
    makeCandle(9, 40, 5112, 5120, 5108, 5118), // 2
    makeCandle(9, 45, 5118, 5125, 5115, 5122), // 3
    makeCandle(9, 50, 5122, 5130, 5120, 5128), // 4
    makeCandle(9, 55, 5128, 5135, 5125, 5132), // 5: end of opening range
    makeCandle(10, 0, 5132, 5140, 5130, 5138), // 6
    makeCandle(10, 5, 5138, 5145, 5135, 5142), // 7
    makeCandle(10, 10, 5142, 5150, 5140, 5148), // 8
    makeCandle(10, 15, 5148, 5155, 5145, 5152), // 9
    makeCandle(10, 20, 5152, 5158, 5148, 5155), // 10
    makeCandle(10, 25, 5155, 5160, 5150, 5157), // 11
    makeCandle(10, 30, 5157, 5162, 5153, 5160), // 12
  ],
  previousClose: 5090,
  previousDay: {
    date: '2024-03-01',
    open: 5080,
    high: 5100,
    low: 5070,
    close: 5090,
    rangePct: 0.59,
    rangePts: 30,
  },
  candleCount: 13,
  asOf: '2024-03-04T20:00:00Z',
};

// ============================================================
// SETUP
// ============================================================

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Not authenticated' }),
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Override fetch to return history for a specific date
function mockHistoryFetch(data: HistoryResponse) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/history')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Not authenticated' }),
    });
  });
}

function mockHistoryError(status: number, message: string) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/history')) {
      return Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve({ error: message }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Not authenticated' }),
    });
  });
}

// ============================================================
// TESTS: BASIC BEHAVIOR
// ============================================================

describe('useHistoryData: basic behavior', () => {
  it('returns null history when no date is selected', () => {
    const { result } = renderHook(() => useHistoryData(''));
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns null for today (uses live data instead)', () => {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    const { result } = renderHook(() => useHistoryData(today));
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/history'),
      expect.anything(),
    );
  });

  it('returns null for future dates', () => {
    const { result } = renderHook(() => useHistoryData('2099-12-31'));
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
  });

  it('fetches history for a past date', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.history).toEqual(mockHistory);
    expect(result.current.hasHistory).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('sets error when fetch fails', async () => {
    mockHistoryError(500, 'Internal server error');

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Internal server error');
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
  });

  it('handles network error gracefully', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new Error('Network failure')),
    );

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network failure');
    expect(result.current.history).toBeNull();
  });

  it('handles non-Error throw gracefully', async () => {
    fetchMock.mockImplementation(() => Promise.reject('unknown')); // NOSONAR: intentionally rejecting with non-Error to test graceful handling

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
  });

  it('handles error response with no JSON body', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/history')) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('not json')),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'x' }),
      });
    });

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('HTTP 502');
  });

  it('clears history when date is cleared', async () => {
    mockHistoryFetch(mockHistory);

    const { result, rerender } = renderHook(
      ({ date }: { date: string }) => useHistoryData(date),
      { initialProps: { date: '2024-03-04' } },
    );

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    rerender({ date: '' });

    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
  });

  it('cancels in-flight request when date changes', async () => {
    mockHistoryFetch(mockHistory);

    const { result, rerender } = renderHook(
      ({ date }: { date: string }) => useHistoryData(date),
      { initialProps: { date: '2024-03-04' } },
    );

    // Immediately change to a different date before first fetch resolves
    rerender({ date: '2024-03-05' });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // The first request should have been cancelled
    // (we can't directly test the cancelled flag, but the hook should be stable)
    expect(result.current.history).not.toBeNull();
  });
});

// ============================================================
// TESTS: getStateAtTime
// ============================================================

describe('useHistoryData: getStateAtTime', () => {
  it('returns null when no history loaded', () => {
    const { result } = renderHook(() => useHistoryData(''));
    expect(result.current.getStateAtTime(10, 0)).toBeNull();
  });

  it('returns snapshot at exact candle time', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    // 10:00 AM ET = candle index 6
    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.spot).toBe(5138); // close of 10:00 candle
    expect(snapshot!.spy).toBeCloseTo(513.8, 1); // spot / 10
    expect(snapshot!.candleIndex).toBe(6);
    expect(snapshot!.totalCandles).toBe(13);
  });

  it('returns previous candle for non-boundary time', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    // 10:03 AM ET is between 10:00 and 10:05 candles — should get 10:00
    const snapshot = result.current.getStateAtTime(10, 3);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.candleIndex).toBe(6); // 10:00 candle
  });

  it('returns first candle for pre-market time', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    // 8:00 AM ET is before market open
    const snapshot = result.current.getStateAtTime(8, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.candleIndex).toBe(0); // First candle
  });

  it('computes running OHLC correctly', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    // At 10:30 (last candle, index 12)
    const snapshot = result.current.getStateAtTime(10, 30);
    expect(snapshot).not.toBeNull();

    const ohlc = snapshot!.runningOHLC;
    expect(ohlc.open).toBe(5100); // First candle's open
    expect(ohlc.last).toBe(5160); // Last candle's close
    // High should be the max high across all candles
    expect(ohlc.high).toBe(5162);
    // Low should be the min low across all candles
    expect(ohlc.low).toBe(5095);
  });

  it('computes opening range from first 6 candles', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 30);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.openingRange).not.toBeNull();

    const or = snapshot!.openingRange!;
    expect(or.complete).toBe(true); // We have >= 6 candles
    // High of first 6 candles: max of 5110, 5115, 5120, 5125, 5130, 5135
    expect(or.high).toBe(5135);
    // Low of first 6 candles: min of 5095, 5100, 5108, 5115, 5120, 5125
    expect(or.low).toBe(5095);
    expect(or.rangePts).toBe(40);
  });

  it('computes overnight gap', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.overnightGap).not.toBeNull();

    const gap = snapshot!.overnightGap!;
    // Today open (5100) - previous close (5090) = 10
    expect(gap.gapPts).toBe(10);
    expect(gap.gapPct).toBeCloseTo(0.2, 1); // 10/5090 ≈ 0.196%
  });

  it('returns null overnight gap when previousClose is 0', async () => {
    const noCloseHistory: HistoryResponse = {
      ...mockHistory,
      previousClose: 0,
    };
    mockHistoryFetch(noCloseHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.overnightGap).toBeNull();
  });

  it('includes previousDay data in snapshot', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot!.yesterday).toEqual(mockHistory.previousDay);
    expect(snapshot!.previousClose).toBe(5090);
  });
});

// ============================================================
// TESTS: EDGE CASES
// ============================================================

describe('useHistoryData: edge cases', () => {
  it('handles empty candles array', async () => {
    const emptyHistory: HistoryResponse = {
      ...mockHistory,
      candles: [],
      candleCount: 0,
    };
    mockHistoryFetch(emptyHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // hasHistory should be false with empty candles
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.getStateAtTime(10, 0)).toBeNull();
  });

  it('opening range is incomplete with fewer than 6 candles', async () => {
    const shortHistory: HistoryResponse = {
      ...mockHistory,
      candles: mockHistory.candles.slice(0, 3),
      candleCount: 3,
    };
    mockHistoryFetch(shortHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(9, 40);
    expect(snapshot!.openingRange).not.toBeNull();
    expect(snapshot!.openingRange!.complete).toBe(false);
  });

  it('returns null previousDay when history has none', async () => {
    const noPrevDay: HistoryResponse = {
      ...mockHistory,
      previousDay: null,
    };
    mockHistoryFetch(noPrevDay);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot!.yesterday).toBeNull();
  });
});
