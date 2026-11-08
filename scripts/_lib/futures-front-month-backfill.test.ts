// @vitest-environment node

/**
 * Tests for the one-off front-month history seed
 * (scripts/_lib/futures-front-month-backfill.ts): what it fetches, how it
 * walks the rule over the sessions, what it writes and in what order, and
 * how a root fails. Module-boundary mocks only: the candle fetch and the
 * three store functions (the real ones are tested where they live, in
 * api/__tests__/futures-daily-candles.test.ts and
 * futures-front-month-pglite.test.ts). The cycle list, `decideFrontMonth`
 * and the expiry order run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFetchVolumes,
  mockFetchStored,
  mockInsertVolumes,
  mockInsertFront,
} = vi.hoisted(() => ({
  mockFetchVolumes: vi.fn(),
  mockFetchStored: vi.fn(),
  mockInsertVolumes: vi.fn(),
  mockInsertFront: vi.fn(),
}));

vi.mock('../../api/_lib/futures-daily-candles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/futures-daily-candles.js')
  >('../../api/_lib/futures-daily-candles.js');
  return { ...actual, fetchDailyContractVolumes: mockFetchVolumes };
});
vi.mock('../../api/_lib/futures-front-month.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/futures-front-month.js')
  >('../../api/_lib/futures-front-month.js');
  return {
    ...actual,
    fetchStoredFrontMonths: mockFetchStored,
    insertContractVolumes: mockInsertVolumes,
    insertFrontMonthRows: mockInsertFront,
  };
});

import {
  FUTURES_ROOTS,
  type FuturesRoot,
} from '../../api/_lib/futures-contracts.js';
import {
  cycleContracts,
  type DailyContractVolume,
} from '../../api/_lib/futures-daily-candles.js';
import type {
  ContractVolumeRow,
  FrontMonthRow,
} from '../../api/_lib/futures-front-month.js';
import {
  SEED_START,
  findOutOfOrder,
  monthPlus,
  parseSeedArgs,
  requiredContracts,
  runFrontMonthSeed,
  volumeRowsToStore,
  walkFrontMonths,
} from './futures-front-month-backfill.js';

// ── Fixtures ──────────────────────────────────────────────

/** A Friday, 14:00 CT: the 2026-11-06 session is still running. */
const NOW = '2026-11-06T20:00:00Z';
const TODAY = '2026-11-06';

function vol(
  tradeDate: string,
  ...pairs: Array<[contract: string, volume: number]>
): ContractVolumeRow[] {
  return pairs.map(([contract, volume]) => ({
    product: 'ES',
    tradeDate,
    contract,
    volume,
  }));
}

function row(tradeDate: string, contract: string): FrontMonthRow {
  return { product: 'ES', tradeDate, contract };
}

// ── parseSeedArgs ─────────────────────────────────────────

describe('parseSeedArgs', () => {
  it('defaults to a real run over all six roots', () => {
    expect(parseSeedArgs([])).toEqual({
      dryRun: false,
      roots: ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN'],
    });
  });

  it('reads --dry-run and --roots, upper-casing and dropping repeats', () => {
    expect(parseSeedArgs(['--dry-run', '--roots', 'es,Nq,ES'])).toEqual({
      dryRun: true,
      roots: ['ES', 'NQ'],
    });
  });

  it.each([
    [['--roots', 'ES,XX'], /unknown root XX/],
    [['--roots'], /--roots needs a value/],
    [['--roots', '--dry-run'], /--roots needs a value/],
    [['--max-pages', '5'], /Unknown flag --max-pages/],
    [['2026-09-04'], /Unexpected argument 2026-09-04/],
  ])('rejects %j, naming the problem', (argv, message) => {
    expect(() => parseSeedArgs(argv)).toThrow(message);
  });
});

// ── monthPlus ─────────────────────────────────────────────

describe('monthPlus', () => {
  it.each([
    ['2026-11-06', 6, '2027-05'],
    ['2026-07-15', 6, '2027-01'],
    ['2026-12-31', 6, '2027-06'],
    ['2026-06-30', 6, '2026-12'],
    ['2026-11-06', 0, '2026-11'],
  ])('%s + %i months is %s', (day, months, expected) => {
    expect(monthPlus(day, months)).toBe(expected);
  });
});

// ── requiredContracts ─────────────────────────────────────

