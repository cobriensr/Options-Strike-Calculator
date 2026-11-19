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

vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { getAccessMode } from '../utils/auth';
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
    vi.mocked(getAccessMode).mockReturnValue('owner');
    localStorage.clear();
  });

  // /api/regime-0dte is owner-or-guest: a public visitor's fetch is a 401 that
  // the panel would show as a red alert, so the hook never asks.
  it('does not fetch, poll or open the window for a public visitor inside the CT session', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useRegime0dte());
      // The eager fetch, then several 45s poll periods and window-watcher ticks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000 * 5);
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.isWindowOpen).toBe(false);
      expect(result.current.displayData).toBeNull();
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches inside the window for a guest, as for an owner', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ gate: 'big_move' }),
    });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.displayData?.gate).toBe('big_move');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe('useRegime0dte polling window follows the market calendar', () => {
  /** Set the mocked CT clock and CT calendar date for the next render. */
  function setCt(date: string, hour: number, minute: number) {
    getCTDateStrMock.mockReturnValue(date);
    getCTTimeMock.mockReturnValue({ hour, minute });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    getCTTimeMock.mockReset();
    getCTDateStrMock.mockReset();
    localStorage.clear();
  });

  // Dates (marketHours.ts stays real): Saturday, Thanksgiving (full close).
  it.each([
    ['a Saturday', '2026-11-14'],
    ['Thanksgiving (full-day close)', '2026-11-26'],
  ])('does not fetch at 10:00 CT on %s', async (_label, date) => {
    setCt(date, 10, 0);

    const { result } = renderHook(() => useRegime0dte());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not schedule the polling interval on a Saturday (no fetch churn)', () => {
    vi.useFakeTimers();
    try {
      setCt('2026-11-14', 10, 0);

      renderHook(() => useRegime0dte());
      act(() => {
        vi.advanceTimersByTime(45_000 * 5);
      });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // 2026-11-27 closes at 13:00 ET, which is 12:00 CT.
  it.each([
    ['11:59 CT is open', 11, 59, true],
    ['12:00 CT is closed', 12, 0, false],
    ['14:00 CT is closed', 14, 0, false],
  ])('half-day 2026-11-27: %s', async (_label, hour, minute, expectOpen) => {
    setCt('2026-11-27', hour, minute);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeResponse({ date: '2026-11-27' }),
    });

    const { result } = renderHook(() => useRegime0dte());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(expectOpen);
    if (expectOpen) {
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  // 2026-06-05 is a normal Friday: the session runs 08:30 to 15:00 CT.
  it.each([
    ['08:29 CT is closed', 8, 29, false],
    ['08:30 CT is open', 8, 30, true],
    ['14:59 CT is open', 14, 59, true],
    ['15:00 CT is closed', 15, 0, false],
  ])(
    'normal weekday 2026-06-05: %s',
    async (_label, hour, minute, expectOpen) => {
      setCt('2026-06-05', hour, minute);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeResponse(),
      });

      const { result } = renderHook(() => useRegime0dte());
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isWindowOpen).toBe(expectOpen);
      if (expectOpen) {
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalled();
        });
      } else {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );
});
