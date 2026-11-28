// @vitest-environment node

/**
 * Tests for the gamma-setup-fire backfill (scripts/_lib/gamma-fires-backfill.ts):
 * the flag parser, the ET window bounds, and the four modes (detect, --dry-run,
 * --outcomes-only, --context-only). The DB handle is a `vi.fn` tagged-template
 * stub that records every statement and answers by its text; nothing reaches a
 * database. The detector module is mocked at its boundary: `loadDayContext`
 * (a DB reader), `detectE1` (so a few canned fires drive the loop) and a spy
 * over the real `getConfidenceTier`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

const { mockSql, mockLoadDayContext, mockDetectE1 } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockLoadDayContext: vi.fn(),
  mockDetectE1: vi.fn(),
}));

vi.mock('../../api/_lib/gamma-detector.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/gamma-detector.js')>();
  return {
    ...actual,
    loadDayContext: mockLoadDayContext,
    detectE1: mockDetectE1,
    getConfidenceTier: vi.fn(actual.getConfidenceTier),
  };
});

import {
  getConfidenceTier,
  type Bar,
  type DayContext,
} from '../../api/_lib/gamma-detector.js';
import {
  UsageError,
  etWindowBounds,
  parseArgs,
  runGammaBackfill,
} from './gamma-fires-backfill.js';

// ── The stub DB ─────────────────────────────────────────────────────────────

interface Call {
  text: string;
  values: unknown[];
}

interface ContextFire {
  session_date: string;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
  open_gap_pct: number | null;
  confidence_tier: string;
}

interface World {
  bars: unknown[];
  snapshots: unknown[];
  pending: unknown[];
  contextFires: ContextFire[];
  /** A statement whose text matches this rejects with 'connection lost'. */
  rejectOn: RegExp | null;
}

let world: World;

const sqlText = (strings: ArrayLike<string>): string =>
  Array.from(strings).join('?').replaceAll(/\s+/g, ' ').trim();

function calls(): Call[] {
  return mockSql.mock.calls.map(([strings, ...values]) => ({
    text: sqlText(strings as string[]),
    values,
  }));
}

const callsMatching = (re: RegExp): Call[] =>
  calls().filter((c) => re.test(c.text));

/** The EDT midnight that opens an ET session date (the test dates are EDT). */
const edtMidnight = (date: string): string => `${date}T04:00:00.000Z`;

function answer(text: string, values: unknown[]): unknown[] {
  if (world.rejectOn?.test(text)) throw new Error('connection lost');
  if (/INSERT INTO ws_gamma_setup_fires/.test(text)) return [{ id: 1 }];
  if (/UPDATE ws_gamma_setup_fires SET prior_5d_ret/.test(text)) {
    // One row per stored fire inside the bound window.
    return world.contextFires
      .filter((f) => edtMidnight(f.session_date) === values[5])
      .map((_, id) => ({ id }));
  }
  if (/AS session_date/.test(text)) return world.contextFires;
  if (/FROM ws_gamma_setup_fires WHERE ret_30m IS NULL/.test(text)) {
    return world.pending;
  }
  if (/FROM periscope_snapshots/.test(text)) return world.snapshots;
  if (/FROM futures_bars/.test(text)) return [];
  if (/FROM vol_realized/.test(text)) return [];
  if (/ts_ms/.test(text) && /FROM index_candles_1m/.test(text)) {
    return world.bars;
  }
  if (/array_agg\(close ORDER BY timestamp DESC\)/.test(text)) {
    return [{ close: '6520.00' }];
  }
  if (/SELECT close FROM index_candles_1m/.test(text)) {
    return [{ close: '6510.00' }];
  }
  return [];
}

// ── Console capture ─────────────────────────────────────────────────────────

let log: MockInstance<typeof console.log>;
let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;

const joined = (spy: MockInstance<typeof console.log>): string =>
  spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
const outLines = (): string[] => joined(log).split('\n');

// ── Fixtures ────────────────────────────────────────────────────────────────

/** 25 one-minute bars from the ET open (EDT) on `date`. */
function barRows(date: string): unknown[] {
  const t0 = Date.parse(`${date}T13:30:00.000Z`);
  return Array.from({ length: 25 }, (_, i) => ({
    ts_ms: String(t0 + i * 60_000),
    date,
    open: '6500.00',
    high: '6501.00',
    low: '6499.00',
    close: '6500.50',
  }));
}

