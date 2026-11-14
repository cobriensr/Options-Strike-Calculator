/**
 * The pure day-level rules behind the economic-event features, shared by the
 * live feature builder (`build-features-phase2.ts`, `addEventFeatures`) and
 * the history backfill (`scripts/_lib/econ-label-backfill.ts`).
 *
 * It lives apart from `build-features-phase2.ts` so a script can import the
 * rules without pulling in that module's UW client, Upstash and Sentry. It
 * imports only the Fed schedule and a type.
 *
 * Spec: docs/superpowers/specs/2026-11-06-economic-events-fomc-classification.md.
 */

import type { EconomicEventType } from './economic-event-type.js';
import { isFomcDecisionDay } from './fomc-schedule.js';

// Which event type labels a day when several are present: the lowest rank
// wins. A Record, not a list, so a new `EconomicEventType` member fails
// type-check here until it is ranked.
const EVENT_TYPE_RANK: Record<EconomicEventType, number> = {
  FOMC: 0,
  CPI: 1,
  PCE: 2,
  JOBS: 3,
  GDP: 4,
  FED: 5,
  PMI: 6,
  RETAIL: 7,
  SENTIMENT: 8,
  OTHER: 9,
};

const EVENT_TYPES_BY_RANK = (
  Object.keys(EVENT_TYPE_RANK) as EconomicEventType[]
).sort((a, b) => EVENT_TYPE_RANK[a] - EVENT_TYPE_RANK[b]);

/**
 * The one rule behind a day's `is_fomc` and `event_type`, given the
 * `event_type`s of that day's `economic_events` rows (none is an empty set).
 * `addEventFeatures` and the history backfill both call it.
 *
 * - `isFomc`: the Fed schedule says it is a decision day, so a scheduled
 *   meeting counts with no rows at all (before the table existed, or in a
 *   gap), OR a row is typed `FOMC`, which the classifier gives only to
 *   decision-type releases (a foreign bank's decision and a speaker who
 *   mentions the decision are vetoed there), so it covers an unscheduled
 *   (emergency) decision.
 * - `eventType`: `FOMC` when `isFomc`, else the first present type in
 *   `EVENT_TYPE_RANK`, else null (no rows, or none of the known types).
 */
export function summarizeDayEvents(
  dateStr: string,
  types: ReadonlySet<string>,
): { isFomc: boolean; eventType: string | null } {
  const isFomc = isFomcDecisionDay(dateStr) || types.has('FOMC');
  if (isFomc) return { isFomc, eventType: 'FOMC' };
  return {
    isFomc,
    eventType: EVENT_TYPES_BY_RANK.find((p) => types.has(p)) ?? null,
  };
}

/**
 * The longest calendar-day gap to the next `economic_events` row that still
 * means "the next event". UW's calendar has weekly jobless claims plus several
 * releases most days, so a gap over 10 days means rows are missing (the
 * 2026-07-22..09-07 hole), not a quiet calendar. A longer gap is no feature
 * value at all.
 */
export const MAX_PLAUSIBLE_EVENT_GAP_DAYS = 10;

/**
 * The ET minute of the day (9:30 AM = 570) by which the economic-calendar cron
 * has stored today's rows: the end of its 9:00 to 9:30 ET window, in which its
 * 9:25 ET fire lands. The cron gates on it (`fetch-economic-calendar.ts`), and
 * the analysis reads an empty today as "not stored yet" until it has passed.
 */
export const ECON_CALENDAR_FETCH_DONE_ET_MINUTES = 570;

/**
 * `days` when it is a plausible gap to the next event row (see
 * MAX_PLAUSIBLE_EVENT_GAP_DAYS), else null: no later row, or a gap long enough
 * to mean missing data.
 */
export function plausibleEventGap(
  days: number | null | undefined,
): number | null {
  return days != null && days <= MAX_PLAUSIBLE_EVENT_GAP_DAYS ? days : null;
}

/**
 * A day's `days_to_next_event`, from the calendar-day gap to the next
 * `economic_events` row (`gapDays`, null with no later row) and whether the
 * day is dated before the first row in the table (`beforeTable`). The one
 * rule for the live builder and the backfill:
 * - before the first row: null, because the table did not exist yet, so the
 *   gap to its first row measures when the table began, not the calendar;
 * - a gap over MAX_PLAUSIBLE_EVENT_GAP_DAYS: null, because rows are missing;
 * - otherwise the gap.
 * A null `beforeTable` (an empty table) is not "before".
 */
export function nextEventGap(
  gapDays: number | null | undefined,
  beforeTable: boolean | null | undefined,
): number | null {
  return beforeTable === true ? null : plausibleEventGap(gapDays);
}
