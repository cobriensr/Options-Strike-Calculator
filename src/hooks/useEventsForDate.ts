/**
 * useEventsForDate — the market events for the SELECTED date.
 *
 * App's forward list (useMarketData: `/api/events?days=30`) is fetched once and
 * answers with the range it covers, `startDate .. endDate`: today and the month
 * ahead as of when it was fetched, and nothing before. A date outside that
 * range (a past date, or one beyond the list's end) finds no events in it. A
 * list that never arrived (its request failed) covers nothing. This hook
 * returns:
 *
 *   - the forward list's own events (same reference, no request, no wait) when
 *     the date falls inside the range the response reports. The range comes
 *     from the response, not from the clock: after ET midnight the list does
 *     not move, so a clock-built window would drift away from what it holds.
 *     Two cases have no reported range and count as today .. today + 30, ET: a
 *     response without a usable one (a fixture's ''), and no response yet while
 *     the list's first load is still running (`forwardLoaded` is false), so a
 *     list that is merely slow does not make a request for today. Once the
 *     first load has finished with no list (`forwardLoaded` true, `forward`
 *     null), no date is covered: today and every forward date take the
 *     own-date path below, so a failed list does not read as a quiet day. If a
 *     list arrives later, coverage applies again from that render: the date's
 *     own request is dropped and its events come from the list;
 *   - otherwise that date's own events, from `/api/events?from=<date>&days=1`,
 *     fetched once per date (`historical`: no polling; a past calendar does not
 *     change, and a far-ahead one is cached server-side), and only after the
 *     picked date has stopped changing for 350 ms. The date input fires on every
 *     valid intermediate value (keyboard entry, a held arrow key, Chrome's year
 *     0002/0020/0202), and the server rate-limits `from` lookups that miss its
 *     cache, so a request per keystroke could leave the date the user stops on
 *     with a 429 and no events. A date already present at mount is fetched at
 *     once.
 *
 * While the fetch is waiting, loading, if it fails, or if the body fails its
 * schema, `events` is `undefined`: "no events known", what a past date had before
 * this hook. The fetch's response is keyed on the `startDate` the endpoint
 * echoes, so the events of a previous date are never returned under a new one.
 *
 * `failed` says the fetch was tried and did not work (as against "still
 * waiting"), so the banner can say so and App can tell the analysis the events
 * are unknown, not none. `retry` repeats the fetch. There is no automatic retry:
 * useFetchedData reports a 429 only as "HTTP 429" and drops Retry-After, so the
 * wait is unknown; the Retry button leaves the timing to the user.
 *
 * The list can hold more than the date's own events (days=1 reaches the next
 * day too, and the forward list holds a month); callers filter by date.
 */

import { useEffect, useRef } from 'react';

import {
  parseEventsResponse,
  type EventsResponseBody,
} from '../lib/events-schema.js';
import type { EventItem, EventsResponse } from '../types/api.js';
import { useDebounced } from './useDebounced.js';
import { useETToday } from './useETToday.js';
import { useFetchedData } from './useFetchedData.js';
import { FORWARD_EVENT_DAYS } from './useMarketData.fetchers.js';

/** What the hook reads of the forward list: its events and the range it covers. */
type ForwardEvents = Pick<EventsResponse, 'events' | 'startDate' | 'endDate'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `isoDate` plus `days` calendar days. Arithmetic on 12:00 UTC, so a DST
 * change in between cannot move the result (the endpoint counts the same way).
 */
function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The dates the forward list answers for: the range its response reports, or
 * today .. today + FORWARD_EVENT_DAYS (ET) when a list is present with none to
 * report, or none has arrived yet and its first load is still running. `null`
 * when no list arrived and its load has finished: nothing is covered.
 */
