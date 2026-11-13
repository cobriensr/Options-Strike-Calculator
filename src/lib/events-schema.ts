/**
 * The /api/events response schema, shared by both readers of the endpoint: the
 * forward list (useMarketData.fetchers) and one date's own events
 * (useEventsForDate). A body that fails it is handled like a failed fetch and
 * reported to Sentry (src/lib/response-guard.ts has the shared pieces).
 *
 * Every field of an event is read (the banner prints description and time, the
 * consumers filter on date and event, and severity picks the colour), so an
 * event is checked whole. `satisfies` ties the schema to EventItem: a field
 * added to the type without one here fails the type-check. Of the envelope,
 * `events` and the range are read. `startDate` is required, not optional: it is
 * the staleness key of the per-date fetch (the gate passes data through when the
 * key is absent), and `startDate .. endDate` is the range the forward list
 * covers. `cached` and `asOf` are left out: nothing reads them, and a field
 * left out cannot break a panel by changing. The schema strips them from what
 * it returns, so a caller that stores the response whole stores the original,
 * not the parse.
 */

import { z } from 'zod';

import type { EventItem } from '../types/api.js';
import { INVALID_SHAPE_ERROR, summarizeZodIssues } from './response-guard.js';
import { captureUnlessAuth } from './sentry-helpers.js';

const eventItemSchema = z.object({
  date: z.string(),
  event: z.string(),
  description: z.string(),
  time: z.string(),
  severity: z.enum(['high', 'medium']),
  source: z.enum(['fred', 'static', 'finnhub']),
}) satisfies z.ZodType<EventItem>;

const eventsResponseSchema = z.object({
  events: z.array(eventItemSchema),
  startDate: z.string(),
  endDate: z.string(),
});

export type EventsResponseBody = z.infer<typeof eventsResponseSchema>;

/**
 * Check an /api/events body. A body that fails the schema is reported to Sentry
 * and rejected with INVALID_SHAPE_ERROR; nothing malformed is returned.
 * `ctx.request` names what was asked for (a date, or 'forward' for the forward
 * list) in the Sentry context.
 */
export function parseEventsResponse(
  raw: unknown,
  ctx: { request: string },
): EventsResponseBody {
  const parsed = eventsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    captureUnlessAuth(new Error('events response failed schema validation'), {
      contexts: {
        events: { ...ctx, ...summarizeZodIssues(parsed.error.issues) },
      },
    });
    throw new Error(INVALID_SHAPE_ERROR);
  }
  return parsed.data;
}
