// @vitest-environment node

/**
 * Tests for the `--repair` mode of the futures bar backfill
 * (futures-bar-repair.ts). The same module-boundary mocks as
 * futures-bar-backfill.test.ts, whose header says what they stand for; the
 * fixtures both files use are in futures-bar-test-helpers.ts.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mock functions live in the helper module so both test files share
// them; this runs ahead of the `vi.mock` calls below, whose factories read
// them.
const {
  mockSql,
  mockUwFetch,
  mockIsMarketHours,
  mockStored,
  mockSchedule,
  mockRefresh,
} = await vi.hoisted(() => import('./futures-bar-test-helpers.js'));

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

import type { StoredFuturesBar } from '../../api/_lib/futures-bars.js';
import type { FuturesRoot } from '../../api/_lib/futures-contracts.js';
import type { FlowMinute } from '../../api/_lib/futures-flow-repair.js';
import {
  DEFAULT_WORK_DIR,
  type BarBackfillOptions,
} from './futures-bar-backfill.js';
import {
  FUTURES_TICK_SIZE,
  REPAIR_CACHE_VERSION,
  inKeepBand,
  planRepair,
  runRepair,
} from './futures-bar-repair.js';
import {
  DAY,
  ENDER,
  PX,
  logs,
  nextDay,
  opts,
  out,
  print,
  routeFrontMonth,
  routeTrades,
  setUpBarRun,
  stopLine,
  storedRow,
  tearDownBarRun,
  tradesContracts,
} from './futures-bar-test-helpers.js';
import type { PagedMinute, SessionPiece } from './futures-flow-backfill.js';

// ── Fixtures ──────────────────────────────────────────────

function run(over: Partial<BarBackfillOptions> = {}) {
  return runRepair({ ...opts({ repair: true, ...over }), apiKey: 'uw-key' });
}

beforeEach(setUpBarRun);

afterEach(tearDownBarRun);

// ── --repair: the keep band and the plan ──────────────────

describe('FUTURES_TICK_SIZE', () => {
  it('holds the CME minimum tick of each root', () => {
    expect(FUTURES_TICK_SIZE).toEqual({
      ES: 0.25,
      NQ: 0.25,
      RTY: 0.1,
      CL: 0.01,
      GC: 0.1,
      ZN: 0.015625,
    });
  });
});

describe('inKeepBand', () => {
  const ohlc = (low: string, high: string) => ({
    open: low,
    high,
    low,
    close: high,
  });
  const flat = (px: string) => ({ open: px, high: px, low: px, close: px });

  it.each<[FuturesRoot, string, string]>([
    ['ES', '6700.000000000', '6701.500000000'],
    ['NQ', '24000.000000000', '24010.000000000'],
    // 0.1 and 0.01 are not exact in binary: the edge still counts as inside.
    ['RTY', '2500.300000000', '2510.700000000'],
    ['CL', '98.070000000', '100.200000000'],
    ['GC', '4010.300000000', '4020.700000000'],
    ['ZN', '107.203125000', '107.234375000'],
  ])(
    '%s: one tick beyond the rebuilt low and high is inside, a hair more is outside',
    (root, low, high) => {
      const tick = FUTURES_TICK_SIZE[root];
      const rebuilt = ohlc(low, high);
      const px = (n: number) => n.toFixed(4);
      const below = Number(low) - tick;
      const above = Number(high) + tick;

      expect(inKeepBand(root, flat(px(below)), rebuilt)).toBe(true);
      expect(inKeepBand(root, flat(px(above)), rebuilt)).toBe(true);
      expect(inKeepBand(root, flat(px(below - 0.0001)), rebuilt)).toBe(false);
      expect(inKeepBand(root, flat(px(above + 0.0001)), rebuilt)).toBe(false);
    },
  );

  it.each(['open', 'high', 'low', 'close'] as const)(
    'a bar whose %s alone lies outside the band is outside it',
    (field) => {
      const bar = { ...flat('6700.5000'), [field]: '6767.5000' };

      expect(
        inKeepBand('ES', bar, ohlc('6700.000000000', '6701.500000000')),
      ).toBe(false);
    },
  );

  it('a bar inside the band on all four prices is inside, whatever order its own prices take', () => {
    expect(
      inKeepBand(
        'ES',
        {
          open: '6701.5000',
          high: '6701.5000',
          low: '6700.0000',
          close: '6700.7500',
        },
        ohlc('6700.000000000', '6701.500000000'),
      ),
    ).toBe(true);
  });

  it('compares prices as numbers, not as text: CL 99.0000 lies inside 98 to 100.2', () => {
    // As text "99.0000" > "100.200000000", which would put it outside.
    expect(
      inKeepBand('CL', flat('99.0000'), ohlc('98.000000000', '100.200000000')),
    ).toBe(true);
    expect(
      inKeepBand('CL', flat('9.0000'), ohlc('98.000000000', '100.200000000')),
    ).toBe(false);
  });
});

describe('planRepair', () => {
  const PIECES: SessionPiece[] = [
    {
      contract: 'ESU6',
      fromMs: Date.parse('2026-09-15T00:00:00Z'),
      toMs: Date.parse('2026-09-16T00:00:00Z'),
    },
  ];
  const T = (hhmm: string) => `2026-09-15T${hhmm}:00.000Z`;

  function bar(
    hhmm: string,
    px: string,
    over: Partial<StoredFuturesBar> = {},
  ): StoredFuturesBar {
    return {
      ts: T(hhmm),
      open: px,
      high: px,
      low: px,
      close: px,
      volume: 5,
      buyVolume: 5,
      sellVolume: 0,
      buyPrints: 1,
      sellPrints: 0,
      contract: null,
      ...over,
    };
  }

  function minute(
    hhmm: string,
    low: string,
    high = low,
    over: Partial<FlowMinute> = {},
    contract = 'ESU6',
  ): [string, PagedMinute] {
    return [
      T(hhmm),
      {
        contract,
        minute: {
          ts: T(hhmm),
          volume: 3,
          buyVolume: 3,
          sellVolume: 0,
          buyPrints: 1,
          sellPrints: 0,
          sideSeen: true,
          ohlc: { open: low, high, low, close: high },
          ...over,
        },
      },
    ];
  }

  function plan(
    stored: StoredFuturesBar[],
    minutes: Array<[string, PagedMinute]>,
    over: { pieces?: SessionPiece[]; holdDeletes?: boolean } = {},
  ) {
    return planRepair({
      root: 'ES',
      stored,
      minutes: new Map(minutes),
      pieces: over.pieces ?? PIECES,
      holdDeletes: over.holdDeletes ?? false,
    });
  }

  it('sorts a day into keep, keep+tag, rewrite, delete and fill', () => {
    const p = plan(
      [
        bar('14:00', '6700.2500'), // in band, untagged → keep+tag
        bar('14:01', '6767.2500'), // ESZ6 prices (~67 points up) → rewrite
        bar('14:02', '6700.2500'), // the scheduled contract printed nothing → delete
        bar('14:03', '6700.7500'), // a websocket-short bar inside the REST band → keep+tag
        bar('14:05', '6700.2500', { contract: 'ESU6' }), // in band, tagged → keep
      ],
      [
        minute('14:00', '6700.250000000'),
        minute('14:01', '6700.250000000'),
        minute('14:03', '6700.000000000', '6701.500000000'),
        minute('14:04', '6700.500000000'), // no bar → fill
        minute('14:05', '6700.250000000'),
      ],
    );

    expect(p.keep).toBe(1);
    expect(p.tags.map((t) => [t.old.ts, t.contract])).toEqual([
      [T('14:00'), 'ESU6'],
      [T('14:03'), 'ESU6'],
    ]);
    expect(p.rewrites.map((r) => r.old.ts)).toEqual([T('14:01')]);
    expect(p.deletes.map((d) => d.ts)).toEqual([T('14:02')]);
    expect(p.fills.map((f) => f.ts)).toEqual([T('14:04')]);
    expect(p).toMatchObject({ held: 0, unjudged: 0, unbuildable: 0 });
  });

  it('a rewrite carries the rebuilt prices, volume, flow and the scheduled contract, whatever contract the stored bar held', () => {
    const p = plan(
      [
        bar('14:01', '6767.2500', { contract: 'ESZ6' }),
        bar('14:02', '6767.2500', { contract: null }),
      ],
      [
        minute('14:01', '6700.250000000', '6702.500000000', {
          volume: 9,
          buyVolume: 4,
          sellVolume: 5,
          buyPrints: 2,
          sellPrints: 3,
        }),
        minute('14:02', '6700.250000000'),
      ],
    );

    expect(p.rewrites).toHaveLength(2);
    expect(p.rewrites[0]!.bar).toEqual({
      ts: T('14:01'),
      open: '6700.250000000',
      high: '6702.500000000',
      low: '6700.250000000',
      close: '6702.500000000',
      volume: 9,
      buyVolume: 4,
      sellVolume: 5,
      buyPrints: 2,
      sellPrints: 3,
      contract: 'ESU6',
    });
    expect(p.rewrites[1]!.bar.contract).toBe('ESU6');
  });

  it('a rebuilt minute with no known side rewrites to NULL flow, as the live handler stores it', () => {
    const p = plan(
      [bar('14:01', '6767.2500')],
      [
        minute('14:01', '6700.250000000', '6700.250000000', {
          sideSeen: false,
        }),
      ],
    );

    expect(p.rewrites[0]!.bar).toMatchObject({
      buyVolume: null,
      sellVolume: null,
      buyPrints: null,
      sellPrints: null,
    });
  });

  it('an in-band bar tagged with another contract is left alone: the tag only fills a NULL', () => {
    const p = plan(
      [bar('14:00', '6700.2500', { contract: 'ESZ6' })],
      [minute('14:00', '6700.250000000')],
    );

    expect(p.keep).toBe(1);
    expect(p.tags).toEqual([]);
    expect(p.rewrites).toEqual([]);
  });

  it('counts the kept bars tagged with another contract apart (keepOtherTag, a subset of keep): not the scheduled one, a NULL one, or one with no storable scheduled name', () => {
    const p = plan(
      [
        bar('14:00', '6700.2500', { contract: 'ESZ6' }), // another contract
        bar('14:01', '6700.2500', { contract: 'ESU6' }), // the scheduled one
        bar('14:02', '6700.2500'), // NULL: tagged, not kept
        bar('14:03', '6700.2500', { contract: 'ESZ6' }), // scheduled name unstorable
      ],
      [
        minute('14:00', '6700.250000000'),
        minute('14:01', '6700.250000000'),
        minute('14:02', '6700.250000000'),
        minute('14:03', '6700.250000000', '6700.250000000', {}, 'NQU6'),
      ],
    );

    expect(p.keep).toBe(3);
    expect(p.keepOtherTag).toBe(1);
    expect(p.tags.map((t) => t.old.ts)).toEqual([T('14:02')]);
  });

  it('a fill carries the rebuilt bar and the scheduled contract', () => {
    const p = plan([], [minute('14:04', '6700.500000000', '6700.750000000')]);

    expect(p.fills).toEqual([
      {
        ts: T('14:04'),
        open: '6700.500000000',
        high: '6700.750000000',
        low: '6700.500000000',
        close: '6700.750000000',
        volume: 3,
        buyVolume: 3,
        sellVolume: 0,
        buyPrints: 1,
        sellPrints: 0,
        contract: 'ESU6',
      },
    ]);
  });

  it('a minute whose prints have no usable price is not filled (counted unbuildable) and a stored bar there is left alone (counted unjudged)', () => {
    const noPrice = { ohlc: null };
    const p = plan(
      [bar('14:01', '6700.2500')],
      [
        minute('14:00', '6700.250000000', '6700.250000000', noPrice),
        minute('14:01', '6700.250000000', '6700.250000000', noPrice),
      ],
    );

    expect(p.fills).toEqual([]);
    expect(p).toMatchObject({
      unbuildable: 1,
      unjudged: 1,
      keep: 0,
    });
    expect(p.tags).toEqual([]);
    expect(p.rewrites).toEqual([]);
    expect(p.deletes).toEqual([]);
  });

  it('a stored bar in a minute the market is closed (the 16:00 CT halt) or outside every piece (an undecided date) is unjudged, never deleted', () => {
    const p = plan(
      [
        bar('21:30', '6700.2500'), // 16:30 CDT, in the halt: inside the merged piece
        bar('14:00', '6700.2500'), // outside the one piece below
      ],
      [],
      {
        pieces: [
          {
            contract: 'ESU6',
            fromMs: Date.parse('2026-09-15T15:00:00Z'),
            toMs: Date.parse('2026-09-16T00:00:00Z'),
          },
        ],
      },
    );

    expect(p.unjudged).toBe(2);
    expect(p.deletes).toEqual([]);
  });

  it('holdDeletes keeps a bar with no rebuilt minute and counts it held instead of deleting it', () => {
    const p = plan(
      [bar('14:02', '6700.2500')],
      [minute('14:00', '6700.250000000')],
      { holdDeletes: true },
    );

    expect(p.deletes).toEqual([]);
    expect(p.held).toBe(1);
  });

  it('a scheduled name that is no outright of the root is never written: no tag, a NULL contract on a rewrite or fill, and the name is listed', () => {
    const p = plan(
      [bar('14:00', '6700.2500'), bar('14:01', '6767.2500')],
      [
        minute('14:00', '6700.250000000', '6700.250000000', {}, 'NQU6'),
        minute('14:01', '6700.250000000', '6700.250000000', {}, 'NQU6'),
        minute('14:02', '6700.250000000', '6700.250000000', {}, 'NQU6'),
      ],
    );

    expect(p.tags).toEqual([]);
    expect(p.keep).toBe(1);
    expect(p.rewrites[0]!.bar.contract).toBeNull();
    expect(p.fills[0]!.contract).toBeNull();
    expect(p.unstorable).toEqual(['NQU6']);
  });
});

// ── --repair: the run ─────────────────────────────────────

describe('runRepair', () => {
  const M = (mm: string) => `2026-09-15T14:${mm}:00.000Z`;
  const RUN_ID = '2026-11-06T23-00-00Z'; // NOW, as a file name

  type WriteKind = 'update' | 'tag' | 'delete' | 'insert';

  function sqlKind(strings: readonly string[]): WriteKind | 'read' | 'other' {
    const text = strings.join('?');
    if (text.includes('DELETE FROM futures_bars')) return 'delete';
    if (/UPDATE futures_bars[\s\S]*SET\s+open/.test(text)) return 'update';
    if (text.includes('UPDATE futures_bars')) return 'tag';
    if (text.includes('INSERT INTO futures_bars')) return 'insert';
    if (text.includes('FROM futures_bars')) return 'read';
    return 'other';
  }

  interface RepairSql {
    /** Per write kind, how many of the first minutes the guard turns away. */
    miss?: Partial<Record<WriteKind, number>>;
    /** A write kind whose statement rejects. */
    reject?: WriteKind;
    /** Called at the start of every write statement. */
    onWrite?: (kind: WriteKind) => void;
  }

  /** Routes the DB: reads by root, and every write answers RETURNING ts. */
  function routeRepairSql(
    stored: Record<string, unknown[]> = {},
    o: RepairSql = {},
  ): void {
    mockSql.mockImplementation(
      async (strings: readonly string[], ...values: unknown[]) => {
        const kind = sqlKind(strings);
        if (kind === 'read') return stored[values[0] as string] ?? [];
        if (kind === 'other') return [];
        o.onWrite?.(kind);
        if (o.reject === kind) throw new Error(`${kind} rejected`);
        const ts = (kind === 'insert' ? values[1] : values[0]) as string[];
        return ts.slice(o.miss?.[kind] ?? 0).map((t) => ({ ts: t }));
      },
    );
  }

  function writes(kind: WriteKind): unknown[][] {
    return mockSql.mock.calls
      .filter((c) => sqlKind(c[0] as readonly string[]) === kind)
      .map((c) => c.slice(1));
  }

  const allWrites = () =>
    (['update', 'tag', 'delete', 'insert'] as const).flatMap((k) => writes(k));

  /** The columns of the UPDATE (rewrite) statement `i`. */
  function rewritten(i = 0) {
    const v = writes('update')[i]!;
    return {
      ts: v[0] as string[],
      open: v[1] as string[],
      high: v[2] as string[],
      low: v[3] as string[],
      close: v[4] as string[],
      volume: v[5] as number[],
      buyVolume: v[6] as Array<number | null>,
      sellVolume: v[7] as Array<number | null>,
      buyPrints: v[8] as Array<number | null>,
      sellPrints: v[9] as Array<number | null>,
      contract: v[10] as Array<string | null>,
      wasOpen: v[11] as string[],
      wasClose: v[12] as string[],
      symbol: v[13],
    };
  }

  function tagged(i = 0) {
    const v = writes('tag')[i]!;
    return {
      ts: v[0] as string[],
      contract: v[1] as string[],
      wasOpen: v[2] as string[],
      wasClose: v[3] as string[],
      symbol: v[4],
    };
  }

  function deleted(i = 0) {
    const v = writes('delete')[i]!;
    return {
      ts: v[0] as string[],
      wasOpen: v[1] as string[],
      wasClose: v[2] as string[],
      symbol: v[3],
    };
  }

  /** A stored ES bar at 14:`mm`, flat at `px`, no contract unless given. */
  function sRow(mm: string, px: string, over: Record<string, unknown> = {}) {
    return storedRow(`2026-09-15T14:${mm}:00Z`, {
      open: px,
      high: px,
      low: px,
      close: px,
      contract: null,
      ...over,
    });
  }

  /**
   * A day with every class in it. Scheduled contract ESU6 all day.
   *  14:00 in band, untagged            → keep+tag
   *  14:01 ESZ6 prices (~67 pts higher) → rewrite
   *  14:02 ESU6 printed nothing         → delete
   *  14:03 websocket-short (one of the three prints) → keep+tag
   *  14:04 no bar                       → fill
   *  14:05 in band, already ESU6        → keep
   */
  function scenarioStored() {
    return [
      sRow('00', '6700.2500'),
      sRow('01', '6767.2500'),
      sRow('02', '6700.2500'),
      sRow('03', '6700.7500'),
      sRow('05', '6700.2500', { contract: 'ESU6' }),
    ];
  }

  const SCENARIO_PRINTS = [
    print(11, '2026-09-15T14:05:20.000000Z', 1, 'buy', '6700.250000000'),
    print(10, '2026-09-15T14:04:30.000000Z', 2, 'buy', '6700.500000000'),
    print(9, '2026-09-15T14:03:50.000000Z', 1, 'sell', '6700.750000000'),
    print(8, '2026-09-15T14:03:30.000000Z', 1, 'buy', '6701.500000000'),
    print(7, '2026-09-15T14:03:10.000000Z', 1, 'buy', '6700.000000000'),
    print(6, '2026-09-15T14:01:30.000000Z', 3, 'buy', '6700.250000000'),
    print(5, '2026-09-15T14:00:30.000000Z', 5, 'buy', '6700.250000000'),
    ENDER,
  ];

  let workDir: string;
  const repair = (over: Partial<BarBackfillOptions> = {}) =>
    run({ repair: true, workDir, ...over });

  const backupFiles = () =>
    existsSync(workDir)
      ? readdirSync(workDir).filter((f) =>
          /^front-month-repair-.*\.jsonl$/.test(f),
        )
      : [];
  const backupLines = () =>
    backupFiles()
      .flatMap((f) => readFileSync(join(workDir, f), 'utf8').split('\n'))
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const cachePath = (root = 'ES', date = DAY) =>
    join(workDir, 'front-month-repair-cache', `${root}-${date}.json`);
  const readCache = (root = 'ES', date = DAY) =>
    JSON.parse(readFileSync(cachePath(root, date), 'utf8')) as {
      version: number;
      root: string;
      date: string;
      pieces: Array<{ contract: string; fromMs: number; toMs: number }>;
      malformed: number;
      minutes: Array<{ contract: string; minute: FlowMinute }>;
    };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'bar-repair-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('classification', () => {
    it('--repair --dry-run counts every class, writes nothing and creates no backup', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      const code = await repair({ dryRun: true });

      expect(code).toBe(0);
      expect(allWrites()).toEqual([]);
      expect(backupFiles()).toEqual([]);
      expect(out()).toMatch(/REPAIR.*DRY RUN/);
      expect(out()).toMatch(
        /ES 2026-09-15 {2}stored 5 {2}keep 1 {2}keep\+tag 2 {2}rewrite 1 {2}delete 1 {2}fill 1 /,
      );
      expect(out()).toMatch(
        /^ {2}ES {2}stored 5 {2}keep 1 {2}keep\+tag 2 {2}rewrite 1 {2}delete 1 {2}fill 1$/m,
      );
    });

    it('a write run rewrites, deletes, tags and fills exactly the classified minutes, each guarded by the open and close it read', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      const code = await repair();

      expect(code).toBe(0);
      expect(writes('update')).toHaveLength(1);
      expect(rewritten()).toEqual({
        ts: [M('01')],
        open: ['6700.250000000'],
        high: ['6700.250000000'],
        low: ['6700.250000000'],
        close: ['6700.250000000'],
        volume: [3],
        buyVolume: [3],
        sellVolume: [0],
        buyPrints: [1],
        sellPrints: [0],
        contract: ['ESU6'],
        wasOpen: ['6767.2500'],
        wasClose: ['6767.2500'],
        symbol: 'ES',
      });
      expect(writes('delete')).toHaveLength(1);
      expect(deleted()).toEqual({
        ts: [M('02')],
        wasOpen: ['6700.2500'],
        wasClose: ['6700.2500'],
        symbol: 'ES',
      });
      // The websocket-short bar is kept and tagged; the already-tagged bar
      // (14:05) is not written at all.
      expect(writes('tag')).toHaveLength(1);
      expect(tagged()).toEqual({
        ts: [M('00'), M('03')],
        contract: ['ESU6', 'ESU6'],
        wasOpen: ['6700.2500', '6700.7500'],
        wasClose: ['6700.2500', '6700.7500'],
        symbol: 'ES',
      });
      expect(writes('insert')).toHaveLength(1);
      const fill = writes('insert')[0]!;
      expect(fill[0]).toBe('ES');
      expect(fill[1]).toEqual([M('04')]);
      expect(fill[11]).toEqual(['ESU6']);
      expect(out()).toMatch(/wrote rewrite 1 {2}delete 1 {2}tag 2 {2}fill 1/);
      expect(out()).toMatch(/Done: rewrote 1, deleted 1, tagged 2, filled 1;/);
    });

    it('never decides a front month: no volume refresh and no schedule call, even in a write run', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair();

      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockStored).toHaveBeenCalledWith('ES', '2026-09-15', '2026-09-16');
    });

    it.each([
      ['a write run', {}],
      ['a dry run', { dryRun: true }],
    ])(
      'an undecided trade date fails the root-day by name before anything is paged or written, and the run exits 1 (%s)',
      async (_mode, over) => {
        routeFrontMonth({}, ['2026-09-16']);
        routeRepairSql({
          ES: [
            sRow('00', '6700.2500'),
            // Trade date 2026-09-16 (after the 17:00 CT open at 22:00Z).
            storedRow('2026-09-15T22:30:00Z', { contract: null }),
          ],
        });
        routeTrades({
          ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 5, 'buy'), ENDER]],
        });

        const code = await repair(over);

        expect(code).toBe(1);
        expect(out()).toMatch(
          /ES 2026-09-15 FAILED: ES: no stored front month for 2026-09-16; run scripts\/backfill-futures-front-month\.ts \(after 0 pages\)/,
        );
        expect(out()).toMatch(/Failed root-days: ES 2026-09-15$/m);
        expect(mockUwFetch).not.toHaveBeenCalled();
        expect(allWrites()).toEqual([]);
        expect(backupLines()).toEqual([]);
        expect(existsSync(cachePath())).toBe(false);
        // The repair reads the front-month table; it never decides a date.
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(mockSchedule).not.toHaveBeenCalled();
        expect(out()).not.toMatch(/undecided trade dates/);
      },
    );

    it('a root with an undecided date fails only its own root-day; another root still repairs', async () => {
      mockStored.mockImplementation(
        async (root: string, from: string, to: string) => {
          const stored = new Map<string, string>();
          for (let d = from; d <= to; d = nextDay(d)) {
            if (root !== 'ES' || d !== '2026-09-16') {
              stored.set(d, `${root}U6`);
            }
          }
          return stored;
        },
      );
      routeRepairSql({ ES: scenarioStored(), NQ: [] });
      routeTrades({ NQU6: [[ENDER]] });

      const code = await repair({ roots: ['ES', 'NQ'] });

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: ES: no stored front month/);
      expect(out()).toMatch(/NQ 2026-09-15 {2}stored 0 /);
    });

    it('a stored bar tagged with another contract and inside the band is left alone, and counted as keep-other-tag', async () => {
      routeRepairSql({ ES: [sRow('00', '6700.2500', { contract: 'ESZ6' })] });
      routeTrades({
        ESU6: [[print(5, '2026-09-15T14:00:30.000000Z', 5, 'buy'), ENDER]],
      });

      await repair();

      expect(allWrites()).toEqual([]);
      expect(out()).toMatch(/stored 1 {2}keep 1 {2}keep\+tag 0 /);
      expect(out()).toMatch(/ES 2026-09-15 .* keep-other-tag 1 /);
      expect(out()).toMatch(/^ {2}ES {2}stored 1 .* keep-other-tag 1$/m);
      expect(out()).toMatch(/keep-other-tag 1; /);
    });

    it('a rewrite sets the scheduled contract over a stored one that was tagged wrongly', async () => {
      routeRepairSql({ ES: [sRow('01', '6767.2500', { contract: 'ESZ6' })] });
      routeTrades({
        ESU6: [[print(6, '2026-09-15T14:01:30.000000Z', 3, 'buy'), ENDER]],
      });

      await repair();

      expect(rewritten().contract).toEqual(['ESU6']);
      expect(rewritten().ts).toEqual([M('01')]);
    });

    it('prints the first few rewrites and deletes: minute, contract, old and rebuilt OHLC', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair({ dryRun: true });

      expect(out()).toMatch(
        /^ {4}rewrite 14:01:00Z ESU6 {2}stored o6767\.2500 h6767\.2500 l6767\.2500 c6767\.2500 {2}rebuilt o6700\.2500 h6700\.2500 l6700\.2500 c6700\.2500$/m,
      );
      expect(out()).toMatch(
        /^ {4}delete 14:02:00Z ESU6 {2}stored o6700\.2500 h6700\.2500 l6700\.2500 c6700\.2500 {2}no counted print$/m,
      );
    });

    it('prints at most three rewrites per root-day', async () => {
      routeRepairSql({
        ES: [0, 1, 2, 3, 4].map((m) => sRow(`0${m}`, '6767.2500')),
      });
      routeTrades({
        ESU6: [
          [
            ...[4, 3, 2, 1, 0].map((m) =>
              print(m + 2, `2026-09-15T14:0${m}:30.000000Z`, 1, 'buy'),
            ),
            ENDER,
          ],
        ],
      });

      await repair({ dryRun: true });

      expect(logs.filter((l) => /^ {4}rewrite /.test(l))).toHaveLength(3);
      expect(out()).toMatch(/rewrite 5 /);
    });

    it('compares the band as numbers: CL stored at 99.0000 inside a rebuilt 98 to 100.2 is kept', async () => {
      routeRepairSql({ CL: [sRow('00', '99.0000')] });
      routeTrades({
        CLU6: [
          [
            print(4, '2026-09-15T14:00:50.000000Z', 1, 'buy', '100.200000000'),
            print(3, '2026-09-15T14:00:10.000000Z', 1, 'buy', '98.000000000'),
            ENDER,
          ],
        ],
      });

      await repair({ roots: ['CL'], dryRun: true });

      expect(out()).toMatch(
        /CL 2026-09-15 {2}stored 1 {2}keep 0 {2}keep\+tag 1 {2}rewrite 0 /,
      );
    });
  });

  describe('safety', () => {
    it('writes the backup before the first write: every row to be rewritten, deleted or tagged is on disk, in full, when the first statement runs', async () => {
      let atFirstWrite: Array<Record<string, unknown>> | null = null;
      let atFirstWriteLogs = -1;
      routeRepairSql(
        { ES: scenarioStored() },
        {
          onWrite: () => {
            if (atFirstWrite === null) {
              atFirstWrite = backupLines();
              atFirstWriteLogs = logs.length;
            }
          },
        },
      );
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair();

      expect(backupFiles()).toEqual([`front-month-repair-${RUN_ID}.jsonl`]);
      const seen = atFirstWrite as Array<Record<string, unknown>> | null;
      expect(seen).not.toBeNull();
      expect(
        seen!.map((l) => [
          l.action,
          (l.row as { ts: string } | undefined)?.ts ??
            (l.after as { ts: string }).ts,
        ]),
      ).toEqual([
        ['rewrite', M('01')],
        ['delete', M('02')],
        ['tag', M('00')],
        ['tag', M('03')],
        ['fill', M('04')],
      ]);
      // The backup path is printed before the first write.
      const pathLine = logs.findIndex((l) =>
        l.includes(`front-month-repair-${RUN_ID}.jsonl`),
      );
      expect(pathLine).toBeGreaterThanOrEqual(0);
      expect(pathLine).toBeLessThan(atFirstWriteLogs);
    });

    it('records each changed row in full, with its new values, so the run can be undone', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair();

      const lines = backupLines();
      expect(lines.every((l) => l.runId === RUN_ID && l.symbol === 'ES')).toBe(
        true,
      );
      const rewrite = lines.find((l) => l.action === 'rewrite')!;
      expect(rewrite.row).toEqual({
        ts: M('01'),
        open: '6767.2500',
        high: '6767.2500',
        low: '6767.2500',
        close: '6767.2500',
        volume: 5,
        buyVolume: 5,
        sellVolume: 0,
        buyPrints: 1,
        sellPrints: 0,
        contract: null,
      });
      expect(rewrite.after).toMatchObject({
        ts: M('01'),
        open: '6700.250000000',
        contract: 'ESU6',
      });
      const del = lines.find((l) => l.action === 'delete')!;
      expect(del.row).toMatchObject({ ts: M('02'), open: '6700.2500' });
      const tag = lines.find((l) => l.action === 'tag')!;
      expect(tag.row).toMatchObject({ ts: M('00'), contract: null });
      expect(tag.after).toEqual({ contract: 'ESU6' });
      expect(lines.find((l) => l.action === 'fill')!.after).toMatchObject({
        ts: M('04'),
        contract: 'ESU6',
      });
    });

    it('appends: a second run in the same second keeps the first run’s lines', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair();
      const first = backupLines().length;
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair();

      expect(backupLines().length).toBe(first * 2);
    });

    it('a write that matches no row (the guard turned it away) is reported as changed since the read, not as written', async () => {
      routeRepairSql(
        { ES: scenarioStored() },
        { miss: { update: 1, delete: 1, tag: 1 } },
      );
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      const code = await repair();

      expect(code).toBe(0);
      expect(out()).toMatch(
        /wrote rewrite 0 {2}delete 0 {2}tag 1 {2}fill 1 {2}changed since read 3/,
      );
      expect(out()).toMatch(/Done: rewrote 0, deleted 0, tagged 1, filled 1;/);
      // The total the owner reads on the one line that is easy to find.
      expect(out()).toMatch(
        /Done: .*; planned 5, applied 2 \(changed since read 3\); held 0, /,
      );
    });

    it('a write run that applied everything it planned says so on the Done line, and a dry run has no planned/applied clause', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair();
      const write = out();
      logs.length = 0;
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair({ dryRun: true });

      expect(write).toMatch(
        /Done: rewrote 1, deleted 1, tagged 2, filled 1; planned 5, applied 5 \(changed since read 0\); held 0, unjudged 0, unbuildable 0, keep-other-tag 0; /,
      );
      expect(out()).toMatch(
        /Done: would rewrite 1, delete 1, tag 2, fill 1; held 0, unjudged 0, unbuildable 0, keep-other-tag 0; /,
      );
      expect(out()).not.toMatch(/planned \d+, applied/);
    });

    it('the Done line totals what a clean second dry run must show as zero: held, unjudged, unbuildable and keep-other-tag, over every root-day', async () => {
      // 14:02 and 14:03 have no rebuilt minute (held: the malformed print
      // withholds 14:01 and the day is not trusted); 14:04 has prints with
      // no usable price (unbuildable); the 21:30Z halt bar is unjudged;
      // 14:05 is kept with another contract.
      routeRepairSql({
        ES: [
          sRow('02', '6700.2500'),
          sRow('03', '6700.2500'),
          sRow('05', '6700.2500', { contract: 'ESZ6' }),
          storedRow('2026-09-15T21:30:00Z', { contract: null }),
        ],
      });
      routeTrades({
        ESU6: [
          [
            print(8, '2026-09-15T14:05:30.000000Z', 1, 'buy'),
            print(7, '2026-09-15T14:04:30.000000Z', 1, 'buy', null),
            print(6, '2026-09-15T14:01:30.000000Z', 1, 'up'), // malformed
            ENDER,
          ],
        ],
      });

      await repair({ dryRun: true });

      expect(out()).toMatch(
        /Done: would rewrite 0, delete 0, tag 0, fill 0; held 2, unjudged 1, unbuildable 1, keep-other-tag 1; /,
      );
      expect(out()).toMatch(
        /^ {2}ES {2}stored 4 {2}keep 1 {2}keep\+tag 0 {2}rewrite 0 {2}delete 0 {2}fill 0 {2}held 2 {2}unjudged 1 {2}unbuildable 1 {2}keep-other-tag 1$/m,
      );
    });

    it('a rejected backup directory fails the run before any read, page or write', async () => {
      const blocker = join(workDir, 'blocker');
      writeFileSync(blocker, 'a file where the directory should be');
      routeRepairSql({ ES: scenarioStored() });

      const code = await repair({ workDir: join(blocker, 'run') });

      expect(code).toBe(1);
      expect(out()).toMatch(/Cannot create the backup file/);
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockUwFetch).not.toHaveBeenCalled();
    });

    it('a dry run does not need the directory: an unwritable one costs the cache only, with a warning', async () => {
      const blocker = join(workDir, 'blocker');
      writeFileSync(blocker, 'a file where the directory should be');
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      const code = await repair({
        dryRun: true,
        workDir: join(blocker, 'run'),
      });

      expect(code).toBe(0);
      expect(out()).toMatch(/WARNING: could not write the cache/);
      expect(out()).toMatch(/rewrite 1 /);
    });

    it.each<[WriteKind, string]>([
      ['update', 'rewrite'],
      ['delete', 'delete'],
      ['tag', 'tag'],
      ['insert', 'fill'],
    ])(
      'a rejected %s fails the root-day and the exit code; the statements after it are not attempted',
      async (kind) => {
        routeRepairSql({ ES: scenarioStored() }, { reject: kind });
        routeTrades({ ESU6: [SCENARIO_PRINTS] });

        const code = await repair();

        expect(code).toBe(1);
        expect(out()).toMatch(
          new RegExp(`ES 2026-09-15 FAILED: ${kind} rejected`),
        );
        expect(out()).toMatch(/Failed root-days: ES 2026-09-15$/m);
        expect(logs).toContain(
          `Re-run with 2026-09-15 --roots ES --max-pages 20000 --repair --work-dir ${workDir}`,
        );
        // Statements run update, delete, tag, insert: none after the failure.
        const order = ['update', 'delete', 'tag', 'insert'] as const;
        for (const later of order.slice(order.indexOf(kind) + 1)) {
          expect(writes(later)).toEqual([]);
        }
      },
    );

    it('a failed read of the stored bars fails the root-day before any UW call or write', async () => {
      mockSql.mockRejectedValue(new Error('connection terminated'));

      const code = await repair();

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: connection terminated/);
      expect(mockUwFetch).not.toHaveBeenCalled();
    });

    it('a UW failure fails the root-day with nothing written; the other roots still run', async () => {
      routeRepairSql({ ES: scenarioStored(), NQ: [] });
      mockUwFetch.mockImplementation(async (_key: string, path: string) => {
        if (path.startsWith('/futures/ESU6/'))
          throw new Error('UW API 502: bad gateway');
        return [];
      });

      const code = await repair({ roots: ['ES', 'NQ'] });

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: UW API 502/);
      expect(out()).toMatch(/NQ 2026-09-15 {2}stored 0 /);
      expect(writes('update')).toEqual([]);
      expect(writes('delete')).toEqual([]);
      expect(backupLines()).toEqual([]);
    });

    it('refuses to start during market hours', async () => {
      mockIsMarketHours.mockReturnValue(true);

      const code = await repair();

      expect(code).toBe(1);
      expect(out()).toMatch(/Refusing to run during market hours/);
      expect(mockSql).not.toHaveBeenCalled();
      expect(backupFiles()).toEqual([]);
    });

    it('stops between dates once the page budget is spent, and the resume line keeps the repair flags', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      const code = await repair({
        dates: [DAY, '2026-09-16'],
        maxPages: 1,
        dryRun: true,
        noCache: true,
      });

      expect(code).toBe(1);
      expect(stopLine()).toMatch(/Page budget spent \(1 of 1\)/);
      expect(logs).toContain(
        `Incomplete: stopped before 2026-09-16. Resume with 2026-09-16 --roots ES --max-pages 1 --repair --dry-run --no-cache --work-dir ${workDir}`,
      );
    });

    describe('a relative work dir', () => {
      // The run's current directory is the test's temp dir, a real chdir, so
      // a relative path that were opened without being resolved would still
      // land in the temp dir and never in the repo. afterEach runs before
      // the outer one that removes the temp dir (Windows cannot remove the
      // current directory).
      let startDir: string;
      beforeEach(() => {
        startDir = process.cwd();
        process.chdir(workDir);
      });
      afterEach(() => {
        process.chdir(startDir);
      });

      it('the re-run line names the work dir in full even when it is the default, so a re-run from another directory finds the same cache and backup', async () => {
        mockSql.mockRejectedValue(new Error('connection terminated'));

        // Fails on the first read, before any cache file is touched.
        await run({ repair: true, dryRun: true, workDir: DEFAULT_WORK_DIR });

        expect(logs).toContain(
          `Re-run with 2026-09-15 --roots ES --max-pages 20000 --repair --dry-run --work-dir ${resolve(DEFAULT_WORK_DIR)}`,
        );
        expect(isAbsolute(resolve(DEFAULT_WORK_DIR))).toBe(true);
        expect(existsSync(join(workDir, 'docs'))).toBe(false);
      });

      it('is resolved against the current directory: the backup, the printed paths and the re-run line are all absolute', async () => {
        routeRepairSql({ ES: scenarioStored() }, { reject: 'insert' });
        routeTrades({ ESU6: [SCENARIO_PRINTS] });

        const code = await repair({ workDir: join('out', 'run') });

        const dir = join(workDir, 'out', 'run');
        const backup = join(dir, `front-month-repair-${RUN_ID}.jsonl`);
        expect(code).toBe(1);
        expect(existsSync(backup)).toBe(true);
        expect(logs).toContain(
          `Backup of every row this run rewrites, deletes or tags, and every fill: ${backup}`,
        );
        expect(logs).toContain(
          `Re-run with 2026-09-15 --roots ES --max-pages 20000 --repair --work-dir ${dir}`,
        );
        // The cache went to the same absolute place.
        expect(
          existsSync(
            join(dir, 'front-month-repair-cache', 'ES-2026-09-15.json'),
          ),
        ).toBe(true);
      });

      it('an unwritable one is named in full in the refusal', async () => {
        const blocker = join(workDir, 'blocker');
        writeFileSync(blocker, 'a file where the directory should be');

        const code = await repair({ workDir: join('blocker', 'run') });

        expect(code).toBe(1);
        expect(out()).toContain(
          `Cannot create the backup file in ${join(blocker, 'run')}:`,
        );
      });
    });
  });

  describe('deletes are held when the rebuilt day may be missing minutes', () => {
    it('a malformed print withholds its minute, so a stored bar there is held, not deleted', async () => {
      routeRepairSql({
        ES: [sRow('01', '6767.2500'), sRow('02', '6767.2500')],
      });
      routeTrades({
        ESU6: [
          [
            print(4, '2026-09-15T14:02:30.000000Z', 1, 'buy'),
            print(3, '2026-09-15T14:01:30.000000Z', 1, 'up'), // malformed
            print(2, '2026-09-15T14:00:30.000000Z', 1, 'buy'),
            ENDER,
          ],
        ],
      });

      const code = await repair();

      expect(code).toBe(0);
      expect(writes('delete')).toEqual([]);
      expect(out()).toMatch(/delete 0 {2}fill 1 .*held 1 /);
      expect(out()).toMatch(/malformed 1 /);
    });

    it('a day on which the scheduled contract printed nothing at all holds every delete: it is a hole in UW, not 1,380 gaps', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [[]] });

      const code = await repair();

      expect(code).toBe(0);
      expect(allWrites()).toEqual([]);
      expect(out()).toMatch(/ES 2026-09-15 .*held 5 .*prints 0$/m);
    });

    it('a roll-day piece whose contract UW has no history for (an empty first page: exhausted) holds its deletes while the other piece repairs; nothing is cached', async () => {
      routeFrontMonth({ '2026-09-16': 'ESZ6' });
      routeRepairSql({
        ES: [
          sRow('00', '6700.2500'), // piece 1, ESU6: no rebuilt minute at all
          storedRow('2026-09-15T22:01:00Z', {
            // piece 2, ESZ6: rebuilt
            open: '6750.5000',
            high: '6750.5000',
            low: '6750.5000',
            close: '6750.5000',
            contract: null,
          }),
        ],
      });
      routeTrades({
        ESU6: [[]],
        ESZ6: [
          [
            print(
              10,
              '2026-09-15T22:01:30.000000Z',
              1,
              'sell',
              '6750.500000000',
            ),
            print(9, '2026-09-15T21:30:00.000000Z', 1, 'buy'),
          ],
        ],
      });

      const code = await repair();

      expect(code).toBe(0);
      // Without the hold the 14:00 bar is a delete: the piece printed nothing.
      expect(writes('delete')).toEqual([]);
      expect(out()).toMatch(
        /ES 2026-09-15 {2}stored 2 {2}keep 0 {2}keep\+tag 1 {2}rewrite 0 {2}delete 0 {2}fill 0 {2}held 1 /,
      );
      expect(tagged().ts).toEqual(['2026-09-15T22:01:00.000Z']);
      expect(out()).toMatch(/held 1, unjudged 0, /);
      expect(existsSync(cachePath())).toBe(false);
    });

    it('a minute withheld as untrustworthy (a page of only already-seen prints, no malformed print) holds the day’s deletes; nothing is cached', async () => {
      const burst = '2026-09-15T14:05:30.000000Z';
      const page = [
        print(13, burst, 1, 'buy'),
        print(12, burst, 1, 'buy'),
        print(11, burst, 1, 'buy'),
      ];
      routeRepairSql({
        ES: [
          sRow('00', '6700.2500'),
          sRow('05', '6700.2500'), // the withheld minute
          sRow('06', '6700.2500'),
        ],
      });
      routeTrades({
        ESU6: [
          page,
          page, // the +1 µs cursor returns the same prints: all seen
          [print(5, '2026-09-15T14:00:30.000000Z', 5, 'buy'), ENDER],
        ],
      });

      const code = await repair();

      expect(code).toBe(0);
      expect(writes('delete')).toEqual([]);
      expect(out()).toMatch(/ES 2026-09-15 .* held 2 .*malformed 0 /);
      expect(tagged().ts).toEqual([M('00')]);
      expect(existsSync(cachePath())).toBe(false);
    });

    it('a malformed print outside the piece (on the page that crosses its start) withholds no minute, but still holds the day’s deletes; the cache keeps that, so a later run holds too', async () => {
      routeRepairSql({
        ES: [sRow('00', '6700.2500'), sRow('02', '6700.2500')],
      });
      const pages = () => [
        [
          print(5, '2026-09-15T14:00:30.000000Z', 5, 'buy'),
          print(4, '2026-09-14T23:59:30.000000Z', 1, 'up'), // malformed, before 00:00Z
        ],
      ];
      routeTrades({ ESU6: pages() });

      await repair();

      expect(writes('delete')).toEqual([]);
      expect(out()).toMatch(/ES 2026-09-15 .* held 1 .*malformed 1 /);
      expect(readCache().malformed).toBe(1);
      logs.length = 0;
      mockUwFetch.mockClear();

      await repair();

      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(writes('delete')).toEqual([]);
      expect(out()).toMatch(/ES 2026-09-15 .* held 1 .*from cache/);
    });

    it('a root-day whose pieces were all paged back to their start and withheld nothing still deletes what the scheduled contract did not print', async () => {
      routeRepairSql({
        ES: [sRow('00', '6700.2500'), sRow('02', '6700.2500')],
      });
      routeTrades({
        ESU6: [[print(5, '2026-09-15T14:00:30.000000Z', 5, 'buy'), ENDER]],
      });

      await repair();

      expect(deleted().ts).toEqual([M('02')]);
      expect(out()).toMatch(/held 0 /);
    });
  });

  describe('the rebuild cache', () => {
    it('saves a completed root-day with its version, root, day, the contract paged for each piece, and the minutes', async () => {
      routeFrontMonth({ '2026-09-16': 'ESZ6' });
      routeRepairSql({ ES: [] });
      routeTrades({
        ESU6: [[print(2, '2026-09-15T14:00:30.000000Z', 2, 'buy'), ENDER]],
        ESZ6: [
          [
            print(
              10,
              '2026-09-15T22:01:30.000000Z',
              1,
              'sell',
              '6750.500000000',
            ),
            print(9, '2026-09-15T21:30:00.000000Z', 1, 'buy'),
          ],
        ],
      });

      await repair({ dryRun: true });

      const cache = readCache();
      expect(cache.version).toBe(REPAIR_CACHE_VERSION);
      expect(cache.root).toBe('ES');
      expect(cache.date).toBe(DAY);
      expect(cache.pieces).toEqual([
        {
          contract: 'ESU6',
          fromMs: Date.parse('2026-09-15T00:00:00Z'),
          toMs: Date.parse('2026-09-15T21:00:00Z'),
        },
        {
          contract: 'ESZ6',
          fromMs: Date.parse('2026-09-15T22:00:00Z'),
          toMs: Date.parse('2026-09-16T00:00:00Z'),
        },
      ]);
      expect(cache.minutes.map((m) => [m.contract, m.minute.ts])).toEqual([
        ['ESU6', M('00')],
        ['ESZ6', '2026-09-15T22:01:00.000Z'],
      ]);
      expect(cache.minutes[0]!.minute).toMatchObject({
        volume: 2,
        buyVolume: 2,
        ohlc: { open: PX },
      });
      expect(out()).toMatch(/0 root-days from the cache, 1 paged/);
    });

    it('a later run uses it: no UW call, the same classes, no pages charged, and the DB is still read', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      const readsBefore = mockSql.mock.calls.length;
      mockUwFetch.mockClear();
      logs.length = 0;

      const code = await repair();

      expect(code).toBe(0);
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(mockSql.mock.calls.length).toBeGreaterThan(readsBefore);
      expect(rewritten().ts).toEqual([M('01')]);
      expect(deleted().ts).toEqual([M('02')]);
      expect(out()).toMatch(/ES 2026-09-15 .* from cache/);
      expect(out()).not.toMatch(/ES 2026-09-15 .*pages \d/);
      expect(out()).toMatch(/1 root-days from the cache, 0 paged/);
    });

    it('the stored bars are never taken from the cache: a bar changed between runs is classified from the DB', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      // The wrong bar was fixed by someone else in the meantime.
      routeRepairSql({
        ES: [
          sRow('01', '6700.2500'),
          ...scenarioStored().filter((r) => r.ts.toISOString() !== M('01')),
        ],
      });
      logs.length = 0;

      await repair({ dryRun: true });

      expect(out()).toMatch(/ES 2026-09-15 .*rewrite 0 /);
      expect(out()).toMatch(/from cache/);
    });

    it('pages served from the cache do not count against --max-pages', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({
        ESU6: [
          SCENARIO_PRINTS,
          [print(20, '2026-09-16T14:00:30.000000Z', 1, 'buy'), ENDER],
        ],
      });
      await repair({ dryRun: true, dates: [DAY, '2026-09-16'], maxPages: 100 });
      logs.length = 0;

      const code = await repair({
        dryRun: true,
        dates: [DAY, '2026-09-16'],
        maxPages: 1,
      });

      // With a budget of 1 page, a paged second date would never start.
      expect(code).toBe(0);
      expect(stopLine()).toBeUndefined();
      expect(out()).toMatch(/2 root-days from the cache, 0 paged/);
    });

    it('--no-cache pages again and refreshes the file', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      mockUwFetch.mockClear();
      routeTrades({
        ESU6: [
          [
            print(5, '2026-09-15T14:00:30.000000Z', 7, 'buy', '6700.250000000'),
            ENDER,
          ],
        ],
      });

      await repair({ dryRun: true, noCache: true });

      expect(mockUwFetch).toHaveBeenCalled();
      expect(readCache().minutes.map((m) => m.minute.ts)).toEqual([M('00')]);
      expect(readCache().minutes[0]!.minute.volume).toBe(7);
    });

    it('a cache written for other contracts is not used: the day is paged again and the file overwritten', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      mockUwFetch.mockClear();
      // The schedule changed: 09-16 is now ESZ6, so the pieces differ.
      routeFrontMonth({ '2026-09-16': 'ESZ6' });
      routeTrades({
        ESU6: [SCENARIO_PRINTS],
        ESZ6: [[print(9, '2026-09-15T21:30:00.000000Z', 1, 'buy')]],
      });

      await repair({ dryRun: true });

      expect(tradesContracts()).toEqual(['ESU6', 'ESZ6']);
      expect(readCache().pieces.map((p) => p.contract)).toEqual([
        'ESU6',
        'ESZ6',
      ]);
    });

    it('a cache of another version is not used, and is not called corrupt: it is simply paged again and overwritten', async () => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      // Version 1 is what the first --repair commit wrote: that file could
      // hold a day with an exhausted piece or a withheld minute.
      expect(REPAIR_CACHE_VERSION).toBeGreaterThan(1);
      const stale = { ...readCache(), version: 1 };
      writeFileSync(cachePath(), JSON.stringify(stale));
      mockUwFetch.mockClear();
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      logs.length = 0;

      await repair({ dryRun: true });

      expect(mockUwFetch).toHaveBeenCalled();
      expect(out()).not.toMatch(/WARNING/);
      expect(readCache().version).toBe(REPAIR_CACHE_VERSION);
    });

    it.each<[string, (c: ReturnType<typeof readCache>) => unknown]>([
      ['another root', (c) => ({ ...c, root: 'NQ' })],
      ['another day', (c) => ({ ...c, date: '2026-09-14' })],
    ])('a cache file recording %s is not used', async (_what, tamper) => {
      routeRepairSql({ ES: scenarioStored() });
      routeTrades({ ESU6: [SCENARIO_PRINTS] });
      await repair({ dryRun: true });
      writeFileSync(cachePath(), JSON.stringify(tamper(readCache())));
      mockUwFetch.mockClear();
      routeTrades({ ESU6: [SCENARIO_PRINTS] });

      await repair({ dryRun: true });

      expect(mockUwFetch).toHaveBeenCalled();
    });

    it.each<[string, string]>([
      [
        'cut off mid-write',
        '{"version":1,"root":"ES","date":"2026-09-15","pie',
      ],
      ['not JSON at all', 'not json'],
      [
        'JSON of the wrong shape',
        JSON.stringify({
          version: REPAIR_CACHE_VERSION,
          root: 'ES',
          date: DAY,
          pieces: 'x',
          minutes: 3,
        }),
      ],
    ])(
      'a corrupt cache file (%s) is paged again with a warning, not a crash',
      async (_what, body) => {
        routeRepairSql({ ES: scenarioStored() });
        routeTrades({ ESU6: [SCENARIO_PRINTS] });
        mkdirSync(join(workDir, 'front-month-repair-cache'), {
          recursive: true,
        });
        writeFileSync(cachePath(), body);

        const code = await repair({ dryRun: true });

        expect(code).toBe(0);
        expect(mockUwFetch).toHaveBeenCalled();
        expect(out()).toMatch(/WARNING: .*ES-2026-09-15\.json.* is corrupt/);
        expect(out()).toMatch(/rewrite 1 /);
        expect(readCache().minutes.length).toBeGreaterThan(0);
      },
    );

    it('a root-day that hit the page budget writes no cache file', async () => {
      routeRepairSql({ ES: scenarioStored() });
      let call = 0;
      mockUwFetch.mockImplementation(async () => {
        call += 1;
        const at = new Date(Date.parse(`${DAY}T23:00:00Z`) - call * 1000);
        return [
          print(call, at.toISOString().replace('.000Z', '.000000Z'), 1, 'buy'),
        ];
      });

      const code = await repair({ dryRun: true });

      expect(code).toBe(1);
      expect(out()).toMatch(/ES 2026-09-15 FAILED: ESU6: more than 5000 pages/);
      expect(existsSync(cachePath())).toBe(false);
    });

    it('a root-day that failed on UW writes no cache file', async () => {
      routeRepairSql({ ES: scenarioStored() });
      mockUwFetch.mockRejectedValue(new Error('UW API 502: bad gateway'));

      await repair({ dryRun: true });

      expect(existsSync(cachePath())).toBe(false);
    });

    it('a day with no session (no piece) pages nothing and writes no cache file', async () => {
      routeRepairSql({ ES: [] });

      // Saturday 2026-09-19: the Globex is closed all day.
      const code = await repair({ dryRun: true, dates: ['2026-09-19'] });

      expect(code).toBe(0);
      expect(mockUwFetch).not.toHaveBeenCalled();
      expect(existsSync(cachePath('ES', '2026-09-19'))).toBe(false);
    });
  });
});
