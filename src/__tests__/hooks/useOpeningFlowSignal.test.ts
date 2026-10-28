/**
 * useOpeningFlowSignal: response validation at the fetch boundary and in
 * the localStorage last-good cache. A 200 whose body doesn't match the
 * /api/opening-flow-signal contract is handled like a failed fetch, so the
 * panel never renders (and crashes on) a malformed payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
    expect(options).toEqual(
      expect.objectContaining({
        contexts: expect.objectContaining({
          openingFlowSignal: expect.objectContaining({
            date: '2026-05-12',
            issues: expect.any(Array),
          }),
        }),
      }),
    );
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
