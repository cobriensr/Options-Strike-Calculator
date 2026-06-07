/**
 * useFlowRegime — Flow Regime recognition badge data hook. Wraps
 * useFetchedData → GET /api/flow-regime: single eager fetch on mount,
 * then polls POLL_INTERVALS.FLOW_REGIME (60s) only while marketOpen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useFlowRegime,
  parseFlowRegime,
  type FlowRegimeResponse,
} from '../hooks/useFlowRegime';

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

function sampleResponse(): FlowRegimeResponse {
  const latest = {
    date: '2026-06-06',
    slot: 2,
    computedAt: '2026-06-06T14:35:00Z',
    ndTilt: -0.42,
    idx0dtePutShare: 0.61,
    ndPercentile: 8,
    idxputPercentile: 94,
    regime: 'bearish' as const,
    color: 'red' as const,
    nTrades: 1200,
    baselineVersion: 1,
  };
  return { date: '2026-06-06', latest };
}

describe('parseFlowRegime', () => {
  it('coerces a well-formed envelope', () => {
    const parsed = parseFlowRegime(sampleResponse());
    expect(parsed.date).toBe('2026-06-06');
    expect(parsed.latest?.regime).toBe('bearish');
    expect(parsed.latest?.idxputPercentile).toBe(94);
    expect(parsed.latest?.baselineVersion).toBe(1);
  });

  it('returns null latest on a malformed payload', () => {
    const parsed = parseFlowRegime({});
    expect(parsed.latest).toBeNull();
    expect(parsed.date).toBe('');
  });

  it('defaults unknown regime/color to normal/gray and null metrics', () => {
    const parsed = parseFlowRegime({
      date: '2026-06-06',
      latest: {
        slot: 0,
        regime: 'wat',
        color: 'purple',
        ndPercentile: 'nope',
        idxputPercentile: null,
      },
    });
    expect(parsed.latest?.regime).toBe('normal');
    expect(parsed.latest?.color).toBe('gray');
    expect(parsed.latest?.ndPercentile).toBeNull();
    expect(parsed.latest?.idxputPercentile).toBeNull();
    expect(parsed.latest?.baselineVersion).toBeNull();
  });
});

describe('useFlowRegime', () => {
  it('fetches /api/flow-regime and exposes latest + slots', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleResponse()));
    const { result } = renderHook(() => useFlowRegime({ marketOpen: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/api/flow-regime');
    expect(result.current.latest?.regime).toBe('bearish');
    expect(result.current.date).toBe('2026-06-06');
    expect(result.current.error).toBeNull();
  });

  it('surfaces an HTTP error and leaves latest null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    const { result } = renderHook(() => useFlowRegime({ marketOpen: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.latest).toBeNull();
  });

  it('polls every 60s while marketOpen is true', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleResponse()));
    renderHook(() => useFlowRegime({ marketOpen: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll when marketOpen is false (gate)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleResponse()));
    renderHook(() => useFlowRegime({ marketOpen: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // One eager mount fetch only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
