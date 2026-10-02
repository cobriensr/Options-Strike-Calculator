// @vitest-environment jsdom

/**
 * useSchwabAuthStatus — owner-only, visibility-gated 5-minute poll of
 * GET /api/auth/schwab-status for the header countdown badge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSchwabAuthStatus } from '../useSchwabAuthStatus';

const POLL_MS = 5 * 60 * 1000;
const EXPIRES_AT = Date.parse('2026-10-04T20:00:00Z');
const EXPIRING = { state: 'expiring', refreshExpiresAt: EXPIRES_AT } as const;

let visibility: DocumentVisibilityState = 'visible';
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let pending fetch/json promise chains settle inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useSchwabAuthStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => jsonResponse(EXPIRING));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never fetches for a non-owner', async () => {
    const { result } = renderHook(() => useSchwabAuthStatus(false));
    await advance(2 * POLL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('fetches the owner endpoint on mount and returns the status', async () => {
    const { result } = renderHook(() => useSchwabAuthStatus(true));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/schwab-status',
      expect.objectContaining({
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.current).toEqual(EXPIRING);
  });

  it('polls every 5 minutes while the tab is visible', async () => {
    renderHook(() => useSchwabAuthStatus(true));
    await settle();
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops polling while hidden and refetches when the tab returns', async () => {
    renderHook(() => useSchwabAuthStatus(true));
    await settle();

    act(() => setVisibility('hidden'));
    await advance(3 * POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts fetching when the session becomes the owner', async () => {
    const { rerender, result } = renderHook(
      ({ owner }) => useSchwabAuthStatus(owner),
      { initialProps: { owner: false } },
    );
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ owner: true });
    await settle();
    expect(result.current).toEqual(EXPIRING);
  });

  it.each([{ state: 'logged_out' }, { state: 'unknown' }])(
    'accepts the $state status',
    async (body) => {
      fetchMock.mockImplementationOnce(async () => jsonResponse(body));
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      expect(result.current).toEqual(body);
    },
  );

  describe('failure modes keep the last known status', () => {
    it('a non-2xx poll', async () => {
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      fetchMock.mockImplementationOnce(async () =>
        jsonResponse({ error: 'Internal error' }, 500),
      );
      await advance(POLL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current).toEqual(EXPIRING);
    });

    it.each([
      ['an unknown state', { state: 'refreshing' }],
      ['an expiry state without a timestamp', { state: 'active' }],
      [
        'a non-numeric timestamp',
        { state: 'expired', refreshExpiresAt: '2026-10-04' },
      ],
      ['a non-object body', ['active']],
    ])('a malformed body: %s', async (_label, body) => {
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      fetchMock.mockImplementationOnce(async () => jsonResponse(body));
      await advance(POLL_MS);
      expect(result.current).toEqual(EXPIRING);
    });

    it('a 2xx body that is not JSON', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response('<html>oops</html>', { status: 200 }),
      );
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      expect(result.current).toBeNull();
    });

    it('a network error', async () => {
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      });
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      expect(result.current).toBeNull();
    });
  });

  it('on unmount aborts the in-flight fetch and stops polling and listening', async () => {
    let captured: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>(() => {
          captured = init.signal ?? undefined;
        }),
    );
    const { unmount } = renderHook(() => useSchwabAuthStatus(true));
    await settle();
    expect(captured?.aborted).toBe(false);

    unmount();
    expect(captured?.aborted).toBe(true);

    await advance(3 * POLL_MS);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
