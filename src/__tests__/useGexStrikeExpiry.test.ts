/**
 * useGexStrikeExpiry — fetches per-strike GEX for SPY, QQQ, SPX, NDX in
 * parallel via Promise.allSettled. Owner-or-guest tier; public access
 * skips the fetch entirely. Polls live (no `at`) at
 * POLL_INTERVALS.STRIKE_BATTLE_MAP, single-shot in snapshot mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { POLL_INTERVALS } from '../constants';
import type {
  GexStrikeExpiryResponse,
  GexStrikeExpiryTicker,
} from '../hooks/useGexStrikeExpiry';

// Mock the access-mode predicate so each test can flip owner/guest/public.
vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as const),
  checkIsOwner: vi.fn(() => true),
}));

import { useGexStrikeExpiry } from '../hooks/useGexStrikeExpiry';
import { getAccessMode } from '../utils/auth';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

function emptyResp(
  ticker: GexStrikeExpiryTicker,
  overrides: Partial<GexStrikeExpiryResponse> = {},
): GexStrikeExpiryResponse {
  return {
    ticker,
    expiry: '2026-05-07',
    at: null,
    rows: [],
    timestamps: [],
    asOf: '2026-05-07T20:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Build a fetch implementation that returns per-ticker results based on
 * the URL's `ticker=` query string, so we don't depend on call ordering.
 */
function tickerRouter(
  responses: Partial<
    Record<
      GexStrikeExpiryTicker,
      | { kind: 'ok'; body: GexStrikeExpiryResponse }
      | { kind: 'http'; status: number }
      | { kind: 'reject'; err: Error }
    >
  >,
): (url: string) => Promise<Response> {
  return async (url: string) => {
    const ticker = (
      ['SPY', 'QQQ', 'SPX', 'NDX'] as GexStrikeExpiryTicker[]
    ).find((t) => url.includes(`ticker=${t}`));
    if (ticker == null) throw new Error(`unknown ticker URL: ${url}`);
    const r = responses[ticker];
    if (!r) return jsonResponse(emptyResp(ticker));
    if (r.kind === 'reject') throw r.err;
    if (r.kind === 'http') return jsonResponse({ error: 'x' }, r.status);
    return jsonResponse(r.body);
  };
}

