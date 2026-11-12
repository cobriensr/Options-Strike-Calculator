/**
 * useEventsForDate — the market events for the SELECTED date.
 *
 * App's forward list (useMarketData: today .. today + 30, ET) covers today and
 * the month ahead, and nothing before today. A past date, or one more than 30
 * days ahead, finds no events in it. This hook returns:
 *
 *   - the forward list itself (same reference, no request) when the date falls
 *     inside that window;
 *   - otherwise that date's own events, from `/api/events?from=<date>&days=1`,
 *     fetched once per date (`historical`: no polling; a past calendar does not
 *     change, and a far-ahead one is cached server-side).
 *
 * While the fetch is loading, if it fails, or if the body fails its schema, it
 * returns `undefined`: "no events known", what a past date had before this
 * hook. The fetch's response is keyed on the `startDate` the endpoint echoes,
 * so the events of a previous date are never returned under a new one.
 *
 * The list can hold more than the date's own events (days=1 reaches the next
 * day too, and the forward list holds a month); callers filter by date.
 */

import { z } from 'zod';

import {
  INVALID_SHAPE_ERROR,
  summarizeZodIssues,
} from '../lib/response-guard.js';
import { captureUnlessAuth } from '../lib/sentry-helpers.js';
import type { EventItem } from '../types/api.js';
import { useETToday } from './useETToday.js';
import { useFetchedData } from './useFetchedData.js';
import { FORWARD_EVENT_DAYS } from './useMarketData.fetchers.js';

// ── Response schema ──────────────────────────────────────────────────────
// Every field of an event is read (the banner prints description and time,
// both consumers filter on date and event, and severity picks the colour), so
// an event is checked whole. `satisfies` ties the schema to EventItem: a field
// added to the type without one here fails the type-check. Of the envelope only
// `events` and `startDate` are read. `startDate` is required, not optional: it
// is the staleness key, and the gate passes data through when the key is absent.

const eventItemSchema = z.object({
  date: z.string(),
  event: z.string(),
  description: z.string(),
  time: z.string(),
  severity: z.enum(['high', 'medium']),
  source: z.enum(['fred', 'static', 'finnhub']),
}) satisfies z.ZodType<EventItem>;

const eventsForDateSchema = z.object({
  events: z.array(eventItemSchema),
  startDate: z.string(),
});

type EventsForDateResponse = z.infer<typeof eventsForDateSchema>;

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

export function useEventsForDate(
  selectedDate: string,
  forwardEvents: readonly EventItem[] | undefined,
): readonly EventItem[] | undefined {
  // The ET date, re-read at ET midnight, so a tab left open moves the window.
  const etToday = useETToday();
  const inForwardWindow =
    selectedDate >= etToday &&
    selectedDate <= addDays(etToday, FORWARD_EVENT_DAYS);
  // An empty or malformed date (the field is being edited) is not worth a
  // request the endpoint would answer with a 400.
  const fetchOwnDate = ISO_DATE.test(selectedDate) && !inForwardWindow;

  const parse = (raw: unknown): EventsForDateResponse => {
    const parsed = eventsForDateSchema.safeParse(raw);
    if (!parsed.success) {
      captureUnlessAuth(new Error('events response failed schema validation'), {
        contexts: {
          eventsForDate: {
            date: selectedDate,
            ...summarizeZodIssues(parsed.error.issues),
          },
        },
      });
      // Handled like a failed fetch: useFetchedData sets `error`, no data.
      throw new Error(INVALID_SHAPE_ERROR);
    }
    return parsed.data;
  };

  const { data } = useFetchedData<EventsForDateResponse>({
    url: fetchOwnDate ? `/api/events?from=${selectedDate}&days=1` : null,
    // Only gates the recurring poll, which `historical` switches off.
    marketOpen: false,
    historical: true,
    parse,
    requestKey: selectedDate,
    responseKey: (d) => d.startDate,
  });

  return fetchOwnDate ? data?.events : forwardEvents;
}
