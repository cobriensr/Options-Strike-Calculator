// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────
// Sentry helper is a no-op in tests — we only care it isn't a hard
// dependency that crashes the error path.
vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));

// Shorten the auto-poll cadence so the "polls on today + open" assertion
// resolves quickly instead of waiting the production interval.
vi.mock('../constants', async () => {
  const actual =
    await vi.importActual<typeof import('../constants')>('../constants');
  return {
    ...actual,
    POLL_INTERVALS: { ...actual.POLL_INTERVALS, ALERTS: 30 },
  };
});

import { captureUnlessAuth } from '../lib/sentry-helpers';
import {
  useIntervalBAFeed,
  type IntervalBAFeedAlert,
  type IntervalBAFeedSummary,
  type UseIntervalBAFeedParams,
} from '../hooks/useIntervalBAFeed';

// CT calendar "today" — mirrors the hook's own todayCt() so the polling
// gate predicate matches regardless of the wall-clock day the suite runs.
function todayCt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const baseAlert: IntervalBAFeedAlert = {
  id: 1,
  option_chain: 'SPXW260512C07360000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: 7360,
  expiry: '2026-05-12',
  bucket_start: '2026-05-12T17:05:00.000Z',
  bucket_end: '2026-05-12T17:10:00.000Z',
  fired_at: '2026-05-12T17:06:24.000Z',
  ratio_pct: 71.23,
  ask_premium: 950000,
  total_premium: 1330000,
  trade_count: 5,
  top_trade_premium: 408480,
  top_trade_size: 888,
  top_trade_executed_at: '2026-05-12T17:06:23.000Z',
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: 7355,
  confluence_tickers: [],
  severity: 'extreme',
};

const baseSummary: IntervalBAFeedSummary = {
  count: 1,
  total_premium: 1330000,
  extreme: 1,
  critical: 0,
  warning: 0,
};

const baseParams: UseIntervalBAFeedParams = {
  date: '2026-05-12',
  startTime: '08:30',
  endTime: '15:00',
  optionType: null,
  minPremium: 0,
  confluenceOnly: false,
  moneyness: null,
};

function mockFetchJson(payload: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as typeof fetch;
}

describe('useIntervalBAFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in the loading state with empty data', () => {
    // Never-resolving fetch so we can observe the initial state.
    globalThis.fetch = vi
      .fn()
      .mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    expect(result.current.loading).toBe(true);
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).toBeNull();
  });

  it('fetches the historical slice and transitions to parsed data', async () => {
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.alerts).toHaveLength(1);
    expect(result.current.alerts[0]?.id).toBe(1);
    expect(result.current.summary).toEqual(baseSummary);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('builds the request URL from the date + time window params', async () => {
    mockFetchJson({ alerts: [], summary: { ...baseSummary, count: 0 } });

    renderHook(() =>
      useIntervalBAFeed({
        ...baseParams,
        optionType: 'C',
        minPremium: 250000,
        confluenceOnly: true,
        moneyness: 'OTM',
      }),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(url).toContain('/api/interval-ba-feed?');
    expect(url).toContain('date=2026-05-12');
    expect(url).toContain('startTime=08%3A30');
    expect(url).toContain('endTime=15%3A00');
    expect(url).toContain('optionType=C');
    expect(url).toContain('minPremium=250000');
    expect(url).toContain('confluenceOnly=1');
    expect(url).toContain('moneyness=OTM');
  });

  it('does NOT auto-poll when the market is closed (historical view)', async () => {
    // Today's date but marketOpen=false → the mount fetch fires once, but
    // the recurring poll gate stays closed, so no further fetches arrive.
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { unmount } = renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: todayCt() }, false),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    // Wait through several would-be poll cycles (30 ms × 3).
    await new Promise((r) => setTimeout(r, 120));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('auto-polls when viewing today during market hours', async () => {
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { unmount } = renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: todayCt() }, true),
    );

    // Mount fetch + at least one poll-driven refetch.
    await waitFor(
      () => {
        expect(
          (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1_000 },
    );

    unmount();
  });

  it('surfaces an error message on a non-ok response', async () => {
    mockFetchJson({ error: 'boom' }, false);

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.alerts).toEqual([]);
  });
});

