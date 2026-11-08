// @vitest-environment node

/**
 * Tests for the one-time futures order-flow backfill (spec Phase 6b, Phase
 * 4b of the session front-month plan). Module-boundary mocks only: the DB
 * (getDb / withDbRetry), the front-month table (futures-front-month.js) and
 * its volume refresh, the UW fetch (uwFetch / withRetry), and the
 * market-hours clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  mockUwFetch,
  mockIsMarketHours,
  mockStored,
  mockSchedule,
  mockRefresh,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockUwFetch: vi.fn(),
  mockIsMarketHours: vi.fn(() => false),
  mockStored: vi.fn(),
  mockSchedule: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../../api/_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock('../../api/_lib/cron-helpers.js', () => ({
  isMarketHours: mockIsMarketHours,
}));
vi.mock('../../api/_lib/futures-front-month.js', () => ({
  fetchStoredFrontMonths: mockStored,
  fetchFrontMonthSchedule: mockSchedule,
}));
vi.mock('../../api/_lib/futures-volume-refresh.js', () => ({
  refreshFrontMonthVolumes: mockRefresh,
}));
vi.mock('../../api/_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../api/_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: { uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));

import {
  parseArgs,
  planDates,
  runBackfill,
  sessionPieces,
  sessionSpans,
  type BackfillOptions,
  type ScheduleReader,
} from './futures-flow-backfill.js';

// ── Fixtures ──────────────────────────────────────────────

const NOW = '2026-08-13T23:00:00Z'; // a Thursday evening, after the close

function opts(over: Partial<BackfillOptions> = {}): BackfillOptions {
  return {
    dates: null,
    from: null,
    to: null,
    roots: ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'],
    dryRun: false,
    maxPages: 20_000,
    ...over,
  };
}

/** A regular REST /trades print (probe 0a shape). */
function print(id: number, at: string, size: number, side: string | null) {
  return {
    executed_at: at,
    is_block: false,
    is_spread: false,
    price: '6300.25',
    side,
    size,
    trade_id: id,
  };
}

/** A NULL-flow row as fetchNullFlowBars' query returns it. */
function nullRow(symbol: string, ts: string, volume: number) {
  return { symbol, ts: new Date(ts), volume, starts_range: true };
}