describe('requiredContracts', () => {
  it('ES on 11-06: ESU6, ESZ6 and ESH7, the second contract after November', () => {
    expect(requiredContracts('ES', ['ESU6', 'ESZ6', 'ESH7'], TODAY)).toEqual([
      'ESU6',
      'ESZ6',
      'ESH7',
    ]);
  });

  it('CL on 11-06: through CLF7, and CLK7 and the months after are not required', () => {
    const listed = [
      'CLN6',
      'CLQ6',
      'CLU6',
      'CLV6',
      'CLX6',
      'CLZ6',
      'CLF7',
      'CLG7',
      'CLH7',
      'CLJ7',
      'CLK7',
    ];
    const required = requiredContracts('CL', listed, TODAY);
    expect(required.at(-1)).toBe('CLF7');
    expect(required).not.toContain('CLG7');
    expect(required).not.toContain('CLK7');
  });

  it('leaves out the contracts that stopped trading before the first decision', () => {
    // CLN6 (July 2026) stopped in June and CLQ6 (August) on 2026-07-21, its
    // last session: UW serves no candles for either, and neither can be the
    // incumbent or the challenger from 07-28 on.
    const required = requiredContracts(
      'CL',
      ['CLN6', 'CLQ6', 'CLU6', 'CLV6', 'CLX6', 'CLZ6', 'CLF7'],
      TODAY,
    );
    expect(required).not.toContain('CLN6');
    expect(required).not.toContain('CLQ6');
    expect(required[0]).toBe('CLU6');
  });

  it.each([
    ['ES', ['ESU6', 'ESZ6', 'ESH7']],
    ['NQ', ['NQU6', 'NQZ6', 'NQH7']],
    ['RTY', ['RTYU6', 'RTYZ6', 'RTYH7']],
    ['ZN', ['ZNU6', 'ZNZ6', 'ZNH7']],
    ['GC', ['GCQ6', 'GCV6', 'GCZ6', 'GCG7']],
  ] as const)(
    'keeps %s from its first contract still trading in August',
    (root, listed) => {
      // None of these stops in July, so the first listed contract is
      // required: ESU6 and GCQ6 have candles from 07-21.
      expect(requiredContracts(root, listed, TODAY)).toEqual(listed);
    },
  );

  it('GC on 11-06: through GCG7, the second even month after November', () => {
    expect(
      requiredContracts('GC', ['GCQ6', 'GCV6', 'GCZ6', 'GCG7', 'GCJ7'], TODAY),
    ).toEqual(['GCQ6', 'GCV6', 'GCZ6', 'GCG7']);
  });

  it('counts from the month of the trade date: in December the next two are ESH7 and ESM7', () => {
    expect(
      requiredContracts('ES', ['ESU6', 'ESZ6', 'ESH7', 'ESM7'], '2026-12-10'),
    ).toEqual(['ESU6', 'ESZ6', 'ESH7', 'ESM7']);
  });

  it('gives the same lists for every root whatever the first decision date in July: the bound is the 1st of the next month', () => {
    const required = (root: FuturesRoot) =>
      requiredContracts(
        root,
        cycleContracts(root, '2026-07', monthPlus(TODAY, 6)),
        TODAY,
      );
    expect(
      Object.fromEntries(FUTURES_ROOTS.map((r) => [r, required(r)])),
    ).toEqual({
      ES: ['ESU6', 'ESZ6', 'ESH7'],
      NQ: ['NQU6', 'NQZ6', 'NQH7'],
      RTY: ['RTYU6', 'RTYZ6', 'RTYH7'],
      ZN: ['ZNU6', 'ZNZ6', 'ZNH7'],
      CL: ['CLU6', 'CLV6', 'CLX6', 'CLZ6', 'CLF7'],
      GC: ['GCQ6', 'GCV6', 'GCZ6', 'GCG7'],
    });
  });

  it('requires the whole list when fewer than two contracts follow the current month', () => {
    expect(requiredContracts('ES', ['ESU6', 'ESZ6'], TODAY)).toEqual([
      'ESU6',
      'ESZ6',
    ]);
  });
});

// ── volumeRowsToStore ─────────────────────────────────────

