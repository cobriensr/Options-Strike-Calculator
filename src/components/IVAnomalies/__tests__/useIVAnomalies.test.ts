import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useIVAnomalies } from '../../../hooks/useIVAnomalies';
import { ivAnomalyBannerStore } from '../banner-store';
import type { IVAnomaliesListResponse, IVAnomalyRow } from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPX',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140,
    ivAtDetect: 0.22,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    flagReasons: ['skew_delta'],
    flowPhase: 'early',
    contextSnapshot: null,
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

function makePayload(spxRows: IVAnomalyRow[]): IVAnomaliesListResponse {
  return {
    mode: 'list',
    latest: {
      SPX: spxRows[0] ?? null,
      SPY: null,
      QQQ: null,
    },
    history: {
      SPX: spxRows,
      SPY: [],
      QQQ: [],
    },
  };
}

describe('useIVAnomalies — dedup + alert semantics', () => {
  beforeEach(() => {
    ivAnomalyBannerStore.__resetForTests();
  });
  afterEach(() => {
    ivAnomalyBannerStore.__resetForTests();
    vi.unstubAllGlobals();
  });

  it('primes the known-set on first poll without firing banners', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(makePayload([makeRow({ id: 1 })])), {
            status: 200,
          }),
        ),
      ),
    );

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies).not.toBeNull());
    // Initial anomaly existed before the page opened — no banner pushed.
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it('pushes new anomalies on subsequent polls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makePayload([makeRow({ id: 1 })])), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makePayload([makeRow({ id: 1 }), makeRow({ id: 2 })])),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.anomalies).not.toBeNull());

    // Second poll triggered manually via refresh.
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() =>
      expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(1),
    );
    expect(ivAnomalyBannerStore.getSnapshot().visible[0]?.id).toBe(2);
  });

  it('does not re-push the same ID across polls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makePayload([makeRow({ id: 1 })])), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makePayload([makeRow({ id: 1 }), makeRow({ id: 2 })])),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makePayload([makeRow({ id: 1 }), makeRow({ id: 2 })])),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // Only id=2 should have been banner-pushed, even though id=1 has shown
    // up in every poll since mount.
    const visible = ivAnomalyBannerStore.getSnapshot().visible;
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(2);
  });

  it('treats 401 as empty (non-owner) without setting error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('Unauthorized', { status: 401 })),
      ),
    );
    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.anomalies).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom'))),
    );
    const { result } = renderHook(() => useIVAnomalies(true, false));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain('boom');
  });

  it('does not setState after unmount when a fetch resolves late', async () => {
    // Resolve the fetch promise on a delay controlled by the test, so we
    // can unmount the hook BEFORE the response arrives.
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useIVAnomalies(true, false));
    unmount();
    // Fetch resolves AFTER the hook unmounted; the hook must not touch
    // state or React will warn about an update on an unmounted component.
    resolveFetch(
      new Response(JSON.stringify(makePayload([makeRow({ id: 99 })])), {
        status: 200,
      }),
    );
    // Give the microtask queue a moment to drain.
    await new Promise((r) => setTimeout(r, 20));
    // React's "update on unmounted" warning goes to console.error.
    const didWarn = warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('unmounted'),
    );
    expect(didWarn).toBe(false);
    warn.mockRestore();
  });

  it('doubles the polling interval after 3 consecutive fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Every fetch fails — keeps failStreak climbing so we can observe
    // the interval double at the 3-fail threshold.
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new Error('always fail'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useIVAnomalies(true, true));

    // Wait for the initial fetch to fail.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // Third fail flips failStreak to 3 → polling effect re-runs with
    // 2× interval (120_000 ms). One base-interval tick should NOT fire
    // another fetch; two back-to-back base ticks (= one 2× tick) should.
    const callsAfter3 = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfter3);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfter3),
    );
    expect(result.current.error).toBeTruthy();
    vi.useRealTimers();
  });
});
