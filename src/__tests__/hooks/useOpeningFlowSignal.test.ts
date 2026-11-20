/**
 * useOpeningFlowSignal: response validation at the fetch boundary and in
 * the localStorage last-good cache. A 200 whose body doesn't match the
 * /api/opening-flow-signal contract is handled like a failed fetch, so the
 * panel never renders (and crashes on) a malformed payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useOpeningFlowSignal,
  type OpeningFlowResponse,
} from '../../hooks/useOpeningFlowSignal';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import { getAccessMode, type AccessMode } from '../../utils/auth';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);
const mockGetAccessMode = vi.mocked(getAccessMode);

const fetchMock = vi.fn();

const LIVE_KEY = 'openingFlowSignal.lastGood';
const HISTORICAL_KEY = 'openingFlowSignal.lastGood:2026-05-12';
// 08:30 CT: inside the 08:25-08:50 polling window.
const IN_WINDOW = new Date('2026-05-13T13:30:00Z');

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function makeResponse(
  overrides: Partial<OpeningFlowResponse> = {},
): OpeningFlowResponse {
  return {
    date: '2026-05-13',
    windowStatus: 'closed',
    openUtc: '2026-05-13T13:30:00Z',
    slice1EndUtc: '2026-05-13T13:35:00Z',
    slice2EndUtc: '2026-05-13T13:40:00Z',
    asOfUtc: '2026-05-13T14:30:00Z',
    stopPct: 0.3,
    exitMinutesFromEntry: 60,
    tickers: {
      SPY: {
        slice1: {
          tickets: [
            {
              strike: 745,
              side: 'call',
              premium: 3_350_000,
              volume: 24_683,
              avgFill: 1.36,
            },
          ],
          callPremium: 3_350_000,
          putPremium: 0,
          biasSide: 'call',
          biasRatio: 1,
          top3SameSide: true,
        },
        slice2: null,
        signal: { fired: false, reason: 'window_not_complete' },
      },
      QQQ: { slice1: null, slice2: null, signal: null },
    },
    ...overrides,
  };
}

function seedLiveCache(data: unknown): void {
  localStorage.setItem(
    LIVE_KEY,
    JSON.stringify({
      data,
      savedAt: '2026-05-13T14:00:00Z',
      date: '2026-05-13',
    }),
  );
}

/** renderHook, plus every value the hook returned, one per render. */
function renderRecorded() {
  const renders: ReturnType<typeof useOpeningFlowSignal>[] = [];
  const rendered = renderHook(() => {
    const value = useOpeningFlowSignal();
    renders.push(value);
    return value;
  });
  return { ...rendered, renders };
}

function notOkResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

