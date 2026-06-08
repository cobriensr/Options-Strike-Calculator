import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { getCTTimeMock, getCTDateStrMock } = vi.hoisted(() => ({
  getCTTimeMock: vi.fn(() => ({ hour: 10, minute: 0 })),
  getCTDateStrMock: vi.fn(() => '2026-06-05'),
}));

vi.mock('../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/timezone')>(
      '../utils/timezone',
    );
  return {
    ...actual,
    getCTTime: getCTTimeMock,
    getCTDateStr: getCTDateStrMock,
  };
});

import { useRegime0dte } from '../hooks/useRegime0dte';
import type { Regime0dteResponse } from '../hooks/useRegime0dte';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const STORAGE_KEY = 'regime0dte:lastgood';

function makeResponse(
  overrides: Partial<Regime0dteResponse> = {},
): Regime0dteResponse {
  return {
    date: '2026-06-05',
    asOfCtMin: 600,
    gate: 'calm',
    gexNearSpot: 1.2e10,
    gexAtOpen: 1.0e10,
    flipStrike: 5900,
    flipMinusOpenPct: -0.4,
    triggers: {
      mostlyRed: { fired: false, atCtMin: null, green: 3, red: 2 },
      ivBreak: { fired: false, atCtMin: null, magPct: null, refHi: 0.3 },
      middayDeepNeg: { fired: false, atCtMin: null, gexMid: null },
    },
    note: 'positive gamma — mean-revert / tight range likely',
    ...overrides,
  };
}

/** Seed a last-good cache entry under STORAGE_KEY with the given payload date. */
function seedCache(date: string, overrides: Partial<Regime0dteResponse> = {}) {
  const cached = makeResponse({ date, ...overrides });
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      data: cached,
      savedAt: `${date}T20:00:00Z`,
      date,
    }),
  );
  return cached;
}

describe('useRegime0dte', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getCTTimeMock.mockReset();
    getCTDateStrMock.mockReset();
    // Default: inside the 08:30–15:00 CT session, "today" is 2026-06-05.
    getCTTimeMock.mockReturnValue({ hour: 10, minute: 0 });
    getCTDateStrMock.mockReturnValue('2026-06-05');
    localStorage.clear();
  });

  it('populates displayData.gate after a successful fetch inside the window', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'lean_down' }),
    });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.displayData?.gate).toBe('lean_down');
    });
    expect(result.current.isWindowOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/regime-0dte',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not fetch and reports isWindowOpen=false outside the CT session', async () => {
    // 16:00 CT — after the 15:00 close.
    getCTTimeMock.mockReturnValue({ hour: 16, minute: 0 });

    const { result } = renderHook(() => useRegime0dte());

    // Give any (incorrect) eager fetch a chance to fire.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.displayData).toBeNull();
  });

  it('does not schedule the polling interval outside the CT window (no fetch churn)', () => {
    // 16:00 CT — closed. With fake timers we can prove no interval ticks
    // fire a fetch even after several poll periods elapse.
    vi.useFakeTimers();
    try {
      getCTTimeMock.mockReturnValue({ hour: 16, minute: 0 });

      renderHook(() => useRegime0dte());

      // Advance well past the 45s poll cadence (and the 60s window watcher).
      act(() => {
        vi.advanceTimersByTime(45_000 * 5);
      });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the today-dated last-good payload from localStorage on mount', () => {
    // Outside the window so no fetch overwrites the cache. Cache date matches
    // "today" (2026-06-05) so it is surfaced as displayData.
    getCTTimeMock.mockReturnValue({ hour: 16, minute: 0 });
    seedCache('2026-06-05', { gate: 'big_move' });

    const { result } = renderHook(() => useRegime0dte());

    expect(result.current.displayData?.gate).toBe('big_move');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT surface a prior-session-day cache as displayData (staleness guard)', () => {
    // Closed window, but a cache from YESTERDAY (2026-06-04) is present while
    // "today" is 2026-06-05. The stale-date cache must be ignored for display
    // — it must NOT paint yesterday's payload as live.
    getCTTimeMock.mockReturnValue({ hour: 16, minute: 0 });
    seedCache('2026-06-04', { gate: 'big_move' });

    const { result } = renderHook(() => useRegime0dte());

    expect(result.current.displayData).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // The stale entry is evicted from storage on read.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('mirrors a fresh payload into the last-good cache', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'lean_down' }),
    });

    renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      data: Regime0dteResponse;
      date: string;
    };
    expect(parsed.data.gate).toBe('lean_down');
    expect(parsed.date).toBe('2026-06-05');
  });

  it('keeps a today-dated last-good payload on a fetch error', async () => {
    seedCache('2026-06-05', { gate: 'calm' });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    // Last-good (today-dated) survives the transient error.
    expect(result.current.displayData?.gate).toBe('calm');
  });
});
