import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { getCTTimeMock } = vi.hoisted(() => ({
  getCTTimeMock: vi.fn(() => ({ hour: 10, minute: 0 })),
}));

vi.mock('../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/timezone')>(
      '../utils/timezone',
    );
  return {
    ...actual,
    getCTTime: getCTTimeMock,
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

describe('useRegime0dte', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getCTTimeMock.mockReset();
    // Default: inside the 08:30–15:00 CT session.
    getCTTimeMock.mockReturnValue({ hour: 10, minute: 0 });
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

  it('restores the last-good payload from localStorage on mount', async () => {
    // Outside the window so no fetch overwrites the cache.
    getCTTimeMock.mockReturnValue({ hour: 16, minute: 0 });
    const cached = makeResponse({ gate: 'big_move', date: '2026-06-04' });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        data: cached,
        savedAt: '2026-06-04T20:00:00Z',
        date: '2026-06-04',
      }),
    );

    const { result } = renderHook(() => useRegime0dte());

    expect(result.current.displayData?.gate).toBe('big_move');
    expect(fetchMock).not.toHaveBeenCalled();
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
    };
    expect(parsed.data.gate).toBe('lean_down');
  });

  it('keeps the last-good payload on a fetch error', async () => {
    const cached = makeResponse({ gate: 'calm' });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        data: cached,
        savedAt: '2026-06-04T20:00:00Z',
        date: '2026-06-04',
      }),
    );
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useRegime0dte());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    // Last-good survives the transient error.
    expect(result.current.displayData?.gate).toBe('calm');
  });
});