describe('volumeRowsToStore', () => {
  const candles: DailyContractVolume[] = [
    { contract: 'ESU6', tradeDate: '2026-06-30', volume: 9 },
    // A sliver of a session: UW's daily candles for 07-21 to 07-24 are partial.
    { contract: 'ESU6', tradeDate: '2026-07-24', volume: 8 },
    { contract: 'ESU6', tradeDate: SEED_START, volume: 7 },
    { contract: 'ESZ6', tradeDate: '2026-11-05', volume: 6 },
    { contract: 'ESZ6', tradeDate: TODAY, volume: 5 },
    { contract: 'ESZ6', tradeDate: '2026-11-07', volume: 4 },
  ];

  it('keeps the seed start up to the day before the current trade date', () => {
    expect(volumeRowsToStore('ES', candles, TODAY)).toEqual([
      { product: 'ES', tradeDate: SEED_START, contract: 'ESU6', volume: 7 },
      { product: 'ES', tradeDate: '2026-11-05', contract: 'ESZ6', volume: 6 },
    ]);
  });

  it('drops the running session: its volume is partial', () => {
    const stored = volumeRowsToStore('ES', candles, TODAY);
    expect(stored.map((r) => r.tradeDate)).not.toContain(TODAY);
  });

  it('drops the partial sessions before the seed start', () => {
    const stored = volumeRowsToStore('ES', candles, TODAY);
    expect(stored.map((r) => r.tradeDate)).not.toContain('2026-07-24');
    expect(stored.every((r) => r.tradeDate >= SEED_START)).toBe(true);
  });
});

// ── walkFrontMonths ───────────────────────────────────────

