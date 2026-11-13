/**
 * useEventsForDate — the events App passes to the snapshot save, the analyze
 * context and the event-day banner for the SELECTED date.
 *
 * A date inside the range the forward list itself reports (its startDate ..
 * endDate) gets that list back untouched, at once, with no request. Any other
 * date (a past one, or one beyond the list) is fetched from
 * /api/events?from=<date>&days=1 once the picked date has settled for 350 ms,
 * and reads undefined ("no events known") while that is loading or if it fails.
 *
 * The clock is pinned to 12:00 ET on 2026-11-12 and every timer is fake: the
 * settle wait and the ET-midnight timer are driven by `advance`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEventsForDate } from '../../hooks/useEventsForDate';
import { FORWARD_EVENT_DAYS } from '../../hooks/useMarketData.fetchers';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import type { EventItem } from '../../types/api';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const fetchMock = vi.fn();

type Forward = NonNullable<Parameters<typeof useEventsForDate>[1]>;

/** The hook's settle wait. The "rapid changes" test pins the exact value. */
const SETTLE_MS = 350;

const TODAY = '2026-11-12';
const YESTERDAY = '2026-11-11';
const PAST = '2026-11-10';
const OTHER_PAST = '2026-11-09';
const WINDOW_END = '2026-12-12'; // today + 30
const JUST_PAST_WINDOW = '2026-12-13'; // today + 31
const FAR_AHEAD = '2026-12-27'; // today + 45

function ev(date: string, event = 'CPI'): EventItem {
  return {
    date,
    event,
    description: `${event} release`,
    time: '8:30',
    severity: 'high',
    source: 'fred',
  };
}

const FORWARD_EVENTS: readonly EventItem[] = [
  ev(TODAY, 'FOMC'),
  ev(WINDOW_END, 'NFP'),
];

/** A forward list as the endpoint reports it: its events and the range. */
function forwardList(
  startDate: string,
  endDate: string,
  events: readonly EventItem[] = FORWARD_EVENTS,
): Forward {
  return { events, startDate, endDate };
}

const FORWARD = forwardList(TODAY, WINDOW_END);

