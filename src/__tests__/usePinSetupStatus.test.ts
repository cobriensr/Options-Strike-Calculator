/**
 * usePinSetupStatus — Pin-Setup Tile data hook. Live mode (no date)
 * polls every PIN_SETUP_INTERVAL (60s) while marketOpen; historical
 * mode (caller sets a date) is one-shot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  usePinSetupStatus,
  type PinSetupStatus,
} from '../hooks/usePinSetupStatus';
import { captureUnlessAuth } from '../lib/sentry-helpers';

vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
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

describe('usePinSetupStatus', () => {
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
    expect(result.current.error).toContain('401');
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
