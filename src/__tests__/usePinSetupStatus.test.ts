/**
 * usePinSetupStatus — Pin-Setup Tile data hook. Live mode (no date)
 * polls every PIN_SETUP_INTERVAL (60s) while marketOpen; historical
 * mode (caller sets a date) is one-shot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  usePinSetupStatus,
  type PinSetupStatus,
} from '../hooks/usePinSetupStatus';

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

function sampleStatus(overrides: Partial<PinSetupStatus> = {}): PinSetupStatus {
  return {
    evaluatedAt: '2026-05-14T18:00:00Z',
    date: null,
    mode: 'live',
    snapshotTs: '2026-05-14T17:59:00Z',
    staleMinutes: 1,
    state: 'WATCH',
    conditions: {
      netGammaAtMagnetM: 1200,
      netGammaThresholdM: 800,
      netGammaMet: true,
      magnetStrike: 5800,
      isRound50: true,
      distanceToMagnet: 4,
      distanceThreshold: 10,
      distanceMet: true,
    },
    spot: 5796,
    bias: 'full-pin',
    recommendedTradeTypes: ['iron condor'],
    avoidedTradeTypes: [],
    trajectory: [],
    outcome: null,
    asOf: '2026-05-14T18:00:00Z',
    ...overrides,
  };
}

describe('usePinSetupStatus', () => {
  it('fetches /api/pin-setup-status with no date in live mode', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleStatus()));
    renderHook(() => usePinSetupStatus({ marketOpen: false }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/api/pin-setup-status');
  });

  it('appends date to the URL when setDate is called', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      result.current.setDate('2026-05-08');
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          (c[0] as string).includes('date=2026-05-08'),
        ),
      ).toBe(true),
    );
  });

  it('exposes data + clears loading on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleStatus()));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.state).toBe('WATCH');
    expect(result.current.data?.bias).toBe('full-pin');
    expect(result.current.error).toBeNull();
  });

  it('exposes an HTTP error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'unauthorized' }, 401),
    );
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('401');
    expect(result.current.data).toBeNull();
  });

  it('surfaces a rejected fetch as a string error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network down');
    expect(result.current.data).toBeNull();
  });

  it('polls every 60s in live mode while marketOpen', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    renderHook(() => usePinSetupStatus({ marketOpen: true }));
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

  it('does not poll when marketOpen=false', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    renderHook(() => usePinSetupStatus({ marketOpen: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when a historical date is selected, even with marketOpen', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.setDate('2024-01-01');
      await vi.advanceTimersByTimeAsync(0);
    });
    // Effect re-fires on date change → one fresh fetch, then no polling.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes refresh that fires a fresh fetch with the current date', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
