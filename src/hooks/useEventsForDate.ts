/**
 * useEventsForDate — the market events for the SELECTED date.
 *
 * App's forward list (useMarketData: `/api/events?days=30`) is fetched once and
 * answers with the range it covers, `startDate .. endDate`: today and the month
 * ahead as of when it was fetched, and nothing before. A date outside that
 * range (a past date, or one beyond the list's end) finds no events in it. This
 * hook returns:
 *
 *   - the forward list's own events (same reference, no request, no wait) when
 *     the date falls inside the range the response reports. The range comes
 *     from the response, not from the clock: after ET midnight the list does
 *     not move, so a clock-built window would drift away from what it holds.
 *     A response without a usable range (a fixture's '', or one not loaded yet)
 *     counts as today .. today + 30, ET, which also keeps a still-loading list
 *     from making a request for today;
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
 * schema, it returns `undefined`: "no events known", what a past date had before
 * this hook. The fetch's response is keyed on the `startDate` the endpoint
 * echoes, so the events of a previous date are never returned under a new one.
 *
 * The list can hold more than the date's own events (days=1 reaches the next
 * day too, and the forward list holds a month); callers filter by date.
 */

import { useEffect, useRef } from 'react';

import {
  parseEventsResponse,
  type EventsResponseBody,
} from '../lib/events-schema.js';
import type { EventItem } from '../types/api.js';
import { useDebounced } from './useDebounced.js';
import { useETToday } from './useETToday.js';
import { useFetchedData } from './useFetchedData.js';
import { FORWARD_EVENT_DAYS } from './useMarketData.fetchers.js';

/** What the hook reads of the forward list: its events and the range it covers. */
interface ForwardEvents {
  readonly events: readonly EventItem[];
  readonly startDate: string;
  readonly endDate: string;
}

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
 * today .. today + FORWARD_EVENT_DAYS (ET) when it has none to report.
 */
function coveredRange(
  forward: ForwardEvents | null | undefined,
  etToday: string,
): { from: string; to: string } {
  if (
    forward != null &&
    ISO_DATE.test(forward.startDate) &&
    ISO_DATE.test(forward.endDate)
  ) {
    return { from: forward.startDate, to: forward.endDate };
  }
  return { from: etToday, to: addDays(etToday, FORWARD_EVENT_DAYS) };
}

export function useEventsForDate(
  selectedDate: string,
  forward: ForwardEvents | null | undefined,
): readonly EventItem[] | undefined {
  // The ET date, re-read at ET midnight, so a tab left open moves the fallback.
  const etToday = useETToday();
  // Lags `selectedDate` by 350 ms; equal to it once the date has stopped moving.
  const settled = useDebounced(selectedDate, 350);

  const covered = coveredRange(forward, etToday);
  const inForwardList =
    selectedDate >= covered.from && selectedDate <= covered.to;
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

  const { data } = useFetchedData<EventsResponseBody>({
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

  return fetchOwnDate ? data?.events : forward?.events;
}