function seedHistoricalCache(data: unknown): void {
  localStorage.setItem(
    HISTORICAL_KEY,
    JSON.stringify({
      data,
      savedAt: '2026-05-12T21:00:00Z',
      date: '2026-05-12',
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockClear();
  mockGetAccessMode.mockReturnValue('owner');
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useOpeningFlowSignal: malformed 200 payloads', () => {
  const good = makeResponse();
  it.each([
    ['an empty object', {}],
    ['a null tickers map', { ...good, tickers: null }],
    [
      'a non-array slice-1 tickets list',
      {
        ...good,
        tickers: {
          SPY: {
            slice1: { ...good.tickers.SPY!.slice1, tickets: 'oops' },
            slice2: null,
            signal: null,
          },
        },
      },
    ],
  ])('treats %s as a failed fetch', async (_label, body) => {
    fetchMock.mockResolvedValue(okResponse(body));

    const { result } = renderHook(() => useOpeningFlowSignal());

    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.displayData).toBeNull();
    // Nothing malformed reaches the last-good cache.
    expect(localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it('keeps showing the last-good cached payload', async () => {
    const cached = makeResponse({ asOfUtc: '2026-05-13T14:00:00Z' });
    seedLiveCache(cached);
    fetchMock.mockResolvedValue(okResponse({}));

    const { result } = renderHook(() => useOpeningFlowSignal());

    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });
    expect(result.current.data).toBeNull();
    expect(result.current.displayData).toEqual(cached);
    const stored = JSON.parse(localStorage.getItem(LIVE_KEY)!) as {
      data: OpeningFlowResponse;
    };
    expect(stored.data).toEqual(cached);
  });

  it('reports a schema failure to Sentry by name with the date and issues', async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    const { result } = renderHook(() => useOpeningFlowSignal('2026-05-12'));

    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'opening-flow-signal response failed schema validation',
    );
    const context = (
      options as { contexts: { openingFlowSignal: Record<string, unknown> } }
    ).contexts.openingFlowSignal;
    expect(context.date).toBe('2026-05-12');
    // Flat "path: message" strings, which survive Sentry's depth-3
    // normalization; issue objects would arrive as "[Object]".
    const issues = context.issues as unknown[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toEqual(expect.stringMatching(/^[\w.]+: \S/));
    }
    expect(issues).toContainEqual(expect.stringMatching(/^tickers: /));
    expect(context.issueCount).toBe(issues.length);
  });

  it('reports a request that keeps failing once, not once per poll', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const { result } = renderHook(() => useOpeningFlowSignal());
    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('reports again once a good response came in between', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({}))
      .mockResolvedValueOnce(okResponse(makeResponse()))
      .mockResolvedValueOnce(okResponse({}));
    const { result } = renderHook(() => useOpeningFlowSignal());
    await waitFor(() => {
      expect(result.current.error).toBe('invalid response shape');
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe('invalid response shape');
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('accepts a payload without the fields the panel never reads', async () => {
    const full = makeResponse();
    const spy = full.tickers.SPY!;
    const body = {
      date: full.date,
      windowStatus: full.windowStatus,
      stopPct: full.stopPct,
      exitMinutesFromEntry: full.exitMinutesFromEntry,
      tickers: {
        SPY: {
          slice1: {
            tickets: spy.slice1!.tickets,
            biasSide: 'call',
            biasRatio: 1,
            top3SameSide: true,
          },
          slice2: { biasShare: 0.7, confirms: true },
          signal: spy.signal,
        },
      },
    };
    fetchMock.mockResolvedValue(okResponse(body));

    const { result } = renderHook(() => useOpeningFlowSignal());

    await waitFor(() => {
      expect(result.current.data?.date).toBe(full.date);
    });
    expect(result.current.error).toBeNull();
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('stores and reports nothing odd for a well-formed payload', async () => {
    const body = makeResponse();
    fetchMock.mockResolvedValue(okResponse(body));

    const { result } = renderHook(() => useOpeningFlowSignal());

    await waitFor(() => {
      expect(result.current.data).toEqual(body);
    });
    expect(result.current.error).toBeNull();
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
    expect(localStorage.getItem(LIVE_KEY)).not.toBeNull();
  });
});

describe('useOpeningFlowSignal: a 2xx body that is not JSON', () => {
  function notJsonResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as Response;
  }

  it('is a failed fetch that stores nothing and is reported by name', async () => {
    fetchMock.mockResolvedValue(notJsonResponse());

    const { result } = renderHook(() => useOpeningFlowSignal());

    await waitFor(() => {
      expect(result.current.error).toBe('invalid response (not JSON)');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(localStorage.getItem(LIVE_KEY)).toBeNull();
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect((err as Error).message).toBe(
      'opening-flow-signal response was not JSON',
    );
    expect(options).toEqual({
      contexts: {
        openingFlowSignal: { date: null, detail: 'Unexpected token <' },
      },
    });
  });

  it('keeps the last good payload', async () => {
    const good = makeResponse();
    fetchMock
      .mockResolvedValueOnce(okResponse(good))
      .mockResolvedValueOnce(notJsonResponse());
    const { result } = renderHook(() => useOpeningFlowSignal());
    await waitFor(() => {
      expect(result.current.data).toEqual(good);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe('invalid response (not JSON)');
    expect(result.current.data).toEqual(good);
    expect(result.current.displayData).toEqual(good);
  });
});

describe('useOpeningFlowSignal: last-good cache validation', () => {
  it('ignores a cached payload that fails the schema', () => {
    // Written by an older build, or by a malformed 200 before the fetch
    // was validated: it has a date but no tickers map.
    seedLiveCache({ date: '2026-05-13', windowStatus: 'closed' });
    // The mount fetch never settles, so only the cache drives displayData.
    fetchMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useOpeningFlowSignal());

    expect(result.current.displayData).toBeNull();
  });

  it('serves a cached payload that passes the schema', () => {
    const cached = makeResponse();
    seedLiveCache(cached);
    fetchMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useOpeningFlowSignal());

    expect(result.current.displayData).toEqual(cached);
  });
});

// /api/opening-flow-signal is owner-or-guest. A public visitor's request is a
// 401 that the panel shows as a red "HTTP 401", and the never-expiring live
// cache slot would show them a previous session's UW-derived payload.
describe('useOpeningFlowSignal: public visitor', () => {
  beforeEach(() => {
    mockGetAccessMode.mockReturnValue('public');
  });

  it('makes no eager fetch for the live signal and stays idle', async () => {
    const { result } = renderHook(() => useOpeningFlowSignal());
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.displayData).toBeNull();
  });

  it('makes no historical fetch on mount or on a date pick', async () => {
    const { result, rerender } = renderHook(
      ({ date }: { date?: string }) => useOpeningFlowSignal(date),
      { initialProps: { date: '2026-05-12' } as { date?: string } },
    );
    rerender({ date: '2026-05-11' });
    rerender({ date: undefined });
    rerender({ date: '2026-05-08' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.displayData).toBeNull();
  });

  it('schedules no poll and fetches nothing inside the signal window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(IN_WINDOW);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const { result } = renderHook(() => useOpeningFlowSignal());
    // The mount fetch, then several 30s poll periods.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000 * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalledWith(
      expect.any(Function),
      30_000,
    );
    expect(result.current.isWindowOpen).toBe(false);
  });

  it('shows no cached payload, live or historical', () => {
    seedLiveCache(makeResponse());
    seedHistoricalCache(makeResponse({ date: '2026-05-12' }));

    const live = renderHook(() => useOpeningFlowSignal());
    const historical = renderHook(() => useOpeningFlowSignal('2026-05-12'));

    expect(live.result.current.displayData).toBeNull();
    expect(historical.result.current.displayData).toBeNull();
    // Hidden, not deleted: a purge is the caller's job, and a later guest
    // login on this browser may still use the cache.
    expect(localStorage.getItem(LIVE_KEY)).not.toBeNull();
    expect(localStorage.getItem(HISTORICAL_KEY)).not.toBeNull();
  });

  it('makes no request when refresh is called', async () => {
    const { result } = renderHook(() => useOpeningFlowSignal());

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides data fetched while signed in once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    const body = makeResponse();
    fetchMock.mockResolvedValue(okResponse(body));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => {
      expect(result.current.displayData).toEqual(body);
    });

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender();

    // The first render after the drop commits before any effect runs, so it
    // is the one that would paint the held payload: it must already be empty.
    expect(renders[before]?.data).toBeNull();
    expect(renders[before]?.displayData).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.displayData).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('hides an error left in memory once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock.mockResolvedValue(notOkResponse(401));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => {
      expect(result.current.error).toBe('HTTP 401');
    });

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender();

    expect(renders[before]?.error).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('starts clean, not from the earlier session, when the visitor signs back in', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    const body = makeResponse();
    fetchMock
      .mockResolvedValueOnce(okResponse(body))
      // The second sign-in's fetch never settles, so only state the hook kept
      // from before the drop can show up as `data`.
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(() => useOpeningFlowSignal());
    await waitFor(() => {
      expect(result.current.data).toEqual(body);
    });

    mockGetAccessMode.mockReturnValue('public');
    rerender();
    mockGetAccessMode.mockReturnValue('guest');
    rerender();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.data).toBeNull();
    expect(result.current.fetchedAt).toBeNull();
    expect(result.current.loading).toBe(true);
    // The last-good cache slot still serves the panel meanwhile.
    expect(result.current.displayData).toEqual(body);
  });

  it('aborts the request in flight on a drop to public, and stores nothing from its late reply', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    let signal: AbortSignal | undefined;
    let reply: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          signal = init.signal ?? undefined;
          reply = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useOpeningFlowSignal());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(signal?.aborted).toBe(false);

    mockGetAccessMode.mockReturnValue('public');
    rerender();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      reply(okResponse(makeResponse()));
      await Promise.resolve();
    });

    expect(localStorage.getItem(LIVE_KEY)).toBeNull();
    expect(result.current.displayData).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the live signal', undefined, '/api/opening-flow-signal'],
    [
      'a historical date',
      '2026-05-12',
      '/api/opening-flow-signal?date=2026-05-12',
    ],
  ])(
    'starts fetching %s once the visitor signs in without a reload',
    async (_label, date, url) => {
      const body = makeResponse({ date: date ?? '2026-05-13' });
      fetchMock.mockResolvedValue(okResponse(body));
      const { result, rerender } = renderHook(() => useOpeningFlowSignal(date));
      await act(async () => {
        await Promise.resolve();
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // The mode is read at render, not frozen at mount.
      mockGetAccessMode.mockReturnValue('guest');
      rerender();

      await waitFor(() => {
        expect(result.current.displayData).toEqual(body);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ credentials: 'include' }),
      );
    },
  );
});

