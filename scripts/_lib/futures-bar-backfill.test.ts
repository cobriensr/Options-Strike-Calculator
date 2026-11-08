// @vitest-environment node

/**
 * Tests for the one-time futures bar rebuild from REST prints. Module-
 * boundary mocks only: the DB (getDb / withDbRetry), the front-month table
 * (futures-front-month.js) and its volume refresh, the UW fetch (uwFetch /
 * withRetry) and the market-hours clock. The bar rules themselves (dedup,
 * OHLC, side) are covered where they live, in
 * api/__tests__/futures-flow-repair.test.ts, and the session pieces and
 * the schedule read in futures-flow-backfill.test.ts; this file checks what
 * the script does with the minutes.
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

import { isFuturesMarketOpen } from '../../src/utils/timezone.js';
import {
  BAR_USAGE,
  parseBarArgs,
  roundTo4dp,
  runBarBackfill,
  type BarBackfillOptions,
} from './futures-bar-backfill.js';

// ── Fixtures ──────────────────────────────────────────────

const NOW = '2026-11-06T23:00:00Z'; // a Friday evening, after the close
const DAY = '2026-09-15'; // ES roll week; the sessions open at 22:00Z (CDT)
const DAY_START = '2026-09-14T23:59:00.000000Z'; // before 00:00 UTC of DAY
const PX = '6700.250000000';

function opts(over: Partial<BarBackfillOptions> = {}): BarBackfillOptions {
  return {
    dates: [DAY],
    from: null,
    to: null,
    roots: ['ES'],
    dryRun: false,
    maxPages: 20_000,
    compare: false,
    ...over,
  };
}

function run(over: Partial<BarBackfillOptions> = {}) {
  return runBarBackfill({ ...opts(over), apiKey: 'uw-key' });
}

/** A regular REST /trades print (probe 0a shape). */
function print(
  id: number,
  at: string,
  size: number,
  side: string | null,
  price: string | null = PX,
) {
  return {
    executed_at: at,
    is_block: false,
    is_spread: false,
    price,
    side,
    size,
    trade_id: id,
  };
}

/** The print that ends a contract's paging: it is before 00:00 UTC. */
const ENDER = print(1, DAY_START, 1, 'buy');

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

/** UW /trades pages per contract, served in order; unknown contracts 404. */
function routeTrades(pages: Record<string, unknown[][]>) {
  const served: Record<string, number> = {};
  mockUwFetch.mockImplementation(async (_key: string, path: string) => {
    const contract = /^\/futures\/([^/]+)\/trades\?/.exec(path)?.[1];
    if (!contract) throw new Error(`unexpected UW path ${path}`);
    const i = served[contract] ?? 0;
    served[contract] = i + 1;
    const page = pages[contract]?.[i];
    if (page === undefined) {
      throw new Error(`UW API 404: ${contract} page ${i}`);
    }
    return page;
  });
}

/** A stored bar as the SELECT returns it (driver types). */
function storedRow(ts: string, over: Record<string, unknown> = {}) {
  return {
    ts: new Date(ts),
    open: '6700.2500',
    high: '6700.2500',
    low: '6700.2500',
    close: '6700.2500',
    volume: 5,
    buy_volume: 5,
    sell_volume: 0,
    buy_prints: 1,
    sell_prints: 0,
    ...over,
  };
}

/**
 * Routes the DB by SQL text. `stored` is keyed by root; an INSERT answers
 * with one RETURNING row per timestamp unless `conflicts` takes some.
 */
function routeSql(stored: Record<string, unknown[]> = {}, conflicts = 0): void {
  mockSql.mockImplementation(
    async (strings: readonly string[], ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO futures_bars')) {
        return (values[1] as string[]).slice(conflicts).map((ts) => ({ ts }));
      }
      if (text.includes('FROM futures_bars')) {
        return stored[values[0] as string] ?? [];
      }
      return [];
    },
  );
}

function insertCalls(): unknown[][] {
  return mockSql.mock.calls.filter((c) =>
    (c[0] as readonly string[]).join('?').includes('INSERT INTO futures_bars'),
  );
}

/** The columns of INSERT call `i`, by name. */
function inserted(i = 0) {
  const v = insertCalls()[i]!.slice(1);
  return {
    symbol: v[0],
    ts: v[1] as string[],
    open: v[2] as string[],
    high: v[3] as string[],
    low: v[4] as string[],
    close: v[5] as string[],
    volume: v[6] as number[],
    buyVolume: v[7] as Array<number | null>,
    sellVolume: v[8] as Array<number | null>,
    buyPrints: v[9] as Array<number | null>,
    sellPrints: v[10] as Array<number | null>,
    contract: v[11] as Array<string | null>,
  };
}

/** The `older_than` of UW call `i`: where that contract's paging started. */
function olderThan(i: number): string | null {
  const path = mockUwFetch.mock.calls[i]![1] as string;
  return new URL(`https://uw.test${path}`).searchParams.get('older_than');
}