function eventsBody(startDate: string, events: readonly EventItem[]) {
  return {
    events,
    startDate,
    endDate: startDate,
    cached: false,
    asOf: '2026-11-12T17:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Run the fake timers for `ms`, then let the promises they released settle (a
 * fetch the advance started lands in the second turn).
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function render(date: string, forward: Forward | null | undefined) {
  return renderHook(
    (props: { date: string; forward: Forward | null | undefined }) =>
      useEventsForDate(props.date, props.forward),
    { initialProps: { date, forward } },
  );
}

/** The abort signal the nth fetch was given. */
function signalOf(callIndex: number): AbortSignal {
  return (fetchMock.mock.calls[callIndex]![1] as RequestInit).signal!;
}

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.useFakeTimers({ now: new Date('2026-11-12T17:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEventsForDate: inside the forward list's range", () => {
  it('returns the forward events themselves for today, with no request', async () => {
    const { result } = render(TODAY, FORWARD);
    await advance(SETTLE_MS);
    expect(result.current).toBe(FORWARD.events);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    'returns undefined for today while the forward list is %s, with no request',
    async (notLoaded) => {
      const { result } = render(TODAY, notLoaded);
      await advance(SETTLE_MS);
      expect(result.current).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps the forward events for the last day the list covers', async () => {
    const { result } = render(WINDOW_END, FORWARD);
    await advance(SETTLE_MS);
    expect(result.current).toBe(FORWARD.events);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the forward events and makes no request for an empty date', async () => {
    const { result } = render('', FORWARD);
    await advance(SETTLE_MS);
    expect(result.current).toBe(FORWARD.events);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a covered date at once, without waiting for the date to settle', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST)])));
    const { result, rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(result.current).toEqual([ev(PAST)]);

    rerender({ date: TODAY, forward: FORWARD });

    // No timer has run since the rerender.
    expect(result.current).toBe(FORWARD.events);
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useEventsForDate: a list that carries no usable range', () => {
  // Fixtures and e2e stubs report '' for the range; a malformed one is the
  // same case. The covered range is then today .. today + 30, ET.
  const NO_RANGE: ReadonlyArray<readonly [string, Forward]> = [
    ['empty dates', forwardList('', '')],
    ['an empty end', forwardList(TODAY, '')],
    ['a malformed start', forwardList('soon', WINDOW_END)],
  ];

  it.each(NO_RANGE)(
    'covers today and today + 30 with %s',
    async (_name, forward) => {
      // The window below is built from 30 days.
      expect(FORWARD_EVENT_DAYS).toBe(30);
      const { result, rerender } = render(TODAY, forward);
      await advance(SETTLE_MS);
      expect(result.current).toBe(forward.events);

      rerender({ date: WINDOW_END, forward });
      await advance(SETTLE_MS);

      expect(result.current).toBe(forward.events);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(NO_RANGE)(
    'fetches yesterday and today + 31 with %s',
    async (_name, forward) => {
      fetchMock.mockResolvedValue(jsonResponse(eventsBody(YESTERDAY, [])));
      const { rerender } = render(YESTERDAY, forward);
      await advance(0);
      rerender({ date: JUST_PAST_WINDOW, forward });
      await advance(SETTLE_MS);

      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        `/api/events?from=${YESTERDAY}&days=1`,
        `/api/events?from=${JUST_PAST_WINDOW}&days=1`,
      ]);
    },
  );
});

describe("useEventsForDate: the forward list's own range, not the clock", () => {
  it('fetches today + 30 when the list ends earlier than that', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(WINDOW_END, [ev(WINDOW_END, 'PCE')])),
    );
    const stale = forwardList(TODAY, '2026-12-10');
    const { result } = render(WINDOW_END, stale);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${WINDOW_END}&days=1`,
    );
    expect(result.current).toEqual([ev(WINDOW_END, 'PCE')]);
  });

  it('answers a day before today from the list when the list starts then', async () => {
    const early = forwardList(YESTERDAY, WINDOW_END);
    const { result } = render(YESTERDAY, early);
    await advance(SETTLE_MS);

    expect(result.current).toBe(early.events);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps serving the days the list covers after ET midnight', async () => {
    // 23:59 ET on 2026-11-12 (EST, UTC-5). The list was fetched that day.
    vi.setSystemTime(new Date('2026-11-13T04:59:00Z'));
    const { result, rerender } = render(TODAY, FORWARD);
    expect(result.current).toBe(FORWARD.events);

    // useETToday re-reads at midnight: etToday is now 2026-11-13.
    await advance(2 * 60 * 1000);
    expect(result.current).toBe(FORWARD.events);
    expect(fetchMock).not.toHaveBeenCalled();

    // The new today + 30 is past the list's end, so it is fetched.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(JUST_PAST_WINDOW, [])),
    );
    rerender({ date: JUST_PAST_WINDOW, forward: FORWARD });
    await advance(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${JUST_PAST_WINDOW}&days=1`,
    );
  });
});

describe('useEventsForDate: a date the forward list does not cover', () => {
  it('fetches a past date once, returns undefined while loading, then its events', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { result } = render(PAST, FORWARD);

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/events?from=${PAST}&days=1`);
    expect(result.current).toBeUndefined();

    await act(async () => {
      pending.resolve(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])));
      await pending.promise;
    });
    await advance(0);
    expect(result.current).toEqual([ev(PAST, 'CPI')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches a date 45 days ahead, which is past the forward list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(FAR_AHEAD, [ev(FAR_AHEAD, 'PCE')])),
    );
    const { result } = render(FAR_AHEAD, FORWARD);
    await advance(0);

    expect(result.current).toEqual([ev(FAR_AHEAD, 'PCE')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${FAR_AHEAD}&days=1`,
    );
  });

  it('fetches the first date past the list (today + 31)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(JUST_PAST_WINDOW, [])),
    );
    render(JUST_PAST_WINDOW, FORWARD);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${JUST_PAST_WINDOW}&days=1`,
    );
  });

  it('fetches yesterday, which a list starting today does not hold', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(YESTERDAY, [ev(YESTERDAY, 'PPI')])),
    );
    const { result } = render(YESTERDAY, FORWARD);
    await advance(0);

    expect(result.current).toEqual([ev(YESTERDAY, 'PPI')]);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${YESTERDAY}&days=1`,
    );
  });

  it('does not refetch when only the forward list changes on a past date', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST)])));
    const { result, rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(result.current).toEqual([ev(PAST)]);

    rerender({
      date: PAST,
      forward: forwardList(TODAY, WINDOW_END, [ev(TODAY, 'GDP')]),
    });
    await advance(SETTLE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([ev(PAST)]);
  });
});

