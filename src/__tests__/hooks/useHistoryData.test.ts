import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  historyVixOHLC,
  useHistoryData,
  useHistoryVixOHLCFallback,
} from '../../hooks/useHistoryData';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import { getAccessMode, type AccessMode } from '../../utils/auth';
import { getETToday } from '../../utils/timezone';
import type { VIXDataMap, VIXDayData } from '../../types';
import type { HistoryResponse } from '../../types/api';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);
const mockGetAccessMode = vi.mocked(getAccessMode);

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

const spxCandles = [
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
];

const spxPreviousDay = {
  date: '2024-03-01',
  open: 5080,
  high: 5100,
  low: 5070,
  close: 5090,
  rangePct: 0.59,
  rangePts: 30,
};

/** Stub SymbolDayData with a single flat candle for non-SPX symbols */
function makeStubSymbol(price: number) {
  return {
    candles: [makeCandle(9, 30, price, price, price, price)],
    previousClose: price,
    previousDay: null,
  };
}

const mockHistory: HistoryResponse = {
  date: '2024-03-04',
  spx: {
    candles: spxCandles,
    previousClose: 5090,
    previousDay: spxPreviousDay,
  },
  vix: makeStubSymbol(14.5),
  vix1d: makeStubSymbol(10.2),
  vix9d: makeStubSymbol(12.8),
  vvix: makeStubSymbol(85),
  candleCount: 13,
  asOf: '2024-03-04T20:00:00Z',
};

// ============================================================
// SETUP
// ============================================================

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCaptureUnlessAuth.mockClear();
  mockGetAccessMode.mockReturnValue('owner');
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
  mockHistoryBody(data);
}

// A 200 from /api/history with any body, well-formed or not.
function mockHistoryBody(data: unknown) {
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

  describe('today (clock pinned to a Wednesday session)', () => {
    // Fake only Date so waitFor and promises keep running on real timers.
    // 2026-03-04T15:00:00Z is Wednesday 10:00 ET, a weekday regardless of
    // the machine's local zone.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-04T15:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const todayET = () =>
      new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });

    it('fetches today and returns null when no candles are available', async () => {
      // Today is now fetched so users can scrub back to earlier times within
      // the current trading session. The default 401 mock simulates a fresh
      // environment or pre-market state where no candles exist yet.
      const today = todayET();
      // The pin holds: ET "today" is the pinned Wednesday, in any local zone.
      expect(today).toBe('2026-03-04');
      const { result } = renderHook(() => useHistoryData(today));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.history).toBeNull();
      expect(result.current.hasHistory).toBe(false);
    });

    it('returns hasHistory true when today has intraday candles', async () => {
      // On a weekday with market data, today fetches successfully so the
      // user can time-scrub within the current session.
      mockHistoryFetch(mockHistory);
      const today = todayET();

      const { result } = renderHook(() => useHistoryData(today));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.hasHistory).toBe(true);
      expect(result.current.history).not.toBeNull();
    });
  });

  it('returns null for future dates', () => {
    const { result } = renderHook(() => useHistoryData('2099-12-31'));
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    // Skipped before the fetch: api/history rejects future dates.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
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

    expect(result.current.error).toBe('unknown');
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

  // The running range is taken over candles 0..index of the array it is
  // given, so it only stays free of lookahead while each datetime appears
  // once, in order. /api/history guarantees that (a doubled session once
  // handed every snapshot of its day the full day's high and low).
  it('stops the running high and low at the requested time', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    // 10:00 AM ET = candle index 6, so the 10:05..10:30 candles (day high
    // 5162) are still in the future.
    const at1000 = result.current.getStateAtTime(10, 0)!.runningOHLC;
    expect(at1000).toEqual({ open: 5100, high: 5140, low: 5095, last: 5138 });

    const atOpen = result.current.getStateAtTime(9, 30)!.runningOHLC;
    expect(atOpen).toEqual({ open: 5100, high: 5110, low: 5095, last: 5105 });
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

  it('exposes previousClose for gap calculation', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot).not.toBeNull();
    // Previous close comes from spx.previousClose
    expect(snapshot!.previousClose).toBe(5090);
    // Today's open is the first candle's open
    expect(snapshot!.runningOHLC.open).toBe(5100);
    // Gap = 5100 - 5090 = 10
    expect(snapshot!.runningOHLC.open - snapshot!.previousClose).toBe(10);
  });

  it('includes previousDay data in snapshot', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot!.yesterday).toEqual(mockHistory.spx.previousDay);
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
      spx: { ...mockHistory.spx, candles: [] },
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
      spx: { ...mockHistory.spx, candles: mockHistory.spx.candles.slice(0, 3) },
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
      spx: { ...mockHistory.spx, previousDay: null },
    };
    mockHistoryFetch(noPrevDay);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot!.yesterday).toBeNull();
  });

  it('returns null VIX values when symbol has empty candles', async () => {
    const noVixCandles: HistoryResponse = {
      ...mockHistory,
      vix: { candles: [], previousClose: 0, previousDay: null },
      vix1d: { candles: [], previousClose: 12, previousDay: null },
      vix9d: { candles: [], previousClose: 0, previousDay: null },
      vvix: { candles: [], previousClose: 85, previousDay: null },
    };
    mockHistoryFetch(noVixCandles);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    const snapshot = result.current.getStateAtTime(10, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.vix).toBeNull();
    expect(snapshot!.vix1d).toBeNull();
    expect(snapshot!.vix9d).toBeNull();
    expect(snapshot!.vvix).toBeNull();
    // previousClose of 0 should become null
    expect(snapshot!.vixPrevClose).toBeNull();
  });

  it('returns error with HTTP status when response body has no error field', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/history')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'Service unavailable' }),
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

    expect(result.current.error).toBe('HTTP 503');
  });

  it('shows specific error when candleCount is 0', async () => {
    const zeroCandles: HistoryResponse = {
      ...mockHistory,
      spx: { ...mockHistory.spx, candles: spxCandles },
      candleCount: 0,
    };
    mockHistoryFetch(zeroCandles);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('No intraday data available');
    expect(result.current.history).toBeNull();
  });
});

