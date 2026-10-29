// @vitest-environment node

/**
 * Tests for the one-time futures order-flow backfill (spec Phase 6b).
 * Module-boundary mocks only: the DB (getDb / withDbRetry), the UW fetch
 * (uwFetch / withRetry), and the market-hours clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockUwFetch, mockIsMarketHours } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockUwFetch: vi.fn(),
  mockIsMarketHours: vi.fn(() => false),
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
vi.mock('../../api/_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../api/_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: { uwRateLimit: vi.fn(), uwBudget: vi.fn() },
}));

import {
  contractCandidates,
  parseArgs,
  planDates,
  runBackfill,
  type BackfillOptions,
} from './futures-flow-backfill.js';

// ── Fixtures ──────────────────────────────────────────────

const NOW = '2026-07-23T23:00:00Z'; // a Thursday evening, after the close

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

function tradesContracts(): string[] {
  return mockUwFetch.mock.calls.map(
    (c) => /^\/futures\/([^/]+)\/trades/.exec(c[1] as string)![1]!,
  );
}

function updateCalls(): unknown[][] {
  return mockSql.mock.calls.filter((c) =>
    (c[0] as readonly string[]).join('?').includes('UPDATE futures_bars'),
  );
}

/** ESU6 leads 07-14; ESZ6 trades a little; ESH7 has no history. */
const ES_0714_PAGES = {
  ESU6: [
    [
      print(3, '2026-07-14T14:01:10.000000Z', 6, 'buy'),
      print(2, '2026-07-14T14:00:20.000000Z', 4, 'sell'),
      print(1, '2026-07-13T23:59:59.000000Z', 9, 'buy'),
    ],
  ],
  ESZ6: [
    [
      print(11, '2026-07-14T09:00:00.000000Z', 1, 'buy'),
      print(10, '2026-07-13T20:00:00.000000Z', 1, 'buy'),
    ],
  ],
  ESH7: [[]],
};

let logs: string[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockIsMarketHours.mockReturnValue(false);
  mockSql.mockResolvedValue([]);
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
  it('defaults to each root’s UW history start (ES 06-30, the rest 07-21) through today, oldest first', () => {
    const plan = planDates(opts(), '2026-07-22');

    expect(plan[0]).toEqual({ date: '2026-06-30', roots: ['ES'] });
    expect(plan.find((d) => d.date === '2026-07-20')?.roots).toEqual(['ES']);
    expect(plan.find((d) => d.date === '2026-07-21')?.roots).toEqual([
      'ES',
      'NQ',
      'RTY',
      'CL',
      'GC',
      'ZN',
    ]);
    expect(plan.at(-1)?.date).toBe('2026-07-22');
    expect(plan).toHaveLength(23);
  });

  it('explicit dates: deduped, oldest first, roots limited to their history, future dates dropped', () => {
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
      { date: '2026-07-01', roots: ['ES'] },
      { date: '2026-07-21', roots: ['ES', 'NQ'] },
    ]);
  });

  it('a --from/--to range clipped to each root’s history', () => {
    const plan = planDates(
      opts({ from: '2026-07-20', to: '2026-07-21', roots: ['NQ', 'ES'] }),
      '2026-07-22',
    );

    expect(plan).toEqual([
      { date: '2026-07-20', roots: ['ES'] },
      { date: '2026-07-21', roots: ['NQ', 'ES'] },
    ]);
  });
});

// ── contractCandidates ────────────────────────────────────

