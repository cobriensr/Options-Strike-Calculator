import { describe, it, expect, vi, beforeEach } from 'vitest';
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

beforeEach(() => {
  fetchMock.mockReset();
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
    const body = JSON.parse(
      (puts[0]?.[1] as RequestInit).body as string,
    ) as { hiddenPanels: string[] };
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
    const body = JSON.parse(
      (puts[0]?.[1] as RequestInit).body as string,
    ) as { panelOrder: string[] };
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
    const body = JSON.parse(
      (puts[0]?.[1] as RequestInit).body as string,
    ) as { groupOrder: string[] };
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