function tradesContracts(): string[] {
  return mockUwFetch.mock.calls.map(
    (c) => /^\/futures\/([^/]+)\/trades/.exec(c[1] as string)![1]!,
  );
}

let logs: string[];
const out = () => logs.join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mockIsMarketHours.mockReturnValue(false);
  routeSql();
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

// ── parseBarArgs ──────────────────────────────────────────

describe('parseBarArgs', () => {
  const base = {
    dates: null,
    from: null,
    to: null,
    roots: ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'],
    dryRun: false,
    maxPages: 20_000,
    compare: false,
  };

  it.each<[string, string[], Partial<BarBackfillOptions>]>([
    [
      'a --from/--to range',
      ['--from', '2026-09-04', '--to', '2026-09-28'],
      { from: '2026-09-04', to: '2026-09-28' },
    ],
    [
      'explicit dates instead of a range',
      ['2026-09-05', '2026-09-04'],
      { dates: ['2026-09-05', '2026-09-04'] },
    ],
    [
      '--compare',
      ['2026-10-30', '--compare'],
      { dates: ['2026-10-30'], compare: true },
    ],
    [
      '--dry-run with a range, roots and a page budget',
      [
        '--dry-run',
        '--from',
        '2026-09-04',
        '--to',
        '2026-09-04',
        '--roots',
        'es,NQ',
        '--max-pages',
        '500',
      ],
      {
        dryRun: true,
        from: '2026-09-04',
        to: '2026-09-04',
        roots: ['ES', 'NQ'],
        maxPages: 500,
      },
    ],
  ])('%s', (_label, argv, expected) => {
    expect(parseBarArgs(argv)).toEqual({ ...base, ...expected });
  });

  it.each<[string, string[], RegExp]>([
    ['no range at all (there is no all-history default)', [], /--from.*--to/],
    ['only --from', ['--from', '2026-09-04'], /--from.*--to/],
    ['only --to', ['--to', '2026-09-28'], /--from.*--to/],
    ['--compare alone', ['--compare'], /--from.*--to/],
    ['a malformed date', ['2026-9-4'], /YYYY-MM-DD/],
    [
      '--from after --to',
      ['--from', '2026-09-28', '--to', '2026-09-04'],
      /after/,
    ],
    ['an unknown flag', ['2026-09-04', '--apply'], /--apply/],
    ['an unknown root', ['2026-09-04', '--roots', 'DX'], /DX/],
    ['a flag missing its value', ['2026-09-04', '--max-pages'], /--max-pages/],
  ])('rejects %s', (_label, argv, message) => {
    expect(() => parseBarArgs(argv)).toThrow(message);
  });

  it('names this script, not the flow backfill, in its usage text', () => {
    expect(BAR_USAGE).toContain('scripts/backfill-futures-bars.ts');
    expect(() => parseBarArgs(['--apply'])).toThrow(
      /scripts\/backfill-futures-bars\.ts/,
    );
  });
});

// ── roundTo4dp ────────────────────────────────────────────

describe('roundTo4dp', () => {
  it.each([
    ['107.203125000', '107.2031'], // ZN 1/64ths
    ['107.234375000', '107.2344'],
    ['107.031250000', '107.0313'], // exactly half: away from zero
    ['7659.000000000', '7659.0000'],
    ['7659', '7659.0000'],
    ['1.5', '1.5000'],
    ['0.00005', '0.0001'],
    ['0.000049999', '0.0000'],
    ['9.99995', '10.0000'], // the carry runs into the integer part
    ['99999999.99995', '100000000.0000'],
  ])('%s → %s', (input, expected) => {
    expect(roundTo4dp(input)).toBe(expected);
  });
});

// ── runBarBackfill: building bars ─────────────────────────

