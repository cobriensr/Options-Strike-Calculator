/**
 * Hook tests for `useGammaSetups` — the polling hook behind the
 * Gamma-Node Composite Detector tile.
 *
 * Verifies the access-mode gate, eager mount-fetch, error surface,
 * recurring poll during market hours, and the `refresh()` escape hatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { POLL_INTERVALS } from '../../constants';
import type { GammaSetupsResponse } from '../../hooks/useGammaSetups';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as const),
}));

import { useGammaSetups } from '../../hooks/useGammaSetups';
import { getAccessMode } from '../../utils/auth';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeResponse(
  overrides: Partial<GammaSetupsResponse> = {},
): GammaSetupsResponse {
  return {
    today: '2026-05-21',
    dow_label: 'Thursday',
    confidence_tier: 'MEDIUM',
    pre_day_filter_fires: false,
    prior_5d_ret: 0.002,
    prior_iv_rank: 18,
    open_gap_pct: 0.1,
    anti_filters: {
      is_fomc_day: false,
      is_dom_1_5: false,
      is_dom_16_20: false,
    },
    nearest_floor: { strike: 7390, gex: 250_000 },
    nearest_ceiling: { strike: 7415, gex: 400_000 },
    fires: [],
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────

describe('useGammaSetups', () => {
  it('skips fetch entirely for public visitors', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useGammaSetups(true));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches on mount and populates data for an owner session', async () => {
    const payload = makeResponse({
      fires: [
        {
          id: 1,
          fired_at: '2026-05-21T14:30:00Z',
          signal_type: 'e1_long_call',
          dow_label: 'Thursday',
          confidence_tier: 'MEDIUM',
          spot_at_fire: 7401,
          node_strike: 7400,
          node_gex: 300_000,
          bar_open: 7395,
          bar_high: 7402,
          bar_low: 7394,
          bar_close: 7401,
          bar_range: 8,
          es_basis_change_5m: 0.5,
          ret_15m: null,
          ret_30m: null,
          ret_60m: null,
          ret_eod: null,
          trade_taken: false,
          trade_pnl_dollars: null,
        },
      ],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    const { result } = renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/gamma-setups/active');
    expect(result.current.data?.fires).toHaveLength(1);
    expect(result.current.data?.fires[0]?.node_strike).toBe(7400);
    expect(result.current.error).toBeNull();
  });

  it('sends credentials: same-origin so the owner cookie ships', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeResponse()));
    renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.credentials).toBe('same-origin');
  });

  it('exposes error string on non-2xx without overwriting prior data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, 500));
    const { result } = renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.data).toBeNull();
  });

  it('captures fetch reject as an error message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('TimeoutError'));
    const { result } = renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(result.current.error).toBe('TimeoutError'));
    expect(result.current.data).toBeNull();
  });

  it('polls at GREEK_FLOW cadence while marketOpen=true', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeResponse()));
    renderHook(() => useGammaSetups(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // eager mount-fetch

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.GREEK_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.GREEK_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll when marketOpen=false but DOES run the eager mount-fetch', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeResponse()));
    renderHook(() => useGammaSetups(false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // eager mount only

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.GREEK_FLOW * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // poll loop never fired
  });

  it('refresh() triggers an immediate fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeResponse()));
    const { result } = renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears a prior error after a successful refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 500))
      .mockResolvedValueOnce(jsonResponse(makeResponse()));

    const { result } = renderHook(() => useGammaSetups(false));
    await waitFor(() => expect(result.current.error).toContain('500'));

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data?.today).toBe('2026-05-21');
  });
});