describe('contractCandidates', () => {
  it.each<[string, Parameters<typeof contractCandidates>, string[]]>([
    ['ES in roll week', ['ES', '2026-09-15'], ['ESU6', 'ESZ6', 'ESH7']],
    [
      'ES after the December expiry',
      ['ES', '2026-12-20'],
      ['ESZ6', 'ESH7', 'ESM7'],
    ],
    ['RTY in July', ['RTY', '2026-07-21'], ['RTYU6', 'RTYZ6', 'RTYH7']],
    [
      'ZN at its end-of-month roll',
      ['ZN', '2026-08-28'],
      ['ZNU6', 'ZNZ6', 'ZNH7'],
    ],
    ['CL lists every month', ['CL', '2026-10-25'], ['CLV6', 'CLX6', 'CLZ6']],
    ['CL across the year end', ['CL', '2026-11-30'], ['CLX6', 'CLZ6', 'CLF7']],
    [
      'GC trades its even months',
      ['GC', '2026-07-25'],
      ['GCQ6', 'GCV6', 'GCZ6'],
    ],
    ['GC across the year end', ['GC', '2026-12-01'], ['GCZ6', 'GCG7', 'GCJ7']],
  ])('%s', (_label, args, expected) => {
    expect(contractCandidates(...args)).toEqual(expected);
  });
});

// ── runBackfill ───────────────────────────────────────────

