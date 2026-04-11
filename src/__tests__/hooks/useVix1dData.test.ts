import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useVix1dData } from '../../hooks/useVix1dData';

// ============================================================
// MOCK DATA
// ============================================================

const mockVix1dMap = {
  '2026-03-11': { o: 14.2, h: 15.8, l: 13.5, c: 15.1 },
  '2026-03-10': { o: 12.0, h: 13.5, l: 11.8, c: 13.0 },
};

// ============================================================
// FETCH MOCK HELPERS
// ============================================================

let fetchSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
});

/**
 * Helper: render the hook and trigger a lazy load via the API endpoint.
 * Mocks /api/vix1d-daily returning 200 with mockVix1dMap.
 */
async function renderAndLoad() {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify(mockVix1dMap), { status: 200 }),
  );

  const { result } = renderHook(() => useVix1dData());

  // Trigger lazy load
  act(() => {
    result.current.getVix1d('2026-03-11', 10);
  });

  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });

  return result;
}

// ============================================================
// TESTS
// ============================================================

describe('useVix1dData', () => {
  // --------------------------------------------------------
  // Lazy load behavior
  // --------------------------------------------------------
  it('does not fetch on mount (lazy)', () => {
    const { result } = renderHook(() => useVix1dData());

    expect(result.current.loaded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from /api/vix1d-daily on first getVix1d call and sets loaded with correct dayCount', async () => {
    const result = await renderAndLoad();

    expect(result.current.dayCount).toBe(2);
    expect(fetchSpy).toHaveBeenCalledWith('/api/vix1d-daily');
  });

  it('falls back to /vix1d-daily.json when API returns 404', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockVix1dMap), { status: 200 }),
      );

    const { result } = renderHook(() => useVix1dData());
    act(() => {
      result.current.getVix1d('2026-03-11', 10);
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(fetchSpy).toHaveBeenNthCalledWith(1, '/api/vix1d-daily');
    expect(fetchSpy).toHaveBeenNthCalledWith(2, '/vix1d-daily.json');
    expect(result.current.dayCount).toBe(2);
  });

  // --------------------------------------------------------
  // getVix1d
  // --------------------------------------------------------
  describe('getVix1d', () => {
    it('returns open when hourET < 12', async () => {
      const result = await renderAndLoad();

      expect(result.current.getVix1d('2026-03-11', 9)).toBe(14.2);
      expect(result.current.getVix1d('2026-03-11', 0)).toBe(14.2);
      expect(result.current.getVix1d('2026-03-11', 11)).toBe(14.2);
    });

    it('returns close when hourET >= 12', async () => {
      const result = await renderAndLoad();

      expect(result.current.getVix1d('2026-03-11', 12)).toBe(15.1);
      expect(result.current.getVix1d('2026-03-11', 15)).toBe(15.1);
      expect(result.current.getVix1d('2026-03-10', 14)).toBe(13.0);
    });

    it('returns null for a date not in the data', async () => {
      const result = await renderAndLoad();

      expect(result.current.getVix1d('2099-01-01', 10)).toBeNull();
    });
  });

  // --------------------------------------------------------
  // getOHLC
  // --------------------------------------------------------
  describe('getOHLC', () => {
    it('returns the full OHLC entry for an existing date', async () => {
      const result = await renderAndLoad();

      expect(result.current.getOHLC('2026-03-11')).toEqual({
        o: 14.2,
        h: 15.8,
        l: 13.5,
        c: 15.1,
      });
    });

    it('returns null for a date not in the data', async () => {
      const result = await renderAndLoad();

      expect(result.current.getOHLC('2099-01-01')).toBeNull();
    });
  });

  // --------------------------------------------------------
  // Error path: non-ok response
  // --------------------------------------------------------
  it('logs warning and keeps loaded false on HTTP error', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const { result } = renderHook(() => useVix1dData());

    // Trigger lazy load
    act(() => {
      result.current.getVix1d('2026-03-11', 10);
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });

    expect(result.current.loaded).toBe(false);
    expect(result.current.dayCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to load VIX1D daily data:',
      'HTTP 401',
    );
  });

  // --------------------------------------------------------
  // Network error: fetch rejects
  // --------------------------------------------------------
  it('logs warning and keeps loaded false on network error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useVix1dData());

    // Trigger lazy load
    act(() => {
      result.current.getVix1d('2026-03-11', 10);
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });

    expect(result.current.loaded).toBe(false);
    expect(result.current.dayCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to load VIX1D daily data:',
      'Failed to fetch',
    );
  });

  // --------------------------------------------------------
  // Empty data
  // --------------------------------------------------------
  it('handles empty data object correctly', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const { result } = renderHook(() => useVix1dData());

    // Trigger lazy load
    act(() => {
      result.current.getVix1d('2026-03-11', 10);
    });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.dayCount).toBe(0);
    expect(result.current.getVix1d('2026-03-11', 10)).toBeNull();
    expect(result.current.getOHLC('2026-03-11')).toBeNull();
  });
});