describe('walkFrontMonths', () => {
  const NO_STORED = new Map<string, string>();

  it('rolls once, on the session after the volume crosses', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol('2026-07-27', ['ESU6', 100], ['ESZ6', 10]),
        ...vol('2026-07-28', ['ESU6', 100], ['ESZ6', 99]),
        ...vol('2026-07-29', ['ESU6', 100], ['ESZ6', 101]),
        ...vol('2026-07-30', ['ESU6', 50], ['ESZ6', 200]),
        ...vol('2026-08-03', ['ESU6', 40], ['ESZ6', 300]),
      ],
      NO_STORED,
      '2026-08-04',
    );
    // 07-29's volume crosses (101 > 100); 07-30 is the first Z6 session.
    expect(walk.series.map((s) => [s.tradeDate, s.contract])).toEqual([
      ['2026-07-28', 'ESU6'],
      ['2026-07-29', 'ESU6'],
      ['2026-07-30', 'ESZ6'],
      ['2026-08-03', 'ESZ6'],
      ['2026-08-04', 'ESZ6'],
    ]);
    expect(walk.switches).toEqual([
      {
        tradeDate: '2026-07-30',
        from: 'ESU6',
        to: 'ESZ6',
        volumeDate: '2026-07-29',
        fromVolume: 100,
        toVolume: 101,
        source: 'candles',
      },
    ]);
  });

  it('starts from the contract with the most volume on the seed start', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESU6', 10], ['ESZ6', 500]),
        ...vol('2026-07-28', ['ESU6', 10], ['ESZ6', 500]),
      ],
      NO_STORED,
      '2026-07-29',
    );
    expect(walk.series[0]).toMatchObject({
      tradeDate: '2026-07-28',
      contract: 'ESZ6',
    });
  });

  it('writes one row per session with volume after the seed start, plus the current trade date', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESU6', 100]),
        ...vol('2026-07-28', ['ESU6', 100]),
        ...vol('2026-07-30', ['ESU6', 100]),
      ],
      NO_STORED,
      '2026-08-04',
    );
    // The seed start itself is only the first decision's input; 07-29 has
    // no candles and so no row; the current date is decided from 07-30.
    expect(walk.rows).toEqual([
      row('2026-07-28', 'ESU6'),
      row('2026-07-30', 'ESU6'),
      row('2026-08-04', 'ESU6'),
    ]);
  });

  it('keeps a stored row, carries on from it and never rolls back', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESZ6', 100], ['ESH7', 10]),
        // ESZ6 leads in every session: the candles alone never choose ESH7.
        ...vol('2026-07-28', ['ESZ6', 100], ['ESH7', 90]),
        ...vol('2026-07-29', ['ESZ6', 100], ['ESH7', 90]),
        ...vol('2026-07-30', ['ESZ6', 200], ['ESH7', 100]),
        ...vol('2026-08-03', ['ESZ6', 200], ['ESH7', 100]),
      ],
      // But ESH7 is stored for 07-29, and the walk goes on from it: an
      // earlier month is never chosen again, however it out-trades ESH7.
      new Map([['2026-07-29', 'ESH7']]),
      '2026-08-04',
    );
    expect(walk.series).toEqual([
      { tradeDate: '2026-07-28', contract: 'ESZ6', source: 'candles' },
      { tradeDate: '2026-07-29', contract: 'ESH7', source: 'stored' },
      { tradeDate: '2026-07-30', contract: 'ESH7', source: 'candles' },
      { tradeDate: '2026-08-03', contract: 'ESH7', source: 'candles' },
      { tradeDate: '2026-08-04', contract: 'ESH7', source: 'candles' },
    ]);
    // The stored date is not written again, and what the candles said is
    // reported.
    expect(walk.rows.map((r) => r.tradeDate)).toEqual([
      '2026-07-28',
      '2026-07-30',
      '2026-08-03',
      '2026-08-04',
    ]);
    expect(walk.kept).toEqual([
      { tradeDate: '2026-07-29', stored: 'ESH7', candles: 'ESZ6' },
    ]);
  });

  it('lowers an answer to the next stored decision, and says so', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESZ6', 100], ['ESH7', 10]),
        // The candles cross at once: ESH7 on 07-29 and every day after...
        ...vol('2026-07-28', ['ESZ6', 100], ['ESH7', 101]),
        ...vol('2026-07-29', ['ESZ6', 100], ['ESH7', 101]),
        ...vol('2026-07-30', ['ESZ6', 100], ['ESH7', 101]),
        ...vol('2026-08-03', ['ESZ6', 100], ['ESH7', 101]),
      ],
      // ...but a later row is already stored as ESZ6, and a row is never
      // updated. Rolling to ESH7 first would make the series step back.
      new Map([['2026-08-03', 'ESZ6']]),
      '2026-08-04',
    );
    expect(walk.series.map((s) => [s.tradeDate, s.contract])).toEqual([
      ['2026-07-28', 'ESZ6'],
      ['2026-07-29', 'ESZ6'],
      ['2026-07-30', 'ESZ6'],
      ['2026-08-03', 'ESZ6'],
      ['2026-08-04', 'ESH7'],
    ]);
    expect(walk.clamped).toEqual([
      { tradeDate: '2026-07-29', wanted: 'ESH7', ceiling: 'ESZ6' },
      { tradeDate: '2026-07-30', wanted: 'ESH7', ceiling: 'ESZ6' },
    ]);
    expect(
      findOutOfOrder(
        'ES',
        new Map(walk.series.map((s) => [s.tradeDate, s.contract])),
      ),
    ).toBeNull();
  });

  it('takes a stored row on a date with no candles as the incumbent', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESZ6', 100], ['ESH7', 10]),
        ...vol('2026-07-28', ['ESZ6', 100], ['ESH7', 10]),
        ...vol('2026-08-03', ['ESZ6', 10], ['ESH7', 100]),
      ],
      new Map([['2026-08-01', 'ESZ6']]),
      '2026-08-04',
    );
    expect(walk.series).toEqual([
      { tradeDate: '2026-07-28', contract: 'ESZ6', source: 'candles' },
      { tradeDate: '2026-08-01', contract: 'ESZ6', source: 'stored' },
      { tradeDate: '2026-08-03', contract: 'ESZ6', source: 'candles' },
      { tradeDate: '2026-08-04', contract: 'ESH7', source: 'candles' },
    ]);
    expect(walk.rows.map((r) => r.tradeDate)).not.toContain('2026-08-01');
    expect(walk.kept).toEqual([]);
  });

  it('decides the current trade date from the latest earlier session', () => {
    const walk = walkFrontMonths(
      'ES',
      [
        ...vol(SEED_START, ['ESZ6', 100], ['ESH7', 10]),
        ...vol('2026-11-05', ['ESZ6', 100], ['ESH7', 300]),
      ],
      NO_STORED,
      TODAY,
    );
    expect(walk.series.at(-1)).toEqual({
      tradeDate: TODAY,
      contract: 'ESH7',
      source: 'candles',
    });
  });

  it.each([
    ['no candles at all', []],
    ['no candles on the seed start', vol('2026-07-28', ['ESU6', 100])],
  ])('throws, naming the date, with %s', (_label, volumes) => {
    expect(() =>
      walkFrontMonths('ES', volumes, new Map(), '2026-08-04'),
    ).toThrow(
      /^no candle volume on 2026-07-27, the session the first decision/,
    );
  });
});

// ── findOutOfOrder ────────────────────────────────────────