describe('runBackfill', () => {
  it('replays the roll over each candidate’s REST minutes and writes the leader’s flow with the conditional UPDATE', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-07-14T14:00:00Z', 4),
        nullRow('ES', '2026-07-14T14:01:00Z', 6),
      ])
      .mockResolvedValueOnce([{ ts: 'a' }, { ts: 'b' }]);
    routeTrades(ES_0714_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-07-14'], roots: ['ES'] }),
      apiKey: 'uw-key',
    });

    expect(code).toBe(0);
    // Every candidate is paged from the last NULL minute back to 00:00 UTC.
    expect(tradesContracts()).toEqual(['ESU6', 'ESZ6', 'ESH7']);
    const firstPath = mockUwFetch.mock.calls[0]![1] as string;
    expect(
      new URL(`https://uw.test${firstPath}`).searchParams.get('older_than'),
    ).toBe('2026-07-14T14:02:00.000000Z');

    const detect = (mockSql.mock.calls[0]![0] as readonly string[]).join('?');
    expect(detect).toContain('buy_volume IS NULL');
    expect(mockSql.mock.calls[0]!.slice(1)).toContain(
      '2026-07-14T00:00:00.000Z',
    );

    const [update] = updateCalls();
    expect((update![0] as readonly string[]).join('?')).toContain(
      'AND b.buy_volume IS NULL',
    );
    expect(update!.slice(1)).toContain('ES');
    expect(update!.slice(1)).toContainEqual([
      '2026-07-14T14:00:00.000Z',
      '2026-07-14T14:01:00.000Z',
    ]);
    expect(update!.slice(1)).toContainEqual([0, 6]); // buy volume
    expect(update!.slice(1)).toContainEqual([4, 0]); // sell volume
    expect(logs.join('\n')).toMatch(/ES 2026-07-14 .*repaired 2/);
    expect(logs.join('\n')).not.toContain('uw-key');
  });

  it('--dry-run reads and matches but never writes', async () => {
    mockSql.mockResolvedValueOnce([
      nullRow('ES', '2026-07-14T14:00:00Z', 4),
      nullRow('ES', '2026-07-14T14:01:00Z', 6),
    ]);
    routeTrades(ES_0714_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-07-14'], roots: ['ES'], dryRun: true }),
      apiKey: 'k',
    });

    expect(code).toBe(0);
    expect(updateCalls()).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/dry run/i);
    expect(logs.join('\n')).toMatch(/ES 2026-07-14 .*would write 2/);
  });

  it('leaves a minute NULL when REST volume misses the Databento-era bar by more than 2%', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-07-14T14:00:00Z', 4),
        nullRow('ES', '2026-07-14T14:01:00Z', 60), // REST has 6
      ])
      .mockResolvedValueOnce([{ ts: 'a' }]);
    routeTrades(ES_0714_PAGES);

    await runBackfill({
      ...opts({ dates: ['2026-07-14'], roots: ['ES'] }),
      apiKey: 'k',
    });

    const [update] = updateCalls();
    expect(update!.slice(1)).toContainEqual(['2026-07-14T14:00:00.000Z']);
    expect(logs.join('\n')).toMatch(/ES 2026-07-14 .*skipped 1/);
  });

  it('a root-day with no NULL-flow bars makes no UW calls (resumable)', async () => {
    const code = await runBackfill({
      ...opts({ dates: ['2026-07-14'], roots: ['ES'] }),
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
        nullRow('ES', '2026-07-14T14:00:00Z', 4),
        nullRow('ES', '2026-07-14T14:01:00Z', 6),
      ])
      .mockResolvedValueOnce([{}, {}]);
    routeTrades(ES_0714_PAGES);

    const code = await runBackfill({
      ...opts({
        dates: ['2026-07-14', '2026-07-15'],
        roots: ['ES'],
        maxPages: 2,
      }),
      apiKey: 'k',
    });

    expect(code).toBe(0);
    // 07-14 used 3 pages; 07-15 never starts.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).toMatch(/page budget.*--from 2026-07-15/is);
  });

  it('a failed root-day (UW 5xx) is reported and fails the exit code; other roots still run', async () => {
    mockSql.mockImplementation(async (strings: readonly string[], ...v) => {
      const text = strings.join('?');
      if (text.includes('UPDATE futures_bars')) return [{}];
      const symbols = v[0] as string[];
      return symbols[0] === 'NQ'
        ? [nullRow('NQ', '2026-07-21T14:00:00Z', 2)]
        : [nullRow('ES', '2026-07-21T14:00:00Z', 4)];
    });
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path.startsWith('/futures/ESU6/')) {
        throw new Error('UW API 502: bad gateway');
      }
      if (path.startsWith('/futures/NQU6/')) {
        return [
          print(2, '2026-07-21T14:00:30.000000Z', 2, 'buy'),
          print(1, '2026-07-20T23:00:00.000000Z', 1, 'buy'),
        ];
      }
      return [];
    });

    const code = await runBackfill({
      ...opts({ dates: ['2026-07-21'], roots: ['ES', 'NQ'] }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/ES 2026-07-21 FAILED: UW API 502/);
    expect(updateCalls().some((c) => c.slice(1).includes('NQ'))).toBe(true);
  });

  it('a rejected UPDATE fails that root-day and the exit code', async () => {
    mockSql
      .mockResolvedValueOnce([
        nullRow('ES', '2026-07-14T14:00:00Z', 4),
        nullRow('ES', '2026-07-14T14:01:00Z', 6),
      ])
      .mockRejectedValueOnce(new Error('connection terminated'));
    routeTrades(ES_0714_PAGES);

    const code = await runBackfill({
      ...opts({ dates: ['2026-07-14'], roots: ['ES'] }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(
      /ES 2026-07-14 FAILED: connection terminated/,
    );
  });

  it('a failed root-day’s pages still count against the page budget', async () => {
    mockSql.mockResolvedValueOnce([nullRow('ES', '2026-07-14T14:00:00Z', 4)]);
    let call = 0;
    mockUwFetch.mockImplementation(async () => {
      call += 1;
      // Page 1 doesn't reach 00:00; page 2 fails.
      if (call === 1) {
        return [print(1, '2026-07-14T12:00:00.000000Z', 1, 'buy')];
      }
      throw new Error('UW API 502: bad gateway');
    });

    const code = await runBackfill({
      ...opts({
        dates: ['2026-07-14', '2026-07-15'],
        roots: ['ES'],
        maxPages: 2,
      }),
      apiKey: 'k',
    });

    expect(code).toBe(1);
    // Both requests counted: 07-15 never starts.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const out = logs.join('\n');
    expect(out).toMatch(/ES 2026-07-14 FAILED.*UW API 502/);
    expect(out).toMatch(/page budget.*--from 2026-07-15/is);
    expect(out).toMatch(/2 pages/);
  });
});
