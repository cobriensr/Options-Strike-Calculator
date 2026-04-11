import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useVixData } from '../../hooks/useVixData';
import type { VIXDataMap } from '../../types';

// ============================================================
// MOCKS
// ============================================================

const mockVixMap: VIXDataMap = {
  '2026-03-11': { open: 18.5, high: 20.1, low: 17.8, close: 19.2 },
  '2026-03-10': { open: 17.0, high: 18.0, low: 16.5, close: 17.5 },
};

vi.mock('../../utils/vixStorage', () => ({
  cacheVixData: vi.fn(),
  loadCachedVixData: vi.fn(() => null),
  loadStaticVixData: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../utils/csvParser', () => ({
  parseVixCSV: vi.fn(() => mockVixMap),
}));

// Re-import after mock registration so we can control return values
import {
  loadCachedVixData,
  loadStaticVixData,
  cacheVixData,
} from '../../utils/vixStorage';

const mockedLoadCached = vi.mocked(loadCachedVixData);
const mockedLoadStatic = vi.mocked(loadStaticVixData);
const mockedCache = vi.mocked(cacheVixData);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadCached.mockReturnValue(null);
  mockedLoadStatic.mockResolvedValue(null);
});

// ============================================================
// TESTS
// ============================================================

describe('useVixData', () => {
  interface RenderOpts {
    ivMode: 'vix' | 'direct';
    timeHour: string;
    timeAmPm: 'AM' | 'PM';
    timezone: 'ET' | 'CT';
    setVixInput: (v: string) => void;
  }

  const defaults: RenderOpts = {
    ivMode: 'vix',
    timeHour: '10',
    timeAmPm: 'AM',
    timezone: 'ET',
    setVixInput: vi.fn(),
  };

  function renderWith(overrides: Partial<RenderOpts> = {}) {
    const opts = { ...defaults, ...overrides };
    return renderHook(() =>
      useVixData(
        opts.ivMode,
        opts.timeHour,
        opts.timeAmPm,
        opts.timezone,
        opts.setVixInput,
      ),
    );
  }

  // --------------------------------------------------------
  // Mount: cached data path
  // --------------------------------------------------------
  it('loads from localStorage cache when available', async () => {
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'cached-upload',
    });

    const { result } = renderWith();

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });
    expect(result.current.vixDataSource).toBe('cached-upload');
    expect(result.current.vixData).toEqual(mockVixMap);
    // Should NOT fall through to static load
    expect(mockedLoadStatic).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------
  // Mount: static fallback path (lines 53-58)
  // --------------------------------------------------------
  it('falls back to static VIX JSON when no cache exists', async () => {
    mockedLoadCached.mockReturnValue(null);
    mockedLoadStatic.mockResolvedValue({
      data: mockVixMap,
      source: '2 days',
    });

    const { result } = renderWith();

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });
    expect(result.current.vixDataSource).toBe('2 days');
    expect(result.current.vixData).toEqual(mockVixMap);
    expect(mockedCache).toHaveBeenCalledWith(mockVixMap, '2 days');
  });

  it('stays unloaded when static also returns null', async () => {
    mockedLoadCached.mockReturnValue(null);
    mockedLoadStatic.mockResolvedValue(null);

    const { result } = renderWith();

    // Give the effect time to resolve
    await waitFor(() => {
      expect(mockedLoadStatic).toHaveBeenCalled();
    });
    expect(result.current.vixDataLoaded).toBe(false);
    expect(result.current.vixDataSource).toBe('');
  });

  // --------------------------------------------------------
  // Date selection / OHLC lookup
  // --------------------------------------------------------
  it('sets vixOHLC when a valid date is selected', async () => {
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith();

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(result.current.vixOHLC).toEqual(mockVixMap['2026-03-11']);
    });
  });

  it('sets vixOHLC to null for a date not in the data', async () => {
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith();

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2099-01-01');
    });

    await waitFor(() => {
      expect(result.current.vixOHLC).toBeNull();
    });
  });

  // --------------------------------------------------------
  // Smart OHLC: morning → open, afternoon → close
  // --------------------------------------------------------
  it('uses open for morning (ET) in smart mode', async () => {
    const setVixInput = vi.fn();
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith({
      setVixInput,
      timeHour: '10',
      timeAmPm: 'AM',
      timezone: 'ET',
    });

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(setVixInput).toHaveBeenCalledWith('18.50');
    });
  });

  it('uses close for afternoon (ET) in smart mode', async () => {
    const setVixInput = vi.fn();
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith({
      setVixInput,
      timeHour: '2',
      timeAmPm: 'PM',
      timezone: 'ET',
    });

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(setVixInput).toHaveBeenCalledWith('19.20');
    });
  });

  it('converts CT to ET via DST-safe helper for smart OHLC', async () => {
    // At steady state (outside the spring-forward DST window), the
    // CT→ET offset is +60 minutes. 12 PM CT → 1 PM ET → etH >= 13 →
    // pick close. The hook now uses `convertCTToET` from
    // src/utils/timezone instead of a hardcoded `+1`, so this test
    // exercises the steady-state path through the shared helper.
    const setVixInput = vi.fn();
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith({
      setVixInput,
      timeHour: '12',
      timeAmPm: 'PM',
      timezone: 'CT',
    });

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(setVixInput).toHaveBeenCalledWith('19.20');
    });
  });

  // NOTE: DST-window behavior is exercised directly in
  // src/__tests__/utils/timezone.test.ts against the `convertCTToET`
  // helper. useVixData just consumes that helper, so a DST test here
  // would be redundant AND hard to write without `vi.useFakeTimers`
  // interfering with React Testing Library's `waitFor`. The fix for
  // FE-STATE-004 follow-up in useVixData is the swap from `+ 1` to
  // `convertCTToET(ctH24, 0).hour` at both effect sites — verified
  // by the steady-state CT→ET test above and the helper's own tests.

  // --------------------------------------------------------
  // Explicit OHLC field selection
  // --------------------------------------------------------
  it('applies explicit OHLC field (high) via setVixOHLCField', async () => {
    const setVixInput = vi.fn();
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith({ setVixInput });

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(result.current.vixOHLC).toBeTruthy();
    });

    act(() => {
      result.current.setVixOHLCField('high');
    });

    await waitFor(() => {
      expect(setVixInput).toHaveBeenCalledWith('20.10');
    });
  });

  // --------------------------------------------------------
  // File upload
  // --------------------------------------------------------
  it('merges uploaded CSV data and updates source', async () => {
    mockedLoadCached.mockReturnValue(null);
    mockedLoadStatic.mockResolvedValue(null);

    const { result } = renderWith();

    const csvText = 'Date,Open,High,Low,Close\n2026-03-11,18.5,20.1,17.8,19.2';
    const file = new File([csvText], 'vix-history.csv', { type: 'text/csv' });

    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileUpload(event);
    });

    expect(result.current.vixDataLoaded).toBe(true);
    expect(result.current.vixDataSource).toMatch(/\d+ days/);
    expect(mockedCache).toHaveBeenCalled();
  });

  it('ignores upload when no file is selected', async () => {
    const { result } = renderWith();

    const event = {
      target: { files: [] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileUpload(event);
    });

    // Should remain in initial state
    expect(result.current.vixDataLoaded).toBe(false);
  });

  // --------------------------------------------------------
  // API fallback for dates not in static data
  // --------------------------------------------------------
  describe('API fallback for dates not in static data', () => {
    beforeEach(() => {
      mockedLoadCached.mockReturnValue({
        data: mockVixMap, // only has 2026-03-11 and 2026-03-10
        source: 'test',
      });
    });

    it('fetches /api/vix-ohlc when selected date is absent from static data', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          open: 20.0,
          high: 21.5,
          low: 19.5,
          close: 21.0,
          count: 2,
        }),
      } as Response);

      const { result } = renderWith();

      await waitFor(() => expect(result.current.vixDataLoaded).toBe(true));

      act(() => {
        result.current.setSelectedDate('2026-03-26'); // not in mockVixMap
      });

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/vix-ohlc?date=2026-03-26',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      await waitFor(() => {
        expect(result.current.vixOHLC).toEqual({
          open: 20.0,
          high: 21.5,
          low: 19.5,
          close: 21.0,
        });
      });

      fetchSpy.mockRestore();
    });

    it('leaves vixOHLC null when API returns count 0', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          open: null,
          high: null,
          low: null,
          close: null,
          count: 0,
        }),
      } as Response);

      const { result } = renderWith();

      await waitFor(() => expect(result.current.vixDataLoaded).toBe(true));

      act(() => {
        result.current.setSelectedDate('2099-01-01');
      });

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(result.current.vixOHLC).toBeNull();
      });

      fetchSpy.mockRestore();
    });

    it('leaves vixOHLC null when API fetch fails', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const { result } = renderWith();

      await waitFor(() => expect(result.current.vixDataLoaded).toBe(true));

      act(() => {
        result.current.setSelectedDate('2026-03-26');
      });

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalled();
      });

      expect(result.current.vixOHLC).toBeNull();

      fetchSpy.mockRestore();
    });

    it('does NOT fetch when date IS in static data', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network'));

      const { result } = renderWith();

      await waitFor(() => expect(result.current.vixDataLoaded).toBe(true));

      // Clear any fetch calls made for the initial selectedDate (today's date,
      // which may not be in mockVixMap) before testing our assertion.
      fetchSpy.mockClear();

      act(() => {
        result.current.setSelectedDate('2026-03-11'); // IS in mockVixMap
      });

      await waitFor(() => {
        expect(result.current.vixOHLC).toEqual(mockVixMap['2026-03-11']);
      });

      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });

  // --------------------------------------------------------
  // Does not call setVixInput in direct IV mode
  // --------------------------------------------------------
  it('does not call setVixInput when ivMode is direct', async () => {
    const setVixInput = vi.fn();
    mockedLoadCached.mockReturnValue({
      data: mockVixMap,
      source: 'test',
    });

    const { result } = renderWith({ setVixInput, ivMode: 'direct' });

    await waitFor(() => {
      expect(result.current.vixDataLoaded).toBe(true);
    });

    act(() => {
      result.current.setSelectedDate('2026-03-11');
    });

    await waitFor(() => {
      expect(result.current.vixOHLC).toBeTruthy();
    });

    // setVixInput should NOT be called in direct mode
    expect(setVixInput).not.toHaveBeenCalled();
  });
});
