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
import { POLL_INTERVALS } from '../constants';
import { getETDateStr } from '../utils/timezone';

// The hook gates its poll on `params.date` being today on the shared ET clock
// (`useETToday`), which rolls at 23:00:01 CT (1 s past ET midnight). Every
// test here that reads "today" runs on a pinned clock (file-level beforeEach):
// with no pin, a run from 23:00 to 24:00 CT gets a CT `date` that is already
// yesterday's, the hook calls it historical, and a "does not poll" test passes
// because of that, not the market. The pin is Thursday 2026-05-14, 13:00 ET,
// after the fixtures' date (2026-05-12), which stays a past day.
const PINNED_NOW = '2026-05-14T17:00:00Z';
const TODAY_ET = getETDateStr(new Date(PINNED_NOW));

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
    // Only Date is faked, so the real timers and waitFor below keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PINNED_NOW));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      useIntervalBAFeed({ ...baseParams, date: TODAY_ET }, false),
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
      useIntervalBAFeed({ ...baseParams, date: TODAY_ET }, true),
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

  // A 2xx the feed cannot use is a failed fetch, not an empty day: it shows an
  // error, reports it once, and holds no alerts.
  it.each([
    ['a string', 'not an object'],
    ['null', null],
    ['an object with no alerts', { summary: baseSummary }],
    ['an object with no summary', { alerts: [baseAlert] }],
    ['alerts that are not an array', { alerts: 'x', summary: baseSummary }],
  ])('reports a malformed 2xx payload: %s', async (_name, payload) => {
    mockFetchJson(payload);

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('malformed response');
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'malformed response' }),
      { tags: { context: 'interval_ba_feed' } },
    );
  });

  it('reports a 2xx whose body is not JSON', async () => {
    const failure = new SyntaxError('Unexpected token < in JSON at position 0');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockRejectedValue(failure),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe(failure.message);
    expect(result.current.alerts).toEqual([]);
    expect(captureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(captureUnlessAuth).toHaveBeenCalledWith(failure, {
      tags: { context: 'interval_ba_feed' },
    });
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
    // Every timer faked, on the pinned clock: the polling tests below read
    // "today", and a fake clock with no `now` starts at the real time.
    vi.useFakeTimers({ now: new Date(PINNED_NOW) });
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

  it('holds a change to the date and both times on one timer and sends one request', async () => {
    mockFetchJson(emptyPayload);
    const { rerender } = renderFeed(baseParams);
    // Drain the timer the mount itself starts, so the count below is only
    // the timers the change adds.
    await advance(SETTLE_MS);
    const base = vi.getTimerCount();

    rerender({
      ...baseParams,
      date: '2026-05-13',
      startTime: '09:00',
      endTime: '14:00',
    });
    // Separate timers per field would fire in separate callbacks, which a
    // browser need not batch into one render; one timer cannot split.
    expect(vi.getTimerCount() - base).toBe(1);
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
    renderFeed({ ...baseParams, date: TODAY_ET }, true);
    expect(fetchUrls()).toHaveLength(1);

    await advance(30);
    expect(fetchUrls()).toHaveLength(2);
    await advance(30);
    expect(fetchUrls()).toHaveLength(3);
  });

  it('polls with the last settled params, not a change still waiting', async () => {
    mockFetchJson(emptyPayload);
    const today = TODAY_ET;
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

  // `loading` is derived from keys: the params the held data was fetched for
  // against the params now asked for (the raw date and times, not the settled
  // ones). Rows are drawn from `alerts` and given the date asked for, so a row
  // must never render with a date other than the one its alerts were fetched
  // for, in the debounce window or while the new date's fetch is in flight.
  it('is loading while a changed date is held and until its response lands, keeping the old alerts meanwhile', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderFeed(baseParams);
    await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
    expect(result.current.loading).toBe(false);

    // The date changed and the hook has not settled it yet: the held alerts
    // belong to the old date, so the feed is loading.
    rerender({ ...baseParams, date: '2026-05-13' });
    expect(result.current.loading).toBe(true);
    expect(result.current.alerts).toEqual([baseAlert]);

    await advance(SETTLE_MS);
    expect(calls).toHaveLength(2);
    expect(result.current.loading).toBe(true);

    await respond(calls[1]!, { alerts: [], summary: baseSummary });
    expect(result.current.loading).toBe(false);
  });

  it('does not flip loading on a poll or a manual refresh', async () => {
    mockFetchJson(emptyPayload);
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const state = useIntervalBAFeed({ ...baseParams, date: TODAY_ET }, true);
      seen.push(state.loading);
      return state;
    });
    await advance(0);
    expect(result.current.loading).toBe(false);
    seen.length = 0;

    // A poll sets state at each step, so each step renders. Every render
    // between the polls and the refresh is already loaded: the rows stay
    // mounted instead of being replaced by "Loading" and remounted.
    for (let i = 0; i < 4; i += 1) await advance(30);
    act(() => result.current.refresh());
    await advance(30);

    expect(fetchUrls().length).toBeGreaterThan(4);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.every((loading) => !loading)).toBe(true);
  });

  // The hook never returns data for a key it does not answer. A fetch that
  // fails has answered its key with an error, so the older key's alerts and
  // summary go, and the error stays until a fetch for the key succeeds: a
  // retry (a refresh or a poll) is not a moment to show the old rows again.
  it('holds no alerts for a date whose fetch failed, and keeps the error through a retry', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderFeed(baseParams);
    await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
    expect(result.current.alerts).toEqual([baseAlert]);

    rerender({ ...baseParams, date: '2026-05-13' });
    await advance(SETTLE_MS);
    await act(async () => {
      calls[1]!.reject(new Error('upstream down'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.error).toBe('upstream down');
    expect(result.current.loading).toBe(false);
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();

    // The retry is in flight: still the error, still no rows of the old date.
    act(() => result.current.refresh());
    await advance(0);
    expect(calls).toHaveLength(3);
    expect(result.current.error).toBe('upstream down');
    expect(result.current.loading).toBe(false);
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();

    // Only an answer for the key clears the error.
    const newer = { ...baseAlert, id: 2 };
    await respond(calls[2]!, { alerts: [newer], summary: baseSummary });
    expect(result.current.error).toBeNull();
    expect(result.current.alerts).toEqual([newer]);
    expect(result.current.summary).toEqual(baseSummary);
  });

  // Each poll aborts its predecessor, so a hung upstream never reaches the
  // 15 s timeout and raises no error: the last rows would sit there looking
  // fresh. `stale` surfaces it by count: more than three polls in a row went
  // unanswered. A count, not a time, so an idle gap (a closed market, a
  // throttled tab, a laptop asleep) or a step of the system clock cannot set
  // or hide it.
  describe('stale', () => {
    it('is set once no response has landed for three polls, and a fresh response clears it', async () => {
      const calls = stubPendingFetch(false);
      const { result } = renderFeed({ ...baseParams, date: TODAY_ET }, true);
      await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
      expect(result.current.stale).toBe(false);

      // Polls at 30 ms; each aborts the last and none is answered.
      for (let i = 0; i < 3; i += 1) {
        await advance(30);
        expect(result.current.stale).toBe(false);
      }
      await advance(30);
      expect(result.current.stale).toBe(true);
      expect(calls).toHaveLength(5);

      await respond(calls.at(-1)!, {
        alerts: [baseAlert],
        summary: baseSummary,
      });
      expect(result.current.stale).toBe(false);
    });

    it('is cleared when polling stops, and never set on a feed that does not poll', async () => {
      const calls = stubPendingFetch(false);
      const { result, rerender } = renderHook(
        ({ open }: { open: boolean }) =>
          useIntervalBAFeed({ ...baseParams, date: TODAY_ET }, open),
        { initialProps: { open: true } },
      );
      await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
      for (let i = 0; i < 4; i += 1) await advance(30);
      expect(result.current.stale).toBe(true);

      // The market closes: the feed no longer polls, so it is not stale.
      rerender({ open: false });
      expect(result.current.stale).toBe(false);
    });

    it.each([
      ['a past date with the market open', '2026-05-12', true],
      ['today with the market closed', TODAY_ET, false],
    ])('is never set on %s', async (_name, date, open) => {
      const calls = stubPendingFetch(false);
      const { result } = renderFeed({ ...baseParams, date }, open);
      await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });

      await advance(1_000);

      expect(calls).toHaveLength(1);
      expect(result.current.stale).toBe(false);
    });

    it('does not flash after an idle gap: the market opens five minutes after the last response', async () => {
      const calls = stubPendingFetch(false);
      const { result, rerender } = renderHook(
        ({ open }: { open: boolean }) =>
          useIntervalBAFeed({ ...baseParams, date: TODAY_ET }, open),
        { initialProps: { open: false } },
      );
      await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });
      await advance(300_000);
      expect(calls).toHaveLength(1);

      rerender({ open: true });
      expect(result.current.stale).toBe(false);

      // The first poll is out and unanswered: one poll, not over three. The
      // newest response is five minutes old, which says nothing here.
      await advance(30);
      expect(calls).toHaveLength(2);
      expect(result.current.stale).toBe(false);
    });

    it('is set by unanswered polls after the system clock steps back an hour', async () => {
      const calls = stubPendingFetch(false);
      const { result } = renderFeed({ ...baseParams, date: TODAY_ET }, true);
      await respond(calls[0]!, { alerts: [baseAlert], summary: baseSummary });

      vi.setSystemTime(new Date(Date.now() - 3_600_000));
      for (let i = 0; i < 3; i += 1) {
        await advance(30);
        expect(result.current.stale).toBe(false);
      }
      await advance(30);

      expect(calls).toHaveLength(5);
      expect(result.current.stale).toBe(true);
    });

    it('is never set while every poll is answered', async () => {
      mockFetchJson(emptyPayload);
      const seen: boolean[] = [];
      renderHook(() => {
        const state = useIntervalBAFeed(
          { ...baseParams, date: TODAY_ET },
          true,
        );
        seen.push(state.stale);
        return state;
      });
      await advance(0);

      for (let i = 0; i < 10; i += 1) await advance(30);

      expect(fetchUrls().length).toBeGreaterThan(10);
      expect(seen.length).toBeGreaterThan(10);
      expect(seen.every((stale) => !stale)).toBe(true);
    });

    it('counts a failed fetch as an answer: an outage shows its error, not the stale label', async () => {
      const okResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue(emptyPayload),
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(okResponse)
        .mockRejectedValue(
          new Error('upstream down'),
        ) as unknown as typeof fetch;
      const { result } = renderFeed({ ...baseParams, date: TODAY_ET }, true);
      await advance(0);
      expect(result.current.error).toBeNull();

      for (let i = 0; i < 6; i += 1) {
        await advance(30);
        expect(result.current.stale).toBe(false);
      }

      expect(result.current.error).toBe('upstream down');
    });
  });
});