describe('runBarBackfill', () => {
  it('inserts only the minutes that have no bar yet, from the scheduled contract’s prints, with open/high/low/close/volume/flow and the contract', async () => {
    routeSql({ ES: [storedRow('2026-09-15T14:01:00Z')] });
    routeTrades({
      ESU6: [
        [
          print(5, '2026-09-15T14:02:50.000000Z', 1, 'sell', '6702.500000000'),
          print(4, '2026-09-15T14:02:10.000000Z', 3, 'buy', '6702.250000000'),
          print(3, '2026-09-15T14:01:30.000000Z', 2, 'sell', '6701.250000000'),
          print(2, '2026-09-15T14:00:30.000000Z', 5, 'buy', '6700.250000000'),
          ENDER,
        ],
      ],
    });

    const code = await run();

    expect(code).toBe(0);
    expect(insertCalls()).toHaveLength(1);
    expect(inserted()).toEqual({
      symbol: 'ES',
      ts: ['2026-09-15T14:00:00.000Z', '2026-09-15T14:02:00.000Z'],
      // UW's decimal strings, unrounded: the column rounds them.
      open: ['6700.250000000', '6702.250000000'],
      high: ['6700.250000000', '6702.500000000'],
      low: ['6700.250000000', '6702.250000000'],
      close: ['6700.250000000', '6702.500000000'],
      volume: [5, 4],
      buyVolume: [5, 3],
      sellVolume: [0, 1],
      buyPrints: [1, 1],
      sellPrints: [0, 1],
      // Each bar carries the contract its trade date was decided on.
      contract: ['ESU6', 'ESU6'],
    });

    // One contract, one chain over the whole UTC day, newest first from 24:00.
    expect(tradesContracts()).toEqual(['ESU6']);
    expect(olderThan(0)).toBe('2026-09-16T00:00:00.000000Z');
    expect(mockSchedule).toHaveBeenCalledWith(
      'ES',
      ['2026-09-15', '2026-09-16'],
      'script',
    );
    const stored = mockSql.mock.calls[0]!;
    expect((stored[0] as readonly string[]).join('?')).toContain(
      'FROM futures_bars',
    );
    expect(stored.slice(1)).toEqual([
      'ES',
      '2026-09-15T00:00:00.000Z',
      '2026-09-16T00:00:00.000Z',
    ]);
    // 1,380 Globex-open minutes, one of them stored.
    expect(out()).toMatch(
      /ES 2026-09-15 {2}missing 1379 {2}built 2 {2}inserted 2 {2}unbuildable 0/,
    );
    expect(out()).not.toContain('uw-key');
    expect(out()).not.toMatch(/prints 0/);
  });

  it('on a roll the day splits at the session open: each piece is paged for its own contract only and its bars carry it', async () => {
    routeFrontMonth({ '2026-09-16': 'ESZ6' });
    routeTrades({
      ESU6: [
        [
          print(6, '2026-09-15T14:02:40.000000Z', 3, 'buy', '6701.000000000'),
          print(2, '2026-09-15T14:00:30.000000Z', 5, 'buy', '6700.250000000'),
          ENDER,
        ],
      ],
      ESZ6: [
        [
          print(
            11,
            '2026-09-15T22:01:30.000000Z',
            10,
            'sell',
            '6750.500000000',
          ),
          print(10, '2026-09-15T22:00:10.000000Z', 1, 'buy', '6749.000000000'),
          print(9, '2026-09-15T21:30:00.000000Z', 1, 'buy', '6749.000000000'),
        ],
      ],
    });

    const code = await run();

    expect(code).toBe(0);
    // 22:00Z is 17:00 CDT: the next session, decided on ESZ6. ESU6 is paged
    // to the 16:00 CT halt (21:00Z) and ESZ6 from the open, neither beyond.
    expect(tradesContracts()).toEqual(['ESU6', 'ESZ6']);
    expect(olderThan(0)).toBe('2026-09-15T21:00:00.000000Z');
    expect(olderThan(1)).toBe('2026-09-16T00:00:00.000000Z');
    // 14:01 is a minute ESU6 did not print: a gap, whatever ESZ6 did.
    expect(inserted().ts).toEqual([
      '2026-09-15T14:00:00.000Z',
      '2026-09-15T14:02:00.000Z',
      '2026-09-15T22:00:00.000Z',
      '2026-09-15T22:01:00.000Z',
    ]);
    expect(inserted().open).toEqual([
      '6700.250000000',
      '6701.000000000',
      '6749.000000000',
      '6750.500000000',
    ]);
    expect(inserted().contract).toEqual(['ESU6', 'ESU6', 'ESZ6', 'ESZ6']);
    expect(out()).toMatch(/front ESU6\/ESZ6/);
  });

  it('splits at 23:00Z in winter, when the sessions open at 17:00 CST', async () => {
    vi.setSystemTime(new Date('2026-11-14T03:00:00Z'));
    routeFrontMonth({ '2026-11-12': 'ESZ6', '2026-11-13': 'ESH7' });
    routeTrades({
      ESZ6: [
        [
          print(2, '2026-11-12T15:00:30.000000Z', 2, 'buy', '6800.250000000'),
          print(1, '2026-11-11T23:59:00.000000Z', 1, 'buy'),
        ],
      ],
      ESH7: [
        [
          print(4, '2026-11-12T23:10:30.000000Z', 7, 'sell', '6850.500000000'),
          // Before the 23:00Z open, in the halt: it ends the piece.
          print(3, '2026-11-12T22:30:00.000000Z', 1, 'sell'),
        ],
      ],
    });

    const code = await run({ dates: ['2026-11-12'] });

    expect(code).toBe(0);
    expect(tradesContracts()).toEqual(['ESZ6', 'ESH7']);
    expect(olderThan(0)).toBe('2026-11-12T22:00:00.000000Z');
    expect(olderThan(1)).toBe('2026-11-13T00:00:00.000000Z');
    expect(inserted().ts).toEqual([
      '2026-11-12T15:00:00.000Z',
      '2026-11-12T23:10:00.000Z',
    ]);
    expect(inserted().contract).toEqual(['ESZ6', 'ESH7']);
  });

  it('stores a scheduled name that is no outright of the root as a NULL contract, with one warning for the root-day', async () => {
    // A decision row only this rule writes, so canonical by construction;
    // the column's CHECK would fail the whole chunk for a name like this.
    routeFrontMonth({ [DAY]: 'NQU6', '2026-09-16': 'NQU6' });
    routeTrades({
      NQU6: [
        [
          print(3, '2026-09-15T14:01:30.000000Z', 1, 'buy'),
          print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
          ENDER,
        ],
      ],
    });

    const code = await run();

    expect(code).toBe(0);
    expect(inserted().ts).toHaveLength(2);
    expect(inserted().contract).toEqual([null, null]);
    expect(
      logs.filter((l) =>
        /ES 2026-09-15 {2}WARNING: .*NQU6 is not an outright of ES/.test(l),
      ),
    ).toHaveLength(1);
  });

  describe('the front-month table', () => {
    it('every date stored: no volume refresh, the schedule is read as stored', async () => {
      routeTrades({ ESU6: [[ENDER]] });

      await run();

      expect(mockStored).toHaveBeenCalledWith('ES', '2026-09-15', '2026-09-16');
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('an undecided date: refreshes the root’s volumes over 1m, then asks for the schedule', async () => {
      routeFrontMonth({}, ['2026-09-16']);
      routeTrades({ ESU6: [[ENDER]] });

      await run();

      expect(mockRefresh).toHaveBeenCalledWith('uw-key', 'ES', '1m');
      expect(mockRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
        mockSchedule.mock.invocationCallOrder[0]!,
      );
    });

    it('a failed volume refresh fails the root-day by name, decides nothing, pages nothing and writes nothing', async () => {
      routeFrontMonth({}, ['2026-09-16']);
      mockRefresh.mockRejectedValue(
        new Error(
          'stale daily candles for ES: the newest ESU6 candle is 09-10',
        ),
      );

      const code = await run();

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: stale daily candles for ES/);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(insertCalls()).toHaveLength(0);
    });

    it('refuses a trade date before the stored front month (2026-07-28) by name, with no read, refresh or decision', async () => {
      const code = await run({ dates: ['2026-07-27'] });

      expect(code).toBe(1);
      expect(out()).toMatch(
        /ES 2026-07-27 FAILED: ES: trade date 2026-07-27 is before the stored front month, which starts 2026-07-28/,
      );
      expect(mockStored).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(insertCalls()).toHaveLength(0);
    });

    it('runs 2026-07-28, whose UTC day opens on trade date 2026-07-28', async () => {
      routeTrades({
        ESU6: [
          [
            print(2, '2026-07-28T14:00:30.000000Z', 1, 'buy'),
            print(1, '2026-07-27T23:59:00.000000Z', 1, 'buy'),
          ],
        ],
      });

      const code = await run({ dates: ['2026-07-28'] });

      expect(code).toBe(0);
      expect(mockSchedule).toHaveBeenCalledWith(
        'ES',
        ['2026-07-28', '2026-07-29'],
        'script',
      );
      expect(inserted().ts).toEqual(['2026-07-28T14:00:00.000Z']);
    });

    describe.each([
      ['--dry-run', { dryRun: true }],
      ['--compare', { compare: true }],
    ] as const)('%s reads the stored decisions only', (_flag, mode) => {
      it('an undecided date: no refresh, no decision, the date is reported and the stored date still pages', async () => {
        routeFrontMonth({}, ['2026-09-16']);
        routeTrades({
          ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 4, 'buy'), ENDER]],
        });
        routeSql({
          ES: [storedRow('2026-09-15T14:00:00Z', { volume: 4, buy_volume: 4 })],
        });

        const code = await run(mode);

        expect(code).toBe(0);
        expect(mockStored).toHaveBeenCalledWith(
          'ES',
          '2026-09-15',
          '2026-09-16',
        );
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(mockSchedule).not.toHaveBeenCalled();
        expect(insertCalls()).toHaveLength(0);
        // 09-15's session only: up to the 16:00 CT halt, nothing of 09-16.
        expect(tradesContracts()).toEqual(['ESU6']);
        expect(olderThan(0)).toBe('2026-09-15T21:00:00.000000Z');
        expect(out()).toMatch(/ES 2026-09-15 .*undecided 2026-09-16/);
        expect(out()).toMatch(
          /ES {2}undecided trade dates 1: 2026-09-16 \(skipped; a real run decides them\)/,
        );
      });

      it('logs a root’s undecided dates once for the run', async () => {
        routeFrontMonth({}, ['2026-09-16', '2026-09-17']);
        routeSql({ ES: [storedRow('2026-09-15T14:00:00Z')] });
        routeTrades({ ESU6: [[ENDER], [ENDER]] });

        await run({ ...mode, dates: [DAY, '2026-09-16'] });

        expect(logs.filter((l) => /undecided trade dates/.test(l))).toEqual([
          '  ES  undecided trade dates 2: 2026-09-16, 2026-09-17 (skipped; a real run decides them)',
        ]);
      });

      it('refuses a trade date before the stored front month by name', async () => {
        routeSql({ ES: [storedRow('2026-07-27T14:00:00Z')] });

        const code = await run({ ...mode, dates: ['2026-07-27'] });

        expect(code).toBe(1);
        expect(out()).toMatch(
          /ES 2026-07-27 FAILED: ES: trade date 2026-07-27 is before/,
        );
        expect(mockStored).not.toHaveBeenCalled();
        expect(mockSchedule).not.toHaveBeenCalled();
      });
    });

    it('--compare leaves the stored bars of an undecided date out of the counts', async () => {
      routeFrontMonth({}, ['2026-09-16']);
      routeSql({
        ES: [
          storedRow('2026-09-15T14:00:00Z', { volume: 4, buy_volume: 4 }),
          // Trade date 2026-09-16, undecided: not a disagreement.
          storedRow('2026-09-15T22:30:00Z'),
        ],
      });
      routeTrades({
        ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 4, 'buy'), ENDER]],
      });

      await run({ compare: true });

      expect(out()).toMatch(
        /ES 2026-09-15 {2}stored 2 {2}compared 1 {2}matched 1 {2}differ 0 {2}stored-only 0 /,
      );
      expect(out()).toMatch(/ES {2}matched 1 of 1 stored \(100\.00%\)/);
    });

    it('--dry-run leaves a root-day with only undecided dates unpaged', async () => {
      routeFrontMonth({}, [DAY, '2026-09-16']);

      const code = await run({ dryRun: true });

      expect(code).toBe(0);
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(out()).toMatch(
        /ES {2}undecided trade dates 2: 2026-09-15, 2026-09-16 /,
      );
      // Nothing was paged, so this is not a hole in UW's history.
      expect(out()).not.toMatch(/prints 0/);
    });

    it('a rejected schedule read fails the root-day by name before any UW call', async () => {
      mockSchedule.mockRejectedValue(new Error('connection terminated'));

      const code = await run();

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: connection terminated/);
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(insertCalls()).toHaveLength(0);
    });
  });

  it('skips a minute whose ohlc is null (a print with no usable price) and counts it', async () => {
    routeTrades({
      ESU6: [
        [
          print(4, '2026-09-15T14:02:30.000000Z', 1, 'buy'),
          print(3, '2026-09-15T14:01:30.000000Z', 1, 'buy', null),
          print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
          ENDER,
        ],
      ],
    });

    const code = await run();

    expect(code).toBe(0);
    expect(inserted().ts).toEqual([
      '2026-09-15T14:00:00.000Z',
      '2026-09-15T14:02:00.000Z',
    ]);
    expect(out()).toMatch(/built 2 .*unbuildable 1 /);
  });

  it('writes flow by the live NULL-vs-0 rule: no known side → all four NULL, a "none" print → known zeros, otherwise the counts', async () => {
    routeTrades({
      ESU6: [
        [
          print(6, '2026-09-15T14:02:40.000000Z', 3, 'sell'),
          print(5, '2026-09-15T14:02:20.000000Z', 2, 'buy'),
          print(4, '2026-09-15T14:02:10.000000Z', 1, 'none'),
          print(3, '2026-09-15T14:01:30.000000Z', 2, 'none'),
          print(2, '2026-09-15T14:00:30.000000Z', 4, null),
          ENDER,
        ],
      ],
    });

    await run();

    const b = inserted();
    expect(b.ts).toEqual([
      '2026-09-15T14:00:00.000Z',
      '2026-09-15T14:01:00.000Z',
      '2026-09-15T14:02:00.000Z',
    ]);
    expect(b.volume).toEqual([4, 2, 6]);
    expect(b.buyVolume).toEqual([null, 0, 2]);
    expect(b.sellVolume).toEqual([null, 0, 3]);
    expect(b.buyPrints).toEqual([null, 0, 1]);
    expect(b.sellPrints).toEqual([null, 0, 1]);
  });

  it('counts a bar the insert did not take (ON CONFLICT DO NOTHING hit) as built but not inserted', async () => {
    routeSql({}, 1);
    routeTrades({
      ESU6: [
        [
          print(3, '2026-09-15T14:01:30.000000Z', 1, 'buy'),
          print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
          ENDER,
        ],
      ],
    });

    await run();

    expect(out()).toMatch(/built 2 {2}inserted 1 /);
  });

  it('a root-day with no missing minute makes no UW call (a re-run resumes)', async () => {
    const open = Array.from(
      { length: 1440 },
      (_, i) => new Date(Date.parse(`${DAY}T00:00:00Z`) + i * 60_000),
    )
      .filter((d) => isFuturesMarketOpen(d))
      .map((d) => storedRow(d.toISOString()));
    expect(open).toHaveLength(1380);
    routeSql({ ES: open });

    const code = await run();

    expect(code).toBe(0);
    expect(mockUwFetch).not.toHaveBeenCalled();
    // Nothing to build: no schedule to read, no decision to make.
    expect(mockStored).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
    expect(out()).toMatch(/1 root-days with nothing to do/);
  });

  it('never processes the current UTC day: the live handler is still writing it', async () => {
    const code = await run({ dates: ['2026-11-06'] });

    expect(code).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(out()).toMatch(/0 dates/);
  });

  it('surfaces malformed prints in the day’s line', async () => {
    routeTrades({
      ESU6: [
        [
          print(4, '2026-09-15T14:02:30.000000Z', 1, 'buy'),
          { ...print(3, '2026-09-15T14:01:30.000000Z', 1, 'up') }, // unknown side
          print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
          ENDER,
        ],
      ],
    });

    await run();

    // The malformed print withholds its minute: no bar, no silent short count.
    expect(inserted().ts).toEqual([
      '2026-09-15T14:00:00.000Z',
      '2026-09-15T14:02:00.000Z',
    ]);
    expect(out()).toMatch(/malformed 1 /);
  });

  // ── Modes ────────────────────────────────────────────────

  it('--dry-run reads and builds but never writes', async () => {
    routeTrades({
      ESU6: [
        [
          print(3, '2026-09-15T14:01:30.000000Z', 1, 'buy'),
          print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
          ENDER,
        ],
      ],
    });

    const code = await run({ dryRun: true });

    expect(code).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(out()).toMatch(/dry run/i);
    expect(out()).toMatch(/ES 2026-09-15 .*built 2 {2}would insert 2 /);
  });

  describe('--compare', () => {
    function routeZn(rows: unknown[]) {
      routeTrades({
        ZNU6: [[...rows, ENDER]],
      });
    }

    it('writes nothing, counts matches and differences at 4 dp, and prints the differences', async () => {
      routeSql({
        ZN: [
          // Matches: 107.203125 stored as 107.2031 by NUMERIC(12,4).
          storedRow('2026-09-15T14:00:00Z', {
            open: '107.2031',
            high: '107.2031',
            low: '107.2031',
            close: '107.2031',
            volume: 4,
            buy_volume: 4,
          }),
          // 107.234375 rounds to 107.2344; stored 107.2343, and the volume
          // and flow differ too.
          storedRow('2026-09-15T14:01:00Z', {
            open: '107.2343',
            high: '107.2343',
            low: '107.2343',
            close: '107.2343',
            volume: 3,
            buy_volume: null,
            sell_volume: null,
            buy_prints: null,
            sell_prints: null,
          }),
          // Stored, but no print rebuilds it.
          storedRow('2026-09-15T14:02:00Z'),
        ],
      });
      routeZn([
        print(4, '2026-09-15T14:03:10.000000Z', 1, 'buy', '107.250000000'),
        print(3, '2026-09-15T14:01:30.000000Z', 2, 'sell', '107.234375000'),
        print(2, '2026-09-15T14:00:30.000000Z', 4, 'buy', '107.203125000'),
      ]);

      const code = await run({ compare: true, roots: ['ZN'] });

      expect(code).toBe(0);
      expect(insertCalls()).toHaveLength(0);
      expect(out()).toMatch(/COMPARE/);
      expect(out()).toMatch(
        /ZN 2026-09-15 {2}stored 3 {2}compared 2 {2}matched 1 {2}differ 1 {2}stored-only 1 {2}rest-only 1 /,
      );
      // The differences name the field, REST at 4 dp, and the stored value.
      expect(out()).toMatch(/14:01:00Z .*open rest 107\.2344 stored 107\.2343/);
      expect(out()).toMatch(/14:01:00Z .*volume rest 2 stored 3/);
      expect(out()).toMatch(/14:01:00Z .*sellVolume rest 2 stored NULL/);
      expect(out()).not.toMatch(/14:00:00Z/);
      expect(out()).not.toMatch(/prints 0/);
      // Of the 3 stored bars, 1 matched: a stored bar REST can't rebuild
      // counts against the root, not just the 2 that were compared.
      expect(out()).toMatch(
        /ZN {2}matched 1 of 3 stored \(33\.33%\) {2}compared 2 {2}stored-only 1 {2}rest-only 1/,
      );
    });

    it('a stored bar no print rebuilds lowers the root’s percentage even when every compared bar matches', async () => {
      routeSql({
        ZN: [
          storedRow('2026-09-15T14:00:00Z', {
            open: '107.2031',
            high: '107.2031',
            low: '107.2031',
            close: '107.2031',
            volume: 4,
            buy_volume: 4,
          }),
          storedRow('2026-09-15T14:05:00Z'), // a leader or roll disagreement
        ],
      });
      routeZn([
        print(2, '2026-09-15T14:00:30.000000Z', 4, 'buy', '107.203125000'),
      ]);

      await run({ compare: true, roots: ['ZN'] });

      expect(out()).toMatch(
        /ZN {2}matched 1 of 2 stored \(50\.00%\) {2}compared 1 {2}stored-only 1 {2}rest-only 0/,
      );
    });

    it('adds a root’s days together and reports each root on its own line', async () => {
      // The stored-bar mock ignores the day window, so both days read the
      // same bar; each day's prints rebuild none of it.
      routeSql({
        ZN: [storedRow('2026-09-15T14:05:00Z')],
        ES: [storedRow('2026-09-15T14:05:00Z')],
      });
      routeTrades({
        ZNU6: [[ENDER], [ENDER]],
        ESU6: [[ENDER], [ENDER]],
      });

      await run({
        compare: true,
        roots: ['ZN', 'ES'],
        dates: [DAY, '2026-09-16'],
      });

      expect(out()).toMatch(/ZN {2}matched 0 of 2 stored \(0\.00%\)/);
      expect(out()).toMatch(/ES {2}matched 0 of 2 stored \(0\.00%\)/);
    });

    it('marks a root-day whose scheduled contract returned no prints', async () => {
      routeSql({ ZN: [storedRow('2026-09-15T14:05:00Z')] });
      routeZn([]);

      await run({ compare: true, roots: ['ZN'] });

      expect(out()).toMatch(/ZN 2026-09-15 .*stored-only 1 .*prints 0/);
    });

    it('prints only the first few differences per root-day', async () => {
      const bad = [0, 1, 2, 3, 4].map((m) =>
        storedRow(`2026-09-15T14:0${m}:00Z`, { open: '1.0000' }),
      );
      routeSql({ ZN: bad });
      routeZn(
        [4, 3, 2, 1, 0].map((m) =>
          print(
            m + 2,
            `2026-09-15T14:0${m}:30.000000Z`,
            5,
            'buy',
            '107.250000000',
          ),
        ),
      );

      await run({ compare: true, roots: ['ZN'] });

      const diffLines = logs.filter((l) => /^ {4}14:0\d:00Z /.test(l));
      expect(diffLines).toHaveLength(3);
      expect(out()).toMatch(/differ 5 /);
    });

    it('a root-day with no stored bar makes no UW call and reads no schedule', async () => {
      const code = await run({ compare: true, roots: ['ZN'] });

      expect(code).toBe(0);
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(mockStored).not.toHaveBeenCalled();
    });
  });

  // ── Limits and failures (R4) ─────────────────────────────

  it('a failed root-day (UW 5xx) is reported and fails the exit code; the other roots still run', async () => {
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      if (path.startsWith('/futures/ESU6/')) {
        throw new Error('UW API 502: bad gateway');
      }
      if (path.startsWith('/futures/NQU6/')) {
        return [
          print(2, '2026-09-15T14:00:30.000000Z', 2, 'buy', '24000.250000000'),
          print(1, DAY_START, 1, 'buy'),
        ];
      }
      return [];
    });

    const code = await run({ roots: ['ES', 'NQ'] });

    expect(code).toBe(1);
    expect(out()).toMatch(/ES 2026-09-15 FAILED: UW API 502/);
    expect(insertCalls()).toHaveLength(1);
    expect(inserted().symbol).toBe('NQ');
    expect(out()).toMatch(/1 failed root-days/);
    // The end of the run names what to re-run: explicit dates stay dates.
    expect(out()).toMatch(/Failed root-days: ES 2026-09-15$/m);
    expect(out()).toMatch(
      /Re-run with 2026-09-15 --roots ES --max-pages 20000$/m,
    );
  });

  it('lists every failed root-day at the end, with a re-run line over the failed dates and roots', async () => {
    mockUwFetch.mockImplementation(async (_key: string, path: string) => {
      const dayAfter = (d: string) => `older_than=${d}`;
      if (
        path.startsWith('/futures/ESU6/') &&
        path.includes(dayAfter('2026-09-16'))
      ) {
        throw new Error('UW API 502: bad gateway');
      }
      if (
        path.startsWith('/futures/NQU6/') &&
        path.includes(dayAfter('2026-09-18'))
      ) {
        throw new Error('UW API 503: unavailable');
      }
      return [];
    });

    const code = await run({
      dates: null,
      from: '2026-09-15',
      to: '2026-09-17',
      roots: ['ES', 'NQ', 'CL'],
    });

    expect(code).toBe(1);
    expect(out()).toMatch(/Failed root-days: ES 2026-09-15, NQ 2026-09-17$/m);
    expect(out()).toMatch(
      /Re-run with --from 2026-09-15 --to 2026-09-17 --roots ES,NQ --max-pages 20000$/m,
    );
    expect(out()).not.toMatch(/finished root-days are skipped/);
  });

  it('keeps the mode flag in the re-run line', async () => {
    mockSql.mockRejectedValue(new Error('connection terminated'));

    await run({ compare: true });

    expect(out()).toMatch(
      /Re-run with 2026-09-15 --roots ES --max-pages 20000 --compare$/m,
    );
  });

  it('a rejected INSERT fails that root-day and the exit code, not a clean run', async () => {
    mockSql.mockImplementation(async (strings: readonly string[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO futures_bars')) {
        throw new Error('connection terminated');
      }
      return [];
    });
    routeTrades({
      ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'), ENDER]],
    });

    const code = await run();

    expect(code).toBe(1);
    expect(out()).toMatch(/ES 2026-09-15 FAILED: connection terminated/);
    expect(out()).toMatch(/Re-run with 2026-09-15 --roots ES/);
  });

  it('a rejected read of the stored bars fails the root-day before any UW call', async () => {
    mockSql.mockRejectedValue(new Error('connection terminated'));

    const code = await run();

    expect(code).toBe(1);
    expect(mockUwFetch).not.toHaveBeenCalled();
    expect(out()).toMatch(/ES 2026-09-15 FAILED: connection terminated/);
  });

  it('a contract that needs more than 5,000 pages in a day fails the root-day, and the pages count against the budget', async () => {
    let call = 0;
    mockUwFetch.mockImplementation(async () => {
      call += 1;
      // One print a second, walking back from the day's end; never ends.
      const at = new Date(Date.parse(`${DAY}T23:00:00Z`) - call * 1000);
      const iso = at.toISOString().replace('.000Z', '.000000Z');
      return [print(call, iso, 1, 'buy')];
    });

    const code = await run({ dates: [DAY, '2026-09-16'], maxPages: 100 });

    expect(code).toBe(1);
    expect(out()).toMatch(/ES 2026-09-15 FAILED: ESU6: more than 5000 pages/);
    expect(out()).toMatch(/\(after 5000 pages\)/);
    expect(out()).toMatch(/Page budget spent.*--from 2026-09-16/is);
    // A failure and an early stop together: both are listed at the end.
    expect(out()).toMatch(/Failed root-days: ES 2026-09-15$/m);
    expect(out()).toMatch(
      /Re-run with 2026-09-15 --roots ES --max-pages 100$/m,
    );
    expect(out()).toMatch(
      /Incomplete: stopped before 2026-09-16\. Resume with 2026-09-16 --roots ES --max-pages 100$/m,
    );
  });

  it('refuses to start during market hours (UW concurrency is shared with the crons)', async () => {
    mockIsMarketHours.mockReturnValue(true);

    const code = await run();

    expect(code).toBe(1);
    expect(out()).toMatch(/Refusing to run during market hours/);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('stops before the next date when market hours begin mid-run, and says where to resume', async () => {
    mockIsMarketHours
      .mockReturnValueOnce(false) // the start guard
      .mockReturnValueOnce(false) // before 09-15
      .mockReturnValue(true); // before 09-16
    routeTrades({
      ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'), ENDER]],
    });

    const code = await run({ dates: [DAY, '2026-09-16'] });

    // Dates were left unprocessed, so the run is not a success.
    expect(code).toBe(1);
    expect(insertCalls()).toHaveLength(1);
    expect(out()).toMatch(/Market hours began: stopping before 2026-09-16/);
    expect(out()).toMatch(/--from 2026-09-16/);
    expect(out()).toMatch(
      /Incomplete: stopped before 2026-09-16\. Resume with 2026-09-16 --roots ES --max-pages 20000$/m,
    );
    expect(out()).not.toMatch(/Failed root-days/);
  });

  it('stops before the next date once the page budget is spent, and exits 1 with the dates to resume', async () => {
    routeTrades({
      ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'), ENDER]],
    });

    const code = await run({ dates: [DAY, '2026-09-16'], maxPages: 1 });

    expect(code).toBe(1);
    // 09-15 used 1 page; 09-16 never starts.
    expect(out()).toMatch(/Page budget spent \(1 of 1\).*--from 2026-09-16/is);
    expect(insertCalls()).toHaveLength(1);
    expect(out()).toMatch(
      /Incomplete: stopped before 2026-09-16\. Resume with 2026-09-16 --roots ES --max-pages 1$/m,
    );
  });

  it('a range run that stops early resumes with --from and the same --to', async () => {
    mockIsMarketHours
      .mockReturnValueOnce(false) // the start guard
      .mockReturnValueOnce(false) // before 09-15
      .mockReturnValue(true); // before 09-16
    routeTrades({
      ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'), ENDER]],
    });

    const code = await run({
      dates: null,
      from: DAY,
      to: '2026-09-17',
      compare: true,
    });

    expect(code).toBe(1);
    expect(out()).toMatch(
      /Incomplete: stopped before 2026-09-16\. Resume with --from 2026-09-16 --to 2026-09-17 --roots ES --max-pages 20000 --compare$/m,
    );
  });

  it('a run that reaches its last date is not marked incomplete', async () => {
    routeTrades({
      ESU6: [[], []],
    });

    const code = await run({ dates: [DAY, '2026-09-16'], maxPages: 100_000 });

    expect(code).toBe(0);
    expect(out()).not.toMatch(/Incomplete/);
  });

  it('marks a root-day whose scheduled contract returned no prints, so a UW history hole shows', async () => {
    routeTrades({ ESU6: [[]] });

    const code = await run();

    expect(code).toBe(0);
    expect(out()).toMatch(/ES 2026-09-15 .*built 0 .*pages 1 {2}prints 0$/m);
  });
});
