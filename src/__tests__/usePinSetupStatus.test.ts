/**
 * usePinSetupStatus — Pin-Setup Tile data hook. Live mode (no date)
 * polls every PIN_SETUP_INTERVAL (60s) while marketOpen; historical
 * mode (caller sets a date) is one-shot. /api/pin-setup-status is
 * owner-or-guest, so a public visitor makes no request of any kind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  usePinSetupStatus,
  type PinSetupStatus,
} from '../hooks/usePinSetupStatus';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { getAccessMode, type AccessMode } from '../utils/auth';

vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);
const mockGetAccessMode = vi.mocked(getAccessMode);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockClear();
  mockGetAccessMode.mockReturnValue('owner');
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function sampleStatus(overrides: Partial<PinSetupStatus> = {}): PinSetupStatus {
  return {
    evaluatedAt: '2026-05-14T18:00:00Z',
    date: null,
    mode: 'live',
    snapshotTs: '2026-05-14T17:59:00Z',
    staleMinutes: 1,
    state: 'WATCH',
    conditions: {
      netGammaAtMagnetM: 1200,
      netGammaThresholdM: 800,
      netGammaMet: true,
      magnetStrike: 5800,
      isRound50: true,
      distanceToMagnet: 4,
      distanceThreshold: 10,
      distanceMet: true,
    },
    spot: 5796,
    bias: 'full-pin',
    recommendedTradeTypes: ['iron condor'],
    avoidedTradeTypes: [],
    trajectory: [],
    outcome: null,
    asOf: '2026-05-14T18:00:00Z',
    ...overrides,
  };
}

/** renderHook, plus every value the hook returned, one per render. */
function renderRecorded() {
  const renders: ReturnType<typeof usePinSetupStatus>[] = [];
  const rendered = renderHook(() => {
    const value = usePinSetupStatus({ marketOpen: false });
    renders.push(value);
    return value;
  });
  return { ...rendered, renders };
}

describe.each(['owner', 'guest'] as const satisfies readonly AccessMode[])(
  'usePinSetupStatus: %s',
  (mode) => {
    beforeEach(() => {
      mockGetAccessMode.mockReturnValue(mode);
    });

    it('fetches /api/pin-setup-status with no date in live mode', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(sampleStatus()));
      renderHook(() => usePinSetupStatus({ marketOpen: false }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toBe('/api/pin-setup-status');
    });

    it('appends date to the URL when setDate is called', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await act(async () => {
        result.current.setDate('2026-05-08');
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some((c) =>
            (c[0] as string).includes('date=2026-05-08'),
          ),
        ).toBe(true),
      );
    });

    it('exposes data + clears loading on success', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(sampleStatus()));
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data?.state).toBe('WATCH');
      expect(result.current.data?.bias).toBe('full-pin');
      expect(result.current.error).toBeNull();
    });

    it('exposes an HTTP error message on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'unauthorized' }, 401),
      );
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe('HTTP 401');
      expect(result.current.data).toBeNull();
    });

    it('surfaces a rejected fetch as a string error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe('network down');
      expect(result.current.data).toBeNull();
    });

    it('polls every 60s in live mode while marketOpen', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      renderHook(() => usePinSetupStatus({ marketOpen: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not poll when marketOpen=false', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      renderHook(() => usePinSetupStatus({ marketOpen: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not poll when a historical date is selected, even with marketOpen', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: true }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        result.current.setDate('2024-01-01');
        await vi.advanceTimersByTimeAsync(0);
      });
      // Effect re-fires on date change → one fresh fetch, then no polling.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('exposes refresh that fires a fresh fetch with the current date', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      const { result } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        result.current.refresh();
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('does not fetch again on a plain re-render once the first fetch settles', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      const { result, rerender } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.data).not.toBeNull());

      rerender();
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not fetch again, or drop its data, when the mode flips between owner and guest', async () => {
      fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
      const { result, rerender } = renderHook(() =>
        usePinSetupStatus({ marketOpen: false }),
      );
      await waitFor(() => expect(result.current.data).not.toBeNull());

      mockGetAccessMode.mockReturnValue(mode === 'owner' ? 'guest' : 'owner');
      rerender();
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.data?.state).toBe('WATCH');
    });
  },
);

