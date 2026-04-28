/**
 * Tests for the two institutional-program data hooks:
 *   - useInstitutionalProgram (program summary + today's blocks)
 *   - useStrikeHeatmap (cumulative premium per strike)
 *
 * Both are simple fetch-and-cache effects that re-fire when their
 * dependency arguments change. We mock `globalThis.fetch` to control
 * the JSON shape and HTTP status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useInstitutionalProgram,
  useStrikeHeatmap,
} from '../hooks/useInstitutionalProgram';

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

// ============================================================
// useInstitutionalProgram
// ============================================================

describe('useInstitutionalProgram', () => {
  it('fetches with the default 60-day window when no opts are passed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ days: [], today: { blocks: [], date: '2026-04-27' } }),
    );
    renderHook(() => useInstitutionalProgram());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/api/institutional-program?days=60');
  });

  it('passes the days argument through to the URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ days: [], today: { blocks: [], date: '2026-04-27' } }),
    );
    renderHook(() => useInstitutionalProgram(30));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('/api/institutional-program?days=30');
  });

  it('appends date / start_time_ct / end_time_ct query params when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ days: [], today: { blocks: [], date: '2026-04-25' } }),
    );
    renderHook(() =>
      useInstitutionalProgram(60, {
        selectedDate: '2026-04-25',
        startTimeCt: '09:30',
        endTimeCt: '15:00',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = new URL(
      fetchMock.mock.calls[0]![0] as string,
      'http://localhost',
    );
    expect(url.searchParams.get('days')).toBe('60');
    expect(url.searchParams.get('date')).toBe('2026-04-25');
    expect(url.searchParams.get('start_time_ct')).toBe('09:30');
    expect(url.searchParams.get('end_time_ct')).toBe('15:00');
  });

  it('omits optional query params when their opts are undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ days: [], today: { blocks: [], date: '2026-04-27' } }),
    );
    renderHook(() => useInstitutionalProgram(60, { selectedDate: '' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = new URL(
      fetchMock.mock.calls[0]![0] as string,
      'http://localhost',
    );
    expect(url.searchParams.has('date')).toBe(false);
    expect(url.searchParams.has('start_time_ct')).toBe(false);
  });

  it('sets data and clears loading on a successful fetch', async () => {
    const payload = {
      days: [
        {
          date: '2026-04-26',
          dominant_pair: null,
          avg_spot: 5800,
          ceiling_pct_above_spot: 0.012,
          n_blocks: 5,
          n_call_blocks: 3,
          n_put_blocks: 2,
        },
      ],
      today: { blocks: [], date: '2026-04-26' },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { result } = renderHook(() => useInstitutionalProgram());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(payload);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an Error on non-OK HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const { result } = renderHook(() => useInstitutionalProgram());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('HTTP 500');
    expect(result.current.data).toBeNull();
  });

  it('surfaces an Error on fetch reject', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useInstitutionalProgram());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('network down');
  });

  it('re-fetches when days argument changes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ days: [], today: { blocks: [], date: '2026-04-27' } }),
    );
    const { rerender } = renderHook(
      ({ days }: { days: number }) => useInstitutionalProgram(days),
      { initialProps: { days: 60 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ days: 30 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toContain('days=30');
  });

  it('does NOT setState after unmount (cancelled flag prevents leaks)', async () => {
    let resolveJson: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveJson = res;
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => pending,
    } as Response);

    const { result, unmount } = renderHook(() => useInstitutionalProgram());
    unmount();
    // Now resolve the pending promise — the cancelled guard should
    // suppress the setState that would otherwise log a warning.
    await act(async () => {
      resolveJson({ days: [], today: { blocks: [], date: '2026-04-27' } });
      // Yield enough microtasks for .then chain to run.
      await Promise.resolve();
      await Promise.resolve();
    });
    // Initial state was loading=true, data=null. Unmount-then-resolve
    // means cancelled was true, so no state change should leak.
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });
});

// ============================================================
// useStrikeHeatmap
// ============================================================

describe('useStrikeHeatmap', () => {
  it('fetches with default ceiling track + 60 days', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ spot: 5800, days: 60, track: 'ceiling', rows: [] }),
    );
    renderHook(() => useStrikeHeatmap());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(
      '/api/institutional-program/strike-heatmap?days=60&track=ceiling',
    );
  });

  it('honors track + days arguments in the URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        spot: 5800,
        days: 30,
        track: 'opening_atm',
        rows: [],
      }),
    );
    renderHook(() => useStrikeHeatmap('opening_atm', 30));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(
      '/api/institutional-program/strike-heatmap?days=30&track=opening_atm',
    );
  });

  it('sets data and clears loading on success', async () => {
    const payload = {
      spot: 5800,
      days: 60,
      track: 'ceiling' as const,
      rows: [
        {
          strike: 5800,
          option_type: 'call' as const,
          n_blocks: 1,
          total_contracts: 100,
          total_premium: 250_000,
          last_seen_date: '2026-04-25',
          active_days: 5,
          latest_expiry: '2026-12-19',
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const { result } = renderHook(() => useStrikeHeatmap());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(payload);
  });

  it('leaves data null on non-OK status (caller renders empty state)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const { result } = renderHook(() => useStrikeHeatmap());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('leaves data null on fetch reject (silent — caller renders empty state)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useStrikeHeatmap());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('re-fetches when track changes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ spot: 5800, days: 60, track: 'ceiling', rows: [] }),
    );
    const { rerender } = renderHook(
      ({ track }: { track: 'ceiling' | 'opening_atm' }) =>
        useStrikeHeatmap(track),
      { initialProps: { track: 'ceiling' } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ track: 'opening_atm' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
