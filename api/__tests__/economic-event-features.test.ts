// @vitest-environment node

/**
 * The pure day-level event rules (api/_lib/economic-event-features.ts): the
 * is_fomc / event_type rule, and the days_to_next_event rule that the live
 * builder and the history backfill share. No mocks: the module imports only
 * the Fed schedule.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PLAUSIBLE_EVENT_GAP_DAYS,
  nextEventGap,
  plausibleEventGap,
  summarizeDayEvents,
} from '../_lib/economic-event-features.js';

// ── plausibleEventGap (the missing-calendar-data rule) ─────

describe('plausibleEventGap', () => {
  it('allows up to ten calendar days', () => {
    expect(MAX_PLAUSIBLE_EVENT_GAP_DAYS).toBe(10);
  });

  it.each([
    [0, 0],
    [1, 1],
    [10, 10],
    [11, null],
    [140, null],
    [null, null],
    [undefined, null],
  ])('%s -> %s', (days, expected) => {
    expect(plausibleEventGap(days)).toBe(expected);
  });
});

// ── summarizeDayEvents (the is_fomc / event_type rule) ─────

describe('summarizeDayEvents', () => {
  // 2026-07-29 is a scheduled decision day; 2026-03-24 is not.
  const DECISION_DAY = '2026-07-29';
  const PLAIN_DAY = '2026-03-24';

  it.each<{
    name: string;
    date: string;
    types: string[];
    expected: { isFomc: boolean; eventType: string | null };
  }>([
    {
      name: 'a decision day with no event rows',
      date: DECISION_DAY,
      types: [],
      expected: { isFomc: true, eventType: 'FOMC' },
    },
    {
      name: 'a decision day whose only rows are FED',
      date: DECISION_DAY,
      types: ['FED'],
      expected: { isFomc: true, eventType: 'FOMC' },
    },
    {
      name: 'a non-decision day whose only rows are FED',
      date: PLAIN_DAY,
      types: ['FED'],
      expected: { isFomc: false, eventType: 'FED' },
    },
    {
      name: 'GDP and FED: GDP wins',
      date: PLAIN_DAY,
      types: ['FED', 'GDP'],
      expected: { isFomc: false, eventType: 'GDP' },
    },
    {
      name: 'FED and PMI: FED wins',
      date: PLAIN_DAY,
      types: ['PMI', 'FED'],
      expected: { isFomc: false, eventType: 'FED' },
    },
    {
      name: 'a FOMC-typed row on a non-decision day (unscheduled decision)',
      date: PLAIN_DAY,
      types: ['FOMC'],
      expected: { isFomc: true, eventType: 'FOMC' },
    },
    {
      name: 'a FOMC-typed row beats every other type',
      date: PLAIN_DAY,
      types: ['CPI', 'FED', 'FOMC', 'OTHER'],
      expected: { isFomc: true, eventType: 'FOMC' },
    },
    {
      name: 'the old wrong April 2026 date (2026-05-06) is not a decision day',
      date: '2026-05-06',
      types: ['FED'],
      expected: { isFomc: false, eventType: 'FED' },
    },
    {
      name: 'no rows on a non-decision day',
      date: PLAIN_DAY,
      types: [],
      expected: { isFomc: false, eventType: null },
    },
    {
      name: 'only a type outside the priority list',
      date: PLAIN_DAY,
      types: ['MYSTERY'],
      expected: { isFomc: false, eventType: null },
    },
  ])('$name', ({ date, types, expected }) => {
    expect(summarizeDayEvents(date, new Set(types))).toEqual(expected);
  });

  it('ranks the types FOMC, CPI, PCE, JOBS, GDP, FED, PMI, RETAIL, SENTIMENT, OTHER', () => {
    const order = [
      'FOMC',
      'CPI',
      'PCE',
      'JOBS',
      'GDP',
      'FED',
      'PMI',
      'RETAIL',
      'SENTIMENT',
      'OTHER',
    ];
    // With a type and everything below it present, the type itself wins.
    for (const [i, type] of order.entries()) {
      expect(
        summarizeDayEvents(PLAIN_DAY, new Set(order.slice(i))).eventType,
      ).toBe(type);
    }
  });
});

// ── nextEventGap (days_to_next_event, live and backfill) ───

describe('nextEventGap', () => {
  it.each<
    [
      string,
      number | null | undefined,
      boolean | null | undefined,
      number | null,
    ]
  >([
    ['a gap of 1 on a day inside the table', 1, false, 1],
    ['the largest plausible gap', 10, false, 10],
    ['one day past it', 11, false, null],
    ['a gap across a hole in the calendar', 47, false, null],
    ['no later row', null, false, null],
    ['no later row (undefined)', undefined, false, null],
    ['a short gap on a day before the first row', 1, true, null],
    ['a gap of 10 on a day before the first row', 10, true, null],
    ['an empty table: the flag is NULL, no gap either', null, null, null],
    ['an unknown flag (undefined) is not "before"', 3, undefined, 3],
  ])('%s', (_label, gapDays, beforeTable, expected) => {
    expect(nextEventGap(gapDays, beforeTable)).toBe(expected);
  });
});
