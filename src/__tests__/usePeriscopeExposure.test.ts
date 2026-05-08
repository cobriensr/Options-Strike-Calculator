/**
 * usePeriscopeExposure unit tests — fetch-on-mount, polling cadence,
 * empty-reason routing, error paths, spot-hint URL behavior, and
 * unmount-mid-fetch safety. Mirrors the existing useNopeIntraday +
 * useContractTape hook test patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AccessMode } from '../utils/auth';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';

vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as AccessMode),
}));

import { usePeriscopeExposure } from '../hooks/usePeriscopeExposure';
import { getAccessMode } from '../utils/auth';
import { POLL_INTERVALS } from '../constants';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeView(overrides: Partial<PeriscopeView> = {}): PeriscopeView {
  return {
    capturedAt: '2026-05-08T13:30:00Z',
    priorCapturedAt: '2026-05-08T13:20:00Z',
    expiry: '2026-05-08',
    spot: 5800,
    gamma: {
      ceiling: { strike: 5825, value: 5_000_000, ptsFromSpot: 25 },
      floor: { strike: 5775, value: 4_000_000, ptsFromSpot: -25 },
      accelTop: [],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 1_500_000,
      tallyWide100: 2_000_000,
      topByAbs: [],
      charmZeroStrike: null,
    },
    vanna: { topByAbs: [] },
    signFlips: [],
    cone: null,
    breaches: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset();
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Access-mode gating
// ============================================================

describe('usePeriscopeExposure: access mode', () => {
  it('does not fetch when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.view).toBeNull();
  });

  it('fetches when access mode is owner', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('fetches when access mode is guest', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});

// ============================================================
// Successful fetch + state
// ============================================================

describe('usePeriscopeExposure: successful fetch', () => {
  it('populates view, asOf, and clears emptyReason on a populated response', async () => {
    const view = makeView({ spot: 5777 });
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: view,
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.view).not.toBeNull());
    expect(result.current.view?.spot).toBe(5777);
    expect(result.current.asOf).toBe('2026-05-08T13:30:00Z');
    expect(result.current.emptyReason).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets emptyReason to no_slot when server returns reason no_slot', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: null,
        reason: 'no_slot',
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.emptyReason).toBe('no_slot'));
    expect(result.current.view).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets emptyReason to no_spot when server returns reason no_spot', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: null,
        reason: 'no_spot',
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.emptyReason).toBe('no_spot'));
    expect(result.current.view).toBeNull();
  });
});

// ============================================================
// Error paths
// ============================================================

describe('usePeriscopeExposure: errors', () => {
  it('sets error string on non-2xx HTTP response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.view).toBeNull();
  });

  it('sets error message when fetch rejects', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.view).toBeNull();
  });
});

// ============================================================
// spotHint URL behavior
// ============================================================

describe('usePeriscopeExposure: spot hint', () => {
  it('passes spot query param when spotHint is finite & positive', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: 4500 }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe(
      '/api/periscope-exposure?spot=4500',
    );
  });

  it('omits spot param when spotHint is null', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: null }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-exposure');
  });

  it('omits spot param when spotHint is 0', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false, spotHint: 0 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-exposure');
  });

  it('omits spot param when spotHint is NaN', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() =>
      usePeriscopeExposure({ marketOpen: false, spotHint: Number.NaN }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-exposure');
  });

  it('omits spot param when spotHint is negative', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false, spotHint: -1 }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/periscope-exposure');
  });
});

// ============================================================
// Polling
// ============================================================

describe('usePeriscopeExposure: polling', () => {
  it('polls at PERISCOPE cadence while market is open', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not poll when market is closed (initial fetch only)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    renderHook(() => usePeriscopeExposure({ marketOpen: false }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cleans up the interval on unmount', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    const { unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// refresh()
// ============================================================

describe('usePeriscopeExposure: refresh', () => {
  it('refresh() triggers a fresh fetch', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView(),
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

// ============================================================
// Unmount-mid-fetch guard
// ============================================================

describe('usePeriscopeExposure: unmount safety', () => {
  it('does not setState when fetch resolves after unmount', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    unmount();
    resolveFetch(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-08T13:30:00Z',
        data: makeView({ spot: 9999 }),
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.view).toBeNull();
    expect(result.current.asOf).toBeNull();
  });

  it('does not set error when fetch rejects after unmount', async () => {
    let rejectFetch: (err: Error) => void = () => {};
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectFetch = reject;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      usePeriscopeExposure({ marketOpen: false }),
    );
    unmount();
    rejectFetch(new Error('late fail'));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.error).toBeNull();
  });
});
