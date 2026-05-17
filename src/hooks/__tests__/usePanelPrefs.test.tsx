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
});
