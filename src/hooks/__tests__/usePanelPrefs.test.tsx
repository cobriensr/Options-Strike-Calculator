import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../utils/auth.js', () => ({
  getAccessMode: vi.fn(),
}));

import { usePanelPrefs } from '../usePanelPrefs';
import { getAccessMode } from '../../utils/auth.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function flushDebounce(): Promise<void> {
  // DEBOUNCE_MS in the hook is 500; wait a bit longer to be safe.
  return new Promise((resolve) => setTimeout(resolve, 600));
}

const STORAGE_KEY = 'sc-panel-prefs-v1';

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
});

describe('usePanelPrefs — public visitor', () => {
  it('skips fetch, isLoaded is true immediately, hidden set is empty', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => usePanelPrefs());

    expect(result.current.isLoaded).toBe(true);
    expect(result.current.hidden.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('toggle updates local state but does not PUT', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => usePanelPrefs());

    act(() => {
      result.current.toggle('sec-darkpool');
    });

    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    await flushDebounce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usePanelPrefs — owner', () => {
  it('fetches GET on mount and sets hidden from response', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ hiddenPanels: ['sec-darkpool', 'sec-greek-flow'] }),
    );

    const { result } = renderHook(() => usePanelPrefs());

    expect(result.current.isLoaded).toBe(false);
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });
    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    expect(result.current.isHidden('sec-greek-flow')).toBe(true);
    expect(result.current.isHidden('sec-iv')).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel-prefs',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('toggle is optimistic; PUT fires once after debounce with cumulative state', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.toggle('sec-a');
      result.current.toggle('sec-b');
      result.current.toggle('sec-c');
    });

    expect(result.current.isHidden('sec-a')).toBe(true);
    expect(result.current.isHidden('sec-b')).toBe(true);
    expect(result.current.isHidden('sec-c')).toBe(true);

    await flushDebounce();

    const putCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(
      (putCalls[0]?.[1] as RequestInit).body as string,
    ) as { hiddenPanels: string[] };
    expect(new Set(body.hiddenPanels)).toEqual(
      new Set(['sec-a', 'sec-b', 'sec-c']),
    );
  });

  it('toggle un-hides a previously hidden panel', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ hiddenPanels: ['sec-darkpool'] }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    act(() => {
      result.current.toggle('sec-darkpool');
    });
    expect(result.current.isHidden('sec-darkpool')).toBe(false);
  });

  it('reset clears all hides and PUTs empty array', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ hiddenPanels: ['sec-a', 'sec-b'] }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.reset();
    });
    expect(result.current.hidden.size).toBe(0);

    await flushDebounce();

    const putCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(
      (putCalls[0]?.[1] as RequestInit).body as string,
    ) as { hiddenPanels: string[] };
    expect(body.hiddenPanels).toEqual([]);
  });

  it('GET 401 falls back to isLoaded=true with empty hidden set', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });
    expect(result.current.hidden.size).toBe(0);
  });

  it('PUT failure leaves optimistic state intact', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    fetchMock.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.toggle('sec-darkpool');
    });
    await flushDebounce();

    expect(result.current.isHidden('sec-darkpool')).toBe(true);
  });

  it('pagehide flushes pending PUT immediately with keepalive: true', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.toggle('sec-darkpool');
    });

    // No PUT yet — still in the 500 ms debounce window
    let puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(0);

    // Simulate cmd+shift+r / tab close — pagehide fires before debounce
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(
      (puts[0]?.[1] as RequestInit & { keepalive?: boolean }).keepalive,
    ).toBe(true);
    const body = JSON.parse((puts[0]?.[1] as RequestInit).body as string) as {
      hiddenPanels: string[];
    };
    expect(body.hiddenPanels).toEqual(['sec-darkpool']);
  });

  it('visibilitychange→hidden flushes pending PUT (iOS Safari path)', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.setOrder(['sec-spot-price', 'sec-datetime']);
    });

    let puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(0);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(
      (puts[0]?.[1] as RequestInit & { keepalive?: boolean }).keepalive,
    ).toBe(true);
    const body = JSON.parse((puts[0]?.[1] as RequestInit).body as string) as {
      panelOrder: string[];
    };
    expect(body.panelOrder).toEqual(['sec-spot-price', 'sec-datetime']);
  });

  it('hook unmount flushes pending PUT (SPA teardown path)', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));

    const { result, unmount } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.setGroupOrder(['Trading', 'Inputs']);
    });

    let puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(0);

    unmount();

    puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    const body = JSON.parse((puts[0]?.[1] as RequestInit).body as string) as {
      groupOrder: string[];
    };
    expect(body.groupOrder).toEqual(['Trading', 'Inputs']);
  });

  it('load-race: toggle BEFORE GET resolves — user wins on touched axis, server wins on untouched axes', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    // Defer the GET so we can toggle before it resolves. The `!`
    // definite-assignment assertion captures the Promise constructor's
    // synchronous executor pattern — TS + sonarjs both then see the
    // correct (Response) => void signature for the later call.
    let resolveGet!: (value: Response) => void;
    const getPromise = new Promise<Response>((r) => {
      resolveGet = r;
    });
    fetchMock.mockImplementationOnce(() => getPromise);
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    const { result } = renderHook(() => usePanelPrefs());

    // User toggles BEFORE the GET resolves — `isLoaded` is still false
    expect(result.current.isLoaded).toBe(false);
    act(() => {
      result.current.toggle('sec-darkpool');
    });
    expect(result.current.isHidden('sec-darkpool')).toBe(true);

    // GET now resolves with stored state across all three axes
    resolveGet(
      jsonResponse({
        hiddenPanels: ['sec-stored-hidden'],
        panelOrder: ['sec-spot-price', 'sec-datetime'],
        groupOrder: ['Trading', 'Inputs'],
      }),
    );
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    // hiddenPanels: user touched it pre-load → user value wins, server
    // value is rejected
    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    expect(result.current.isHidden('sec-stored-hidden')).toBe(false);
    // panelOrder + groupOrder: user didn't touch → server values apply
    expect(result.current.order).toEqual(['sec-spot-price', 'sec-datetime']);
    expect(result.current.groupOrder).toEqual(['Trading', 'Inputs']);

    await flushDebounce();

    // PUT body has ONLY the touched axis — stored panelOrder + groupOrder
    // are never sent, so the server's partial-update merge preserves them.
    const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts).toHaveLength(1);
    const body = JSON.parse(
      (puts[0]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({ hiddenPanels: ['sec-darkpool'] });
    expect('panelOrder' in body).toBe(false);
    expect('groupOrder' in body).toBe(false);
  });

  it('GET on mount loads panelOrder + groupOrder from server', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        hiddenPanels: ['sec-darkpool'],
        panelOrder: ['sec-spot-price', 'sec-datetime'],
        groupOrder: ['Trading', 'Inputs'],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    expect(result.current.order).toEqual(['sec-spot-price', 'sec-datetime']);
    expect(result.current.groupOrder).toEqual(['Trading', 'Inputs']);
  });
});

