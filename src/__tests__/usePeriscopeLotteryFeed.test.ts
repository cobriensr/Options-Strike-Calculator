/**
 * usePeriscopeLotteryFeed — polling hook backing the PeriscopeLotteryPanel.
 * Polls every 60s only when date is today AND marketOpen.
 * Cancels in-flight fetches on unmount and on key changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePeriscopeLotteryFeed } from '../hooks/usePeriscopeLotteryFeed';
import type {
  PeriscopeLotteryFeedResponse,
  PeriscopeLotteryFire,
} from '../components/PeriscopeLottery/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function emptyFeed(
  overrides: Partial<PeriscopeLotteryFeedResponse> = {},
): PeriscopeLotteryFeedResponse {
  return {
    date: '2026-05-18',
    fireType: 'both',
    count: 0,
    fires: [],
    ...overrides,
  };
}

function sampleFire(
  overrides: Partial<PeriscopeLotteryFire> = {},
): PeriscopeLotteryFire {
  return {
    id: 1,
    fireType: 'call_lottery',
    fireTime: '2026-05-18T18:43:12Z',
    expiry: '2026-05-18',
    eventStrike: 7380,
    tradeStrike: 7430,
    spotAtEvent: 7362.14,
    strikeDist: 17.86,
    greekPost: -7403.4,
    greekDelta: -4513.3,
    greekLvlRank: 0.95,
    greekChgRank: 0.999,
    gexDollars: -974008661,
    callRatio: -3.58,
    qqqNetPremBalance30m: 0.6,
    entryPx: 0.1,
    vix: 18.31,
    v3StrictPass: true,
    v4Badge: true,
    peakPx: 25,
    peakPct: 250,
    peakTime: '2026-05-18T19:01:47Z',
    eodClosePx: 0.05,
    realizedRPeak: 249,
    realizedREod: -0.5,
    outcomeLocked: true,
    createdAt: '2026-05-18T18:43:50Z',
    ...overrides,
  };
}

describe('usePeriscopeLotteryFeed', () => {
  it('builds the URL with date, fire_type=both, limit=50 by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      usePeriscopeLotteryFeed({ date: '2026-05-18', marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/periscope-lottery-feed?');
    expect(url).toContain('date=2026-05-18');
    expect(url).toContain('fire_type=both');
    expect(url).toContain('limit=50');
  });

  it('threads fireType and limit overrides into the URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      usePeriscopeLotteryFeed({
        date: '2026-05-18',
        marketOpen: false,
        fireType: 'call_lottery',
        limit: 25,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('fire_type=call_lottery');
    expect(url).toContain('limit=25');
  });

  it('clears loading and exposes fires on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFeed({ count: 1, fires: [sampleFire()] })),
    );
    const { result } = renderHook(() =>
      usePeriscopeLotteryFeed({ date: '2026-05-18', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fires).toHaveLength(1);
    expect(result.current.fires[0]?.tradeStrike).toBe(7430);
    expect(result.current.fires[0]?.v4Badge).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('exposes the error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      usePeriscopeLotteryFeed({ date: '2026-05-18', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.fires).toEqual([]);
  });

  it('polls every 60s when marketOpen=true and not historical', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      usePeriscopeLotteryFeed({
        date: '2026-05-18',
        marketOpen: true,
        historical: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 60s passes — one more fetch fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Another 60s — third fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not poll when historical=true (date is in the past)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      usePeriscopeLotteryFeed({
        date: '2024-01-01',
        marketOpen: true,
        historical: true,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance well past the 60s poll interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when marketOpen=false', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      usePeriscopeLotteryFeed({
        date: '2026-05-18',
        marketOpen: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetch() forces a fresh fetch on demand', async () => {
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    const { result } = renderHook(() =>
      usePeriscopeLotteryFeed({ date: '2026-05-18', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
