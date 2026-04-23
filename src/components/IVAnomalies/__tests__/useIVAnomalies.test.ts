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
});