// ============================================================
// TESTS: MALFORMED 200 PAYLOADS
// ============================================================

describe('useHistoryData: malformed 200 payloads', () => {
  it.each([
    ['an empty object', {}],
    [
      'a wrong-typed spx.candles',
      { ...mockHistory, spx: { ...mockHistory.spx, candles: 'oops' } },
    ],
    [
      'a candle with a string close',
      {
        ...mockHistory,
        spx: {
          ...mockHistory.spx,
          candles: [{ ...spxCandles[0], close: '5105' }],
        },
      },
    ],
  ])('treats %s as a failed fetch', async (_label, body) => {
    mockHistoryBody(body);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('invalid response shape');
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.getStateAtTime(10, 0)).toBeNull();
  });

  it('drops the previous date history when the next date is malformed', async () => {
    mockHistoryFetch(mockHistory);
    const { result, rerender } = renderHook(
      ({ date }: { date: string }) => useHistoryData(date),
      { initialProps: { date: '2024-03-04' } },
    );
    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    mockHistoryBody({ date: '2024-03-05' });
    rerender({ date: '2024-03-05' });

    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
  });

  it('reports a schema failure to Sentry by name with the date and issues', async () => {
    mockHistoryBody({});

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'history response failed schema validation',
    );
    const context = (
      options as { contexts: { history: Record<string, unknown> } }
    ).contexts.history;
    expect(context.date).toBe('2024-03-04');
    // Flat "path: message" strings: Sentry would flatten issue objects to
    // "[Object]" at its depth-3 normalization.
    const issues = context.issues as unknown[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toEqual(expect.stringMatching(/^[\w.]+: \S/));
    }
    expect(issues).toContainEqual(expect.stringMatching(/^spx: /));
    expect(context.issueCount).toBe(issues.length);
  });

  it('treats a 2xx body that is not JSON as a failed fetch and reports it', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('invalid response (not JSON)');
    expect(result.current.history).toBeNull();
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect((err as Error).message).toBe('history response was not JSON');
    expect(options).toEqual({
      contexts: {
        history: { date: '2024-03-04', detail: 'Unexpected token <' },
      },
    });
  });

  it('does not report a well-formed response to Sentry', async () => {
    mockHistoryFetch(mockHistory);

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });
});

// ============================================================
// TESTS: A MISSING previousClose
// ============================================================