// ============================================================
// Midnight rollover (docs/superpowers/specs/panel-date-rollover-2026-11-14.md,
// Phase 8, design item 3)
//
// The poll gate was `settled.date === todayCt()`, a CT date read from the wall
// clock on each render. It was wrong twice: from 23:00 to 24:00 CT, when ET is
// already on the new day, a feed on the new day was called historical and did
// not poll; and a per-render read does not flip at midnight without a render,
// so a feed left on the night kept polling it. The gate reads `today` from the
// shared ET clock (`useETToday`), which re-renders the hook at the roll, 1 s
// past ET midnight (23:00:01 CT the evening before). The auto-poll is 30 ms
// here (the mock above), so each case starts 500 ms before midnight: the roll
// is 1.5 s in. A poll's own result re-renders the hook, so the case that
// starts polling at the roll is the one that tells the shared clock from a
// wall-clock read: a historical feed has no polls to re-render it. The
// `date` is constant in these cases, so the settle delay does not move them;
// the roll of a date that follows today is on the feed component's tests.
// ============================================================

describe.each([
  {
    zone: 'EST (winter)',
    midnight: '2026-11-10T05:00:00Z',
    // 23:30 CT the evening before, ET already on the new day.
    window: '2026-11-10T05:30:00Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    midnight: '2026-07-15T04:00:00Z',
    window: '2026-07-15T04:30:00Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('useIntervalBAFeed: across the $zone midnight', (m) => {
  const POLL_MS = POLL_INTERVALS.ALERTS;
  /** Midnight is this far after the start; the roll is 1 s after midnight. */
  const LEAD_MS = 500;
  const ROLL_MS = LEAD_MS + 1_000;

  beforeEach(() => {
    vi.clearAllMocks();
    // Every timer is faked: the shared clock's roll and the hook's poll.
    vi.useFakeTimers();
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const startAt = (iso: string, leadMs = 0) =>
    vi.setSystemTime(new Date(Date.parse(iso) - leadMs));
  /**
   * Advance in one-poll steps, each in its own act(): a poll sets state, and
   * the refetch it triggers runs when React flushes that update. One act
   * around the whole advance would batch the polls into a single refetch.
   */
  const advance = async (ms: number) => {
    if (ms === 0) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      return;
    }
    for (let left = ms; left > 0; left -= POLL_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.min(POLL_MS, left));
      });
    }
  };
  const requests = () =>
    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  /** The `date` of every request so far, in order. */
  const datesRequested = () =>
    requests().map((c) =>
      new URL(c[0] as string, 'http://x').searchParams.get('date'),
    );

  it('stops polling a feed left on the night once the roll comes', async () => {
    startAt(m.midnight, LEAD_MS);
    renderHook(() => useIntervalBAFeed({ ...baseParams, date: m.night }, true));
    await advance(0);
    expect(requests()).toHaveLength(1);

    // Through midnight, before the roll at 1.5 s: still the night's day to the
    // shared clock, so it keeps polling.
    await advance(ROLL_MS - 100);
    const beforeRoll = requests().length;
    expect(beforeRoll).toBeGreaterThan(10);

    // Past the roll the night is yesterday: the poll stops.
    await advance(200);
    const afterRoll = requests().length;
    await advance(POLL_MS * 10);

    expect(requests()).toHaveLength(afterRoll);
    expect(new Set(datesRequested())).toEqual(new Set([m.night]));
  });

  it('starts polling a feed dated the new day at the roll, with no re-render but the roll', async () => {
    startAt(m.midnight, LEAD_MS);
    renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: m.morning }, true),
    );
    await advance(0);
    // Dated tomorrow while it is still the night: the mount fetch only, and
    // none even once the wall clock passes midnight, before the roll.
    await advance(ROLL_MS - 100);
    expect(requests()).toHaveLength(1);

    // 23:00:01 CT the evening before: ET is on the new day, CT is not.
    await advance(200);
    const afterRoll = requests().length;
    await advance(POLL_MS * 5);

    expect(requests().length).toBeGreaterThan(afterRoll);
    expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
  });

  it('polls a feed dated the new ET day at 23:30 CT, when CT is still on the night', async () => {
    startAt(m.window);
    renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: m.morning }, true),
    );
    await advance(0);
    expect(requests()).toHaveLength(1);

    await advance(POLL_MS * 5);

    // A CT comparator calls the new day historical here and never polls.
    expect(requests().length).toBeGreaterThan(1);
    expect(new Set(datesRequested())).toEqual(new Set([m.morning]));
  });

  it('does not poll a feed on the new day when the market is closed', async () => {
    startAt(m.window);
    renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: m.morning }, false),
    );
    await advance(0);
    await advance(POLL_MS * 5);

    expect(requests()).toHaveLength(1);
  });

  it('keeps a past-dated feed from polling across the roll', async () => {
    startAt(m.midnight, LEAD_MS);
    renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: '2026-04-20' }, true),
    );
    await advance(0);
    await advance(ROLL_MS + 500);

    expect(datesRequested()).toEqual(['2026-04-20']);
  });
});