function coveredRange(
  forward: ForwardEvents | null | undefined,
  forwardLoaded: boolean,
  etToday: string,
): { from: string; to: string } | null {
  if (
    forward != null &&
    ISO_DATE.test(forward.startDate) &&
    ISO_DATE.test(forward.endDate)
  ) {
    return { from: forward.startDate, to: forward.endDate };
  }
  if (forward == null && forwardLoaded) return null;
  return { from: etToday, to: addDays(etToday, FORWARD_EVENT_DAYS) };
}

interface EventsForDate {
  /**
   * The selected date's events. `undefined` when none are known: the date's own
   * fetch is waiting, loading or failed, or the forward list is still loading.
   */
  readonly events: readonly EventItem[] | undefined;
  /**
   * True only when this date's own fetch has failed for the current request
   * (HTTP error, network error, a body that is not JSON or fails the schema).
   * False while it loads or waits, and for a date the forward list covers.
   */
  readonly failed: boolean;
  /** Fetch this date again. Does nothing for a date the forward list covers. */
  readonly retry: () => void;
}

/**
 * `forward` is the forward list (null or undefined until one arrives).
 * `forwardLoaded` says its first load has finished, whether or not it brought a
 * list: it is how "still loading" is told from "failed", which both leave
 * `forward` empty.
 */
export function useEventsForDate(
  selectedDate: string,
  forward: ForwardEvents | null | undefined,
  forwardLoaded: boolean,
): EventsForDate {
  // The ET date, re-read at ET midnight, so a tab left open moves the fallback.
  const etToday = useETToday();
  // Lags `selectedDate` by 350 ms; equal to it once the date has stopped moving.
  const settled = useDebounced(selectedDate, 350);

  const covered = coveredRange(forward, forwardLoaded, etToday);
  const inForwardList =
    covered != null &&
    selectedDate >= covered.from &&
    selectedDate <= covered.to;
  // An empty or malformed date (the field is being edited) is not worth a
  // request the endpoint would answer with a 400.
  const fetchOwnDate = ISO_DATE.test(selectedDate) && !inForwardList;
  const requestDate =
    fetchOwnDate && settled === selectedDate ? selectedDate : null;

  // The date of the latest request made. `parse` runs when a response lands,
  // and by then `selectedDate` may have moved on (the primitive does not abort
  // a request when the url goes null), so it reports this, not the render's
  // `selectedDate`. A newer request aborts the older one, so the latest date is
  // the only in-flight request's.
  const requestedDateRef = useRef('');
  useEffect(() => {
    if (requestDate != null) requestedDateRef.current = requestDate;
  }, [requestDate]);

  // The request date of the last COMMITTED render, null when it had none. The
  // fetch effect of a request date has run, and reset the error, by the render
  // after the one that first carries it, so this is how `failed` tells a fetch's
  // own error from one left over (below).
  const committedDateRef = useRef<string | null>(null);
  useEffect(() => {
    committedDateRef.current = requestDate;
  }, [requestDate]);

  const { data, error, refresh } = useFetchedData<EventsResponseBody>({
    url: requestDate == null ? null : `/api/events?from=${requestDate}&days=1`,
    // Only gates the recurring poll, which `historical` switches off.
    marketOpen: false,
    historical: true,
    // A body that fails the schema is reported, then thrown as a failed fetch:
    // useFetchedData sets `error` and stores no data.
    parse: (raw) =>
      parseEventsResponse(raw, { request: requestedDateRef.current }),
    requestKey: selectedDate,
    responseKey: (d) => d.startDate,
  });

  // useFetchedData clears `error` only when a fetch starts. A url change does
  // not clear it, and neither does the url going null while a date settles, so
  // the error of the date the user left is still held in the render that first
  // carries the new request date. It is this date's only once a render with this
  // request date has already committed. A date left and returned to is the same
  // case: the url went null in between.
  const failed =
    requestDate != null &&
    error != null &&
    committedDateRef.current === requestDate;

  return {
    events: fetchOwnDate ? data?.events : forward?.events,
    failed,
    retry: refresh,
  };
}
