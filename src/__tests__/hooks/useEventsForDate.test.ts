/**
 * useEventsForDate — the events App passes to the snapshot save, the analyze
 * context and the event-day banner for the SELECTED date.
 *
 * Inside the forward list's window (today .. today + 30, ET) it hands back the
 * forward list untouched and makes no request. Outside it (a past date, or one
 * more than 30 days ahead) it fetches /api/events?from=<date>&days=1 once, and
 * returns undefined ("no events known") while that is loading or if it fails.
 *
 * The clock is pinned to 12:00 ET on 2026-11-12 (Date only, so the real timers
 * the fetch settling relies on keep running).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEventsForDate } from '../../hooks/useEventsForDate';
import { FORWARD_EVENT_DAYS } from '../../hooks/useMarketData.fetchers';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import type { EventItem } from '../../types/api';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const fetchMock = vi.fn();

const TODAY = '2026-11-12';
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

const FORWARD: readonly EventItem[] = [
  ev(TODAY, 'FOMC'),
  ev(WINDOW_END, 'NFP'),
];

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

/** Let an already-settled fetch (resolved or rejected) land in the hook. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function render(date: string, forward: readonly EventItem[] | undefined) {
  return renderHook(
    (props: { date: string; forward: readonly EventItem[] | undefined }) =>
      useEventsForDate(props.date, props.forward),
    { initialProps: { date, forward } },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T17:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEventsForDate: inside the forward window', () => {
  it('returns the forward list itself for today, with no request', async () => {
    const { result } = render(TODAY, FORWARD);
    await settle();
    expect(result.current).toBe(FORWARD);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined for today while the forward list is not loaded, with no request', async () => {
    const { result } = render(TODAY, undefined);
    await settle();
    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the forward list for the last day it covers (today + 30)', async () => {
    // WINDOW_END and JUST_PAST_WINDOW assume the 30-day forward request;
    // change that length and this fails before the dates above mislead.
    expect(FORWARD_EVENT_DAYS).toBe(30);
    const { result } = render(WINDOW_END, FORWARD);
    await settle();
    expect(result.current).toBe(FORWARD);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the forward list and makes no request for an empty date', async () => {
    const { result } = render('', FORWARD);
    await settle();
    expect(result.current).toBe(FORWARD);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useEventsForDate: a date the forward list does not cover', () => {
  it('fetches a past date once, returns undefined while loading, then its events', async () => {
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { result } = render(PAST, FORWARD);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/events?from=${PAST}&days=1`);
    expect(result.current).toBeUndefined();

    await act(async () => {
      pending.resolve(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])));
      await pending.promise;
    });
    await waitFor(() => expect(result.current).toEqual([ev(PAST, 'CPI')]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches a date 45 days ahead, which is past the forward window', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(FAR_AHEAD, [ev(FAR_AHEAD, 'PCE')])),
    );
    const { result } = render(FAR_AHEAD, FORWARD);

    await waitFor(() => expect(result.current).toEqual([ev(FAR_AHEAD, 'PCE')]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${FAR_AHEAD}&days=1`,
    );
  });

  it('fetches the first date past the window (today + 31)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(JUST_PAST_WINDOW, [])),
    );
    render(JUST_PAST_WINDOW, FORWARD);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/events?from=${JUST_PAST_WINDOW}&days=1`,
    );
  });

  it('fetches yesterday, which the forward list (from today) does not hold', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody('2026-11-11', [ev('2026-11-11', 'PPI')])),
    );
    const { result } = render('2026-11-11', FORWARD);

    await waitFor(() =>
      expect(result.current).toEqual([ev('2026-11-11', 'PPI')]),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/events?from=2026-11-11&days=1',
    );
  });

  it('does not refetch when only the forward list changes on a past date', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST)])));
    const { result, rerender } = render(PAST, FORWARD);
    await waitFor(() => expect(result.current).toEqual([ev(PAST)]));

    rerender({ date: PAST, forward: [ev(TODAY, 'GDP')] });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([ev(PAST)]);
  });

  it('returns the forward list again, with no new request, when the date comes back to today', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST)])));
    const { result, rerender } = render(PAST, FORWARD);
    await waitFor(() => expect(result.current).toEqual([ev(PAST)]));

    rerender({ date: TODAY, forward: FORWARD });
    await settle();

    expect(result.current).toBe(FORWARD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useEventsForDate: switching dates', () => {
  it("never shows the previous date's events while the new date loads", async () => {
    const second = deferred();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])))
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = render(PAST, FORWARD);
    await waitFor(() => expect(result.current).toEqual([ev(PAST, 'CPI')]));

    rerender({ date: OTHER_PAST, forward: FORWARD });
    // The first date's response is still the one the fetch hook holds; it
    // must not be handed out under the new date.
    expect(result.current).toBeUndefined();

    await act(async () => {
      second.resolve(
        jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
      );
      await second.promise;
    });
    await waitFor(() =>
      expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]),
    );
  });

  it('keeps only the latest date when an earlier date answers late', async () => {
    const first = deferred();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
      );
    const { result, rerender } = render(PAST, FORWARD);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ date: OTHER_PAST, forward: FORWARD });
    await waitFor(() =>
      expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]),
    );

    // The first date's answer arrives after the second's.
    await act(async () => {
      first.resolve(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])));
      await first.promise;
    });
    await settle();

    expect(result.current).toEqual([ev(OTHER_PAST, 'NFP')]);
  });

  it('drops a response whose echoed startDate is not the requested date', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(eventsBody(OTHER_PAST, [ev(OTHER_PAST, 'NFP')])),
    );
    const { result } = render(PAST, FORWARD);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(result.current).toBeUndefined();
  });
});

describe('useEventsForDate: failures read as "no events known"', () => {
  it('returns undefined when the request rejects', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = render(PAST, FORWARD);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(result.current).toBeUndefined();
  });

  it('returns undefined on a 400 (a date outside the endpoint bounds)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'from must be 2025-01-01 or later' }, 400),
    );
    const { result } = render('2024-06-03', FORWARD);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(result.current).toBeUndefined();
  });

  it('returns undefined on a 500', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Internal server error' }, 500),
    );
    const { result } = render(PAST, FORWARD);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(result.current).toBeUndefined();
  });

  it('does not show the previous date as the new date failed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [ev(PAST, 'CPI')])))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result, rerender } = render(PAST, FORWARD);
    await waitFor(() => expect(result.current).toEqual([ev(PAST, 'CPI')]));

    rerender({ date: OTHER_PAST, forward: FORWARD });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settle();

    expect(result.current).toBeUndefined();
  });

  it.each([
    ['events is not an array', { events: 'nope', startDate: PAST }],
    [
      'an event has no severity',
      {
        events: [{ date: PAST, event: 'CPI', description: 'd', time: '8:30' }],
        startDate: PAST,
      },
    ],
    [
      'an event has an unknown severity',
      { events: [{ ...ev(PAST), severity: 'extreme' }], startDate: PAST },
    ],
    ['startDate is missing', { events: [ev(PAST)] }],
    ['the body is not an object', ['CPI']],
  ])(
    'returns undefined and reports to Sentry when %s',
    async (_name, malformed) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(malformed));
      const { result } = render(PAST, FORWARD);
      await waitFor(() => expect(mockCaptureUnlessAuth).toHaveBeenCalled());
      await settle();

      expect(result.current).toBeUndefined();
      expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
      const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
      expect((error as Error).message).toBe(
        'events response failed schema validation',
      );
      expect(options).toMatchObject({
        contexts: {
          eventsForDate: { date: PAST, issueCount: expect.any(Number) },
        },
      });
    },
  );

  it('does not report a well-formed response to Sentry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(eventsBody(PAST, [])));
    const { result } = render(PAST, FORWARD);
    await waitFor(() => expect(result.current).toEqual([]));

    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });
});