describe('useGexStrikeExpiry', () => {
  it('public access skips fetch and clears loading', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useGexStrikeExpiry(true, '2026-05-07'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data.SPY).toBeNull();
    expect(result.current.data.QQQ).toBeNull();
    expect(result.current.data.SPX).toBeNull();
    expect(result.current.data.NDX).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('owner mode + all 4 tickers succeed populates data and leaves error null', async () => {
    fetchMock.mockImplementation(
      tickerRouter({
        SPY: { kind: 'ok', body: emptyResp('SPY', { rows: [] }) },
        QQQ: { kind: 'ok', body: emptyResp('QQQ') },
        SPX: { kind: 'ok', body: emptyResp('SPX') },
        NDX: { kind: 'ok', body: emptyResp('NDX') },
      }),
    );
    const { result } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.data.SPY?.ticker).toBe('SPY');
    expect(result.current.data.QQQ?.ticker).toBe('QQQ');
    expect(result.current.data.SPX?.ticker).toBe('SPX');
    expect(result.current.data.NDX?.ticker).toBe('NDX');
    expect(result.current.error).toBeNull();
    expect(result.current.errors.SPY).toBeNull();
    expect(result.current.errors.QQQ).toBeNull();
    expect(result.current.errors.SPX).toBeNull();
    expect(result.current.errors.NDX).toBeNull();
  });

  it('builds URL with ticker + expiry; no `at` in live mode', async () => {
    fetchMock.mockImplementation(tickerRouter({}));
    renderHook(() => useGexStrikeExpiry(false, '2026-05-07'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    for (const url of urls) {
      expect(url).toContain('/api/gex-strike-expiry?');
      expect(url).toContain('expiry=2026-05-07');
      expect(url).not.toContain('at=');
    }
    expect(urls.some((u) => u.includes('ticker=SPY'))).toBe(true);
    expect(urls.some((u) => u.includes('ticker=QQQ'))).toBe(true);
    expect(urls.some((u) => u.includes('ticker=SPX'))).toBe(true);
    expect(urls.some((u) => u.includes('ticker=NDX'))).toBe(true);
  });

  it('attaches `at` query param in snapshot mode', async () => {
    fetchMock.mockImplementation(tickerRouter({}));
    renderHook(() =>
      useGexStrikeExpiry(true, '2026-05-07', '2026-05-07T18:00:00Z'),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    for (const url of urls) {
      expect(url).toContain('at=2026-05-07T18%3A00%3A00Z');
    }
  });

  it('1 ticker fails → error names that ticker; others populated', async () => {
    fetchMock.mockImplementation(
      tickerRouter({
        SPX: { kind: 'http', status: 500 },
      }),
    );
    const { result } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Partial fetch failure: SPX');
    expect(result.current.errors.SPX).toContain('SPX: HTTP 500');
    expect(result.current.errors.SPY).toBeNull();
    expect(result.current.errors.QQQ).toBeNull();
    expect(result.current.errors.NDX).toBeNull();
    expect(result.current.data.SPX).toBeNull();
    expect(result.current.data.SPY?.ticker).toBe('SPY');
    expect(result.current.data.QQQ?.ticker).toBe('QQQ');
    expect(result.current.data.NDX?.ticker).toBe('NDX');
  });

  it('multiple tickers fail → error joins names in TICKERS order', async () => {
    fetchMock.mockImplementation(
      tickerRouter({
        SPX: { kind: 'http', status: 500 },
        NDX: { kind: 'reject', err: new Error('NDX network') },
      }),
    );
    const { result } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // TICKERS = ['SPY', 'QQQ', 'SPX', 'NDX'] — failed in that order.
    expect(result.current.error).toBe('Partial fetch failure: SPX, NDX');
    expect(result.current.errors.SPX).toBeTruthy();
    expect(result.current.errors.NDX).toBeTruthy();
    expect(result.current.errors.SPY).toBeNull();
    expect(result.current.errors.QQQ).toBeNull();
  });

  it('401 is graceful — that ticker stays null but is NOT in failed list', async () => {
    fetchMock.mockImplementation(
      tickerRouter({
        SPX: { kind: 'http', status: 401 },
      }),
    );
    const { result } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.errors.SPX).toBeNull();
    expect(result.current.data.SPX).toBeNull();
    expect(result.current.data.SPY?.ticker).toBe('SPY');
  });

  it('snapshot mode does not poll', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(tickerRouter({}));
    renderHook(() =>
      useGexStrikeExpiry(true, '2026-05-07', '2026-05-07T18:00:00Z'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.STRIKE_BATTLE_MAP * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('live mode polls every STRIKE_BATTLE_MAP', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(tickerRouter({}));
    renderHook(() => useGexStrikeExpiry(true, '2026-05-07'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.STRIKE_BATTLE_MAP);
    });
    // 4 more (one batch per tick).
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('marketOpen=false in live mode does not poll', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(tickerRouter({}));
    renderHook(() => useGexStrikeExpiry(false, '2026-05-07'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.STRIKE_BATTLE_MAP * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refresh() flips loading=true and triggers another fetch round', async () => {
    fetchMock.mockImplementation(tickerRouter({}));
    const { result } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      result.current.refresh();
    });
    // After refresh begins, loading flipped true synchronously and
    // another 4 calls fire.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('unmount mid-fetch does not write state', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValue(pending);

    const { result, unmount } = renderHook(() =>
      useGexStrikeExpiry(false, '2026-05-07'),
    );
    unmount();
    // Resolve all 4 in-flight fetches post-unmount.
    resolveFetch(jsonResponse(emptyResp('SPY')));
    await act(async () => {});
    // Data stays at the initial empty state.
    expect(result.current.data.SPY).toBeNull();
    expect(result.current.data.QQQ).toBeNull();
    expect(result.current.data.SPX).toBeNull();
    expect(result.current.data.NDX).toBeNull();
  });
});
