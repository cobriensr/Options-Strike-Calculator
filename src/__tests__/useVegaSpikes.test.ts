/**
 * useVegaSpikes — polls /api/vega-spikes for recent Dir Vega Spike events
 * with three view ranges (today/7d/30d). Today polls every 60s during
 * marketOpen; historical ranges fetch once.
 *
 * Validation: malformed rows are dropped, not poison the whole feed.
 * Race-safety: an AbortController per effect kills in-flight requests
 * on range change or unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useVegaSpikes, type VegaSpike } from '../hooks/useVegaSpikes';

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

function makeRawSpike(overrides: Partial<VegaSpike> = {}): VegaSpike {
  return {
    id: 1,
    ticker: 'SPY',
    date: '2026-04-27',
    timestamp: '2026-04-27T14:30:00Z',
    dirVegaFlow: 12_500,
    zScore: 4.2,
    vsPriorMax: 1.7,
    priorMax: 7_300,
    baselineMad: 2_900,
    barsElapsed: 12,
    confluence: false,
    fwdReturn5m: 0.0012,
    fwdReturn15m: 0.0034,
    fwdReturn30m: null,
    insertedAt: '2026-04-27T14:30:05Z',
    ...overrides,
  };
}

// ============================================================
// useVegaSpikes
// ============================================================

describe('useVegaSpikes', () => {
  it('fetches /api/vega-spikes?range=today on mount with default range', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ spikes: [] }));
    renderHook(() => useVegaSpikes(/* marketOpen */ false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/vega-spikes?range=today');
  });

  it('clears loading and stores validated spikes on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ spikes: [makeRawSpike()] }));
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.spikes).toHaveLength(1);
    expect(result.current.spikes[0]?.ticker).toBe('SPY');
    expect(result.current.error).toBeNull();
  });

  it('drops malformed rows but keeps valid siblings', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        spikes: [
          makeRawSpike({ id: 1 }),
          { id: 'not-a-number', ticker: 'QQQ' }, // malformed
          makeRawSpike({ id: 3, ticker: 'QQQ' }),
        ],
      }),
    );
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.spikes).toHaveLength(2);
    expect(result.current.spikes.map((s) => s.id)).toEqual([1, 3]);
  });

  it('accepts null forward returns (nullable finite number contract)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        spikes: [
          makeRawSpike({
            fwdReturn5m: null,
            fwdReturn15m: null,
            fwdReturn30m: null,
          }),
        ],
      }),
    );
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.spikes).toHaveLength(1);
    expect(result.current.spikes[0]?.fwdReturn5m).toBeNull();
  });

  it('rejects non-finite numbers (NaN/Infinity) on numeric fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        spikes: [makeRawSpike({ zScore: Number.POSITIVE_INFINITY })],
      }),
    );
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.spikes).toHaveLength(0);
  });

  it('surfaces an error string on non-OK HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() =>
      expect(result.current.error).toBe('Request failed (503)'),
    );
  });

  it('surfaces an error on unexpected response shape (no spikes array)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ wrong: 'shape' }));
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() =>
      expect(result.current.error).toBe('Unexpected response shape'),
    );
  });

  it('surfaces fetch network errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('does NOT poll for historical ranges (7d/30d)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spikes: [] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useVegaSpikes(/* marketOpen */ true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setRange('7d');
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toContain('range=7d');

    // Advance 5 min — no further calls because 7d is one-shot.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT poll today range when market is closed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spikes: [] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useVegaSpikes(/* marketOpen */ false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls every 60s for today range while market is open', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spikes: [] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useVegaSpikes(/* marketOpen */ true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('does NOT show the spinner on subsequent polls (only on first load)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spikes: [makeRawSpike()] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useVegaSpikes(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.spikes).toHaveLength(1);

    // Trigger another poll; loading should stay false since spikes is non-empty.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
  });

  it('encodes the range value in the URL (defensive against future range tokens)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spikes: [] }));
    const { result } = renderHook(() => useVegaSpikes(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    act(() => result.current.setRange('30d'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/vega-spikes?range=30d');
  });

  it('does not surface an error when an in-flight request is aborted on unmount', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFn = reject;
      }),
    );
    const { result, unmount } = renderHook(() => useVegaSpikes(false));
    unmount();
    rejectFn(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    // Yield two microtasks for the catch chain to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
  });
});