const barAt = (iso: string): Bar => ({
  timestamp: new Date(iso),
  open: 6500,
  high: 6501,
  low: 6499,
  close: 6500.5,
});

/**
 * detectE1 fires on the 13:52Z and 13:53Z windows with the SAME hold bar and
 * node (a duplicate key), and once more at 13:54Z on another node: three
 * candidate fires, two distinct keys.
 */
function cannedE1(window: ReadonlyArray<Bar>) {
  const last = window.at(-1)?.timestamp.toISOString();
  if (
    last === '2026-04-14T13:52:00.000Z' ||
    last === '2026-04-14T13:53:00.000Z'
  ) {
    return {
      breakBar: barAt('2026-04-14T13:48:00.000Z'),
      holdBar: barAt('2026-04-14T13:51:00.000Z'),
      node: { strike: 6500, value: 1_000_000 },
    };
  }
  if (last === '2026-04-14T13:54:00.000Z') {
    return {
      breakBar: barAt('2026-04-14T13:50:00.000Z'),
      holdBar: barAt('2026-04-14T13:54:00.000Z'),
      node: { strike: 6510, value: 2_000_000 },
    };
  }
  return null;
}

/** A stored fire the outcome fill will find pending. */
const PENDING_FIRE = {
  id: 7,
  fired_at: new Date('2026-09-21T16:30:00.000Z'),
  signal_type: 'e1_long_call',
  bar_close: '6500.50',
};

const MON = '2026-09-14';
const TUE = '2026-09-15';

function storedFire(
  date: string,
  over: Partial<ContextFire> = {},
): ContextFire {
  return {
    session_date: date,
    prior_5d_ret: 0.0195,
    prior_iv_rank: 30,
    pre_day_filter_fires: false,
    open_gap_pct: 2.81,
    confidence_tier: 'HIGH',
    ...over,
  };
}

function dayContext(over: Partial<DayContext> = {}): DayContext {
  return {
    today: MON,
    dow_label: 'Monday',
    day_open: 6500,
    prior_close: 6490,
    open_gap_pct: -0.14,
    prior_5d_ret: -0.0115,
    prior_iv_rank: 30,
    pre_day_filter_fires: true,
    is_fomc_day: false,
    is_dom_1_5: false,
    is_dom_16_20: false,
    ...over,
  };
}