describe('usePanelPrefs — localStorage cache', () => {
  it('seeds initial state synchronously from localStorage on first render', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: ['sec-darkpool', 'sec-greek-flow'],
        panelOrder: ['sec-spot-price', 'sec-datetime'],
        groupOrder: ['Trading', 'Inputs'],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());

    // First render — no waitFor — values must already be populated.
    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    expect(result.current.isHidden('sec-greek-flow')).toBe(true);
    expect(result.current.order).toEqual(['sec-spot-price', 'sec-datetime']);
    expect(result.current.groupOrder).toEqual(['Trading', 'Inputs']);
  });

  it('writes to localStorage when a panel is toggled (public visitor)', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => usePanelPrefs());

    act(() => {
      result.current.toggle('sec-darkpool');
    });

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as { hiddenPanels: string[] };
    expect(stored.hiddenPanels).toEqual(['sec-darkpool']);
    // Public path still doesn't PUT — localStorage is the only store.
    await flushDebounce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes to localStorage when panel order changes', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => usePanelPrefs());

    act(() => {
      result.current.setOrder(['sec-spot-price', 'sec-datetime']);
    });

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as { panelOrder: string[] };
    expect(stored.panelOrder).toEqual(['sec-spot-price', 'sec-datetime']);
  });

  it('writes to localStorage when group order changes', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => usePanelPrefs());

    act(() => {
      result.current.setGroupOrder(['Trading', 'Inputs']);
    });

    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as { groupOrder: string[] };
    expect(stored.groupOrder).toEqual(['Trading', 'Inputs']);
  });

  it('owner: server GET overwrites localStorage cache for untouched axes', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: ['sec-stale'],
        panelOrder: [],
        groupOrder: [],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        hiddenPanels: ['sec-fresh-from-server'],
        panelOrder: ['sec-spot-price'],
        groupOrder: ['Trading'],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());

    // Pre-GET: localStorage cache is visible.
    expect(result.current.isHidden('sec-stale')).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    // Post-GET: server state wins on untouched axes (cross-device sync).
    expect(result.current.isHidden('sec-stale')).toBe(false);
    expect(result.current.isHidden('sec-fresh-from-server')).toBe(true);
    expect(result.current.order).toEqual(['sec-spot-price']);
    expect(result.current.groupOrder).toEqual(['Trading']);

    // localStorage is updated to match the server state, so the next
    // refresh paints the right thing from cache.
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as { hiddenPanels: string[]; panelOrder: string[]; groupOrder: string[] };
    expect(stored.hiddenPanels).toEqual(['sec-fresh-from-server']);
    expect(stored.panelOrder).toEqual(['sec-spot-price']);
    expect(stored.groupOrder).toEqual(['Trading']);
  });

  it('falls back to empty state when localStorage has corrupt JSON', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    window.localStorage.setItem(STORAGE_KEY, '{ this is not valid json');

    const { result } = renderHook(() => usePanelPrefs());

    expect(result.current.hidden.size).toBe(0);
    expect(result.current.order).toEqual([]);
    expect(result.current.groupOrder).toEqual([]);
  });

  it('ignores malformed entries inside the stored payload', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: ['sec-ok', 42, null, 'sec-also-ok'],
        panelOrder: 'not-an-array',
        groupOrder: ['Trading', { nope: true }],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());

    expect(result.current.isHidden('sec-ok')).toBe(true);
    expect(result.current.isHidden('sec-also-ok')).toBe(true);
    expect(result.current.hidden.size).toBe(2);
    expect(result.current.order).toEqual([]);
    expect(result.current.groupOrder).toEqual(['Trading']);
  });
});

