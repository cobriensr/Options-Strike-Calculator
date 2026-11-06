// @vitest-environment node

/**
 * Pure parts of the economic-event label backfill: argument parsing, the date
 * arithmetic, the plan (reclassify, then recompute the training_features
 * columns) and the printed report. The SQL is covered on real Postgres in
 * econ-label-backfill-pglite.test.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPlan,
  daysBetween,
  dbHost,
  formatReport,
  parseArgs,
  type BackfillPlan,
  type EventRow,
  type FeatureRow,
} from './econ-label-backfill.js';

const event = (
  id: number,
  date: string,
  eventName: string,
  eventType: string,
): EventRow => ({ id, date, eventName, eventType });

const feature = (
  date: string,
  isFomc: boolean | null,
  eventType: string | null,
  daysToNextEvent: number | null,
): FeatureRow => ({ date, isFomc, eventType, daysToNextEvent });

describe('parseArgs', () => {
  it('is a dry run unless --apply is passed', () => {
    expect(parseArgs([])).toEqual({ apply: false, envFile: null });
    expect(parseArgs(['--dry-run'])).toEqual({ apply: false, envFile: null });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, envFile: null });
  });

  it('takes --env-file with a value', () => {
    expect(parseArgs(['--apply', '--env-file', 'x/.env.local'])).toEqual({
      apply: true,
      envFile: 'x/.env.local',
    });
  });

  it.each([
    [['--env-file'], /--env-file needs a value/],
    [['--env-file', '--apply'], /--env-file needs a value/],
    [['--force'], /unknown argument --force/],
    [['apply'], /unknown argument apply/],
    [['--apply', '--dry-run'], /--apply and --dry-run contradict/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('daysBetween', () => {
  it.each([
    ['2026-05-06', '2026-05-07', 1],
    ['2026-05-06', '2026-06-10', 35],
    ['2026-07-29', '2026-10-28', 91],
    ['2026-12-30', '2027-01-02', 3],
    // Across the US spring-forward (2026-03-08) and fall-back (2026-11-01):
    // a calendar-day gap is not 24 h of local time.
    ['2026-03-07', '2026-03-09', 2],
    ['2026-10-31', '2026-11-02', 2],
    // Leap day.
    ['2028-02-28', '2028-03-01', 2],
  ])('%s to %s is %i', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days);
  });
});

describe('dbHost', () => {
  it('shows the host only, never the credentials', () => {
    expect(
      dbHost('postgres://user:s3cret@ep-cool-123.neon.tech/db?sslmode=require'),
    ).toBe('ep-cool-123.neon.tech');
  });

  it.each([undefined, '', 'not a url'])('says so for %j', (url) => {
    expect(dbHost(url)).toBe('(DATABASE_URL missing or not a URL)');
  });
});

describe('buildPlan', () => {
  it('reclassifies economic_events and reports only the rows that change', () => {
    const plan = buildPlan(
      [
        event(1, '2026-05-06', 'Fed speech: Fed governor Bowman', 'FOMC'),
        event(2, '2026-06-10', 'Monthly U.S. federal budget', 'FOMC'),
        event(3, '2026-10-28', 'U.S. interest rate decision', 'OTHER'),
        event(4, '2026-10-28', 'Fed Chair Powell press conference', 'FOMC'),
        event(5, '2026-11-06', 'Nonfarm payrolls', 'JOBS'),
      ],
      [],
    );
    expect(plan.eventRows).toBe(5);
    expect(plan.eventChanges).toEqual([
      {
        id: 1,
        date: '2026-05-06',
        eventName: 'Fed speech: Fed governor Bowman',
        from: 'FOMC',
        to: 'FED',
      },
      {
        id: 2,
        date: '2026-06-10',
        eventName: 'Monthly U.S. federal budget',
        from: 'FOMC',
        to: 'OTHER',
      },
      {
        id: 3,
        date: '2026-10-28',
        eventName: 'U.S. interest rate decision',
        from: 'OTHER',
        to: 'FOMC',
      },
    ]);
  });

  const EVENTS = [
    event(1, '2026-05-06', 'Fed speech: Fed governor Bowman', 'FOMC'),
    event(2, '2026-06-10', 'Monthly U.S. federal budget', 'FOMC'),
    event(3, '2026-10-28', 'U.S. interest rate decision', 'OTHER'),
    event(4, '2026-11-06', 'Nonfarm payrolls', 'JOBS'),
  ];

  it('recomputes is_fomc, event_type and days_to_next_event from the corrected rows', () => {
    const plan = buildPlan(EVENTS, [
      // A wrongly-FOMC speech day: not a decision day, FED, 35 days to 06-10.
      feature('2026-05-06', true, 'FOMC', null),
      // A decision day with no rows at all: FOMC from the schedule alone.
      feature('2026-07-29', false, null, null),
      // The decision typed OTHER: FOMC now; the next event is 9 days out.
      feature('2026-10-28', false, 'OTHER', 8),
      // A budget release that was typed FOMC: OTHER.
      feature('2026-06-10', true, 'FOMC', 126),
      // Correct already: one day before the 11-06 payrolls.
      feature('2026-11-05', false, null, 1),
      // The last event day: nothing later, so NULL (the old 0 was wrong).
      feature('2026-11-06', false, 'JOBS', 0),
    ]);

    const byDate = new Map(plan.featureChanges.map((c) => [c.date, c]));
    expect(byDate.get('2026-05-06')).toEqual({
      date: '2026-05-06',
      isFomc: { from: true, to: false },
      eventType: { from: 'FOMC', to: 'FED' },
      daysToNextEvent: { from: null, to: 35 },
    });
    expect(byDate.get('2026-07-29')).toEqual({
      date: '2026-07-29',
      isFomc: { from: false, to: true },
      eventType: { from: null, to: 'FOMC' },
      daysToNextEvent: { from: null, to: 91 },
    });
    expect(byDate.get('2026-10-28')).toEqual({
      date: '2026-10-28',
      isFomc: { from: false, to: true },
      eventType: { from: 'OTHER', to: 'FOMC' },
      daysToNextEvent: { from: 8, to: 9 },
    });
    expect(byDate.get('2026-06-10')).toEqual({
      date: '2026-06-10',
      isFomc: { from: true, to: false },
      eventType: { from: 'FOMC', to: 'OTHER' },
      daysToNextEvent: { from: 126, to: 140 },
    });
    expect(byDate.has('2026-11-05')).toBe(false);
    expect(byDate.get('2026-11-06')).toEqual({
      date: '2026-11-06',
      isFomc: { from: false, to: false },
      eventType: { from: 'JOBS', to: 'JOBS' },
      daysToNextEvent: { from: 0, to: null },
    });
    expect(plan.featureRows).toBe(6);
    expect(plan.featureChanges).toHaveLength(5);
  });

  it('counts is_fomc before and after, and what precedes the first event row', () => {
    const plan = buildPlan(EVENTS, [
      feature('2026-03-18', false, null, null), // decision day, before the table
      feature('2026-05-06', true, 'FOMC', null),
      feature('2026-07-29', false, null, null),
    ]);
    expect(plan.isFomcBefore).toBe(1);
    expect(plan.isFomcAfter).toBe(2); // 03-18 and 07-29
    expect(plan.firstEventDate).toBe('2026-05-06');
    expect(plan.featureRowsBeforeFirstEvent).toBe(1); // 03-18
  });

  it('a NULL is_fomc is written but is not a flip', () => {
    const plan = buildPlan(EVENTS, [feature('2026-11-05', null, null, 1)]);
    const [change] = plan.featureChanges;
    expect(change?.isFomc).toEqual({ from: null, to: false });
    expect(plan.isFomcBefore).toBe(0);
    expect(plan.isFomcAfter).toBe(0);
  });

  it('is empty on a database that is already correct', () => {
    const plan = buildPlan(
      [
        event(1, '2026-05-06', 'Fed speech: Fed governor Bowman', 'FED'),
        event(2, '2026-10-28', 'U.S. interest rate decision', 'FOMC'),
      ],
      [
        feature('2026-05-06', false, 'FED', 175),
        feature('2026-10-28', true, 'FOMC', null),
      ],
    );
    expect(plan.eventChanges).toEqual([]);
    expect(plan.featureChanges).toEqual([]);
  });

  it('has no first event date without event rows', () => {
    const plan = buildPlan([], [feature('2026-03-18', false, null, null)]);
    expect(plan.firstEventDate).toBeNull();
    expect(plan.featureRowsBeforeFirstEvent).toBe(0);
    // The decision day is still FOMC from the schedule.
    expect(plan.featureChanges[0]?.isFomc).toEqual({ from: false, to: true });
  });
});

describe('formatReport', () => {
  const plan = (): BackfillPlan => ({
    ...buildPlan(
      [
        event(1, '2026-05-06', 'Fed speech: Fed governor Bowman', 'FOMC'),
        event(2, '2026-05-06', 'Fed speech: Fed governor Bowman', 'FOMC'),
        event(3, '2026-10-28', 'U.S. interest rate decision', 'OTHER'),
      ],
      [
        feature('2026-05-06', true, 'FOMC', null),
        feature('2026-10-28', false, 'OTHER', 8),
      ],
    ),
    snapshotsMissed: { total: 71, matched: 71 },
    snapshotsWrong: { total: 66, matched: 66 },
    featuresEventDayMissed: { total: 1, matched: 1 },
    featuresEventDayWrong: { total: 1, matched: 1 },
    fires: { total: 12, matched: 3 },
  });

  it('prints every section for a dry run and says nothing was written', () => {
    const text = formatReport({
      plan: plan(),
      apply: false,
      written: null,
    });
    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/economic_events: 3 rows read, 3 change type/);
    expect(text).toMatch(/FOMC → FED: 2/);
    expect(text).toMatch(/OTHER → FOMC: 1/);
    // Each distinct changed name once, with its row count.
    expect(text).toMatch(
      /FOMC → FED {2}Fed speech: Fed governor Bowman \(2 rows\)/,
    );
    expect(text).toMatch(
      /OTHER → FOMC {2}U\.S\. interest rate decision \(1 row\)/,
    );
    expect(text).toMatch(/is_fomc true: 1 → 1/);
    expect(text).toMatch(
      /is_fomc flips \(2\): 2026-05-06 true→false, 2026-10-28 false→true/,
    );
    expect(text).toMatch(/event_type changes: 2/);
    expect(text).toMatch(/days_to_next_event changes: 2/);
    expect(text).toMatch(/2026-04-29: market_snapshots 71 of 71 rows match/);
    expect(text).toMatch(/2026-05-06: market_snapshots 66 of 66 rows match/);
    expect(text).toMatch(/ws_gamma_setup_fires: 3 of 12 rows match/);
    expect(text).toMatch(/Dry run: nothing written/);
  });

  it('prints the written counts for an apply and warns when they differ from the plan', () => {
    const written = {
      economic_events: 3,
      training_features: 2,
      market_snapshots_missed: 71,
      market_snapshots_wrong: 60,
      training_features_event_day_missed: 1,
      training_features_event_day_wrong: 1,
      ws_gamma_setup_fires: 3,
    };
    const text = formatReport({ plan: plan(), apply: true, written });
    expect(text).toMatch(/APPLY/);
    expect(text).toMatch(/Written in one transaction/);
    expect(text).toMatch(/economic_events 3/);
    expect(text).toMatch(
      /WARNING: market_snapshots_wrong planned 66, wrote 60/,
    );
    expect(text).not.toMatch(/WARNING: economic_events/);
  });

  it('says there is nothing to change on a clean database', () => {
    const clean: BackfillPlan = {
      ...buildPlan([], []),
      snapshotsMissed: { total: 71, matched: 0 },
      snapshotsWrong: { total: 66, matched: 0 },
      featuresEventDayMissed: { total: 1, matched: 0 },
      featuresEventDayWrong: { total: 1, matched: 0 },
      fires: { total: 12, matched: 0 },
    };
    expect(formatReport({ plan: clean, apply: true, written: null })).toMatch(
      /Nothing to change/,
    );
  });
});