beforeEach(() => {
  world = {
    bars: [],
    snapshots: [],
    pending: [],
    contextFires: [],
    rejectOn: null,
  };
  mockSql
    .mockReset()
    .mockImplementation(async (strings, ...values) =>
      answer(sqlText(strings as string[]), values),
    );
  mockLoadDayContext.mockReset().mockResolvedValue(dayContext());
  mockDetectE1.mockReset().mockReturnValue(null);
  vi.mocked(getConfidenceTier).mockClear();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the backfill against the stub DB; resolves to the exit code. */
const run = (...argv: string[]): Promise<number> =>
  runGammaBackfill(argv, mockSql as never);

// ── Flags ───────────────────────────────────────────────────────────────────

describe('flags', () => {
  it('rejects an unknown flag: exit 2, the flag named, no statement run', async () => {
    expect(await run('--dryrun')).toBe(2);

    expect(joined(error)).toMatch(/unknown argument --dryrun/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it.each([
    ['a stray positional', ['2026-09-21']],
    ['--from=VALUE', ['--from=2026-09-21']],
  ])('rejects %s', async (_label, argv) => {
    expect(await run(...argv)).toBe(2);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it.each([
    [['--from'], /--from needs a YYYY-MM-DD value/],
    [['--from', '--dry-run'], /--from needs a YYYY-MM-DD value/],
    [['--to', '2026-9-21'], /--to 2026-9-21 is not a YYYY-MM-DD date/],
    [['--from', '2026-02-30'], /--from 2026-02-30 is not a YYYY-MM-DD date/],
    [
      ['--from', '2026-09-22', '--to', '2026-09-21'],
      /--from 2026-09-22 is after --to 2026-09-21/,
    ],
    [
      ['--dry-run', '--outcomes-only'],
      /--dry-run has nothing to print with --outcomes-only/,
    ],
  ])('rejects the bad window or combination %j', async (argv, message) => {
    expect(await run(...argv)).toBe(2);

    expect(joined(error)).toMatch(message);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('parses the known flags and defaults the window', () => {
    expect(parseArgs([])).toEqual({
      from: '2026-02-26',
      to: '2026-05-22',
      windowExplicit: false,
      dryRun: false,
      outcomesOnly: false,
      contextOnly: false,
    });
    expect(
      parseArgs([
        '--include-gexbot',
        '--from',
        '2026-09-21',
        '--to',
        '2026-09-21',
        '--outcomes-only',
      ]),
    ).toEqual({
      from: '2026-09-21',
      to: '2026-09-21',
      windowExplicit: true,
      dryRun: false,
      outcomesOnly: true,
      contextOnly: false,
    });
  });

  it('throws UsageError for a bad argument', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
  });
});

// ── The window ──────────────────────────────────────────────────────────────

describe('etWindowBounds', () => {
  it.each([
    // A one-day window covers that whole ET day.
    [
      '2026-09-21',
      '2026-09-21',
      '2026-09-21T04:00:00.000Z',
      '2026-09-22T04:00:00.000Z',
    ],
    // EST in January.
    [
      '2026-01-15',
      '2026-01-15',
      '2026-01-15T05:00:00.000Z',
      '2026-01-16T05:00:00.000Z',
    ],
    // 02-26 (EST) -> 04-17 (EDT): spans the March switch, each end in its own offset.
    [
      '2026-02-26',
      '2026-04-17',
      '2026-02-26T05:00:00.000Z',
      '2026-04-18T04:00:00.000Z',
    ],
    // The end rolls over a month boundary.
    [
      '2026-09-30',
      '2026-09-30',
      '2026-09-30T04:00:00.000Z',
      '2026-10-01T04:00:00.000Z',
    ],
  ])('%s -> %s is [%s, %s)', (from, to, start, end) => {
    expect(etWindowBounds(from, to)).toEqual({ startIso: start, endIso: end });
  });
});

// ── --dry-run ───────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  beforeEach(() => {
    world.bars = [...barRows('2026-04-14'), ...barRows('2026-04-15')];
    world.snapshots = [
      {
        captured_ms: String(Date.parse('2026-04-14T13:45:00.000Z')),
        expiry: '2026-04-14',
        strike: 6500,
        value: '1000000',
      },
    ];
    mockDetectE1.mockImplementation(cannedE1);
  });

  it('performs no INSERT or UPDATE and reads no fires', async () => {
    expect(
      await run('--dry-run', '--from', '2026-04-14', '--to', '2026-04-15'),
    ).toBe(0);

    expect(callsMatching(/ws_gamma_setup_fires/)).toEqual([]);
    expect(callsMatching(/INSERT|UPDATE|DELETE/i)).toEqual([]);
    // It still read the inputs detection needs.
    expect(callsMatching(/FROM periscope_snapshots/)).toHaveLength(1);
    expect(callsMatching(/FROM index_candles_1m/)).toHaveLength(1);
  });

  it('prints "date  fires" per session date, counting each key once, zero included', async () => {
    await run('--dry-run', '--from', '2026-04-14', '--to', '2026-04-15');

    const lines = outLines();
    expect(lines).toContain('date  fires');
    // Three candidate fires, two distinct (fired_at, signal_type, node_strike).
    expect(lines).toContain('2026-04-14  2');
    expect(lines).toContain('2026-04-15  0');
    expect(joined(log)).toMatch(/generated 3 candidate fires/);
  });

  it('never reports an insert, an outcome fill or the closing summary', async () => {
    await run('--dry-run', '--from', '2026-04-14', '--to', '2026-04-15');

    const out = joined(log);
    expect(out).not.toMatch(/inserted/);
    expect(out).not.toMatch(/outcome/);
    expect(out).not.toMatch(/Final ws_gamma_setup_fires summary/);
    expect(out).toMatch(/dry run: nothing written/);
  });

  it('still caps a detection window at the GEXBot cutover', async () => {
    await run('--dry-run', '--from', '2026-04-14', '--to', '2026-09-21');

    expect(joined(warn)).toMatch(/--to 2026-09-21 reaches the GEXBot era/);
  });
});

// ── detection (no flag) ─────────────────────────────────────────────────────

describe('a detection run', () => {
  beforeEach(() => {
    world.bars = barRows('2026-04-14');
    world.snapshots = [
      {
        captured_ms: String(Date.parse('2026-04-14T13:45:00.000Z')),
        expiry: '2026-04-14',
        strike: 6500,
        value: '1000000',
      },
    ];
    world.pending = [PENDING_FIRE];
    mockDetectE1.mockImplementation(cannedE1);
  });

  it('bounds its outcome fill to the explicit window, as Runbook C runs it', async () => {
    expect(await run('--from', '2026-04-14', '--to', '2026-04-14')).toBe(0);

    // An unbounded fill would also touch every NULL-ret_30m fire outside the
    // window, and so outside the backup taken for it.
    const fills = callsMatching(/WHERE ret_30m IS NULL/);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.values).toEqual([
      '2026-04-14T04:00:00.000Z',
      '2026-04-15T04:00:00.000Z',
    ]);
    expect(callsMatching(/INSERT INTO ws_gamma_setup_fires/)).toHaveLength(3);
    expect(joined(log)).toMatch(/outcome backfill updated 1 rows/);
  });

  it('with no flags inserts every candidate, fills outcomes table-wide and prints the summary', async () => {
    expect(await run()).toBe(0);

    // insertFires keeps its per-row loop (a pure move; batching is out of scope).
    expect(callsMatching(/INSERT INTO ws_gamma_setup_fires/)).toHaveLength(3);
    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    expect(fill?.values).toEqual([null, null]);
    expect(
      callsMatching(/UPDATE ws_gamma_setup_fires SET ret_15m/),
    ).toHaveLength(1);
    expect(callsMatching(/GROUP BY signal_type/)).toHaveLength(1);
    expect(joined(log)).toMatch(/outcome backfill updated 1 rows/);
  });
});

// ── --outcomes-only ─────────────────────────────────────────────────────────

describe('--outcomes-only', () => {
  beforeEach(() => {
    world.pending = [PENDING_FIRE];
  });

  it('runs no detection and no insert', async () => {
    expect(
      await run(
        '--outcomes-only',
        '--from',
        '2026-09-21',
        '--to',
        '2026-09-21',
      ),
    ).toBe(0);

    expect(mockDetectE1).not.toHaveBeenCalled();
    expect(
      callsMatching(/periscope_snapshots|futures_bars|vol_realized/),
    ).toEqual([]);
    expect(callsMatching(/ts_ms/)).toEqual([]);
    expect(callsMatching(/INSERT/)).toEqual([]);
    // The fill itself ran.
    expect(
      callsMatching(/UPDATE ws_gamma_setup_fires SET ret_15m/),
    ).toHaveLength(1);
  });

  it('bounds the outcome fill to an explicit window', async () => {
    await run('--outcomes-only', '--from', '2026-09-21', '--to', '2026-09-21');

    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    expect(fill?.values).toEqual([
      '2026-09-21T04:00:00.000Z',
      '2026-09-22T04:00:00.000Z',
    ]);
    expect(fill?.text).toMatch(/fired_at >= COALESCE\(\?::timestamptz/);
    expect(fill?.text).toMatch(/fired_at < COALESCE\(\?::timestamptz/);
  });

  it('covers the whole ET day for a one-day window (the bound instants)', async () => {
    await run('--outcomes-only', '--from', '2026-01-15', '--to', '2026-01-15');

    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    expect(fill?.values).toEqual([
      '2026-01-15T05:00:00.000Z',
      '2026-01-16T05:00:00.000Z',
    ]);
  });

  it('stays table-wide when neither --from nor --to is passed', async () => {
    await run('--outcomes-only');

    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    expect(fill?.values).toEqual([null, null]);
    expect(joined(log)).toMatch(/table-wide/);
  });

  it('bounds a one-sided window, the missing side taking its default', async () => {
    await run('--outcomes-only', '--to', '2026-05-22');

    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    // The default --from is 2026-02-26 (EST); --to 2026-05-22 ends in EDT.
    expect(fill?.values).toEqual([
      '2026-02-26T05:00:00.000Z',
      '2026-05-23T04:00:00.000Z',
    ]);
  });

  it('is not clamped to the GEXBot cutover', async () => {
    await run('--outcomes-only', '--from', '2026-09-21', '--to', '2026-09-21');

    const [fill] = callsMatching(/WHERE ret_30m IS NULL/);
    // A cutover clamp would have pulled the end back to 2026-05-26.
    expect(fill?.values).toEqual([
      '2026-09-21T04:00:00.000Z',
      '2026-09-22T04:00:00.000Z',
    ]);
    expect(joined(warn)).not.toMatch(/GEXBot era/);
  });
});

// ── R4: a DB reject ─────────────────────────────────────────────────────────

describe('a DB reject', () => {
  it('exits non-zero from the outcome fill and never reports success', async () => {
    world.rejectOn = /WHERE ret_30m IS NULL/;

    const code = await run(
      '--outcomes-only',
      '--from',
      '2026-09-21',
      '--to',
      '2026-09-21',
    );

    expect(code).toBe(1);
    expect(joined(error)).toMatch(/connection lost/);
    expect(joined(log)).not.toMatch(/outcome backfill updated/);
    expect(joined(log)).not.toMatch(/done in/);
    expect(callsMatching(/UPDATE/)).toEqual([]);
  });

  it('exits non-zero from an insert and never reports success', async () => {
    world.bars = barRows('2026-04-14');
    world.snapshots = [
      {
        captured_ms: String(Date.parse('2026-04-14T13:45:00.000Z')),
        expiry: '2026-04-14',
        strike: 6500,
        value: '1000000',
      },
    ];
    mockDetectE1.mockImplementation(cannedE1);
    world.rejectOn = /INSERT INTO ws_gamma_setup_fires/;

    expect(await run('--from', '2026-04-14', '--to', '2026-04-14')).toBe(1);

    expect(joined(error)).toMatch(/connection lost/);
    expect(joined(log)).not.toMatch(/inserted \d+ new fires/);
    expect(joined(log)).not.toMatch(/done in/);
    expect(callsMatching(/WHERE ret_30m IS NULL/)).toEqual([]);
  });

  it('exits non-zero when loading the detection inputs fails', async () => {
    world.rejectOn = /FROM periscope_snapshots/;

    expect(
      await run('--dry-run', '--from', '2026-04-14', '--to', '2026-04-15'),
    ).toBe(1);

    expect(joined(error)).toMatch(/connection lost/);
    expect(outLines()).not.toContain('date  fires');
  });
});

// ── --context-only ──────────────────────────────────────────────────────────

describe('--context-only', () => {
  const WINDOW = ['--from', MON, '--to', TUE] as const;

  beforeEach(() => {
    world.contextFires = [
      storedFire(MON),
      storedFire(MON),
      storedFire(TUE, { confidence_tier: 'MEDIUM' }),
    ];
    mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
      dayContext({
        today: now.toISOString().slice(0, 10),
        dow_label: now.toISOString().startsWith(MON) ? 'Monday' : 'Tuesday',
      }),
    );
  });

  it.each([
    ['no window', ['--context-only']],
    ['only --from', ['--context-only', '--from', MON]],
    ['only --to', ['--context-only', '--to', TUE]],
    [
      'with --outcomes-only beside it',
      ['--context-only', '--outcomes-only', ...WINDOW],
    ],
  ])('exits 2 and touches nothing: %s', async (_label, argv) => {
    expect(await run(...argv)).toBe(2);

    expect(joined(error)).toMatch(/--context-only/);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockLoadDayContext).not.toHaveBeenCalled();
  });

  it('runs no detection, no insert and no outcome fill', async () => {
    expect(await run('--context-only', ...WINDOW)).toBe(0);

    expect(mockDetectE1).not.toHaveBeenCalled();
    expect(
      callsMatching(/periscope_snapshots|futures_bars|vol_realized/),
    ).toEqual([]);
    expect(callsMatching(/ts_ms/)).toEqual([]);
    expect(callsMatching(/INSERT/)).toEqual([]);
    expect(callsMatching(/ret_30m IS NULL|SET ret_15m/)).toEqual([]);
    expect(callsMatching(/GROUP BY signal_type/)).toEqual([]);
  });

  it("updates only the five day-context columns, bounded to each date's ET window", async () => {
    await run('--context-only', ...WINDOW);

    const updates = callsMatching(/UPDATE ws_gamma_setup_fires/);
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      const setList = /SET (.*?) WHERE/.exec(update.text)?.[1] ?? '';
      expect(
        setList.split(', ').map((assign) => assign.split(' = ')[0]),
      ).toEqual([
        'prior_5d_ret',
        'prior_iv_rank',
        'pre_day_filter_fires',
        'open_gap_pct',
        'confidence_tier',
      ]);
      expect(update.text).toMatch(
        /WHERE fired_at >= \?::timestamptz AND fired_at < \?::timestamptz/,
      );
    }
    // Values: the five columns, then that date's [00:00 ET, next 00:00 ET).
    expect(updates[0]?.values).toEqual([
      -0.0115,
      30,
      true,
      -0.14,
      'MAXIMUM',
      '2026-09-14T04:00:00.000Z',
      '2026-09-15T04:00:00.000Z',
    ]);
    expect(updates[1]?.values.slice(5)).toEqual([
      '2026-09-15T04:00:00.000Z',
      '2026-09-16T04:00:00.000Z',
    ]);
  });

  it('prints "date  fires  updated" per date', async () => {
    await run('--context-only', ...WINDOW);

    const lines = outLines();
    expect(lines).toContain('date  fires  updated');
    expect(lines).toContain('2026-09-14  2  2');
    expect(lines).toContain('2026-09-15  1  1');
  });

  it.each([
    ['Monday', true, 'MAXIMUM'],
    ['Monday', false, 'HIGH'],
    ['Friday', true, 'HIGH'],
    ['Tuesday', true, 'MEDIUM'],
  ] as const)(
    'takes the tier from getConfidenceTier: %s, filter %s -> %s',
    async (dow, filter, tier) => {
      world.contextFires = [storedFire(MON, { confidence_tier: 'MEDIUM' })];
      mockLoadDayContext.mockResolvedValue(
        dayContext({ dow_label: dow, pre_day_filter_fires: filter }),
      );

      await run('--context-only', '--from', MON, '--to', MON);

      expect(getConfidenceTier).toHaveBeenCalledWith(dow, filter);
      const [update] = callsMatching(/UPDATE ws_gamma_setup_fires/);
      expect(update?.values[4]).toBe(tier);
    },
  );

  it.each([
    ['2026-09-14', '2026-09-14T16:00:00.000Z'],
    ['2026-02-27', '2026-02-27T17:00:00.000Z'],
  ])('loads the day context at 12:00 ET on %s (%s)', async (date, noon) => {
    world.contextFires = [storedFire(date)];

    await run('--context-only', '--from', date, '--to', date);

    expect(mockLoadDayContext).toHaveBeenCalledTimes(1);
    expect(mockLoadDayContext.mock.calls[0]?.[1]).toEqual(new Date(noon));
  });

  it('reads the fires of the explicit window only, not clamped to the cutover', async () => {
    await run('--context-only', ...WINDOW);

    const [read] = callsMatching(/AS session_date/);
    // 09-14 and 09-15 are well after the 2026-05-26 cutover.
    expect(read?.values).toEqual([
      '2026-09-14T04:00:00.000Z',
      '2026-09-16T04:00:00.000Z',
    ]);
    expect(joined(warn)).not.toMatch(/GEXBot era/);
    expect(callsMatching(/UPDATE ws_gamma_setup_fires/)).toHaveLength(2);
  });

  it('says so and writes nothing when the window holds no fires', async () => {
    world.contextFires = [];

    expect(await run('--context-only', ...WINDOW)).toBe(0);

    expect(joined(log)).toMatch(
      /no fires in 2026-09-14 → 2026-09-15; nothing to update/,
    );
    expect(mockLoadDayContext).not.toHaveBeenCalled();
    expect(callsMatching(/UPDATE/)).toEqual([]);
  });

  describe('--dry-run', () => {
    it('prints the stored and new values per column and writes nothing', async () => {
      world.contextFires = [storedFire(MON), storedFire(MON)];

      expect(
        await run('--context-only', '--dry-run', '--from', MON, '--to', MON),
      ).toBe(0);

      // It reads the fires (the one dry run that does) and writes nothing.
      expect(callsMatching(/AS session_date/)).toHaveLength(1);
      expect(callsMatching(/INSERT|UPDATE|DELETE/i)).toEqual([]);

      const lines = outLines().map((l) => l.trim());
      const line = (column: string): string =>
        lines.find((l) => l.startsWith(`${column} `)) ?? '';
      expect(lines).toContain('2026-09-14  fires=2');
      expect(line('prior_5d_ret')).toMatch(
        /^prior_5d_ret\s+stored 0\.0195\s+new -0\.0115\s+CHANGED$/,
      );
      expect(line('prior_iv_rank')).toMatch(
        /^prior_iv_rank\s+stored 30\s+new 30$/,
      );
      expect(line('pre_day_filter_fires')).toMatch(
        /^pre_day_filter_fires\s+stored false\s+new true\s+CHANGED$/,
      );
      expect(line('open_gap_pct')).toMatch(
        /^open_gap_pct\s+stored 2\.81\s+new -0\.14\s+CHANGED$/,
      );
      expect(line('confidence_tier')).toMatch(
        /^confidence_tier\s+stored HIGH\s+new MAXIMUM\s+CHANGED$/,
      );
      expect(joined(log)).toMatch(/dry run: nothing written/);
    });

    it('lists every distinct stored value when a date holds mixed ones', async () => {
      world.contextFires = [
        storedFire(MON, { prior_5d_ret: 0.0195 }),
        storedFire(MON, { prior_5d_ret: null }),
      ];

      await run('--context-only', '--dry-run', '--from', MON, '--to', MON);

      expect(joined(log)).toMatch(
        /prior_5d_ret\s+stored 0\.0195 \/ null\s+new -0\.0115/,
      );
    });
  });

  describe('guards', () => {
    it('refuses a date with no SPX candles instead of writing a zero gap', async () => {
      mockLoadDayContext.mockResolvedValue(dayContext({ day_open: 0 }));

      expect(await run('--context-only', '--from', MON, '--to', MON)).toBe(1);

      expect(joined(error)).toMatch(/no SPX candles for 2026-09-14/);
      expect(callsMatching(/UPDATE/)).toEqual([]);
    });

    it.each([
      ['no prior close', 0],
      ['an unreadable prior close', Number.NaN],
    ])(
      'refuses a date with %s instead of writing a zero gap, and writes no earlier date either',
      async (_label, priorClose) => {
        // 09-14 is fine, 09-15 has no prior close: all reads come first.
        mockLoadDayContext.mockImplementation(async (_sql, now: Date) =>
          now.toISOString().startsWith(TUE)
            ? dayContext({ prior_close: priorClose, open_gap_pct: 0 })
            : dayContext(),
        );

        expect(await run('--context-only', '--from', MON, '--to', TUE)).toBe(1);

        expect(joined(error)).toMatch(/no prior-day SPX close for 2026-09-15/);
        expect(callsMatching(/UPDATE/)).toEqual([]);
      },
    );

    it('refuses a weekend date, which has no tier', async () => {
      world.contextFires = [storedFire('2026-09-19')];
      mockLoadDayContext.mockResolvedValue(dayContext({ dow_label: null }));

      expect(
        await run(
          '--context-only',
          '--from',
          '2026-09-19',
          '--to',
          '2026-09-19',
        ),
      ).toBe(1);

      expect(joined(error)).toMatch(/2026-09-19 is not a weekday/);
      expect(callsMatching(/UPDATE/)).toEqual([]);
    });
  });

  describe('a DB reject (R4)', () => {
    it('exits non-zero when reading the fires fails', async () => {
      world.rejectOn = /AS session_date/;

      expect(await run('--context-only', ...WINDOW)).toBe(1);

      expect(joined(error)).toMatch(/connection lost/);
      expect(callsMatching(/UPDATE/)).toEqual([]);
      expect(joined(log)).not.toMatch(/context-only: \d+ dates/);
    });

    it('exits non-zero, and writes nothing, when the detector cannot load a context', async () => {
      mockLoadDayContext.mockRejectedValueOnce(new Error('connection lost'));

      expect(await run('--context-only', ...WINDOW)).toBe(1);

      expect(joined(error)).toMatch(/connection lost/);
      // Every read happens before the first write.
      expect(callsMatching(/UPDATE/)).toEqual([]);
    });

    it('exits non-zero when an UPDATE fails, naming the date and never reporting success', async () => {
      world.rejectOn = /UPDATE ws_gamma_setup_fires SET prior_5d_ret/;

      expect(await run('--context-only', ...WINDOW)).toBe(1);

      expect(joined(error)).toMatch(/connection lost/);
      expect(joined(error)).toMatch(/2026-09-14/);
      expect(joined(log)).not.toMatch(/context-only: \d+ dates/);
      expect(outLines()).not.toContain('2026-09-14  2  2');
    });
  });
});
