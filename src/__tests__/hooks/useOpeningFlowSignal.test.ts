/**
 * useOpeningFlowSignal: response validation at the fetch boundary and in
 * the localStorage last-good cache. A 200 whose body doesn't match the
 * /api/opening-flow-signal contract is handled like a failed fetch, so the
 * panel never renders (and crashes on) a malformed payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useOpeningFlowSignal,
  type OpeningFlowResponse,
} from '../../hooks/useOpeningFlowSignal';
import { captureUnlessAuth } from '../../lib/sentry-helpers';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const fetchMock = vi.fn();

const LIVE_KEY = 'openingFlowSignal.lastGood';

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

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
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