describe('usePanelPrefs — GET does not clobber non-empty localStorage seed', () => {
  // Regression test for the cmd+shift+r data-loss bug: the keepalive
  // PUT fired from pagehide can drop silently (sendPut .catches and
  // swallows errors). On the next mount, the GET would return the
  // stale empty arrays from the DB and overwrite the freshly-seeded
  // localStorage state — and because the post-state effect mirrors
  // state back to localStorage, the cleared values were also written
  // back, destroying the user's saved order/visibility across a
  // reload.
  //
  // Rule under test: when the GET response is an empty array for an
  // axis AND localStorage had a non-empty seed for that axis, prefer
  // the local seed. Non-empty server responses still win
  // (cross-device sync) and "both empty" is a no-op either way.

  it('GET returning empty panelOrder does NOT wipe localStorage-seeded order', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: [],
        panelOrder: ['sec-spot-price', 'sec-datetime', 'sec-iv'],
        groupOrder: [],
      }),
    );
    // Server returns empty arrays — simulates the stale-DB case where
    // the last keepalive PUT didn't land.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ hiddenPanels: [], panelOrder: [], groupOrder: [] }),
    );

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    expect(result.current.order).toEqual([
      'sec-spot-price',
      'sec-datetime',
      'sec-iv',
    ]);
    // localStorage must also stay non-empty — the post-state effect
    // would otherwise mirror the cleared state back and the next
    // reload would have a truly empty seed.
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as { panelOrder: string[] };
    expect(stored.panelOrder).toEqual([
      'sec-spot-price',
      'sec-datetime',
      'sec-iv',
    ]);
  });

  it('GET returning empty hiddenPanels does NOT wipe localStorage-seeded hides', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: ['sec-darkpool', 'sec-greek-flow'],
        panelOrder: [],
        groupOrder: [],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ hiddenPanels: [], panelOrder: [], groupOrder: [] }),
    );

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    expect(result.current.isHidden('sec-darkpool')).toBe(true);
    expect(result.current.isHidden('sec-greek-flow')).toBe(true);
  });

  it('non-empty server panelOrder DOES overwrite empty localStorage (cross-device sync)', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    // No localStorage seed — first time on this device.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        hiddenPanels: [],
        panelOrder: ['sec-x', 'sec-y'],
        groupOrder: [],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    expect(result.current.order).toEqual(['sec-x', 'sec-y']);
  });

  it('non-empty server panelOrder DOES overwrite non-empty localStorage (server is authoritative when both present)', async () => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: [],
        panelOrder: ['old-a', 'old-b'],
        groupOrder: [],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        hiddenPanels: [],
        panelOrder: ['new-1', 'new-2', 'new-3'],
        groupOrder: [],
      }),
    );

    const { result } = renderHook(() => usePanelPrefs());
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    // When both sides have data, server wins — preserves cross-device
    // sync of meaningful reorderings.
    expect(result.current.order).toEqual(['new-1', 'new-2', 'new-3']);
  });
});