describe.each(['owner', 'guest'] as const satisfies readonly AccessMode[])(
  'useOpeningFlowSignal: %s keeps fetching',
  (mode) => {
    beforeEach(() => {
      mockGetAccessMode.mockReturnValue(mode);
    });

    it('fetches the live signal on mount, even outside the window', async () => {
      const body = makeResponse();
      fetchMock.mockResolvedValue(okResponse(body));

      const { result } = renderHook(() => useOpeningFlowSignal());

      await waitFor(() => {
        expect(result.current.displayData).toEqual(body);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/opening-flow-signal',
        expect.objectContaining({ credentials: 'include' }),
      );
      expect(localStorage.getItem(LIVE_KEY)).not.toBeNull();
    });

    it('fetches a historical date on mount and again on each date pick', async () => {
      fetchMock.mockResolvedValue(okResponse(makeResponse()));
      const { rerender } = renderHook(
        ({ date }: { date: string }) => useOpeningFlowSignal(date),
        { initialProps: { date: '2026-05-12' } },
      );
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      expect(fetchMock.mock.calls[0]![0]).toBe(
        '/api/opening-flow-signal?date=2026-05-12',
      );

      rerender({ date: '2026-05-11' });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
      expect(fetchMock.mock.calls[1]![0]).toBe(
        '/api/opening-flow-signal?date=2026-05-11',
      );
    });

    it('polls every 30s inside the window and reports it open', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(IN_WINDOW);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      fetchMock.mockResolvedValue(okResponse(makeResponse()));

      const { result } = renderHook(() => useOpeningFlowSignal());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.isWindowOpen).toBe(true);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('serves the cached payload while the first fetch is out', () => {
      const cached = makeResponse();
      seedLiveCache(cached);
      fetchMock.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useOpeningFlowSignal());

      expect(result.current.displayData).toEqual(cached);
    });

    it('surfaces a non-2xx reply by name and keeps the cached payload', async () => {
      const cached = makeResponse();
      seedLiveCache(cached);
      fetchMock.mockResolvedValue(notOkResponse(401));

      const { result } = renderHook(() => useOpeningFlowSignal());

      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 401');
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
      expect(result.current.displayData).toEqual(cached);
      const stored = JSON.parse(localStorage.getItem(LIVE_KEY)!) as {
        data: OpeningFlowResponse;
      };
      expect(stored.data).toEqual(cached);
    });

    it('surfaces a rejected fetch by name and keeps the cached payload', async () => {
      const cached = makeResponse();
      seedLiveCache(cached);
      fetchMock.mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => useOpeningFlowSignal());

      await waitFor(() => {
        expect(result.current.error).toBe('network down');
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
      expect(result.current.displayData).toEqual(cached);
    });

    it('does not fetch again on a plain re-render once the first fetch settles', async () => {
      fetchMock.mockResolvedValue(okResponse(makeResponse()));
      const { result, rerender } = renderHook(() => useOpeningFlowSignal());
      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      rerender();
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not fetch again when the mode flips between owner and guest', async () => {
      fetchMock.mockResolvedValue(okResponse(makeResponse()));
      const { result, rerender } = renderHook(() => useOpeningFlowSignal());
      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      mockGetAccessMode.mockReturnValue(mode === 'owner' ? 'guest' : 'owner');
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  },
);