// /api/pin-setup-status is owner-or-guest. A public visitor's request is a 401
// that the tile shows as a red "HTTP 401". The hook makes no request for one
// whoever its caller is, so it does not lean on the `marketOpen` a caller
// passes to keep the poll shut.
describe('usePinSetupStatus: public visitor', () => {
  beforeEach(() => {
    mockGetAccessMode.mockReturnValue('public');
  });

  it('makes no fetch on mount and returns nothing, loading included', async () => {
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('makes no fetch on a date pick, and keeps the picked date', async () => {
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await act(async () => {
      result.current.setDate('2026-05-08');
    });
    await act(async () => {
      result.current.setDate('2026-05-07');
    });
    await act(async () => {
      result.current.setDate(null);
    });
    await act(async () => {
      result.current.setDate('2026-05-06');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.date).toBe('2026-05-06');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('makes no request when refresh is called', async () => {
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );

    await act(async () => {
      result.current.refresh();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('schedules no poll even when the caller says the market is open', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    renderHook(() => usePinSetupStatus({ marketOpen: true }));
    // The mount fetch, then several 60s poll periods.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 * 5);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
    );
  });

  it('hides data fetched while signed in once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => expect(result.current.data?.state).toBe('WATCH'));

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender();

    // The first render after the drop commits before any effect runs, so it
    // is the one that would paint the held payload: it must already be empty.
    expect(renders[before]?.data).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('hides an error left in memory once the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => expect(result.current.error).toBe('HTTP 401'));

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender();

    expect(renders[before]?.error).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('hides loading while a request is in flight when the visitor drops to public', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result, rerender, renders } = renderRecorded();
    await waitFor(() => expect(result.current.loading).toBe(true));

    const before = renders.length;
    mockGetAccessMode.mockReturnValue('public');
    rerender();

    expect(renders[before]?.loading).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('starts clean, not from the earlier session, when the visitor signs back in', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(sampleStatus()))
      // The second sign-in's fetch never settles, so only state the hook kept
      // from before the drop can show up as `data`.
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderRecorded();
    await waitFor(() => expect(result.current.data?.state).toBe('WATCH'));

    mockGetAccessMode.mockReturnValue('public');
    rerender();
    mockGetAccessMode.mockReturnValue('guest');
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('aborts the request in flight on a drop to public, and keeps nothing from its late reply', async () => {
    mockGetAccessMode.mockReturnValue('guest');
    let signal: AbortSignal | undefined;
    let reply: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            signal = init.signal ?? undefined;
            reply = resolve;
          }),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderRecorded();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    mockGetAccessMode.mockReturnValue('public');
    rerender();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      reply(jsonResponse(sampleStatus()));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Signing back in: nothing from the aborted request was stored.
    mockGetAccessMode.mockReturnValue('guest');
    rerender();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeNull();
  });

  it('starts fetching the live status once the visitor signs in without a reload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result, rerender } = renderRecorded();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The mode is read at render, not frozen at mount.
    mockGetAccessMode.mockReturnValue('guest');
    rerender();

    await waitFor(() => expect(result.current.data?.state).toBe('WATCH'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pin-setup-status',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('fetches the date picked while public once the visitor signs in', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { result, rerender } = renderRecorded();
    await act(async () => {
      result.current.setDate('2026-05-08');
    });
    expect(fetchMock).not.toHaveBeenCalled();

    mockGetAccessMode.mockReturnValue('guest');
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/pin-setup-status?date=2026-05-08',
    );
  });

  it('polls again once the visitor signs in while the market is open', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(sampleStatus()));
    const { rerender } = renderHook(() =>
      usePinSetupStatus({ marketOpen: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    mockGetAccessMode.mockReturnValue('guest');
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('usePinSetupStatus: malformed 200 payloads', () => {
  it.each([
    ['an empty object', {}],
    ['a missing state', { ...sampleStatus(), state: undefined }],
    ['an unknown state', { ...sampleStatus(), state: 'PINNED' }],
    ['a null conditions block', { ...sampleStatus(), conditions: null }],
    ['a non-array trajectory', { ...sampleStatus(), trajectory: 'oops' }],
  ])('treats %s as a failed fetch', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('invalid response shape');
    expect(result.current.data).toBeNull();
  });

  it('keeps the last good status when a refresh returns a malformed body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(sampleStatus()))
      .mockResolvedValueOnce(jsonResponse({ state: 3 }));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.data?.state).toBe('WATCH'));

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.error).toBe('invalid response shape'),
    );
    expect(result.current.data).toEqual(sampleStatus());
  });

  it('reports a schema failure to Sentry by name with the date and issues', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'pin-setup-status response failed schema validation',
    );
    const context = (
      options as { contexts: { pinSetupStatus: Record<string, unknown> } }
    ).contexts.pinSetupStatus;
    expect(context.date).toBeNull();
    // Flat "path: message" strings, which survive Sentry's depth-3
    // normalization; issue objects would arrive as "[Object]".
    const issues = context.issues as unknown[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toEqual(expect.stringMatching(/^[\w.]+: \S/));
    }
    expect(issues).toContainEqual(expect.stringMatching(/^state: /));
    expect(context.issueCount).toBe(issues.length);
  });

  it('reports a request that keeps failing once, not once per poll', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('reports again once a good response came in between', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse(sampleStatus()))
      .mockResolvedValueOnce(jsonResponse({}));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() =>
      expect(result.current.error).toBe('invalid response shape'),
    );

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.error).toBe('invalid response shape'),
    );

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(2);
  });

  it('accepts a status without the fields the tile never reads', async () => {
    const full = sampleStatus();
    const body = {
      evaluatedAt: full.evaluatedAt,
      date: full.date,
      mode: full.mode,
      staleMinutes: full.staleMinutes,
      state: full.state,
      conditions: {
        netGammaAtMagnetM: full.conditions.netGammaAtMagnetM,
        magnetStrike: full.conditions.magnetStrike,
        distanceToMagnet: full.conditions.distanceToMagnet,
      },
      spot: full.spot,
      bias: full.bias,
      recommendedTradeTypes: full.recommendedTradeTypes,
      trajectory: full.trajectory,
      outcome: full.outcome,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.data?.state).toBe('WATCH');
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('does not report a well-formed response to Sentry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleStatus()));
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });
});