describe('usePanelPrefs — access mode changes without a remount', () => {
  // App re-renders on every mode change (useAccessSession), so each test flips
  // the mocked mode and calls rerender(): the same hook instance, no remount.

  beforeEach(() => {
    // A queued `mockResolvedValueOnce` / `mockImplementationOnce` answers the
    // GET a test is about. Anything else: a PUT resolves ok, and a GET that no
    // test queued never answers.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Promise.resolve(jsonResponse({}))
        : new Promise<Response>(() => undefined),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deferredResponse() {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Long enough for a resolved reply to run its `.then` chain and any state
  // write it would make; a negative assertion needs it to mean something.
  const settle = () => new Promise<void>((r) => setTimeout(r, 30));

  const putCalls = () =>
    fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');

  function putBody(call: unknown[] | undefined): Record<string, unknown> {
    return JSON.parse((call?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
  }

  describe('public to guest', () => {
    it('runs the GET and applies the guest server layout', async () => {
      vi.mocked(getAccessMode).mockReturnValue('public');
      const { result, rerender } = renderHook(() => usePanelPrefs());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.isLoaded).toBe(true);

      const get = deferredResponse();
      fetchMock.mockImplementationOnce(() => get.promise);
      vi.mocked(getAccessMode).mockReturnValue('guest');
      rerender();

      // The GET went out on the flip, and the layout is not loaded until it
      // answers.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/panel-prefs',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(result.current.isLoaded).toBe(false);

      get.resolve(
        jsonResponse({
          hiddenPanels: ['sec-darkpool'],
          panelOrder: ['sec-spot-price', 'sec-datetime'],
          groupOrder: ['Trading', 'Inputs'],
        }),
      );
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });
      expect(result.current.isHidden('sec-darkpool')).toBe(true);
      expect(result.current.order).toEqual(['sec-spot-price', 'sec-datetime']);
      expect(result.current.groupOrder).toEqual(['Trading', 'Inputs']);
    });

    it('PUTs a toggle made after the flip', async () => {
      vi.mocked(getAccessMode).mockReturnValue('public');
      const { result, rerender } = renderHook(() => usePanelPrefs());
      fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
      vi.mocked(getAccessMode).mockReturnValue('guest');
      rerender();
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      act(() => {
        result.current.toggle('sec-a');
      });
      await flushDebounce();

      expect(putCalls()).toHaveLength(1);
      expect(putBody(putCalls()[0])).toEqual({ hiddenPanels: ['sec-a'] });
    });

    it('registers the pagehide and visibilitychange flush after the flip', async () => {
      vi.mocked(getAccessMode).mockReturnValue('public');
      const { result, rerender } = renderHook(() => usePanelPrefs());
      fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
      vi.mocked(getAccessMode).mockReturnValue('guest');
      rerender();
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      act(() => {
        result.current.toggle('sec-a');
      });
      expect(putCalls()).toHaveLength(0);

      // pagehide fires inside the debounce window; a registered listener
      // flushes the edit at once, with keepalive.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      expect(putCalls()).toHaveLength(1);
      expect(
        (putCalls()[0]?.[1] as RequestInit & { keepalive?: boolean }).keepalive,
      ).toBe(true);
      expect(putBody(putCalls()[0])).toEqual({ hiddenPanels: ['sec-a'] });
    });

    it('keeps an axis the visitor changed while public, and sends it once signed in', async () => {
      vi.mocked(getAccessMode).mockReturnValue('public');
      const { result, rerender } = renderHook(() => usePanelPrefs());

      // Touched before the flip, while public: local only, no request.
      act(() => {
        result.current.toggle('sec-local');
      });
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          hiddenPanels: ['sec-server'],
          panelOrder: ['sec-spot-price'],
          groupOrder: ['Trading'],
        }),
      );
      vi.mocked(getAccessMode).mockReturnValue('guest');
      rerender();
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      // The touched axis keeps the local value; the untouched axes take the
      // guest's server layout.
      expect(result.current.isHidden('sec-local')).toBe(true);
      expect(result.current.isHidden('sec-server')).toBe(false);
      expect(result.current.order).toEqual(['sec-spot-price']);
      expect(result.current.groupOrder).toEqual(['Trading']);

      // The kept edit reaches the server on the next flush, and only that
      // axis is sent, so the stored order axes stay untouched.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(putCalls()).toHaveLength(1);
      expect(putBody(putCalls()[0])).toEqual({ hiddenPanels: ['sec-local'] });
    });
  });

  describe('guest to public', () => {
    async function renderLoadedGuest() {
      vi.mocked(getAccessMode).mockReturnValue('guest');
      fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
      const hook = renderHook(() => usePanelPrefs());
      await waitFor(() => {
        expect(hook.result.current.isLoaded).toBe(true);
      });
      return hook;
    }

    it('sends no PUT for a toggle after the downgrade and removes the flush listeners', async () => {
      const { result, rerender } = await renderLoadedGuest();
      const removeFromWindow = vi.spyOn(window, 'removeEventListener');
      const removeFromDocument = vi.spyOn(document, 'removeEventListener');

      vi.mocked(getAccessMode).mockReturnValue('public');
      rerender();

      expect(removeFromWindow).toHaveBeenCalledWith(
        'pagehide',
        expect.any(Function),
      );
      expect(removeFromDocument).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );

      act(() => {
        result.current.toggle('sec-a');
      });
      // A listener left registered would flush this edit at once.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flushDebounce();

      expect(result.current.isHidden('sec-a')).toBe(true);
      expect(putCalls()).toHaveLength(0);
    });

    it('drops an edit still waiting in the debounce at the downgrade', async () => {
      const { result, rerender } = await renderLoadedGuest();

      act(() => {
        result.current.toggle('sec-a');
      });
      expect(putCalls()).toHaveLength(0);

      vi.mocked(getAccessMode).mockReturnValue('public');
      rerender();
      await flushDebounce();

      // Neither the debounce timer nor the cleanup's flush sent it: the
      // cookie is gone, so the PUT could only 401.
      expect(putCalls()).toHaveLength(0);
      // The optimistic state stays on screen.
      expect(result.current.isHidden('sec-a')).toBe(true);
    });

    it('writes nothing when a GET in flight at the downgrade answers late', async () => {
      vi.mocked(getAccessMode).mockReturnValue('guest');
      const get = deferredResponse();
      fetchMock.mockImplementationOnce(() => get.promise);
      const { result, rerender } = renderHook(() => usePanelPrefs());
      expect(result.current.isLoaded).toBe(false);
      const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;

      vi.mocked(getAccessMode).mockReturnValue('public');
      rerender();

      // The cleanup aborted the request, and public has nothing to load.
      expect(signal?.aborted).toBe(true);
      expect(result.current.isLoaded).toBe(true);

      await act(async () => {
        get.resolve(
          jsonResponse({
            hiddenPanels: ['sec-server'],
            panelOrder: ['sec-spot-price'],
            groupOrder: ['Trading'],
          }),
        );
        await settle();
      });

      expect(result.current.hidden.size).toBe(0);
      expect(result.current.order).toEqual([]);
      expect(result.current.groupOrder).toEqual([]);
    });

    it('writes nothing when the reply lands after the mode went public but before the re-render', async () => {
      vi.mocked(getAccessMode).mockReturnValue('guest');
      const get = deferredResponse();
      fetchMock.mockImplementationOnce(() => get.promise);
      const { result } = renderHook(() => usePanelPrefs());

      // The cookie is gone but nothing has re-rendered the hook yet, so the
      // request is not aborted: the reply re-reads the live mode.
      vi.mocked(getAccessMode).mockReturnValue('public');
      await act(async () => {
        get.resolve(jsonResponse({ hiddenPanels: ['sec-server'] }));
        await settle();
      });

      expect(result.current.isHidden('sec-server')).toBe(false);
    });

    it('writes nothing from an aborted request even when the live mode reads guest again', async () => {
      vi.mocked(getAccessMode).mockReturnValue('guest');
      const get = deferredResponse();
      fetchMock.mockImplementationOnce(() => get.promise);
      const { result, rerender } = renderHook(() => usePanelPrefs());

      vi.mocked(getAccessMode).mockReturnValue('public');
      rerender();
      // The mode flaps back before the reply, with no render in between: the
      // live-mode re-read passes, so only the abort can stop this write.
      vi.mocked(getAccessMode).mockReturnValue('guest');
      await act(async () => {
        get.resolve(jsonResponse({ hiddenPanels: ['sec-server'] }));
        await settle();
      });

      expect(result.current.isHidden('sec-server')).toBe(false);
    });
  });

  describe('one identity to another', () => {
    it('does not send the guest identity edit as the owner, and loads the owner layout', async () => {
      vi.mocked(getAccessMode).mockReturnValue('guest');
      fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
      const { result, rerender } = renderHook(() => usePanelPrefs());
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });

      act(() => {
        result.current.toggle('sec-guest-edit');
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ hiddenPanels: ['sec-owner-layout'] }),
      );
      vi.mocked(getAccessMode).mockReturnValue('owner');
      rerender();
      await waitFor(() => {
        expect(result.current.isHidden('sec-owner-layout')).toBe(true);
      });
      await flushDebounce();

      // Another identity: the guest's queued edit is not written to the
      // owner's layout, and the owner's server layout replaces it.
      expect(putCalls()).toHaveLength(0);
      expect(result.current.isHidden('sec-guest-edit')).toBe(false);
    });

    it('aborts the first GET and ignores its late reply when the mode flips again', async () => {
      vi.mocked(getAccessMode).mockReturnValue('public');
      const { result, rerender } = renderHook(() => usePanelPrefs());

      const guestGet = deferredResponse();
      const ownerGet = deferredResponse();
      fetchMock
        .mockImplementationOnce(() => guestGet.promise)
        .mockImplementationOnce(() => ownerGet.promise);

      vi.mocked(getAccessMode).mockReturnValue('guest');
      rerender();
      const guestSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
      vi.mocked(getAccessMode).mockReturnValue('owner');
      rerender();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(guestSignal?.aborted).toBe(true);

      // The guest reply lands first, late: it must not stand in for the
      // owner's layout or end the owner's loading.
      await act(async () => {
        guestGet.resolve(jsonResponse({ hiddenPanels: ['sec-guest-layout'] }));
        await settle();
      });
      expect(result.current.isHidden('sec-guest-layout')).toBe(false);
      expect(result.current.isLoaded).toBe(false);

      ownerGet.resolve(jsonResponse({ hiddenPanels: ['sec-owner-layout'] }));
      await waitFor(() => {
        expect(result.current.isLoaded).toBe(true);
      });
      expect(result.current.isHidden('sec-owner-layout')).toBe(true);
      expect(result.current.isHidden('sec-guest-layout')).toBe(false);
    });
  });

  it('flushes a pending edit on unmount under the mode it was made in', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result, rerender, unmount } = renderHook(() => usePanelPrefs());
    fetchMock.mockResolvedValueOnce(jsonResponse({ hiddenPanels: [] }));
    vi.mocked(getAccessMode).mockReturnValue('guest');
    rerender();
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });

    act(() => {
      result.current.setOrder(['sec-spot-price', 'sec-datetime']);
    });
    unmount();

    expect(putCalls()).toHaveLength(1);
    expect(putBody(putCalls()[0])).toEqual({
      panelOrder: ['sec-spot-price', 'sec-datetime'],
    });
  });

  it('sends nothing on unmount while public', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result, unmount } = renderHook(() => usePanelPrefs());

    act(() => {
      result.current.toggle('sec-a');
    });
    unmount();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
