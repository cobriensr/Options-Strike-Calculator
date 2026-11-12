// @vitest-environment node

/**
 * Pure parts of the snapshot event-flag backfill (scripts/_lib/
 * snapshot-event-flag-backfill.ts): argument parsing, the month chunks, the
 * key and month refusals, the plan and the printed report. The SQL is covered
 * on real Postgres in snapshot-event-flag-backfill-pglite.test.ts.
 *
 * Two module boundaries are mocked: `db.js` (a tagged-template stub that
 * answers the snapshot read) and `market-events.js` (`fetchMarketEvents`
 * only; the real `eventNamesForSnapshot` runs). Nothing reaches FRED,
 * Finnhub, Redis or a database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, fetchMarketEvents } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  fetchMarketEvents: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../../api/_lib/market-events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/market-events.js')>()),
  fetchMarketEvents,
}));

import type { EventItem } from '../../api/_lib/market-events.js';
import {
  buildPlan,
  fetchMonthlyNames,
  formatReport,
  monthRanges,
  parseArgs,
  requireApiKeys,
  runBackfill,
  type BackfillResult,
  type FeatureRow,
  type Plan,
  type SnapshotRow,
} from './snapshot-event-flag-backfill.js';

const snap = (
  id: number,
  date: string,
  isEventDay: boolean | null,
  eventNames: string[] | null,
): SnapshotRow => ({ id, date, isEventDay, eventNames });

const feat = (date: string, isEventDay: boolean | null): FeatureRow => ({
  date,
  isEventDay,
});

const plan = (
  snapshots: SnapshotRow[],
  computed: Record<string, string[]>,
  opts: { features?: FeatureRow[]; keepEarnings?: boolean } = {},
): Plan =>
  buildPlan({
    snapshots,
    features: opts.features ?? [],
    namesByDate: new Map(Object.entries(computed)),
    keepEarnings: opts.keepEarnings ?? false,
  });

const eventItem = (date: string, event: string): EventItem => ({
  date,
  event,
  description: event,
  time: '8:30 AM',
  severity: 'high',
  source: 'fred',
});

describe('parseArgs', () => {
  it('is a dry run, keeping nothing, unless told otherwise', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      keepEarnings: false,
      envFile: null,
      help: false,
    });
    expect(parseArgs(['--dry-run']).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--keep-earnings']).keepEarnings).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('takes --env-file with a value', () => {
    expect(
      parseArgs(['--apply', '--keep-earnings', '--env-file', 'x/.env.local']),
    ).toEqual({
      apply: true,
      keepEarnings: true,
      envFile: 'x/.env.local',
      help: false,
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

describe('monthRanges', () => {
  it.each([
    [
      'a range inside one month is clipped on both ends',
      ['2026-03-20', '2026-03-05', '2026-03-12'],
      [{ month: '2026-03', start: '2026-03-05', end: '2026-03-20' }],
    ],
    [
      'a single date is its own one-day range',
      ['2026-03-05', '2026-03-05'],
      [{ month: '2026-03', start: '2026-03-05', end: '2026-03-05' }],
    ],
    [
      'a range across a year boundary clips only the outer months',
      ['2025-12-15', '2026-01-20'],
      [
        { month: '2025-12', start: '2025-12-15', end: '2025-12-31' },
        { month: '2026-01', start: '2026-01-01', end: '2026-01-20' },
      ],
    ],
    [
      'interior months run the whole month, leap February included',
      ['2028-01-10', '2028-02-15', '2028-03-03'],
      [
        { month: '2028-01', start: '2028-01-10', end: '2028-01-31' },
        { month: '2028-02', start: '2028-02-01', end: '2028-02-29' },
        { month: '2028-03', start: '2028-03-01', end: '2028-03-03' },
      ],
    ],
    [
      'a month with no snapshot dates is skipped',
      ['2026-01-05', '2026-03-09'],
      [
        { month: '2026-01', start: '2026-01-05', end: '2026-01-31' },
        { month: '2026-03', start: '2026-03-01', end: '2026-03-09' },
      ],
    ],
    ['no dates, no months', [], []],
  ])('%s', (_label, dates, expected) => {
    expect(monthRanges(dates)).toEqual(expected);
  });
});

describe('requireApiKeys', () => {
  it('passes when both keys are set', () => {
    expect(() =>
      requireApiKeys({ FRED_API_KEY: 'f', FINNHUB_API_KEY: 'h' }),
    ).not.toThrow();
  });

  it('names a missing FRED key', () => {
    expect(() => requireApiKeys({ FINNHUB_API_KEY: 'h' })).toThrow(
      /FRED_API_KEY is not set/,
    );
  });

  it('names a missing Finnhub key and says why it is required', () => {
    expect(() => requireApiKeys({ FRED_API_KEY: 'f' })).toThrow(
      /FINNHUB_API_KEY is not set.*strip every stored earnings name/s,
    );
  });

  it('treats an empty value as unset, and names both when both are missing', () => {
    expect(() =>
      requireApiKeys({ FRED_API_KEY: '', FINNHUB_API_KEY: '' }),
    ).toThrow(/FRED_API_KEY is not set.*FINNHUB_API_KEY is not set/s);
  });
});

describe('buildPlan: which snapshot rows are written', () => {
  it('writes nothing when the stored names are the computed ones in another order', () => {
    const p = plan([snap(1, '2026-05-12', true, ['PPI', 'CPI'])], {
      '2026-05-12': ['CPI', 'PPI'],
    });
    expect(p.snapshotChanges).toEqual([]);
  });

  it('writes nothing when only duplicates differ', () => {
    const p = plan(
      [
        snap(1, '2026-05-12', true, ['CPI', 'CPI']),
        snap(2, '2026-05-12', true, ['CPI']),
      ],
      { '2026-05-12': ['CPI', 'CPI'] },
    );
    expect(p.snapshotChanges).toEqual([]);
  });

  it('counts NULL names as empty: NULL on a quiet day with the flag false is already right', () => {
    const p = plan([snap(1, '2026-05-11', false, null)], {});
    expect(p.snapshotChanges).toEqual([]);
  });

  it('writes a NULL flag on a quiet day, as false', () => {
    const p = plan([snap(1, '2026-05-11', null, [])], {});
    expect(p.snapshotChanges).toEqual([
      {
        id: 1,
        date: '2026-05-11',
        from: { isEventDay: null, eventNames: [] },
        to: { isEventDay: false, eventNames: [] },
      },
    ]);
  });

  it('writes a flag mismatch even when the names agree', () => {
    const p = plan(
      [snap(1, '2026-05-12', false, ['CPI']), snap(2, '2026-05-11', true, [])],
      { '2026-05-12': ['CPI'] },
    );
    expect(p.snapshotChanges.map((c) => [c.id, c.to])).toEqual([
      [1, { isEventDay: true, eventNames: ['CPI'] }],
      [2, { isEventDay: false, eventNames: [] }],
    ]);
  });

  it('writes the computed names in the computed order, as [] and not NULL on a quiet day', () => {
    const p = plan(
      [
        snap(1, '2026-05-12', false, null),
        snap(2, '2026-05-13', true, ['FOMC']),
      ],
      { '2026-05-12': ['PCE', 'PPI'] },
    );
    expect(p.snapshotChanges).toEqual([
      {
        id: 1,
        date: '2026-05-12',
        from: { isEventDay: false, eventNames: null },
        to: { isEventDay: true, eventNames: ['PCE', 'PPI'] },
      },
      {
        id: 2,
        date: '2026-05-13',
        from: { isEventDay: true, eventNames: ['FOMC'] },
        to: { isEventDay: false, eventNames: [] },
      },
    ]);
  });
});

describe('buildPlan: --keep-earnings', () => {
  const rows = [snap(1, '2026-05-20', true, ['CPI', 'NVDA Earnings'])];

  it('drops a stored earnings name that the computed list lacks by default', () => {
    const p = plan(rows, { '2026-05-20': ['CPI'] });
    expect(p.snapshotChanges[0]?.to).toEqual({
      isEventDay: true,
      eventNames: ['CPI'],
    });
  });

  it('appends it to the computed names when kept', () => {
    const p = plan(rows, { '2026-05-20': ['PPI'] }, { keepEarnings: true });
    expect(p.snapshotChanges[0]?.to).toEqual({
      isEventDay: true,
      eventNames: ['PPI', 'NVDA Earnings'],
    });
  });

  it('writes nothing when the kept names make the row already right', () => {
    const p = plan(rows, { '2026-05-20': ['CPI'] }, { keepEarnings: true });
    expect(p.snapshotChanges).toEqual([]);
  });

  it('does not duplicate an earnings name the computed list has, or keep one twice', () => {
    const p = plan(
      [
        snap(1, '2026-05-20', true, [
          'AAPL Earnings',
          'TSLA Earnings',
          'TSLA Earnings',
        ]),
      ],
      { '2026-05-20': ['AAPL Earnings', 'CPI'] },
      { keepEarnings: true },
    );
    expect(p.snapshotChanges[0]?.to.eventNames).toEqual([
      'AAPL Earnings',
      'CPI',
      'TSLA Earnings',
    ]);
  });

  it('keeps only names ending in " Earnings", not other stored names', () => {
    const p = plan(
      [snap(1, '2026-05-20', true, ['FOMC', 'Earnings', 'NVDA Earnings Call'])],
      { '2026-05-20': [] },
      { keepEarnings: true },
    );
    expect(p.snapshotChanges[0]?.to).toEqual({
      isEventDay: false,
      eventNames: [],
    });
  });

  it('turns a flag on for a day whose only name is a kept earnings name', () => {
    const p = plan(
      [snap(1, '2026-05-20', false, ['NVDA Earnings'])],
      {},
      { keepEarnings: true, features: [feat('2026-05-20', false)] },
    );
    expect(p.snapshotChanges[0]?.to).toEqual({
      isEventDay: true,
      eventNames: ['NVDA Earnings'],
    });
    expect(p.featureChanges).toEqual([
      { date: '2026-05-20', from: false, to: true },
    ]);
  });
});

describe('buildPlan: per-name day counts', () => {
  it('counts days, not rows, and keeps gained and lost apart', () => {
    const p = plan(
      [
        // 05-12: three rows gain CPI, one row also loses FOMC.
        snap(1, '2026-05-12', false, []),
        snap(2, '2026-05-12', false, null),
        snap(3, '2026-05-12', true, ['FOMC']),
        // 05-13: two rows lose FOMC.
        snap(4, '2026-05-13', true, ['FOMC']),
        snap(5, '2026-05-13', true, ['FOMC']),
        // 05-14: already right.
        snap(6, '2026-05-14', true, ['CPI']),
        // 05-15: gains CPI.
        snap(7, '2026-05-15', false, []),
      ],
      {
        '2026-05-12': ['CPI'],
        '2026-05-14': ['CPI'],
        '2026-05-15': ['CPI'],
      },
    );
    expect(p.nameDays).toEqual([
      { name: 'CPI', gained: 2, lost: 0 },
      { name: 'FOMC', gained: 0, lost: 2 },
    ]);
  });

  it('omits a name that only ever stays put', () => {
    const p = plan([snap(1, '2026-05-14', true, ['CPI'])], {
      '2026-05-14': ['CPI'],
    });
    expect(p.nameDays).toEqual([]);
  });
});

describe('buildPlan: dates that lose or gain a flag', () => {
  const p = plan(
    [
      // 05-06: the mislabelled FOMC day. Two rows, both lose it.
      snap(1, '2026-05-06', true, ['FOMC']),
      snap(2, '2026-05-06', true, ['FOMC', 'NVDA Earnings']),
      // 05-07: a flag with no names, nothing computed.
      snap(3, '2026-05-07', true, null),
      // 05-08: gains a flag on every row.
      snap(4, '2026-05-08', false, []),
      snap(5, '2026-05-08', false, null),
      // 05-11: a mixed day. One row already carries the flag, so the day
      // neither gains nor loses it, though one row is written.
      snap(6, '2026-05-11', true, ['CPI']),
      snap(7, '2026-05-11', false, []),
      // 05-12: a quiet day that stays quiet.
      snap(8, '2026-05-12', false, []),
    ],
    {
      '2026-05-08': ['PPI'],
      '2026-05-11': ['CPI'],
    },
  );

  it('lists every date that ends with no flag after having one, with its old names', () => {
    expect(p.lostFlagDates).toEqual([
      { date: '2026-05-06', oldNames: ['FOMC', 'NVDA Earnings'] },
      { date: '2026-05-07', oldNames: [] },
    ]);
  });

  it('lists every date that gains a flag', () => {
    expect(p.gainedFlagDates).toEqual(['2026-05-08']);
  });

  it('still writes the mixed day row that was behind', () => {
    expect(p.snapshotChanges.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 7]);
  });
});

describe('buildPlan: training_features', () => {
  it('writes the date flag only where it is distinct, NULL included', () => {
    const p = plan(
      [
        snap(1, '2026-05-12', false, []),
        snap(2, '2026-05-12', false, []),
        snap(3, '2026-05-13', false, []),
        snap(4, '2026-05-14', true, ['FOMC']),
        snap(5, '2026-05-15', true, ['CPI']),
      ],
      { '2026-05-12': ['CPI'], '2026-05-15': ['CPI'] },
      {
        features: [
          feat('2026-05-12', false), // gains
          feat('2026-05-13', false), // already right
          feat('2026-05-14', true), // loses
          feat('2026-05-15', true), // already right
        ],
      },
    );
    expect(p.featureRows).toBe(4);
    expect(p.featureChanges).toEqual([
      { date: '2026-05-12', from: false, to: true },
      { date: '2026-05-14', from: true, to: false },
    ]);
  });

  it('writes a NULL feature flag', () => {
    const p = plan(
      [snap(1, '2026-05-13', false, [])],
      {},
      {
        features: [feat('2026-05-13', null)],
      },
    );
    expect(p.featureChanges).toEqual([
      { date: '2026-05-13', from: null, to: false },
    ]);
  });

  it('skips a snapshot date with no feature row, and a feature row with no snapshot', () => {
    const p = plan(
      [snap(1, '2026-05-12', false, [])],
      { '2026-05-12': ['CPI'] },
      { features: [feat('2026-05-01', true)] },
    );
    expect(p.featureRows).toBe(0);
    expect(p.featureChanges).toEqual([]);
  });
});

describe('fetchMonthlyNames', () => {
  const march = { month: '2026-03', start: '2026-03-05', end: '2026-03-31' };
  const april = { month: '2026-04', start: '2026-04-01', end: '2026-04-09' };

  beforeEach(() => {
    fetchMarketEvents.mockReset();
    vi.stubEnv('FRED_API_KEY', 'fred-secret-value');
    vi.stubEnv('FINNHUB_API_KEY', 'finnhub-secret-value');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls the lookup once per month, in turn, with the month range', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMarketEvents.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { events: [], complete: true };
    });

    await fetchMonthlyNames([march, april]);

    expect(fetchMarketEvents.mock.calls).toEqual([
      ['2026-03-05', '2026-03-31'],
      ['2026-04-01', '2026-04-09'],
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('maps each date to the names the shared definition gives, in event order', async () => {
    fetchMarketEvents.mockResolvedValueOnce({
      events: [
        eventItem('2026-03-06', 'NFP'),
        eventItem('2026-03-12', 'CPI'),
        eventItem('2026-03-12', 'PPI'),
      ],
      complete: true,
    });

    const { namesByDate, fetched } = await fetchMonthlyNames([march]);

    expect(Object.fromEntries(namesByDate)).toEqual({
      '2026-03-06': ['NFP'],
      '2026-03-12': ['CPI', 'PPI'],
    });
    expect(fetched).toEqual([{ ...march, eventCount: 3 }]);
  });

  it('refuses an incomplete month and names it, before fetching the next', async () => {
    fetchMarketEvents
      .mockResolvedValueOnce({ events: [], complete: true })
      .mockResolvedValueOnce({ events: [], complete: false });

    await expect(
      fetchMonthlyNames([march, april, { ...april, month: '2026-05' }]),
    ).rejects.toThrow(/events for 2026-04 .*are incomplete/);
    expect(fetchMarketEvents).toHaveBeenCalledTimes(2);
  });

  it('refuses a month whose lookup rejects, names it, and never echoes a key', async () => {
    fetchMarketEvents.mockRejectedValueOnce(
      new Error(
        'GET https://x?api_key=fred-secret-value&token=finnhub-secret-value failed',
      ),
    );

    const failure = await fetchMonthlyNames([march]).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/events for 2026-03 .*could not be fetched/);
    expect(message).not.toContain('fred-secret-value');
    expect(message).not.toContain('finnhub-secret-value');
  });
});

describe('runBackfill refusals', () => {
  beforeEach(() => {
    mockSql.mockReset();
    fetchMarketEvents.mockReset();
    vi.stubEnv('FRED_API_KEY', 'f');
    vi.stubEnv('FINNHUB_API_KEY', 'h');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const opts = { apply: true, keepEarnings: false, undoDir: 'unused' };

  it.each([
    ['FRED_API_KEY', 'FINNHUB_API_KEY'],
    ['FINNHUB_API_KEY', 'FRED_API_KEY'],
  ])(
    'refuses before reading or fetching anything when %s is unset',
    async (missing) => {
      vi.stubEnv(missing, '');

      await expect(runBackfill(opts)).rejects.toThrow(`${missing} is not set`);

      expect(mockSql).not.toHaveBeenCalled();
      expect(fetchMarketEvents).not.toHaveBeenCalled();
    },
  );

  it('refuses when there are no snapshot rows, before any fetch', async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(runBackfill(opts)).rejects.toThrow(
      /no market_snapshots rows dated 2026-11-11 or earlier/,
    );

    expect(fetchMarketEvents).not.toHaveBeenCalled();
  });

  it('refuses an incomplete month, names it and writes nothing', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, day: '2026-02-10', is_event_day: false, event_names: [] },
      { id: 2, day: '2026-03-04', is_event_day: false, event_names: [] },
    ]);
    fetchMarketEvents
      .mockResolvedValueOnce({ events: [], complete: true })
      .mockResolvedValueOnce({ events: [], complete: false });

    await expect(runBackfill(opts)).rejects.toThrow(/events for 2026-03 /);

    // The snapshot read is the only database call: no feature read, no write.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe('formatReport', () => {
  const months = [
    { month: '2026-05', start: '2026-05-06', end: '2026-05-12', eventCount: 4 },
  ];
  const snapshots = [
    snap(1, '2026-05-06', true, ['FOMC']),
    snap(2, '2026-05-06', true, ['FOMC']),
    snap(3, '2026-05-12', false, []),
    snap(4, '2026-05-12', false, []),
  ];
  const result = (over: Partial<BackfillResult> = {}): BackfillResult => ({
    plan: plan(
      snapshots,
      { '2026-05-12': ['CPI'] },
      { features: [feat('2026-05-06', true), feat('2026-05-12', false)] },
    ),
    months,
    apply: false,
    keepEarnings: false,
    undoFile: null,
    outcome: null,
    ...over,
  });

  it('says it is a dry run and what it read', () => {
    const text = formatReport(result());
    expect(text).toContain('DRY RUN (writes nothing)');
    expect(text).toContain('4 market_snapshots rows on 2 dates');
    expect(text).toContain('2026-05-06 to 2026-05-12');
    expect(text).toContain('2026-05 (2026-05-06..2026-05-12): 4 events');
    expect(text).toContain('Dry run: nothing written');
  });

  it('prints the per-name day counts, the lost dates with old and new names, and the gained count and dates', () => {
    const text = formatReport(result());
    expect(text).toMatch(/CPI\s+gain 1\s+lose 0/);
    expect(text).toMatch(/FOMC\s+gain 0\s+lose 1/);
    expect(text).toContain('Dates that lose their event flag (1)');
    expect(text).toContain('2026-05-06  FOMC -> (none)');
    expect(text).toContain('Dates that gain an event flag (1): 2026-05-12');
  });

  it('prints the planned rows per table and the total', () => {
    const text = formatReport(result());
    expect(text).toContain('market_snapshots: 4 of 4 rows to write');
    expect(text).toContain('training_features: 2 of 2 rows to write');
    expect(text).toContain('Total planned writes: 6');
  });

  it('says whether earnings are being kept', () => {
    expect(formatReport(result())).toContain('--keep-earnings: off');
    expect(formatReport(result({ keepEarnings: true }))).toContain(
      '--keep-earnings: on',
    );
  });

  it('reports a flag-only old state when a date had a flag but no names', () => {
    const text = formatReport({
      ...result(),
      plan: plan([snap(1, '2026-05-07', true, null)], {}),
    });
    expect(text).toContain('2026-05-07  (flag set, no names) -> (none)');
  });

  it('says there is nothing to change when the plan is empty', () => {
    const empty = plan([snap(1, '2026-05-12', true, ['CPI'])], {
      '2026-05-12': ['CPI'],
    });
    expect(formatReport(result({ plan: empty }))).toContain(
      'Nothing to change',
    );
  });

  it('reports the undo file, the rows written and every skipped row after an apply', () => {
    const text = formatReport(
      result({
        apply: true,
        undoFile: 'docs/tmp/snapshot-event-flags/undo-x.json',
        outcome: {
          written: { market_snapshots: 3, training_features: 1 },
          skipped: { snapshotIds: [4], featureDates: ['2026-05-12'] },
        },
      }),
    );
    expect(text).toContain('APPLY (one transaction)');
    expect(text).toContain(
      'Undo file: docs/tmp/snapshot-event-flags/undo-x.json',
    );
    expect(text).toContain(
      'Written in one transaction: market_snapshots 3, training_features 1.',
    );
    expect(text).toContain(
      'WARNING: 1 market_snapshots row skipped, changed since the read: id 4',
    );
    expect(text).toContain(
      'WARNING: 1 training_features row skipped, changed since the read: 2026-05-12',
    );
  });

  it('prints no warning when nothing was skipped', () => {
    const text = formatReport(
      result({
        apply: true,
        undoFile: 'u.json',
        outcome: {
          written: { market_snapshots: 4, training_features: 2 },
          skipped: { snapshotIds: [], featureDates: [] },
        },
      }),
    );
    expect(text).not.toContain('WARNING');
  });

  it('caps a long skipped list', () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const text = formatReport(
      result({
        apply: true,
        undoFile: 'u.json',
        outcome: {
          written: { market_snapshots: 0, training_features: 0 },
          skipped: { snapshotIds: ids, featureDates: [] },
        },
      }),
    );
    expect(text).toContain('30 market_snapshots rows skipped');
    expect(text).toContain('ids 1, 2, 3');
    expect(text).toContain('and 10 more');
    expect(text).not.toContain('30,');
  });
});