/** UW /trades pages per contract, served in order; unknown contracts 404. */
function routeTrades(pages: Record<string, unknown[][]>) {
  const served: Record<string, number> = {};
  mockUwFetch.mockImplementation(async (_key: string, path: string) => {
    const contract = /^\/futures\/([^/]+)\/trades\?/.exec(path)?.[1];
    if (!contract) throw new Error(`unexpected UW path ${path}`);
    const i = served[contract] ?? 0;
    served[contract] = i + 1;
    const page = pages[contract]?.[i];
    if (page === undefined)
      throw new Error(`UW API 404: ${contract} page ${i}`);
    return page;
  });
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Routes the front-month table. Every date is decided, on `${root}U6`
 * unless `contracts` names the date; `undecided` dates have no stored row.
 * The schedule answers only the dates it is asked about, like the real one.
 */
function routeFrontMonth(
  contracts: Record<string, string> = {},
  undecided: readonly string[] = [],
) {
  const contractOn = (root: string, date: string) =>
    contracts[date] ?? `${root}U6`;
  mockStored.mockImplementation(
    async (root: string, from: string, to: string) => {
      const stored = new Map<string, string>();
      for (let d = from; d <= to; d = nextDay(d)) {
        if (!undecided.includes(d)) stored.set(d, contractOn(root, d));
      }
      return stored;
    },
  );
  mockSchedule.mockImplementation(
    async (root: string, dates: readonly string[]) => ({
      contractFor: (d: string) =>
        dates.includes(d) ? contractOn(root, d) : undefined,
      contracts: [...new Set(dates.map((d) => contractOn(root, d)))],
    }),
  );
}

/**
 * Routes the DB by day: NULL-flow rows per UTC date and root; every UPDATE
 * hits one row.
 */
function routeNullBars(byDate: Record<string, Array<{ symbol: string }>>) {
  mockSql.mockImplementation(
    async (strings: readonly string[], ...values: unknown[]) => {
      if (strings.join('?').includes('UPDATE futures_bars')) return [{}];
      const [symbols, startIso] = values as [string[], string];
      return (byDate[startIso.slice(0, 10)] ?? []).filter(
        (r) => r.symbol === symbols[0],
      );
    },
  );
}

function tradesContracts(): string[] {
  return mockUwFetch.mock.calls.map(
    (c) => /^\/futures\/([^/]+)\/trades/.exec(c[1] as string)![1]!,
  );
}

/** The `older_than` of UW call `i`: where that contract's paging started. */
function olderThan(i: number): string | null {
  const path = mockUwFetch.mock.calls[i]![1] as string;
  return new URL(`https://uw.test${path}`).searchParams.get('older_than');
}

function updateCalls(): unknown[][] {
  return mockSql.mock.calls.filter((c) =>
    (c[0] as readonly string[]).join('?').includes('UPDATE futures_bars'),
  );
}

/** ESU6 leads 07-14; its page ends with a print before the first NULL minute. */
const ES_PAGES = {
  ESU6: [
    [
      print(3, '2026-08-04T14:01:10.000000Z', 6, 'buy'),
      print(2, '2026-08-04T14:00:20.000000Z', 4, 'sell'),
      print(1, '2026-08-03T23:59:59.000000Z', 9, 'buy'),
    ],
  ],
};

let logs: string[];

/** The line a run prints when it stops before a date, if it did. */
const stopLine = () =>
  logs.find((l) => /Page budget spent|Market hours began/.test(l));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockIsMarketHours.mockReturnValue(false);
  mockSql.mockResolvedValue([]);
  routeFrontMonth();
  mockRefresh.mockResolvedValue({ contracts: [], offered: 0, inserted: 0 });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── parseArgs ─────────────────────────────────────────────

describe('parseArgs', () => {
  it.each<[string, string[], Partial<BackfillOptions>]>([
    ['no arguments: the default range, every root', [], {}],
    [
      'explicit dates, in any order',
      ['2026-07-15', '2026-07-14'],
      { dates: ['2026-07-15', '2026-07-14'] },
    ],
    [
      'a --from/--to range',
      ['--from', '2026-08-01', '--to', '2026-08-31'],
      { from: '2026-08-01', to: '2026-08-31' },
    ],
    ['--dry-run', ['--dry-run'], { dryRun: true }],
    ['--max-pages', ['--max-pages', '500'], { maxPages: 500 }],
    ['--roots, any case', ['--roots', 'es,NQ'], { roots: ['ES', 'NQ'] }],
    [
      '--roots, a repeated root once',
      ['--roots', 'ES,nq,es,NQ'],
      { roots: ['ES', 'NQ'] },
    ],
  ])('%s', (_label, argv, expected) => {
    expect(parseArgs(argv)).toEqual(opts(expected));
  });

  it.each<[string, string[], RegExp]>([
    ['a malformed date', ['2026-7-14'], /YYYY-MM-DD/],
    ['an impossible date', ['2026-02-30'], /YYYY-MM-DD/],
    ['a malformed --from', ['--from', 'yesterday'], /--from/],
    ['a flag missing its value', ['--to'], /--to/],
    [
      'dates mixed with a range',
      ['2026-07-14', '--from', '2026-07-01'],
      /either/,
    ],
    [
      '--from after --to',
      ['--from', '2026-08-02', '--to', '2026-08-01'],
      /after/,
    ],
    ['a zero page budget', ['--max-pages', '0'], /--max-pages/],
    ['a non-numeric page budget', ['--max-pages', 'lots'], /--max-pages/],
    ['an unknown root', ['--roots', 'ES,DX'], /DX/],
    ['an unknown flag', ['--apply'], /--apply/],
  ])('rejects %s', (_label, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

// ── planDates ─────────────────────────────────────────────

describe('planDates', () => {
  it('defaults to the first date with a stored front month (2026-07-28) for every root, through today, oldest first', () => {
    const plan = planDates(opts(), '2026-08-02');

    expect(plan).toHaveLength(6);
    expect(plan[0]).toEqual({
      date: '2026-07-28',
      roots: ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'],
    });
    expect(plan.at(-1)?.date).toBe('2026-08-02');
  });

  it('a default range starts at the first stored front month even for one root', () => {
    expect(planDates(opts({ roots: ['ES'] }), '2026-07-29')).toEqual([
      { date: '2026-07-28', roots: ['ES'] },
      { date: '2026-07-29', roots: ['ES'] },
    ]);
  });

  it('explicit dates: deduped, oldest first, every root on every date, future dates dropped', () => {
    const plan = planDates(
      opts({
        dates: [
          '2026-07-21',
          '2026-06-29',
          '2026-07-01',
          '2026-07-01',
          '2026-07-30',
        ],
        roots: ['ES', 'NQ'],
      }),
      '2026-07-22',
    );

    expect(plan).toEqual([
      { date: '2026-06-29', roots: ['ES', 'NQ'] },
      { date: '2026-07-01', roots: ['ES', 'NQ'] },
      { date: '2026-07-21', roots: ['ES', 'NQ'] },
    ]);
  });

  it('a --from/--to range gives every root every date, in the order the roots were given', () => {
    const plan = planDates(
      opts({ from: '2026-07-20', to: '2026-07-21', roots: ['NQ', 'ES'] }),
      '2026-07-22',
    );

    expect(plan).toEqual([
      { date: '2026-07-20', roots: ['NQ', 'ES'] },
      { date: '2026-07-21', roots: ['NQ', 'ES'] },
    ]);
  });
});

// ── sessionSpans ──────────────────────────────────────────

describe('sessionSpans', () => {
  const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
  const spans = (from: string, to: string) =>
    sessionSpans(Date.parse(from), Date.parse(to)).map((s) => [
      s.tradeDate,
      minute(s.fromMs),
      minute(s.toMs),
    ]);

  it.each<[string, string, string, string[][]]>([
    [
      'a summer day splits at the 22:00Z open and skips the 16:00 CT halt hour',
      '2026-07-14T00:00:00Z',
      '2026-07-15T00:00:00Z',
      [
        ['2026-07-14', '2026-07-14T00:00Z', '2026-07-14T21:00Z'],
        ['2026-07-15', '2026-07-14T22:00Z', '2026-07-15T00:00Z'],
      ],
    ],
    [
      'a winter day splits at the 23:00Z open and skips the 22:00Z halt hour',
      '2026-11-12T00:00:00Z',
      '2026-11-13T00:00:00Z',
      [
        ['2026-11-12', '2026-11-12T00:00Z', '2026-11-12T22:00Z'],
        ['2026-11-13', '2026-11-12T23:00Z', '2026-11-13T00:00Z'],
      ],
    ],
    [
      'the Sunday before the fall-back opens at 22:00Z (CDT)',
      '2026-10-25T00:00:00Z',
      '2026-10-26T00:00:00Z',
      [['2026-10-26', '2026-10-25T22:00Z', '2026-10-26T00:00Z']],
    ],
    [
      'the fall-back Sunday opens at 23:00Z (CST)',
      '2026-11-01T00:00:00Z',
      '2026-11-02T00:00:00Z',
      [['2026-11-02', '2026-11-01T23:00Z', '2026-11-02T00:00Z']],
    ],
    [
      'the Sunday before the spring-forward opens at 23:00Z (CST)',
      '2027-03-07T00:00:00Z',
      '2027-03-08T00:00:00Z',
      [['2027-03-08', '2027-03-07T23:00Z', '2027-03-08T00:00Z']],
    ],
    [
      'the spring-forward Sunday opens at 22:00Z (CDT)',
      '2027-03-14T00:00:00Z',
      '2027-03-15T00:00:00Z',
      [['2027-03-15', '2027-03-14T22:00Z', '2027-03-15T00:00Z']],
    ],
    [
      'a Friday ends at 16:00 CT: the 17:00 CT hour that would be Saturday’s is closed',
      '2026-07-17T00:00:00Z',
      '2026-07-18T00:00:00Z',
      [['2026-07-17', '2026-07-17T00:00Z', '2026-07-17T21:00Z']],
    ],
    [
      'a Saturday has no open minute',
      '2026-07-18T00:00:00Z',
      '2026-07-19T00:00:00Z',
      [],
    ],
    [
      'a window inside one session keeps its own bounds',
      '2026-07-14T14:20:00Z',
      '2026-07-14T14:41:00Z',
      [['2026-07-14', '2026-07-14T14:20Z', '2026-07-14T14:41Z']],
    ],
    [
      'a late window after the open belongs to the next date alone',
      '2026-07-14T22:30:00Z',
      '2026-07-14T22:31:00Z',
      [['2026-07-15', '2026-07-14T22:30Z', '2026-07-14T22:31Z']],
    ],
    [
      'a window that starts in the halt hour is clipped to the open',
      '2026-07-14T21:30:00Z',
      '2026-07-14T22:10:00Z',
      [['2026-07-15', '2026-07-14T22:00Z', '2026-07-14T22:10Z']],
    ],
    ['an empty window', '2026-07-14T14:00:00Z', '2026-07-14T14:00:00Z', []],
  ])('%s', (_label, from, to, expected) => {
    expect(spans(from, to)).toEqual(expected);
  });
});

// ── sessionPieces ─────────────────────────────────────────

describe('sessionPieces', () => {
  // 2026-08-04 14:00Z to 2026-08-06 14:00Z: three trade dates, 08-04 to 08-06.
  const from = Date.parse('2026-08-04T14:00:00Z');
  const to = Date.parse('2026-08-06T14:00:00Z');
  const reader = (contracts: Record<string, string>): ScheduleReader =>
    vi.fn(async () => new Map(Object.entries(contracts)));
  const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

  it('one contract on every date is one piece over the whole window', async () => {
    const { pieces, undecided } = await sessionPieces(
      reader({
        '2026-08-04': 'ESU6',
        '2026-08-05': 'ESU6',
        '2026-08-06': 'ESU6',
      }),
      'ES',
      from,
      to,
    );

    expect(undecided).toEqual([]);
    expect(
      pieces.map((p) => [p.contract, minute(p.fromMs), minute(p.toMs)]),
    ).toEqual([['ESU6', '2026-08-04T14:00Z', '2026-08-06T14:00Z']]);
  });

  it('a roll makes a piece per contract', async () => {
    const { pieces } = await sessionPieces(
      reader({
        '2026-08-04': 'ESU6',
        '2026-08-05': 'ESU6',
        '2026-08-06': 'ESZ6',
      }),
      'ES',
      from,
      to,
    );

    expect(
      pieces.map((p) => [p.contract, minute(p.fromMs), minute(p.toMs)]),
    ).toEqual([
      ['ESU6', '2026-08-04T14:00Z', '2026-08-05T21:00Z'],
      ['ESZ6', '2026-08-05T22:00Z', '2026-08-06T14:00Z'],
    ]);
  });

  it('a date without a contract is listed undecided, and a piece never spans it', async () => {
    const { pieces, undecided } = await sessionPieces(
      reader({ '2026-08-04': 'ESU6', '2026-08-06': 'ESU6' }),
      'ES',
      from,
      to,
    );

    expect(undecided).toEqual(['2026-08-05']);
    expect(
      pieces.map((p) => [p.contract, minute(p.fromMs), minute(p.toMs)]),
    ).toEqual([
      ['ESU6', '2026-08-04T14:00Z', '2026-08-04T21:00Z'],
      ['ESU6', '2026-08-05T22:00Z', '2026-08-06T14:00Z'],
    ]);
  });

  it('a window with no Globex-open minute reads no schedule', async () => {
    const schedules = reader({});

    const result = await sessionPieces(
      schedules,
      'ES',
      Date.parse('2026-08-08T00:00:00Z'), // a Saturday
      Date.parse('2026-08-09T00:00:00Z'),
    );

    expect(result).toEqual({ pieces: [], undecided: [] });
    expect(schedules).not.toHaveBeenCalled();
  });
});

// ── runBackfill ───────────────────────────────────────────

describe('runBackfill', () => {
  it('pages the scheduled contract over the NULL minutes’ span and writes its flow with the conditional UPDATE', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-08-04T14:00:00Z', 4),
        nullRow('ES', '2026-08-04T14:01:00Z', 6),
      ])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeTrades(ES_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
      apiKey: 'uw-key',
    });

    expect(code).toBe(0);
    // Only the scheduled contract, from the last NULL minute back to the
    // first (not to 00:00 UTC, and no back month).
    expect(tradesContracts()).toEqual(['ESU6']);
    expect(olderThan(0)).toBe('2026-08-04T14:02:00.000000Z');
    expect(mockSchedule).toHaveBeenCalledWith('ES', ['2026-08-04'], 'script');

    const detect = (mockSql.mock.calls[0]![0] as readonly string[]).join('?');
    expect(detect).toContain('buy_volume IS NULL');
    expect(mockSql.mock.calls[0]!.slice(1)).toContain(
      '2026-08-04T00:00:00.000Z',
    );

    const [update] = updateCalls();
    expect((update![0] as readonly string[]).join('?')).toContain(
      'AND b.buy_volume IS NULL',
    );
    expect(update!.slice(1)).toContain('ES');
    expect(update!.slice(1)).toContainEqual([
      '2026-08-04T14:00:00.000Z',
      '2026-08-04T14:01:00.000Z',
    ]);
    expect(update!.slice(1)).toContainEqual([0, 6]); // buy volume
    expect(update!.slice(1)).toContainEqual([4, 0]); // sell volume
    expect(logs.join('\n')).toMatch(/ES 2026-08-04 .*repaired 2/);
    expect(logs.join('\n')).toMatch(/pages 1 /);
    expect(logs.join('\n')).not.toContain('uw-key');
  });

  describe('session pieces', () => {
    const tail = (id: number, at: string) => print(id, at, 1, 'buy');

    it('splits the UTC day at the session open: each piece pages only its own session’s contract, over its own window', async () => {
      routeFrontMonth({ '2026-08-05': 'ESZ6' });
      mockSql
        .mockResolvedValueOnce([
          nullRow('ES', '2026-08-04T14:00:00Z', 4),
          nullRow('ES', '2026-08-04T22:30:00Z', 3),
        ])
        .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
      routeTrades({
        ESU6: [
          [
            print(2, '2026-08-04T14:00:20.000000Z', 4, 'buy'),
            tail(1, '2026-08-04T13:59:00.000000Z'),
          ],
        ],
        ESZ6: [
          [
            print(4, '2026-08-04T22:30:10.000000Z', 3, 'sell'),
            tail(3, '2026-08-04T21:59:00.000000Z'),
          ],
        ],
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
        apiKey: 'k',
      });

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith(
        'ES',
        ['2026-08-04', '2026-08-05'],
        'script',
      );
      // ESU6 pages the first session up to the 16:00 CT halt, ESZ6 only the
      // second session: neither is paged over the other's window.
      expect(tradesContracts()).toEqual(['ESU6', 'ESZ6']);
      expect(olderThan(0)).toBe('2026-08-04T21:00:00.000000Z');
      expect(olderThan(1)).toBe('2026-08-04T22:31:00.000000Z');

      const [update] = updateCalls();
      expect(update!.slice(1)).toContainEqual([
        '2026-08-04T14:00:00.000Z',
        '2026-08-04T22:30:00.000Z',
      ]);
      expect(update!.slice(1)).toContainEqual([4, 0]); // buy volume
      expect(update!.slice(1)).toContainEqual([0, 3]); // sell volume
      expect(logs.join('\n')).toMatch(/pages 2 .*front ESU6\/ESZ6/);
    });

    it('a late minute pages only its own piece, not the day from 00:00', async () => {
      routeFrontMonth({ '2026-08-05': 'ESZ6' });
      mockSql
        .mockResolvedValueOnce([nullRow('ES', '2026-08-04T22:30:00Z', 3)])
        .mockResolvedValueOnce([{ ts: 'a' }]);
      routeTrades({
        ESZ6: [
          [
            print(2, '2026-08-04T22:30:10.000000Z', 3, 'sell'),
            tail(1, '2026-08-04T21:59:00.000000Z'),
          ],
        ],
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
        apiKey: 'k',
      });

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith('ES', ['2026-08-05'], 'script');
      expect(mockStored).toHaveBeenCalledWith('ES', '2026-08-05', '2026-08-05');
      expect(tradesContracts()).toEqual(['ESZ6']);
      expect(olderThan(0)).toBe('2026-08-04T22:31:00.000000Z');
      expect(logs.join('\n')).toMatch(/ES 2026-08-04 .*repaired 1 .*pages 1 /);
    });

    it('splits at 23:00Z in winter and pages nothing in the 22:00Z halt hour', async () => {
      vi.setSystemTime(new Date('2026-11-14T03:00:00Z'));
      routeFrontMonth({ '2026-11-12': 'ESZ6', '2026-11-13': 'ESH7' });
      mockSql
        .mockResolvedValueOnce([
          nullRow('ES', '2026-11-12T15:00:00Z', 2),
          nullRow('ES', '2026-11-12T23:30:00Z', 5),
        ])
        .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
      // ESH7's page ends with a print at 22:30Z: before the 23:00Z open, so
      // it completes the piece. A split at the summer 22:00Z would not.
      routeTrades({
        ESZ6: [
          [
            print(2, '2026-11-12T15:00:10.000000Z', 2, 'buy'),
            tail(1, '2026-11-12T14:59:00.000000Z'),
          ],
        ],
        ESH7: [
          [
            print(4, '2026-11-12T23:30:10.000000Z', 5, 'sell'),
            tail(3, '2026-11-12T22:30:00.000000Z'),
          ],
        ],
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-11-12'], roots: ['ES'] }),
        apiKey: 'k',
      });

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith(
        'ES',
        ['2026-11-12', '2026-11-13'],
        'script',
      );
      expect(tradesContracts()).toEqual(['ESZ6', 'ESH7']);
      expect(olderThan(0)).toBe('2026-11-12T22:00:00.000000Z');
      expect(olderThan(1)).toBe('2026-11-12T23:31:00.000000Z');
      expect(logs.join('\n')).toMatch(/ES 2026-11-12 .*repaired 2 .*pages 2 /);
    });

    it('both sessions on one contract are one piece, paged once over the whole span', async () => {
      mockSql
        .mockResolvedValueOnce([
          nullRow('ES', '2026-08-04T14:00:00Z', 4),
          nullRow('ES', '2026-08-04T22:30:00Z', 3),
        ])
        .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
      routeTrades({
        ESU6: [
          [
            print(3, '2026-08-04T22:30:10.000000Z', 3, 'sell'),
            print(2, '2026-08-04T14:00:20.000000Z', 4, 'buy'),
            tail(1, '2026-08-04T13:59:00.000000Z'),
          ],
        ],
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
        apiKey: 'k',
      });

      expect(code).toBe(0);
      expect(tradesContracts()).toEqual(['ESU6']);
      expect(olderThan(0)).toBe('2026-08-04T22:31:00.000000Z');
      expect(logs.join('\n')).toMatch(/repaired 2 .*pages 1 /);
    });
  });

  describe('the front-month table', () => {
    const runOne = () =>
      runBackfill({
        ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
        apiKey: 'uw-key',
      });

    it('every date stored: no volume refresh, the schedule is read as stored', async () => {
      mockSql
        .mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)])
        .mockResolvedValueOnce([{ ts: 'a' }]);
      routeTrades(ES_PAGES);

      const code = await runOne();

      expect(code).toBe(0);
      expect(mockStored).toHaveBeenCalledWith('ES', '2026-08-04', '2026-08-04');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    });

    it('an undecided date: refreshes the root’s volumes over 1m, then asks for the schedule', async () => {
      routeFrontMonth({}, ['2026-08-04']);
      mockSql
        .mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)])
        .mockResolvedValueOnce([{ ts: 'a' }]);
      routeTrades(ES_PAGES);

      const code = await runOne();

      expect(code).toBe(0);
      expect(mockRefresh).toHaveBeenCalledWith('uw-key', 'ES', '1m');
      expect(mockRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
        mockSchedule.mock.invocationCallOrder[0]!,
      );
      // A real run decides the date; nothing is left to report.
      expect(logs.join('\n')).not.toMatch(/undecided/);
    });

    it('refreshes each root once per run, however many of its dates are undecided', async () => {
      routeFrontMonth({}, ['2026-08-11', '2026-08-12']);
      routeNullBars({
        '2026-08-11': [
          nullRow('ES', '2026-08-11T14:00:00Z', 4),
          nullRow('NQ', '2026-08-11T14:00:00Z', 4),
        ],
        '2026-08-12': [
          nullRow('ES', '2026-08-12T14:00:00Z', 4),
          nullRow('NQ', '2026-08-12T14:00:00Z', 4),
        ],
      });
      mockUwFetch.mockResolvedValue([
        print(1, '2026-08-11T13:00:00.000000Z', 1, 'buy'),
      ]);

      const code = await runBackfill({
        ...opts({ dates: ['2026-08-11', '2026-08-12'], roots: ['ES', 'NQ'] }),
        apiKey: 'uw-key',
      });

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledTimes(4);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledWith('uw-key', 'ES', '1m');
      expect(mockRefresh).toHaveBeenCalledWith('uw-key', 'NQ', '1m');
    });

    it('a failed refresh is not remembered: the root’s next root-day tries again', async () => {
      routeFrontMonth({}, ['2026-08-04', '2026-08-05']);
      routeNullBars({
        '2026-08-04': [nullRow('ES', '2026-08-04T14:00:00Z', 4)],
        '2026-08-05': [nullRow('ES', '2026-08-05T14:00:00Z', 4)],
      });
      mockRefresh
        .mockRejectedValueOnce(new Error('UW API 503: unavailable'))
        .mockResolvedValueOnce({ contracts: [], offered: 0, inserted: 0 });
      routeTrades({
        ESU6: [
          [
            print(2, '2026-08-05T14:00:30.000000Z', 4, 'buy'),
            print(1, '2026-08-05T13:00:00.000000Z', 1, 'buy'),
          ],
        ],
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-08-04', '2026-08-05'], roots: ['ES'] }),
        apiKey: 'k',
      });

      expect(code).toBe(1);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      expect(logs.join('\n')).toMatch(/ES 2026-08-04 FAILED: UW API 503/);
      expect(logs.join('\n')).toMatch(/ES 2026-08-05 .*repaired 1/);
    });

    it('a failed volume refresh fails that root-day by name, decides nothing and pages nothing', async () => {
      routeFrontMonth({}, ['2026-08-04']);
      mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);
      mockRefresh.mockRejectedValue(
        new Error(
          'stale daily candles for ES: the newest ESU6 candle is 07-10',
        ),
      );

      const code = await runOne();

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(
        /ES 2026-08-04 FAILED: stale daily candles for ES/,
      );
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(updateCalls()).toHaveLength(0);
    });

    it.each<[string, () => void]>([
      [
        'read of the stored decisions',
        () => mockStored.mockRejectedValue(new Error('connection terminated')),
      ],
      [
        'schedule read',
        () =>
          mockSchedule.mockRejectedValue(new Error('connection terminated')),
      ],
    ])(
      'a rejected %s fails that root-day by name before any UW call',
      async (_label, reject) => {
        mockSql.mockResolvedValueOnce([
          nullRow('ES', '2026-08-04T14:00:00Z', 4),
        ]);
        reject();

        const code = await runOne();

        expect(code).toBe(1);
        expect(logs.join('\n')).toMatch(
          /ES 2026-08-04 FAILED: connection terminated/,
        );
        expect(mockUwFetch).not.toHaveBeenCalled();
        expect(updateCalls()).toHaveLength(0);
      },
    );

    it('a schedule with no contract for a date it was asked about fails the root-day', async () => {
      mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);
      mockSchedule.mockResolvedValue({
        contractFor: () => undefined,
        contracts: [],
      });

      const code = await runOne();

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(
        /ES 2026-08-04 FAILED: ES: no front month for 2026-08-04/,
      );
      expect(mockUwFetch).not.toHaveBeenCalled();
    });

    it('a root-day with no NULL-flow bars reads no schedule and refreshes nothing', async () => {
      routeFrontMonth({}, ['2026-08-04']);

      const code = await runOne();

      expect(code).toBe(0);
      expect(mockStored).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('before the stored front month (it starts 2026-07-28)', () => {
    const runDay = (date: string, dryRun = false) =>
      runBackfill({
        ...opts({ dates: [date], roots: ['ES'], dryRun }),
        apiKey: 'uw-key',
      });

    it.each([false, true])(
      'refuses a trade date before it by name, with no read, refresh or decision (dry run: %s)',
      async (dryRun) => {
        mockSql.mockResolvedValueOnce([
          nullRow('ES', '2026-07-27T14:00:00Z', 4),
        ]);

        const code = await runDay('2026-07-27', dryRun);

        expect(code).toBe(1);
        expect(logs.join('\n')).toMatch(
          /ES 2026-07-27 FAILED: ES: trade date 2026-07-27 is before the stored front month, which starts 2026-07-28/,
        );
        expect(mockStored).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(mockSchedule).not.toHaveBeenCalled();
        expect(mockUwFetch).not.toHaveBeenCalled();
        expect(updateCalls()).toHaveLength(0);
      },
    );

    it('an explicit range before it fails every root by name, none dropped', async () => {
      const roots = ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'] as const;
      routeNullBars({
        '2026-06-29': roots.map((r) => nullRow(r, '2026-06-29T14:00:00Z', 4)),
        '2026-07-21': roots.map((r) => nullRow(r, '2026-07-21T14:00:00Z', 4)),
      });

      const code = await runBackfill({
        ...opts({ dates: ['2026-06-29', '2026-07-21'] }),
        apiKey: 'uw-key',
      });

      expect(code).toBe(1);
      const failed = logs.filter((l) =>
        /FAILED: .*is before the stored front month/.test(l),
      );
      expect(failed).toHaveLength(12);
      for (const root of roots) {
        for (const date of ['2026-06-29', '2026-07-21']) {
          expect(
            failed.some((l) =>
              l.includes(
                `${root} ${date} FAILED: ${root}: trade date ${date} is before`,
              ),
            ),
          ).toBe(true);
        }
      }
      expect(mockStored).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
    });

    it('runs 2026-07-28', async () => {
      mockSql
        .mockResolvedValueOnce([nullRow('ES', '2026-07-28T14:00:00Z', 4)])
        .mockResolvedValueOnce([{ ts: 'a' }]);
      routeTrades({
        ESU6: [
          [
            print(2, '2026-07-28T14:00:20.000000Z', 4, 'buy'),
            print(1, '2026-07-28T13:00:00.000000Z', 1, 'buy'),
          ],
        ],
      });

      const code = await runDay('2026-07-28');

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith('ES', ['2026-07-28'], 'script');
      expect(logs.join('\n')).toMatch(/ES 2026-07-28 .*repaired 1/);
    });

    it('goes by the minute’s trade date, not the UTC date: a 2026-07-27 minute after the open is 2026-07-28’s', async () => {
      mockSql
        .mockResolvedValueOnce([nullRow('ES', '2026-07-27T22:30:00Z', 3)])
        .mockResolvedValueOnce([{ ts: 'a' }]);
      routeTrades({
        ESU6: [
          [
            print(2, '2026-07-27T22:30:10.000000Z', 3, 'sell'),
            print(1, '2026-07-27T21:59:00.000000Z', 1, 'sell'),
          ],
        ],
      });

      const code = await runDay('2026-07-27');

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith('ES', ['2026-07-28'], 'script');
      expect(logs.join('\n')).toMatch(/ES 2026-07-27 .*repaired 1/);
    });

    it('a root-day that reaches back before it is refused whole: nothing of 2026-07-28 is paged either', async () => {
      mockSql.mockResolvedValueOnce([
        nullRow('ES', '2026-07-27T14:00:00Z', 4),
        nullRow('ES', '2026-07-27T22:30:00Z', 3),
      ]);

      const code = await runDay('2026-07-27');

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(
        /ES 2026-07-27 FAILED: ES: trade date 2026-07-27 is before/,
      );
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('--dry-run reads the stored decisions only', () => {
    const dry = (dates: string[], roots: BackfillOptions['roots'] = ['ES']) =>
      runBackfill({
        ...opts({ dates, roots, dryRun: true }),
        apiKey: 'uw-key',
      });

    it('an undecided date: no refresh, no decision, no paging, and the date is reported rather than counted as outside 2%', async () => {
      routeFrontMonth({}, ['2026-08-04']);
      mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);

      const code = await dry(['2026-08-04']);

      expect(code).toBe(0);
      expect(mockStored).toHaveBeenCalledWith('ES', '2026-08-04', '2026-08-04');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(updateCalls()).toHaveLength(0);
      const out = logs.join('\n');
      expect(out).toMatch(
        /ES 2026-08-04 {2}null 1 {2}would write 0 {2}skipped 0 .*undecided 2026-08-04/,
      );
      expect(out).toMatch(
        /ES {2}undecided trade dates 1: 2026-08-04 \(skipped; a real run decides them\)/,
      );
    });

    it('the stored dates of the same root-day still page; only the undecided date is skipped', async () => {
      routeFrontMonth({}, ['2026-08-05']);
      mockSql.mockResolvedValueOnce([
        nullRow('ES', '2026-08-04T14:00:00Z', 4),
        nullRow('ES', '2026-08-04T22:30:00Z', 3), // trade date 2026-08-05
      ]);
      routeTrades(ES_PAGES);

      const code = await dry(['2026-08-04']);

      expect(code).toBe(0);
      // 08-04's session pages up to the halt hour; 08-05's piece is not paged.
      expect(tradesContracts()).toEqual(['ESU6']);
      expect(olderThan(0)).toBe('2026-08-04T21:00:00.000000Z');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      const out = logs.join('\n');
      expect(out).toMatch(/ES 2026-08-04 .*would write 1 {2}skipped 0 /);
      expect(out).toMatch(/undecided trade dates 1: 2026-08-05/);
    });

    it('logs each root’s undecided dates once for the run, not once per root-day', async () => {
      routeFrontMonth({}, ['2026-08-04', '2026-08-05']);
      routeNullBars({
        '2026-08-04': [
          nullRow('ES', '2026-08-04T14:00:00Z', 4),
          nullRow('NQ', '2026-08-04T14:00:00Z', 4),
        ],
        '2026-08-05': [nullRow('ES', '2026-08-05T14:00:00Z', 4)],
      });

      const code = await dry(['2026-08-04', '2026-08-05'], ['ES', 'NQ']);

      expect(code).toBe(0);
      const summary = logs.filter((l) => /undecided trade dates/.test(l));
      expect(summary).toEqual([
        '  ES  undecided trade dates 2: 2026-08-04, 2026-08-05 (skipped; a real run decides them)',
        '  NQ  undecided trade dates 1: 2026-08-04 (skipped; a real run decides them)',
      ]);
    });

    it('all dates stored: nothing is reported undecided', async () => {
      mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);
      routeTrades(ES_PAGES);

      await dry(['2026-08-04']);

      expect(logs.join('\n')).not.toMatch(/undecided/);
    });

    it('a rejected read of the stored decisions fails the root-day by name', async () => {
      mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);
      mockStored.mockRejectedValue(new Error('connection terminated'));

      const code = await dry(['2026-08-04']);

      expect(code).toBe(1);
      expect(logs.join('\n')).toMatch(
        /ES 2026-08-04 FAILED: connection terminated/,
      );
      expect(mockUwFetch).not.toHaveBeenCalled();
    });
  });

  it('--dry-run reads and matches but never writes', async () => {
    mockSql.mockResolvedValueOnce([
      nullRow('ES', '2026-08-04T14:00:00Z', 4),
      nullRow('ES', '2026-08-04T14:01:00Z', 6),
    ]);
    routeTrades(ES_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-08-04'], roots: ['ES'], dryRun: true }),
      apiKey: 'k',
    });

    expect(code).toBe(0);
    expect(updateCalls()).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/dry run/i);
    expect(logs.join('\n')).toMatch(/ES 2026-08-04 .*would write 2/);
  });

  it('leaves a minute NULL when REST volume misses the Databento-era bar by more than 2%', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-08-04T14:00:00Z', 4),
        nullRow('ES', '2026-08-04T14:01:00Z', 60), // REST has 6
      ])
      .mockResolvedValueOnce([{ ts: 'a' }]);
    routeTrades(ES_PAGES);

    await runBackfill({
      ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
      apiKey: 'k',
    });

    const [update] = updateCalls();
    expect(update!.slice(1)).toContainEqual(['2026-08-04T14:00:00.000Z']);
    expect(logs.join('\n')).toMatch(/ES 2026-08-04 .*skipped 1/);
  });

  it('a root-day with no NULL-flow bars makes no UW calls (resumable)', async () => {
    const code = await runBackfill({
      ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
      apiKey: 'k',
    });

    expect(code).toBe(0);
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('refuses to start during market hours (UW concurrency is shared with the crons)', async () => {
    mockIsMarketHours.mockReturnValue(true);

    const code = await runBackfill({ ...opts(), apiKey: 'k' });

    expect(code).toBe(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('stops before the next date once the page budget is spent, and says where to resume', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-08-04T14:00:00Z', 4),
        nullRow('ES', '2026-08-04T14:01:00Z', 6),
      ])
      .mockResolvedValueOnce([{}, {}]);
    routeTrades(ES_PAGES);

    const code = await runBackfill({
      ...opts({
        dates: ['2026-08-04', '2026-08-05'],
        roots: ['ES'],
        maxPages: 1,
      }),
      apiKey: 'k',
    });

    // A run that stopped short is not a success (the bar script's rule).
    expect(code).toBe(1);
    // 08-04 used 1 page; 08-05 never starts.
    expect(mockSql).toHaveBeenCalledTimes(2);
    const out = logs.join('\n');
    expect(stopLine()).toMatch(
      /Page budget spent \(1 of 1\): stopping before 2026-08-05\./,
    );
    expect(out).toMatch(
      /Incomplete: stopped before 2026-08-05\. Resume with 2026-08-05 --roots ES --max-pages 1$/m,
    );
    expect(out).toMatch(
      /Not reached: 2026-08-05 → 2026-08-05, roots ES \(1 root-days\)$/m,
    );
  });

  it('stops before the next date when market hours begin mid-run: exits 1 and names what was not reached', async () => {
    mockIsMarketHours
      .mockReturnValueOnce(false) // the start guard
      .mockReturnValueOnce(false) // before 08-04
      .mockReturnValue(true); // before 08-05
    routeNullBars({ '2026-08-04': [nullRow('ES', '2026-08-04T14:00:00Z', 4)] });
    routeTrades(ES_PAGES);

    const code = await runBackfill({
      ...opts({
        dates: ['2026-08-04', '2026-08-05', '2026-08-06'],
        roots: ['ES', 'NQ'],
      }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(stopLine()).toMatch(
      /Market hours began: stopping before 2026-08-05\./,
    );
    expect(out).toMatch(
      /Incomplete: stopped before 2026-08-05\. Resume with 2026-08-05 2026-08-06 --roots ES,NQ --max-pages 20000$/m,
    );
    expect(out).toMatch(
      /Not reached: 2026-08-05 → 2026-08-06, roots ES,NQ \(4 root-days\)$/m,
    );
    expect(out).not.toMatch(/FAILED/);
  });

  it.each<[string, Partial<BackfillOptions>, boolean]>([
    ['the page budget', { maxPages: 1 }, false],
    ['market hours', {}, true],
  ])(
    'the stop-time line for %s carries no resume arguments: an explicit-date run resumes from the Incomplete line',
    async (_label, over, marketHours) => {
      if (marketHours) {
        mockIsMarketHours
          .mockReturnValueOnce(false) // the start guard
          .mockReturnValueOnce(false) // before 08-04
          .mockReturnValue(true); // before 08-05
      }
      routeNullBars({
        '2026-08-04': [nullRow('ES', '2026-08-04T14:00:00Z', 4)],
      });
      routeTrades(ES_PAGES);

      const code = await runBackfill({
        ...opts({
          dates: ['2026-08-04', '2026-08-05'],
          roots: ['ES'],
          ...over,
        }),
        apiKey: 'k',
      });

      expect(code).toBe(1);
      // Dates and --from are exclusive, so a --from here would be a command
      // that fails; the arguments are on the Incomplete line only.
      expect(stopLine()).toMatch(/stopping before 2026-08-05\./);
      expect(stopLine()).not.toContain('--from');
      expect(stopLine()).toMatch(/Incomplete line/);
      const resume = logs.filter((l) => l.startsWith('Incomplete:'));
      expect(resume).toHaveLength(1);
      expect(resume[0]).toMatch(/Resume with 2026-08-05 --roots ES /);
      expect(resume[0]).not.toContain('--from');
    },
  );

  it('a range run that stops early resumes with --from and the same --to, and keeps --dry-run', async () => {
    mockIsMarketHours
      .mockReturnValueOnce(false) // the start guard
      .mockReturnValueOnce(false) // before 08-04
      .mockReturnValue(true); // before 08-05

    const code = await runBackfill({
      ...opts({
        from: '2026-08-04',
        to: '2026-08-06',
        roots: ['ES'],
        dryRun: true,
      }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(
      /Incomplete: stopped before 2026-08-05\. Resume with --from 2026-08-05 --to 2026-08-06 --roots ES --max-pages 20000 --dry-run$/m,
    );
  });

  it('a run that reaches its last date is not marked incomplete', async () => {
    const code = await runBackfill({
      ...opts({ dates: ['2026-08-04', '2026-08-05'], roots: ['ES'] }),
      apiKey: 'k',
    });

    expect(code).toBe(0);
    expect(logs.join('\n')).not.toMatch(/Incomplete|Not reached/);
  });

  it('a failed root-day (UW 5xx) is reported and fails the exit code; other roots still run', async () => {
    mockSql.mockImplementation(async (strings: readonly string[], ...v) => {
      const text = strings.join('?');
      if (text.includes('UPDATE futures_bars')) return [{}];
      const symbols = v[0] as string[];
      return symbols[0] === 'NQ'
        ? [nullRow('NQ', '2026-08-11T14:00:00Z', 2)]
        : [nullRow('ES', '2026-08-11T14:00:00Z', 4)];
    });
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path.startsWith('/futures/ESU6/')) {
        throw new Error('UW API 502: bad gateway');
      }
      if (path.startsWith('/futures/NQU6/')) {
        return [
          print(2, '2026-08-11T14:00:30.000000Z', 2, 'buy'),
          print(1, '2026-08-10T23:00:00.000000Z', 1, 'buy'),
        ];
      }
      return [];
    });

    const code = await runBackfill({
      ...opts({ dates: ['2026-08-11'], roots: ['ES', 'NQ'] }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/ES 2026-08-11 FAILED: UW API 502/);
    expect(updateCalls().some((c) => c.slice(1).includes('NQ'))).toBe(true);
  });

  it('a rejected UPDATE fails that root-day and the exit code', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-08-04T14:00:00Z', 4),
        nullRow('ES', '2026-08-04T14:01:00Z', 6),
      ])
      .mockRejectedValueOnce(new Error('connection terminated'));
    routeTrades(ES_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-08-04'], roots: ['ES'] }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(
      /ES 2026-08-04 FAILED: connection terminated/,
    );
  });

  it('a failed root-day’s pages still count against the page budget', async () => {
    mockSql.mockResolvedValueOnce([nullRow('ES', '2026-08-04T14:00:00Z', 4)]);
    let call = 0;
    mockUwFetch.mockImplementation(async () => {
      call += 1;
      // Page 1 doesn't reach the first NULL minute; page 2 fails.
      if (call === 1) {
        return [print(1, '2026-08-04T14:00:30.000000Z', 1, 'buy')];
      }
      throw new Error('UW API 502: bad gateway');
    });

    const code = await runBackfill({
      ...opts({
        dates: ['2026-08-04', '2026-08-05'],
        roots: ['ES'],
        maxPages: 2,
      }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    // Both requests counted: 08-05 never starts.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const out = logs.join('\n');
    expect(out).toMatch(/ES 2026-08-04 FAILED.*UW API 502/);
    expect(stopLine()).toMatch(
      /Page budget spent \(2 of 2\): stopping before 2026-08-05\./,
    );
    // A failure and an early stop together: both are listed.
    expect(out).toMatch(/Incomplete: stopped before 2026-08-05\./);
    expect(out).toMatch(/2 pages/);
  });
});