describe('useIntervalBAFeed settling and abort', () => {
  // useDebounced's default delay: how long a changed date or time window
  // waits before the hook fetches it.
  const SETTLE_MS = 250;

  interface PendingFetch {
    url: string;
    signal: AbortSignal;
    resolve: (payload: unknown) => void;
    reject: (err: unknown) => void;
  }

  /**
   * A fetch whose every call stays pending until the test settles it. With
   * `honorAbort` it rejects with the signal's reason when its signal aborts,
   * like a real fetch; without it the response can still arrive after the
   * abort, so the tests can check the hook never writes it to state.
   */
  function stubPendingFetch(honorAbort: boolean): PendingFetch[] {
    const calls: PendingFetch[] = [];
    globalThis.fetch = vi.fn(
      (url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (honorAbort) {
            signal.addEventListener('abort', () => reject(signal.reason));
          }
          calls.push({
            url,
            signal,
            resolve: (payload) =>
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => payload,
              }),
            reject,
          });
        }),
    ) as unknown as typeof fetch;
    return calls;
  }

  function fetchUrls(): string[] {
    return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function respond(call: PendingFetch, payload: unknown): Promise<void> {
    await act(async () => {
      call.resolve(payload);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  function renderFeed(initial: UseIntervalBAFeedParams, marketOpen = false) {
    return renderHook(
      (params: UseIntervalBAFeedParams) =>
        useIntervalBAFeed(params, marketOpen),
      { initialProps: initial },
    );
  }

  const emptyPayload = { alerts: [], summary: { ...baseSummary, count: 0 } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches on mount without waiting for the delay', () => {
    mockFetchJson(emptyPayload);

    renderFeed(baseParams);

    expect(fetchUrls()).toHaveLength(1);
  });

  it.each([
    ['startTime', ['08:31', '08:32', '08:33'], 'startTime=08%3A33'],
    ['endTime', ['14:58', '14:57', '14:56'], 'endTime=14%3A56'],
    ['date', ['2026-05-13', '2026-05-14', '2026-05-15'], 'date=2026-05-15'],
  ] as const)(
    'sends one request for a burst of %s changes, with the last value',
    async (field, values, expected) => {
      mockFetchJson(emptyPayload);
      const { rerender } = renderFeed(baseParams);

      for (const value of values) {
        rerender({ ...baseParams, [field]: value });
        await advance(SETTLE_MS - 50);
      }
      // Each change came inside the previous one's window: nothing yet.
      expect(fetchUrls()).toHaveLength(1);

      await advance(50);
      expect(fetchUrls()).toHaveLength(2);
      expect(fetchUrls()[1]).toContain(expected);

      await advance(SETTLE_MS * 4);
      expect(fetchUrls()).toHaveLength(2);
    },
  );

  it('sends one request when the date and both times change together', async () => {
    mockFetchJson(emptyPayload);
    const { rerender } = renderFeed(baseParams);

    rerender({
      ...baseParams,
      date: '2026-05-13',
      startTime: '09:00',
      endTime: '14:00',
    });
    await advance(SETTLE_MS);

    expect(fetchUrls()).toHaveLength(2);
    expect(fetchUrls()[1]).toContain('date=2026-05-13');
    expect(fetchUrls()[1]).toContain('startTime=09%3A00');
    expect(fetchUrls()[1]).toContain('endTime=14%3A00');
  });

  it('sends a second request for a change after the window', async () => {
    mockFetchJson(emptyPayload);
    const { rerender } = renderFeed(baseParams);

    rerender({ ...baseParams, startTime: '09:00' });
    await advance(SETTLE_MS);
    expect(fetchUrls()).toHaveLength(2);

    rerender({ ...baseParams, startTime: '09:30' });
    await advance(SETTLE_MS);
    expect(fetchUrls()).toHaveLength(3);
    expect(fetchUrls()[2]).toContain('startTime=09%3A30');
  });

  it('fetches a filter change at once, without the delay', () => {
    mockFetchJson(emptyPayload);
    const { rerender } = renderFeed(baseParams);

    rerender({ ...baseParams, optionType: 'C' });

    expect(fetchUrls()).toHaveLength(2);
    expect(fetchUrls()[1]).toContain('optionType=C');
  });

  it('drops a pending change when unmounted', async () => {
    mockFetchJson(emptyPayload);
    const { rerender, unmount } = renderFeed(baseParams);

    rerender({ ...baseParams, startTime: '09:00' });
    unmount();
    await advance(SETTLE_MS * 2);

    expect(fetchUrls()).toHaveLength(1);
  });

  it('aborts the superseded request and ignores its response when it arrives before the new one', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderFeed(baseParams);
    expect(calls).toHaveLength(1);

    rerender({ ...baseParams, startTime: '09:00' });
    await advance(SETTLE_MS);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);

    await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(result.current.fetchedAt).toBeNull();
    expect(result.current.loading).toBe(true);

    const newer = { ...baseAlert, id: 2 };
    await respond(calls[1]!, { alerts: [newer], summary: baseSummary });
    expect(result.current.alerts).toEqual([newer]);
    expect(result.current.loading).toBe(false);
  });

  it('does not let a superseded response replace newer data', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderFeed(baseParams);

    rerender({ ...baseParams, startTime: '09:00' });
    await advance(SETTLE_MS);
    const newer = { ...baseAlert, id: 2 };
    await respond(calls[1]!, { alerts: [newer], summary: baseSummary });
    expect(result.current.alerts).toEqual([newer]);

    await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });

    expect(result.current.alerts).toEqual([newer]);
  });

  it('aborts the in-flight request on unmount without an error or a report', async () => {
    const calls = stubPendingFetch(true);
    const { unmount } = renderFeed(baseParams);
    expect(calls[0]?.signal.aborted).toBe(false);

    unmount();
    await advance(0);

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('treats an aborted request as no error and sends no report', async () => {
    const calls = stubPendingFetch(true);
    const { result, rerender } = renderFeed(baseParams);

    rerender({ ...baseParams, startTime: '09:00' });
    await advance(SETTLE_MS);
    expect(calls[0]?.signal.aborted).toBe(true);
    await respond(calls[1]!, { alerts: [baseAlert], summary: baseSummary });

    expect(result.current.error).toBeNull();
    expect(result.current.alerts).toHaveLength(1);
    expect(captureUnlessAuth).not.toHaveBeenCalled();
  });

  it('still surfaces and reports a network failure', async () => {
    const calls = stubPendingFetch(false);
    const failure = new Error('network down');
    const { result } = renderFeed(baseParams);

    await act(async () => {
      calls[0]?.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.error).toBe('network down');
    expect(result.current.loading).toBe(false);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      tags: { context: 'interval_ba_feed' },
    });
  });

  it('keeps the 15 s timeout: its expiry surfaces as an error, not as an abort', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const calls = stubPendingFetch(true);
    const { result } = renderFeed(baseParams);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);

    await act(async () => {
      timeout.abort(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(result.current.error).toContain('timed out');
    expect(result.current.loading).toBe(false);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
  });

  it('keeps polling at its interval while viewing today with the market open', async () => {
    mockFetchJson(emptyPayload);
    renderFeed({ ...baseParams, date: todayCt() }, true);
    expect(fetchUrls()).toHaveLength(1);

    await advance(30);
    expect(fetchUrls()).toHaveLength(2);
    await advance(30);
    expect(fetchUrls()).toHaveLength(3);
  });

  it('polls with the last settled params, not a change still waiting', async () => {
    mockFetchJson(emptyPayload);
    const today = todayCt();
    const { rerender } = renderFeed({ ...baseParams, date: today }, true);

    rerender({ ...baseParams, date: today, startTime: '09:00' });
    await advance(30);
    expect(fetchUrls()).toHaveLength(2);
    expect(fetchUrls()[1]).toContain('startTime=08%3A30');

    await advance(SETTLE_MS - 30);
    expect(fetchUrls().at(-1)).toContain('startTime=09%3A00');
    expect(
      fetchUrls()
        .slice(0, -1)
        .every((url) => url.includes('startTime=08%3A30')),
    ).toBe(true);
  });
});
