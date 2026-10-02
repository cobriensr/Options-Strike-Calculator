// @vitest-environment jsdom

/**
 * useSchwabAuthStatus — owner-only, visibility-gated 5-minute poll of
 * GET /api/auth/schwab-status for the header countdown badge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));

import { captureUnlessAuth } from '../../lib/sentry-helpers';
import { useSchwabAuthStatus } from '../useSchwabAuthStatus';

const POLL_MS = 5 * 60 * 1000;
const EXPIRES_AT = Date.parse('2026-10-04T20:00:00Z');
const EXPIRING = { state: 'expiring', refreshExpiresAt: EXPIRES_AT } as const;
const LOGGED_OUT = { state: 'logged_out' } as const;
const CAPTURE_OPTIONS = {
  level: 'warning',
  tags: { context: 'schwab_status_fetch' },
};

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

/** Mount for the owner and settle the first (good) load. */
async function mountWithGoodLoad() {
  const hook = renderHook(() => useSchwabAuthStatus(true));
  await settle();
  expect(hook.result.current).toEqual(EXPIRING);
  return hook;
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
    vi.mocked(captureUnlessAuth).mockClear();
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
    expect(captureUnlessAuth).not.toHaveBeenCalled();
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

  it.each([LOGGED_OUT, { state: 'unknown' }])(
    'accepts the $state status',
    async (body) => {
      fetchMock.mockImplementationOnce(async () => jsonResponse(body));
      const { result } = renderHook(() => useSchwabAuthStatus(true));
      await settle();
      expect(result.current).toEqual(body);
    },
  );

  describe('a failed poll keeps the last known status', () => {
    it('a non-2xx response, uncaptured (the endpoint captures its own 5xx)', async () => {
      const { result } = await mountWithGoodLoad();
      fetchMock.mockImplementationOnce(async () =>
        jsonResponse({ error: 'Internal error' }, 500),
      );
      await advance(POLL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current).toEqual(EXPIRING);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown state', { state: 'refreshing' }],
      ['an expiry state without a timestamp', { state: 'active' }],
      [
        'a non-numeric timestamp',
        { state: 'expired', refreshExpiresAt: '2026-10-04' },
      ],
      ['a non-object body', ['active']],
    ])('a malformed body (%s), captured', async (_label, body) => {
      const { result } = await mountWithGoodLoad();
      fetchMock.mockImplementationOnce(async () => jsonResponse(body));
      await advance(POLL_MS);
      expect(result.current).toEqual(EXPIRING);
      expect(captureUnlessAuth).toHaveBeenCalledOnce();
      expect(captureUnlessAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'schwab-status: malformed response body',
        }),
        CAPTURE_OPTIONS,
      );
    });

    it('a 2xx body that is not JSON, captured', async () => {
      const { result } = await mountWithGoodLoad();
      fetchMock.mockImplementationOnce(
        async () => new Response('<html>oops</html>', { status: 200 }),
      );
      await advance(POLL_MS);
      expect(result.current).toEqual(EXPIRING);
      expect(captureUnlessAuth).toHaveBeenCalledOnce();
      expect(captureUnlessAuth).toHaveBeenCalledWith(
        expect.any(SyntaxError),
        CAPTURE_OPTIONS,
      );
    });

    it.each([
      ['a network error', new TypeError('Failed to fetch')],
      [
        'a fetch timeout',
        new DOMException('The operation timed out.', 'TimeoutError'),
      ],
    ])('%s, captured', async (_label, err) => {
      const { result } = await mountWithGoodLoad();
      fetchMock.mockImplementationOnce(async () => {
        throw err;
      });
      await advance(POLL_MS);
      expect(result.current).toEqual(EXPIRING);
      expect(captureUnlessAuth).toHaveBeenCalledWith(err, CAPTURE_OPTIONS);
    });

    it('an AbortError, not captured (aborts are expected)', async () => {
      const { result } = await mountWithGoodLoad();
      fetchMock.mockImplementationOnce(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      });
      await advance(POLL_MS);
      expect(result.current).toEqual(EXPIRING);
      expect(captureUnlessAuth).not.toHaveBeenCalled();
    });
  });

  it('ignores a superseded response that resolves after a newer one', async () => {
    // Fetch #1 hangs; going hidden aborts it, and coming back starts fetch
    // #2, which answers logged_out. Fetch #1 then resolves anyway (a fetch
    // that ignored its abort). Its stale EXPIRING must not overwrite #2.
    let resolveFirst!: (res: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockImplementationOnce(async () => jsonResponse(LOGGED_OUT));

    const { result } = renderHook(() => useSchwabAuthStatus(true));
    await settle();
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(LOGGED_OUT);

    await act(async () => {
      resolveFirst(jsonResponse(EXPIRING));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual(LOGGED_OUT);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('ignores a superseded response whose body arrives after a newer one', async () => {
    // Fetch #1's headers arrive at once, so the post-fetch abort check has
    // already passed; only its json() hangs. Going hidden aborts #1, and
    // coming back starts fetch #2, which answers logged_out. Then #1's body
    // arrives with EXPIRING. Nothing throws and the body is well-formed, so
    // the only thing that can drop it is the abort re-check after json().
    let resolveJson!: (body: unknown) => void;
    const slowBody = {
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        }),
    } as unknown as Response;
    fetchMock.mockImplementationOnce(async () => slowBody);
    fetchMock.mockImplementationOnce(async () => jsonResponse(LOGGED_OUT));

    const { result } = renderHook(() => useSchwabAuthStatus(true));
    await settle();
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(LOGGED_OUT);

    await act(async () => {
      resolveJson(EXPIRING);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual(LOGGED_OUT);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
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
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });
});