describe('findOutOfOrder', () => {
  it.each<[string, Array<[string, string]>]>([
    ['an empty series', []],
    ['a single date', [['2026-07-28', 'ESU6']]],
    [
      'a forward series with repeats',
      [
        ['2026-07-28', 'ESU6'],
        ['2026-07-29', 'ESU6'],
        ['2026-07-30', 'ESZ6'],
      ],
    ],
    [
      'a decade wrap: ESZ9 then ESH0 at the end of 2029',
      [
        ['2029-12-18', 'ESZ9'],
        ['2029-12-19', 'ESH0'],
      ],
    ],
  ])('finds nothing in %s', (_label, entries) => {
    expect(findOutOfOrder('ES', new Map(entries))).toBeNull();
  });

  it('names the first pair that steps back', () => {
    expect(
      findOutOfOrder(
        'ES',
        new Map([
          ['2026-07-28', 'ESZ6'],
          ['2026-07-29', 'ESU6'],
          ['2026-07-30', 'ESH7'],
          ['2026-08-03', 'ESZ6'],
        ]),
      ),
    ).toEqual({
      earlierDate: '2026-07-28',
      earlierContract: 'ESZ6',
      laterDate: '2026-07-29',
      laterContract: 'ESU6',
    });
  });

  it('orders by date whatever order the map was built in', () => {
    expect(
      findOutOfOrder(
        'ES',
        new Map([
          ['2026-07-29', 'ESU6'],
          ['2026-07-28', 'ESZ6'],
        ]),
      ),
    ).toMatchObject({ earlierDate: '2026-07-28', laterDate: '2026-07-29' });
  });
});

// ── runFrontMonthSeed ─────────────────────────────────────

/** Candle dates of the synthetic history; the last is the running session. */
const CANDLE_DATES = [
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-11-05',
  '2026-11-06',
];

/**
 * Per contract (by its month and year) and date, a history in which the
 * September contract leads at first, the December one out-trades it on
 * 07-28 (so it is the front from 07-29), and the March one never trades
 * much. Any other contract has a volume of 1.
 */
const SEPTEMBER: Record<string, number> = {
  '2026-07-27': 100,
  '2026-07-28': 100,
  '2026-07-29': 50,
};
const DECEMBER: Record<string, number> = {
  '2026-07-27': 10,
  '2026-07-28': 120,
  '2026-07-29': 200,
  '2026-11-05': 500,
};
const SHAPE: Record<string, (date: string) => number> = {
  U6: (d) => SEPTEMBER[d] ?? 5,
  Z6: (d) => DECEMBER[d] ?? 250,
  H7: () => 1,
};

function rollCandles(
  contracts: readonly string[],
  skip: readonly string[] = [],
): DailyContractVolume[] {
  return contracts
    .filter((c) => !skip.includes(c))
    .flatMap((contract) =>
      CANDLE_DATES.map((tradeDate) => ({
        contract,
        tradeDate,
        volume: SHAPE[contract.slice(-2)]?.(tradeDate) ?? 1,
      })),
    );
}