describe('useEventsForDate: settling the picked date', () => {
  it('makes one request, for the last date, when the date changes three times in a row', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST)])));
    const { result, rerender } = render(TODAY, FORWARD);

    // Keyboard entry or a held arrow key: each step is a valid ISO date.
    rerender({ date: '2026-11-08', forward: FORWARD });
    await advance(100);
    rerender({ date: OTHER_PAST, forward: FORWARD });
    await advance(100);
    rerender({ date: PAST, forward: FORWARD });

    // One millisecond short of the wait: still nothing sent.
    await advance(SETTLE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/events?from=${PAST}&days=1`);
    expect(result.current).toEqual([ev(PAST)]);
  });

  it('sends nothing for a date the user passed through on the way to a covered one', async () => {
    const { result, rerender } = render(TODAY, FORWARD);
    rerender({ date: PAST, forward: FORWARD });
    await advance(100);
    rerender({ date: WINDOW_END, forward: FORWARD });
    await advance(SETTLE_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBe(FORWARD.events);
  });
});

describe('useEventsForDate: switching dates', () => {
  it("never shows the previous date's events while the new date loads", async () => {
    const second = deferred();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])))
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(result.current).toEqual([ev(PAST, 'CPI')]);

    rerender({ date: OTHER_PAST, forward: FORWARD });
    // The first date's response is still the one the fetch hook holds; it
    // must not be handed out under the new date.
    expect(result.current).toBeUndefined();
    await advance(SETTLE_MS);
    expect(result.current).toBeUndefined();

    await act(async () => {
      second.resolve(
        jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
      );
      await second.promise;
    });
    await advance(0);
    expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]);
  });

  it('keeps only the latest date when an earlier date answers late', async () => {
    const first = deferred();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
      );
    const { result, rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstSignal = signalOf(0);
    expect(firstSignal.aborted).toBe(false);

    rerender({ date: OTHER_PAST, forward: FORWARD });
    await advance(SETTLE_MS);
    expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]);
    // Superseded, so cancelled, not merely ignored when it lands.
    expect(firstSignal.aborted).toBe(true);

    // The first date's answer arrives after the second's.
    await act(async () => {
      first.resolve(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])));
      await first.promise;
    });
    await advance(0);

    expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]);
  });

  it('drops a response whose echoed startDate is not the requested date', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
    );
    const { result } = render(PAST, FORWARD);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
  });
});

describe('useEventsForDate: failures read as "no events known"', () => {
  it('returns undefined when the request rejects', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = render(PAST, FORWARD);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
  });

  it('returns undefined on a 400 (a date outside the endpoint bounds)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'from must be 2025-01-01 or later' }, 400),
    );
    const { result } = render('2024-06-03', FORWARD);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
  });

  it('returns undefined on a 429 without reporting it, and does not retry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Too many requests' }, 429),
    );
    const { result } = render(PAST, FORWARD);
    await advance(0);
    await advance(SETTLE_MS);

    expect(result.current).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('returns undefined on a 500', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Internal server error' }, 500),
    );
    const { result } = render(PAST, FORWARD);
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
  });

  it('does not show the previous date as the new date failed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result, rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(result.current).toEqual([ev(PAST, 'CPI')]);

    rerender({ date: OTHER_PAST, forward: FORWARD });
    await advance(SETTLE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBeUndefined();
  });

  // Each body is whole but for the one thing named, so a case cannot pass on
  // some other missing field.
  it.each([
    [
      'events is not an array',
      { events: 'nope', startDate: PAST, endDate: PAST },
    ],
    [
      'an event has no severity',
      {
        events: [{ date: PAST, event: 'CPI', description: 'd', time: '8:30' }],
        startDate: PAST,
        endDate: PAST,
      },
    ],
    [
      'an event has an unknown severity',
      {
        events: [{ ...ev(PAST), severity: 'extreme' }],
        startDate: PAST,
        endDate: PAST,
      },
    ],
    ['startDate is missing', { events: [ev(PAST)], endDate: PAST }],
    ['endDate is missing', { events: [ev(PAST)], startDate: PAST }],
    ['the body is not an object', ['CPI']],
  ])(
    'returns undefined and reports to Sentry when %s',
    async (_name, malformed) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(malformed));
      const { result } = render(PAST, FORWARD);
      await advance(0);

      expect(result.current).toBeUndefined();
      expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
      const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
      expect((error as Error).message).toBe(
        'events response failed schema validation',
      );
      expect(options).toMatchObject({
        contexts: {
          events: { request: PAST, issueCount: expect.any(Number) },
        },
      });
    },
  );

  it('reports the date the request was made for, not the one on screen when it lands', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { rerender } = render(PAST, FORWARD);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The user keeps typing: the request is still in flight, and the settle
    // wait has not elapsed, so no new request has replaced it.
    rerender({ date: OTHER_PAST, forward: FORWARD });
    await act(async () => {
      pending.resolve(jsonResponse({ events: 'nope', startDate: PAST }));
      await pending.promise;
    });
    await advance(0);

    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
    expect(mockCaptureUnlessAuth.mock.calls[0]![1]).toMatchObject({
      contexts: { events: { request: PAST } },
    });
  });

  it('does not report a well-formed response to Sentry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [])));
    const { result } = render(PAST, FORWARD);
    await advance(0);

    expect(result.current).toEqual([]);
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });
});