describe('usePinSetupStatus: a 2xx body that is not JSON', () => {
  function notJsonResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as Response;
  }

  it('is a failed fetch that stores nothing and is reported by name', async () => {
    fetchMock.mockResolvedValue(notJsonResponse());
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('invalid response (not JSON)');
    expect(result.current.data).toBeNull();
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    const [err, options] = mockCaptureUnlessAuth.mock.calls[0]!;
    expect((err as Error).message).toBe(
      'pin-setup-status response was not JSON',
    );
    expect(options).toEqual({
      contexts: {
        pinSetupStatus: { date: null, detail: 'Unexpected token <' },
      },
    });
  });

  it('keeps the last good status', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(sampleStatus()))
      .mockResolvedValueOnce(notJsonResponse());
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(result.current.data?.state).toBe('WATCH'));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.error).toBe('invalid response (not JSON)'),
    );

    expect(result.current.data).toEqual(sampleStatus());
  });
});

describe('usePinSetupStatus: superseded fetches', () => {
  it('drops a live response that lands after the historical date it was replaced by', async () => {
    let resolveLive: (res: Response) => void = () => {};
    const live = new Promise<Response>((resolve) => {
      resolveLive = resolve;
    });
    const historical = sampleStatus({ mode: 'historical', date: '2026-05-08' });
    fetchMock.mockImplementation((url: string) =>
      url.includes('date=') ? Promise.resolve(jsonResponse(historical)) : live,
    );
    const { result } = renderHook(() =>
      usePinSetupStatus({ marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.setDate('2026-05-08');
    });
    await waitFor(() => expect(result.current.data?.mode).toBe('historical'));

    // The live request that was in flight answers late.
    await act(async () => {
      resolveLive(jsonResponse(sampleStatus({ mode: 'live' })));
      await live;
    });

    expect(result.current.data).toEqual(historical);
    expect(result.current.loading).toBe(false);
    const liveInit = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(liveInit?.signal?.aborted).toBe(true);
  });
});