// An old `history:v3` entry, or a response the browser cached before
// api/history.ts took previousDay.close, can lack previousClose: Schwab left
// its own out on an empty day, and JSON drops undefined. The VIX-family
// symbols tolerate that (0, as the endpoint sends for a failed symbol or an
// unknown previous session); SPX stays strict.
describe('useHistoryData: a missing previousClose', () => {
  function withoutPreviousClose(
    symbol: HistoryResponse['vix'],
  ): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...symbol };
    delete rest.previousClose;
    return rest;
  }

  const VIX_FAMILY = ['vix', 'vix1d', 'vix9d', 'vvix'] as const;

  function omitVixFamilyPreviousClose(
    history: HistoryResponse,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...history };
    for (const key of VIX_FAMILY) out[key] = withoutPreviousClose(history[key]);
    return out;
  }

  it('still reports an empty day as "No intraday data available"', async () => {
    mockHistoryBody(
      omitVixFamilyPreviousClose({
        ...mockHistory,
        spx: { ...mockHistory.spx, candles: [] },
        candleCount: 0,
      }),
    );

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('No intraday data available');
    expect(result.current.history).toBeNull();
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('accepts a trading day whose VIX symbols lack it, as 0', async () => {
    mockHistoryBody(omitVixFamilyPreviousClose(mockHistory));

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    expect(result.current.history?.vix.previousClose).toBe(0);
    // 0 reads as "unknown", the same as a failed symbol's.
    expect(result.current.getStateAtTime(10, 0)?.vixPrevClose).toBeNull();
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('rejects a payload whose SPX lacks it', async () => {
    mockHistoryBody({
      ...mockHistory,
      spx: withoutPreviousClose(mockHistory.spx),
    });

    const { result } = renderHook(() => useHistoryData('2024-03-04'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('invalid response shape');
    expect(result.current.history).toBeNull();
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// TESTS: ACCESS MODE
// ============================================================

/**
 * renderHook with a changeable date, plus every value the hook returned, one
 * per render. `snapshot` is `getStateAtTime(10, 0)` as that render saw it.
 */
function renderRecorded(initialDate = '2024-03-04') {
  const renders: (ReturnType<typeof useHistoryData> & {
    snapshot: ReturnType<ReturnType<typeof useHistoryData>['getStateAtTime']>;
  })[] = [];
  const rendered = renderHook(
    ({ date }: { date: string }) => {
      const value = useHistoryData(date);
      renders.push({ ...value, snapshot: value.getStateAtTime(10, 0) });
      return value;
    },
    { initialProps: { date: initialDate } },
  );
  return { ...rendered, renders };
}

/** Let any request the mount or a rerender started settle or not start. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

// A date the hook skips before any request, whatever the viewer's access.
const SKIPPED_DATES = [
  ['empty', ''],
  ['in the future', '2099-12-31'],
  ['a Saturday', '2024-03-02'],
  ['a Sunday', '2024-03-03'],
  ['a market holiday', '2025-12-25'],
] as const;

describe.each(['owner', 'guest'] as const satisfies readonly AccessMode[])(
  'useHistoryData: %s keeps fetching',
  (mode) => {
    beforeEach(() => {
      mockGetAccessMode.mockReturnValue(mode);
    });

    it('fetches the selected past date and returns its history', async () => {
      mockHistoryFetch(mockHistory);

      const { result } = renderHook(() => useHistoryData('2024-03-04'));

      await waitFor(() => {
        expect(result.current.hasHistory).toBe(true);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/history?date=2024-03-04',
        expect.objectContaining({ credentials: 'same-origin' }),
      );
      expect(result.current.history).toEqual(mockHistory);
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    it('surfaces a non-2xx reply by name', async () => {
      mockHistoryError(503, 'Schwab unavailable');

      const { result } = renderHook(() => useHistoryData('2024-03-04'));

      await waitFor(() => {
        expect(result.current.error).toBe('Schwab unavailable');
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.history).toBeNull();
    });

    it('surfaces a rejected fetch by name', async () => {
      fetchMock.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() => useHistoryData('2024-03-04'));

      await waitFor(() => {
        expect(result.current.error).toBe('Network failure');
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.history).toBeNull();
    });

    it.each(SKIPPED_DATES)(
      'makes no request for a date that is %s',
      async (_label, date) => {
        const { result } = renderHook(() => useHistoryData(date));
        await flush();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.current.history).toBeNull();
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
      },
    );

    // The effect's cleanup aborts the request in flight, and an aborted
    // request never reaches the `setLoading(false)` after its reply, so a
    // skipped date has to clear the flag itself or AppHeader keeps a "Loading…"
    // badge next to BACKTEST for as long as that date is selected.
    it.each(SKIPPED_DATES)(
      'clears loading when a date that is %s replaces a fetch in flight',
      async (_label, date) => {
        fetchMock.mockReturnValue(new Promise(() => {}));
        const { result, rerender } = renderRecorded('2024-03-04');
        await waitFor(() => {
          expect(result.current.loading).toBe(true);
        });

        rerender({ date });
        await flush();

        expect(result.current.loading).toBe(false);
        expect(result.current.history).toBeNull();
        expect(result.current.error).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('fetches again on each date pick', async () => {
      mockHistoryFetch(mockHistory);
      const { result, rerender } = renderRecorded('2024-03-04');
      await waitFor(() => {
        expect(result.current.hasHistory).toBe(true);
      });

      rerender({ date: '2024-03-05' });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(fetchMock.mock.calls[1]![0]).toBe('/api/history?date=2024-03-05');
    });

    it('does not fetch again on a plain re-render', async () => {
      mockHistoryFetch(mockHistory);
      const { result, rerender } = renderRecorded();
      await waitFor(() => {
        expect(result.current.hasHistory).toBe(true);
      });

      rerender({ date: '2024-03-04' });
      rerender({ date: '2024-03-04' });
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not fetch again, or drop its history, when the mode flips between owner and guest', async () => {
      mockHistoryFetch(mockHistory);
      const { result, rerender } = renderRecorded();
      await waitFor(() => {
        expect(result.current.hasHistory).toBe(true);
      });

      mockGetAccessMode.mockReturnValue(mode === 'owner' ? 'guest' : 'owner');
      rerender({ date: '2024-03-04' });
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.history).toEqual(mockHistory);
      expect(result.current.hasHistory).toBe(true);
    });
  },
);

// /api/history is owner-or-guest. For a public visitor "no history" is the
// answer, not an error: the unmocked fetch below is a 401 "Not authenticated",
// which a hook that asked would hand to AppHeader as a red "NO INTRADAY"
// badge on every past date the visitor picks.
describe('useHistoryData: public visitor', () => {
  beforeEach(() => {
    mockGetAccessMode.mockReturnValue('public');
  });

  it('makes no request for a past date on mount, and shows no history and no error', async () => {
    const { result } = renderHook(() => useHistoryData('2024-03-04'));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.history).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.getStateAtTime(10, 0)).toBeNull();
  });

  describe('today (clock pinned to a Wednesday session)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-04T15:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('makes no request for today either', async () => {
      const today = getETToday();
      expect(today).toBe('2026-03-04');

      const { result } = renderHook(() => useHistoryData(today));
      await flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  it('makes no request on a date pick, whatever the date', async () => {
    const { result, rerender } = renderRecorded('2024-03-04');
    for (const date of ['2024-03-05', '', '2099-12-31', '2024-03-06']) {
      rerender({ date });
    }
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.history).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('hides history fetched while signed in once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    mockHistoryFetch(mockHistory);
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });
    expect(renders.at(-1)?.snapshot).not.toBeNull();

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender({ date: '2024-03-04' });

    // The first render after the drop commits before any effect runs, so it
    // is the one that would paint the held history: it must already be empty.
    expect(renders[before]?.history).toBeNull();
    expect(renders[before]?.hasHistory).toBe(false);
    expect(renders[before]?.snapshot).toBeNull();
    expect(renders[before]?.error).toBeNull();
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.getStateAtTime(10, 0)).toBeNull();
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hides an error left in memory once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    mockHistoryError(401, 'Not authenticated');
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => {
      expect(result.current.error).toBe('Not authenticated');
    });

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender({ date: '2024-03-04' });

    expect(renders[before]?.error).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('aborts the request in flight on a drop to public, and keeps nothing from its late reply', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    let signal: AbortSignal | undefined;
    let reply: (res: unknown) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((resolve) => {
            signal = init.signal ?? undefined;
            reply = resolve;
          }),
      )
      // The sign-back-in's request never settles, so only history kept from
      // the aborted one could show up below.
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });
    expect(signal?.aborted).toBe(false);

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender({ date: '2024-03-04' });
    expect(signal?.aborted).toBe(true);
    expect(renders[before]?.loading).toBe(false);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      reply({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockHistory),
      });
      await Promise.resolve();
    });
    expect(result.current.history).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockGetAccessMode.mockReturnValue('guest');
    rerender({ date: '2024-03-04' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
  });

  it('fetches the selected date once the visitor signs in without a reload', async () => {
    mockHistoryFetch(mockHistory);
    const { result, rerender } = renderRecorded();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // The mode is read at render and sits in the effect's deps, not frozen at
    // mount: signing in with a guest key starts the fetch for the date the
    // visitor already picked.
    mockGetAccessMode.mockReturnValue('guest');
    rerender({ date: '2024-03-04' });

    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/history?date=2024-03-04',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(result.current.history).toEqual(mockHistory);
    expect(result.current.error).toBeNull();
  });

  it('starts clean, not from the earlier session, when the visitor signs back in', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockHistory),
        }),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderRecorded();
    await waitFor(() => {
      expect(result.current.hasHistory).toBe(true);
    });

    mockGetAccessMode.mockReturnValue('public');
    rerender({ date: '2024-03-04' });
    mockGetAccessMode.mockReturnValue('guest');
    rerender({ date: '2024-03-04' });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.history).toBeNull();
    expect(result.current.hasHistory).toBe(false);
    expect(result.current.loading).toBe(true);
  });
});

// ============================================================
// historyVixOHLC
// ============================================================

describe('historyVixOHLC', () => {
  const vixCandles = [
    makeCandle(9, 30, 14.5, 15.1, 14.4, 14.9),
    makeCandle(9, 35, 14.9, 15.6, 14.8, 15.4),
    makeCandle(9, 40, 15.4, 15.5, 13.9, 14.2),
  ];
  const withVix: HistoryResponse = {
    ...mockHistory,
    vix: { candles: vixCandles, previousClose: 14.1, previousDay: null },
  };

  it("derives the date's VIX OHLC from its own history's candles", () => {
    expect(historyVixOHLC(withVix, '2024-03-04')).toEqual({
      open: 14.5,
      high: 15.6,
      low: 13.9,
      close: 14.2,
    });
  });

  it("returns null for another date's history", () => {
    // useHistoryData keeps the last date's history while the new date's
    // loads; its OHLC must not be filled in as the new date's VIX.
    expect(historyVixOHLC(withVix, '2024-03-05')).toBeNull();
  });

  it('returns null without history or VIX candles', () => {
    expect(historyVixOHLC(null, '2024-03-04')).toBeNull();
    expect(
      historyVixOHLC(
        {
          ...withVix,
          vix: { candles: [], previousClose: 0, previousDay: null },
        },
        '2024-03-04',
      ),
    ).toBeNull();
  });
});

// ============================================================
// useHistoryVixOHLCFallback (App's wiring)
// ============================================================

describe('useHistoryVixOHLCFallback', () => {
  const vixCandles = [
    makeCandle(9, 30, 14.5, 15.1, 14.4, 14.9),
    makeCandle(9, 35, 14.9, 15.6, 14.8, 15.4),
  ];
  const own: HistoryResponse = {
    ...mockHistory,
    vix: { candles: vixCandles, previousClose: 14.1, previousDay: null },
  };
  const OHLC = { open: 14.5, high: 15.6, low: 14.4, close: 15.4 };

  interface Props {
    history: HistoryResponse | null;
    date: string;
    vixOHLC: VIXDayData | null;
    /** The static table; empty unless a test gives the date an entry. */
    vixData?: VIXDataMap;
  }

  function mount(initialProps: Props) {
    const setVixOHLC = vi.fn();
    const view = renderHook(
      ({ history, date, vixOHLC, vixData = {} }: Props) =>
        useHistoryVixOHLCFallback(history, date, vixOHLC, setVixOHLC, vixData),
      { initialProps },
    );
    return { ...view, setVixOHLC };
  }

  it("fills the date's VIX OHLC from its own history when none is set", () => {
    const { setVixOHLC } = mount({
      history: own,
      date: '2024-03-04',
      vixOHLC: null,
    });

    expect(setVixOHLC).toHaveBeenCalledTimes(1);
    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  const OTHER = { open: 20, high: 21, low: 19, close: 20.5 };

  it("leaves the static table's entry for a past date alone", () => {
    const { setVixOHLC } = mount({
      history: own,
      date: '2024-03-04',
      vixOHLC: OTHER,
      vixData: { '2024-03-04': OTHER },
    });

    expect(setVixOHLC).not.toHaveBeenCalled();
  });

  it("replaces a past date's snapshot-derived OHLC with the candles'", () => {
    // /api/vix-ohlc samples the snapshots saved that day; the candles cover
    // the whole session.
    const { setVixOHLC } = mount({
      history: own,
      date: '2024-03-04',
      vixOHLC: OTHER,
    });

    expect(setVixOHLC).toHaveBeenCalledTimes(1);
    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  it("replaces the snapshot-derived OHLC when the date's candles arrive later", () => {
    const { setVixOHLC, rerender } = mount({
      history: null,
      date: '2024-03-04',
      vixOHLC: OTHER,
    });
    expect(setVixOHLC).not.toHaveBeenCalled();

    rerender({ history: own, date: '2024-03-04', vixOHLC: OTHER });
    expect(setVixOHLC).toHaveBeenCalledTimes(1);
    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  it('sets the candles once, not again when they are already the OHLC', () => {
    const { setVixOHLC, rerender } = mount({
      history: own,
      date: '2024-03-04',
      vixOHLC: OTHER,
    });
    const set = setVixOHLC.mock.calls[0]![0] as VIXDayData;

    rerender({ history: own, date: '2024-03-04', vixOHLC: set });
    expect(setVixOHLC).toHaveBeenCalledTimes(1);
  });

  it("replaces today's snapshot-derived OHLC with the candles' too", () => {
    const today = getETToday();
    const { setVixOHLC } = mount({
      history: { ...own, date: today },
      date: today,
      vixOHLC: OTHER,
    });

    expect(setVixOHLC).toHaveBeenCalledTimes(1);
    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  it("fills today's OHLC from the candles when none is set", () => {
    const today = getETToday();
    const { setVixOHLC } = mount({
      history: { ...own, date: today },
      date: today,
      vixOHLC: null,
    });

    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  it("leaves the static table's entry for today alone", () => {
    const today = getETToday();
    const { setVixOHLC } = mount({
      history: { ...own, date: today },
      date: today,
      vixOHLC: OTHER,
      vixData: { [today]: OTHER },
    });

    expect(setVixOHLC).not.toHaveBeenCalled();
  });

  it("keeps today's API OHLC when today has no VIX candles", () => {
    const today = getETToday();
    const { setVixOHLC } = mount({
      history: {
        ...own,
        date: today,
        vix: { candles: [], previousClose: 0, previousDay: null },
      },
      date: today,
      vixOHLC: OTHER,
    });

    expect(setVixOHLC).not.toHaveBeenCalled();
  });

  it("keeps a past date's API OHLC when the date has no VIX candles", () => {
    const { setVixOHLC } = mount({
      history: {
        ...own,
        vix: { candles: [], previousClose: 0, previousDay: null },
      },
      date: '2024-03-04',
      vixOHLC: OTHER,
    });

    expect(setVixOHLC).not.toHaveBeenCalled();
  });

  it("fills nothing from the last date's history while the new one loads", () => {
    // useHistoryData keeps 03-04's history after the switch to 03-05.
    const { setVixOHLC, rerender } = mount({
      history: own,
      date: '2024-03-05',
      vixOHLC: null,
    });
    expect(setVixOHLC).not.toHaveBeenCalled();

    // 03-05's own history arrives.
    rerender({
      history: { ...own, date: '2024-03-05' },
      date: '2024-03-05',
      vixOHLC: null,
    });
    expect(setVixOHLC).toHaveBeenCalledTimes(1);
    expect(setVixOHLC).toHaveBeenCalledWith(OHLC);
  });

  it('fills nothing without history', () => {
    const { setVixOHLC } = mount({
      history: null,
      date: '2024-03-04',
      vixOHLC: null,
    });

    expect(setVixOHLC).not.toHaveBeenCalled();
  });
});