describe('runFrontMonthSeed', () => {
  let logs: string[];
  let errors: string[];

  function run(
    roots: FuturesRoot[] = ['ES'],
    over: { dryRun?: boolean } = {},
  ): Promise<number> {
    return runFrontMonthSeed({
      apiKey: 'uw-key',
      roots,
      dryRun: over.dryRun ?? false,
    });
  }

  function writtenVolumes(): ContractVolumeRow[] {
    return mockInsertVolumes.mock.calls.flatMap(
      (call) => call[0] as ContractVolumeRow[],
    );
  }

  function writtenDecisions(): FrontMonthRow[] {
    return mockInsertFront.mock.calls.flatMap(
      (call) => call[0] as FrontMonthRow[],
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    mockFetchVolumes.mockReset();
    mockFetchStored.mockReset();
    mockInsertVolumes.mockReset();
    mockInsertFront.mockReset();
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts),
    );
    mockFetchStored.mockResolvedValue(new Map());
    mockInsertVolumes.mockImplementation(
      async (rows: unknown[]) => rows.length,
    );
    mockInsertFront.mockImplementation(async (rows: unknown[]) => rows.length);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches six months of candles for the listed contracts, then writes the rolls once', async () => {
    expect(await run()).toBe(0);

    // July through six months past today (2027-05): ESM7 (June) is out.
    expect(mockFetchVolumes).toHaveBeenCalledWith(
      'uw-key',
      'ES',
      ['ESU6', 'ESZ6', 'ESH7'],
      '6m',
    );
    expect(writtenDecisions()).toEqual([
      row('2026-07-28', 'ESU6'),
      row('2026-07-29', 'ESZ6'),
      row('2026-11-05', 'ESZ6'),
      row('2026-11-06', 'ESZ6'),
    ]);
    const output = logs.join('\n');
    // The switch: date, from -> to, and the deciding session's two volumes.
    expect(output).toMatch(
      /2026-07-29\s+ESU6 → ESZ6.*2026-07-28.*ESZ6 120.*ESU6 100/,
    );
    expect(output).toMatch(/volumes: inserted 12 of 12/);
    expect(output).toMatch(/decisions: inserted 4 of 4/);
    expect(errors).toEqual([]);
  });

  it("does not write the running session's volume", async () => {
    await run();
    const dates = new Set(writtenVolumes().map((r) => r.tradeDate));
    expect(dates).toEqual(
      new Set(['2026-07-27', '2026-07-28', '2026-07-29', '2026-11-05']),
    );
    expect(writtenVolumes()).toHaveLength(12);
    // The running session still gets its decision row.
    expect(writtenDecisions().map((r) => r.tradeDate)).toContain(TODAY);
  });

  it('writes the volumes before the decisions, and reads the series back after both', async () => {
    await run();
    expect(mockInsertVolumes.mock.invocationCallOrder[0]).toBeLessThan(
      mockInsertFront.mock.invocationCallOrder[0]!,
    );
    // The stored rows are read once before the walk and once after the writes.
    expect(mockFetchStored).toHaveBeenCalledTimes(2);
    expect(mockFetchStored).toHaveBeenCalledWith('ES', '2026-07-28', TODAY);
    expect(mockFetchStored.mock.invocationCallOrder[0]).toBeLessThan(
      mockInsertVolumes.mock.invocationCallOrder[0]!,
    );
    expect(mockFetchStored.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockInsertFront.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a stored row and carries on from it', async () => {
    // Stored: ESZ6 on 07-28, a session before the candles roll.
    mockFetchStored.mockResolvedValueOnce(new Map([['2026-07-28', 'ESZ6']]));
    expect(await run()).toBe(0);
    expect(writtenDecisions()).toEqual([
      row('2026-07-29', 'ESZ6'),
      row('2026-11-05', 'ESZ6'),
      row('2026-11-06', 'ESZ6'),
    ]);
    // A kept row that the candles disagree with is reported, not an error.
    expect(logs.join('\n')).toMatch(/kept.*2026-07-28.*ESZ6.*candles.*ESU6/);
    expect(errors).toEqual([]);
  });

  it('ignores the partial sessions before the seed start: December ahead of September on 07-23 does not roll', async () => {
    // UW's daily candles for 07-21 to 07-24 hold only a sliver of each
    // session (prod, 2026-11-08: RTY September traded 73 to 1,685 a day,
    // then 144,241 on 07-27). A roll only moves forward, so a roll on that
    // noise would hold December through September.
    const sessions: Record<string, [september: number, december: number]> = {
      '2026-07-23': [73, 218],
      '2026-07-24': [1685, 90],
      '2026-07-27': [144_241, 90_000],
      '2026-07-28': [150_000, 100_000],
      '2026-11-05': [150_000, 100_000],
      [TODAY]: [10, 10],
    };
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        contracts.flatMap((contract) =>
          Object.entries(sessions).map(([tradeDate, [sep, dec]]) => ({
            contract,
            tradeDate,
            volume: { ESU6: sep, ESZ6: dec }[contract] ?? 1,
          })),
        ),
    );
    expect(await run()).toBe(0);

    // The first decision (07-28) takes September, which leads on 07-27, and
    // nothing rolls after it.
    expect(writtenDecisions()).toEqual([
      row('2026-07-28', 'ESU6'),
      row('2026-11-05', 'ESU6'),
      row('2026-11-06', 'ESU6'),
    ]);
    expect(logs.join('\n')).toMatch(/ES: 3 decisions 2026-07-28 → /);
    expect(logs.join('\n')).not.toMatch(/ESU6 → ESZ6/);
    // And the slivers are not stored as volume either.
    expect(writtenVolumes().every((r) => r.tradeDate >= SEED_START)).toBe(true);
    // Three sessions (07-27, 07-28, 11-05) of three contracts.
    expect(writtenVolumes()).toHaveLength(9);
  });

  it('fails a root on a fetch error, by name, and still runs the others', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, root: string, contracts: readonly string[]) => {
        if (root === 'ES') throw new Error('UW API 500: upstream down');
        return rollCandles(contracts);
      },
    );
    expect(await run(['ES', 'NQ'])).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*UW API 500: upstream down/);
    expect(errors.join('\n')).toMatch(/Failed roots: ES/);
    expect(writtenDecisions().map((r) => r.product)).toEqual([
      'NQ',
      'NQ',
      'NQ',
      'NQ',
    ]);
    expect(writtenVolumes().every((r) => r.product === 'NQ')).toBe(true);
  });

  it('fails ES on an empty ESZ6 result, naming it, and still runs NQ', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, root: string, contracts: readonly string[]) =>
        rollCandles(contracts, root === 'ES' ? ['ESZ6'] : []),
    );
    expect(await run(['ES', 'NQ'])).toBe(1);
    // The root is named once, by the failure line.
    expect(errors[0]).toMatch(
      /^ {2}ES FAILED: UW returned no daily candles for ESZ6;/,
    );
    expect(errors.join('\n')).not.toMatch(/ESU6|ESH7/);
    // Nothing of ES is written: not even its volumes.
    expect(writtenVolumes().every((r) => r.product === 'NQ')).toBe(true);
    expect(writtenDecisions().every((r) => r.product === 'NQ')).toBe(true);
    expect(writtenDecisions()).toHaveLength(4);
  });

  it('does not fail CL on an empty far month, CLK7', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts, ['CLK7']),
    );
    expect(await run(['CL'])).toBe(0);
    expect(errors).toEqual([]);
    expect(mockInsertFront).toHaveBeenCalledTimes(1);
  });

  it('does not fail CL on an empty CLN6 or CLQ6, which stopped before the first decision', async () => {
    // Probe 2026-11-07: CLQ6 returns no rows (its last session was 07-21),
    // CLU6 has rows from 07-21.
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts, ['CLN6', 'CLQ6']),
    );
    expect(await run(['CL'])).toBe(0);
    expect(errors).toEqual([]);
  });

  it('fails CL, naming CLU6, when CLU6 is empty', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts, ['CLN6', 'CLQ6', 'CLU6']),
    );
    expect(await run(['CL'])).toBe(1);
    expect(errors[0]).toMatch(
      /^ {2}CL FAILED: UW returned no daily candles for CLU6;/,
    );
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('fails CL when CLF7, the second contract after November, is empty', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts, ['CLF7']),
    );
    expect(await run(['CL'])).toBe(1);
    expect(errors.join('\n')).toMatch(/CL.*CLF7/);
    expect(mockInsertVolumes).not.toHaveBeenCalled();
  });

  it('fails a root whose candles are malformed (the fetch throws), by name', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, root: string, contracts: readonly string[]) => {
        if (root === 'NQ') {
          throw new Error(
            'fetchDailyContractVolumes: UW daily candles for NQ contract NQZ6: row 3 is malformed (v: expected number)',
          );
        }
        return rollCandles(contracts);
      },
    );
    expect(await run(['NQ', 'ES'])).toBe(1);
    expect(errors.join('\n')).toMatch(/NQ.*NQZ6.*row 3 is malformed/);
    expect(writtenDecisions().every((r) => r.product === 'ES')).toBe(true);
  });

  it('fails a root when the stored decisions cannot be read, and runs the others', async () => {
    mockFetchStored.mockImplementation(async (root: string) => {
      if (root === 'ES') throw new Error('connection lost');
      return new Map();
    });
    expect(await run(['ES', 'NQ'])).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*connection lost/);
    expect(writtenVolumes().every((r) => r.product === 'NQ')).toBe(true);
  });

  it('fails a root when the volume insert is rejected, writing no decisions for it', async () => {
    mockInsertVolumes.mockImplementation(async (rows: ContractVolumeRow[]) => {
      if (rows[0]?.product === 'ES') throw new Error('insert rejected');
      return rows.length;
    });
    expect(await run(['ES', 'NQ'])).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*insert rejected/);
    expect(writtenDecisions().every((r) => r.product === 'NQ')).toBe(true);
  });

  it('fails a root when the decision insert is rejected, and runs the others', async () => {
    mockInsertFront.mockImplementation(async (rows: FrontMonthRow[]) => {
      if (rows[0]?.product === 'ES') throw new Error('connection lost');
      return rows.length;
    });
    expect(await run(['ES', 'NQ'])).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*connection lost/);
    expect(errors.join('\n')).toMatch(/Failed roots: ES/);
    expect(mockInsertFront).toHaveBeenCalledTimes(2);
  });

  it('names the pair that steps back after the write, fails its root, and still runs the others', async () => {
    let esReads = 0;
    mockFetchStored.mockImplementation(async (root: string) => {
      if (root !== 'ES') return new Map();
      esReads += 1;
      // The second read (after the writes) holds a series that steps back.
      return esReads === 2
        ? new Map([
            ['2026-07-28', 'ESZ6'],
            ['2026-07-29', 'ESU6'],
          ])
        : new Map();
    });
    expect(await run(['ES', 'NQ'])).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*2026-07-28 ESZ6.*2026-07-29 ESU6/);
    expect(errors.join('\n')).toMatch(/Failed roots: ES/);
    // The writes happened (and are reported); NQ ran after ES.
    expect(logs.join('\n')).toMatch(/ES.*decisions: inserted 4 of 4/);
    expect(writtenDecisions().some((r) => r.product === 'NQ')).toBe(true);
  });

  it('fails a root with no volume on 2026-07-27, naming the date, writing nothing for it, and runs the others', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, root: string, contracts: readonly string[]) =>
        rollCandles(contracts).filter(
          (c) => root !== 'NQ' || c.tradeDate !== SEED_START,
        ),
    );
    expect(await run(['NQ', 'ES'])).toBe(1);
    expect(errors[0]).toMatch(
      /^ {2}NQ FAILED: no candle volume on 2026-07-27,/,
    );
    expect(errors.join('\n')).toMatch(/Failed roots: NQ\./);
    expect(writtenVolumes().every((r) => r.product === 'ES')).toBe(true);
    expect(writtenDecisions().every((r) => r.product === 'ES')).toBe(true);
    expect(writtenDecisions()).toHaveLength(4);
  });

  it.each([
    ['a real run', false],
    ['a dry run', true],
  ])(
    'fails a root whose series to write steps back, by name, before any insert (%s)',
    async (_label, dryRun) => {
      // Stored rows that were already out of order: the walk keeps them, so
      // the series it would leave behind steps back. It must not be written.
      mockFetchStored.mockImplementation(async (root: string) =>
        root === 'ES'
          ? new Map([
              ['2026-07-28', 'ESZ6'],
              ['2026-07-29', 'ESU6'],
            ])
          : new Map(),
      );
      expect(await run(['ES', 'NQ'], { dryRun })).toBe(1);
      expect(errors[0]).toMatch(
        /^ {2}ES FAILED: the series to write steps back: 2026-07-28 ESZ6, then 2026-07-29 ESU6/,
      );
      expect(errors.join('\n')).toMatch(/Failed roots: ES\./);
      expect(writtenVolumes().every((r) => r.product === 'NQ')).toBe(true);
      expect(writtenDecisions().every((r) => r.product === 'NQ')).toBe(true);
      // NQ was walked (and in a real run written) after ES failed.
      expect(logs.join('\n')).toMatch(/NQ: 4 decisions/);
    },
  );

  it('writes nothing in a dry run, says so, and still prints the switches', async () => {
    expect(await run(['ES', 'NQ'], { dryRun: true })).toBe(0);
    expect(mockInsertVolumes).not.toHaveBeenCalled();
    expect(mockInsertFront).not.toHaveBeenCalled();
    // Reads the stored rows once per root; no read-back check.
    expect(mockFetchStored).toHaveBeenCalledTimes(2);
    const output = logs.join('\n');
    expect(output).toMatch(/DRY RUN/);
    expect(output).toMatch(/2026-07-29\s+ESU6 → ESZ6/);
    expect(output).toMatch(/would insert 12 volume rows and 4 decision rows/);
  });

  it('still fails a root in a dry run when its candles are missing', async () => {
    mockFetchVolumes.mockImplementation(
      async (_key: string, _root: string, contracts: readonly string[]) =>
        rollCandles(contracts, ['ESZ6']),
    );
    expect(await run(['ES'], { dryRun: true })).toBe(1);
    expect(errors.join('\n')).toMatch(/ES.*ESZ6/);
  });
});
