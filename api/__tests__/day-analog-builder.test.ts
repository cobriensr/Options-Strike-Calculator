// @vitest-environment node

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ctWallClockToUtcIso } from '../../src/utils/timezone.js';
import {
  ANALOG_WINDOW_MINUTES,
  CASH_OPEN_MIN_CT,
  DAY_ANALOG_FEATURE_SET,
  MIN_BARS,
  PROXY_JUMP_PTS,
  WINDOW_GRACE_MS,
  buildCashWindow,
  buildDayAnalogWindows,
  cashSessionLabels,
  formatWindowSummary,
  openGaps,
  type AnalogBar,
  type AnalogWindow,
  type AnalogWindowMinutes,
  type CashSessionLabels,
  type DayAnalogBuild,
  type LabelResult,
  type Refusal,
  type WindowResult,
} from '../_lib/day-analog-builder.js';
import {
  fetchFuturesBars,
  type StoredFuturesBar,
} from '../_lib/futures-bars.js';

vi.mock('../_lib/futures-bars.js', () => ({ fetchFuturesBars: vi.fn() }));

// ── Helpers ──────────────────────────────────────────────────────────

/** [open, high, low, close, volume, contract?] */
type Row = readonly [
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  contract?: string | null,
];

const DATE = '2026-11-23'; // a Monday, CST: 08:30 CT is 14:30Z
const OPEN = CASH_OPEN_MIN_CT; // 08:30 CT in minutes after midnight
const ct = (hour: number, minute: number): number => hour * 60 + minute;

function isoAt(date: string, ctMinutes: number): string {
  const iso = ctWallClockToUtcIso(date, ctMinutes);
  if (iso === null) throw new Error(`no UTC stamp for ${date} ${ctMinutes}`);
  return iso;
}

/** Stamp consecutive minutes from `fromCtMin` (CT minutes after midnight). */
function bars(
  date: string,
  fromCtMin: number,
  rows: readonly Row[],
): AnalogBar[] {
  return rows.map(([open, high, low, close, volume, contract = null], i) => ({
    ts: isoAt(date, fromCtMin + i),
    open,
    high,
    low,
    close,
    volume,
    contract,
  }));
}

/** `count` quiet bars at `price`: open = close, high +1, low −1. */
function flat(count: number, price = 6000, volume = 100): Row[] {
  return Array.from(
    { length: count },
    (): Row => [price, price + 1, price - 1, price, volume],
  );
}

function withRow(rows: readonly Row[], index: number, row: Row): Row[] {
  return rows.map((r, i) => (i === index ? row : r));
}

function dropMinute(
  list: readonly AnalogBar[],
  date: string,
  ctMinutes: number,
): AnalogBar[] {
  const ts = isoAt(date, ctMinutes);
  return list.filter((b) => b.ts !== ts);
}

function okWindow(result: WindowResult): AnalogWindow {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.window;
}

function okLabels(result: LabelResult): CashSessionLabels {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.labels;
}

const window15 = (list: readonly AnalogBar[], date = DATE): WindowResult =>
  buildCashWindow(date, 15, list);

const NAN_CLOSE: Row = [6000, 6001, 5999, Number.NaN, 100];
const GAP_16: Row = [6016, 6017, 5999, 6000, 100]; // opens 16 over a 6000 close
const ESZ6: Row = [6000, 6001, 5999, 6000, 100, 'ESZ6'];
const ESH7: Row = [6000, 6001, 5999, 6000, 100, 'ESH7'];

// ── Module surface ───────────────────────────────────────────────────

describe('day-analog-builder constants', () => {
  it('exports the values the later tasks and the Python backfill rely on', () => {
    expect(DAY_ANALOG_FEATURE_SET).toBe('cash_open_pct_change_v2');
    expect([...ANALOG_WINDOW_MINUTES]).toEqual([15, 30, 60]);
    expect(CASH_OPEN_MIN_CT).toBe(510);
    expect(MIN_BARS).toBe(10);
    expect(PROXY_JUMP_PTS).toBe(15);
    expect(WINDOW_GRACE_MS).toBe(75_000);
  });
});

// ── openGaps ─────────────────────────────────────────────────────────

describe('openGaps', () => {
  it('marks an open more than 15 pt from the previous close', () => {
    const first: Row = [6000, 6001, 5999, 6000, 100];
    const over: Row = [6016, 6017, 5999, 6000, 100];
    const exact: Row = [6015, 6016, 5999, 6000, 100];
    const below: Row = [5984, 6001, 5983, 6000, 100];
    expect(openGaps(bars(DATE, OPEN, [first, over]))).toEqual([false, true]);
    // 15 pt exactly is not a gap.
    expect(openGaps(bars(DATE, OPEN, [first, exact]))).toEqual([false, false]);
    // Direction does not matter.
    expect(openGaps(bars(DATE, OPEN, [first, below]))).toEqual([false, true]);
  });

  it('never marks the first bar, and returns an empty array for no bars', () => {
    expect(openGaps(bars(DATE, OPEN, [[6000, 6001, 5999, 6000, 100]]))).toEqual(
      [false],
    );
    expect(openGaps([])).toEqual([]);
  });

  it('compares with the neighbouring bar, whatever its minute', () => {
    const list = [
      ...bars(DATE, OPEN, [[6000, 6001, 5999, 6000, 100]]),
      ...bars(DATE, OPEN + 20, [GAP_16]),
    ];
    expect(openGaps(list)).toEqual([false, true]);
  });
});

// ── buildCashWindow: the vector ──────────────────────────────────────

/** The carry-forward series: minute 3 missing, minutes 4-14 close 6012. */
function carryRows(): { head: Row[]; tail: Row[] } {
  return {
    head: [
      [6000, 6001, 5999, 6000, 100],
      [6000, 6004, 5999, 6003, 100],
      [6003, 6007, 6002, 6006, 100],
    ],
    tail: [
      [6006, 6013, 6005, 6012, 100],
      ...Array.from({ length: 10 }, (): Row => [6012, 6013, 6011, 6012, 100]),
    ],
  };
}

function carrySeries(): AnalogBar[] {
  const { head, tail } = carryRows();
  return [...bars(DATE, OPEN, head), ...bars(DATE, OPEN + 4, tail)];
}

describe('buildCashWindow vector', () => {
  it('builds the 15-minute vector from the 08:30 open with carry-forward', () => {
    const w = okWindow(window15(carrySeries()));
    expect(w.features).toHaveLength(15);
    expect(w.features[0]).toBeCloseTo(0, 12);
    expect(w.features[1]).toBeCloseTo(0.0005, 12);
    expect(w.features[2]).toBeCloseTo(0.001, 12);
    expect(w.features[3]).toBeCloseTo(0.001, 12); // carried over the gap
    expect(w.features[4]).toBeCloseTo(0.002, 12);
    expect(w.features[14]).toBeCloseTo(0.002, 12);
    expect(w.bars).toBe(14);
    expect(w.close).toBe(6012);
    expect(w.open).toBe(6000);
    expect(w.nMinutes).toBe(15);
    expect(w.contract).toBeNull();
  });

  it('takes the window high, low and volume over the bars present', () => {
    const w = okWindow(window15(carrySeries()));
    expect(w.high).toBe(6013);
    expect(w.low).toBe(5999);
    expect(w.volume).toBe(1400);
    expect(w.summary).toBe(formatWindowSummary(w));
  });

  it.each(ANALOG_WINDOW_MINUTES)(
    'builds an N-entry vector labelled with N for N = %i',
    (n) => {
      const w = okWindow(buildCashWindow(DATE, n, bars(DATE, OPEN, flat(n))));
      expect(w.features).toHaveLength(n);
      expect(w.features.every((f) => f === 0)).toBe(true);
      expect(w.bars).toBe(n);
      expect(w.nMinutes).toBe(n);
      expect(w.summary).toContain(` | ${n}m delta `);
    },
  );

  it('uses only bars 08:30 to 08:30+N−1 and ignores the 07:30 lead-in', () => {
    const { head, tail } = carryRows();
    const window = [...bars(DATE, OPEN, head), ...bars(DATE, OPEN + 4, tail)];
    // Lead-in closes 6005, within 15 pt of the 6000 anchor open.
    const leadIn = bars(DATE, OPEN - 60, flat(60, 6005));
    const after = bars(DATE, OPEN + 15, [[6012, 6100, 5900, 6050, 999]]);
    const bare = okWindow(window15(window));
    const full = okWindow(window15([...leadIn, ...window, ...after]));
    expect(full).toEqual(bare);
    expect(full.bars).toBe(14);
    expect(full.high).toBe(6013); // the 08:45 bar's 6100 is not in N = 15
    expect(full.volume).toBe(1400);
  });

  it('never reads past minute N−1', () => {
    const window = flat(15);
    const calm: Row = [6000, 6001, 5999, 6000, 100];
    const wild: Row = [6000, 6041, 5959, 6040, 100]; // close/high/low +-40
    const a = window15(bars(DATE, OPEN, [...window, calm]));
    const b = window15(bars(DATE, OPEN, [...window, wild]));
    expect(b).toEqual(a);
    expect(a.ok).toBe(true);
  });
});

// ── buildCashWindow: refusals ────────────────────────────────────────

describe('buildCashWindow refusals', () => {
  const at0830 = (rows: readonly Row[], date = DATE): AnalogBar[] =>
    bars(date, OPEN, rows);
  const mixed = (rows: readonly Row[]): Row[] =>
    withRow(withRow(rows, 0, ESZ6), 7, ESH7);

  const cases: Array<[string, string, AnalogBar[], Refusal]> = [
    [
      '1 not_trading_day (Thanksgiving)',
      '2026-11-26',
      at0830(flat(15), '2026-11-26'),
      'not_trading_day',
    ],
    [
      '2 no_anchor (the series starts 08:31)',
      DATE,
      bars(DATE, OPEN + 1, flat(14)),
      'no_anchor',
    ],
    ['3 too_few_bars (9 bars)', DATE, at0830(flat(9)), 'too_few_bars'],
    [
      '4 bad_bar (a NaN close, not flagged despite a gap at 08:40)',
      DATE,
      at0830(withRow(withRow(flat(15), 5, NAN_CLOSE), 10, GAP_16)),
      'bad_bar',
    ],
    [
      '5 mixed_contract (ESZ6 and ESH7)',
      DATE,
      at0830(mixed(flat(15))),
      'mixed_contract',
    ],
    [
      '6 flagged (a 16 pt open gap on the 08:40 bar)',
      DATE,
      at0830(withRow(flat(15), 10, GAP_16)),
      'flagged',
    ],
    [
      '1 before 2: a holiday with no anchor',
      '2026-11-26',
      bars('2026-11-26', OPEN + 1, flat(14)),
      'not_trading_day',
    ],
    [
      '2 before 3: no anchor and 9 bars',
      DATE,
      bars(DATE, OPEN + 1, flat(9)),
      'no_anchor',
    ],
    [
      '3 before 4: 9 bars and a NaN close',
      DATE,
      at0830(withRow(flat(9), 5, NAN_CLOSE)),
      'too_few_bars',
    ],
    [
      '3 before 6: 9 bars and a 16 pt gap',
      DATE,
      at0830(withRow(flat(9), 7, GAP_16)),
      'too_few_bars',
    ],
    [
      '4 before 5: a NaN close and mixed contracts',
      DATE,
      at0830(withRow(mixed(flat(15)), 5, NAN_CLOSE)),
      'bad_bar',
    ],
    [
      '5 before 6: mixed contracts and a 16 pt gap',
      DATE,
      at0830(withRow(mixed(flat(15)), 10, GAP_16)),
      'mixed_contract',
    ],
  ];

  it.each(cases)(
    'refuses each reason in order: %s',
    (_name, date, list, reason) => {
      expect(buildCashWindow(date, 15, list)).toEqual({
        ok: false,
        nMinutes: 15,
        reason,
      });
    },
  );

  it('refuses an empty series for no anchor', () => {
    expect(window15([])).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'no_anchor',
    });
  });

  it('accepts exactly MIN_BARS bars and carries the last close to minute N−1', () => {
    const w = okWindow(window15(bars(DATE, OPEN, flat(MIN_BARS))));
    expect(w.bars).toBe(MIN_BARS);
    expect(w.features).toHaveLength(15);
  });

  const badFields: Array<[string, Row]> = [
    ['a NaN open', [Number.NaN, 6001, 5999, 6000, 100]],
    ['a zero low', [6000, 6001, 0, 6000, 100]],
    ['a negative high', [6000, -1, 5999, 6000, 100]],
    ['an infinite close', [6000, 6001, 5999, Number.POSITIVE_INFINITY, 100]],
    ['a NaN volume', [6000, 6001, 5999, 6000, Number.NaN]],
    ['a negative volume', [6000, 6001, 5999, 6000, -1]],
  ];

  it.each(badFields)('refuses %s as bad_bar', (_name, row) => {
    expect(window15(at0830(withRow(flat(15), 3, row)))).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'bad_bar',
    });
  });

  it('accepts a zero volume', () => {
    const rows = withRow(flat(15), 3, [6000, 6001, 5999, 6000, 0]);
    expect(window15(at0830(rows)).ok).toBe(true);
  });

  it('refuses a bad bar just before the anchor or just after the window', () => {
    const lead = (row: Row): AnalogBar[] => bars(DATE, OPEN - 1, [row]);
    const trail = (row: Row): AnalogBar[] => bars(DATE, OPEN + 15, [row]);
    const window = at0830(flat(15));
    const good: Row = [6000, 6001, 5999, 6000, 100];
    const cases: Array<[string, AnalogBar[]]> = [
      [
        'before: NaN close',
        [...lead([6000, 6001, 5999, Number.NaN, 100]), ...window],
      ],
      [
        'after: NaN open',
        [...window, ...trail([Number.NaN, 6001, 5999, 6000, 100])],
      ],
      [
        'after: negative volume',
        [...window, ...trail([6000, 6001, 5999, 6000, -1])],
      ],
    ];
    for (const [name, list] of cases) {
      expect(window15(list), name).toEqual({
        ok: false,
        nMinutes: 15,
        reason: 'bad_bar',
      });
    }
    // The same neighbours, well formed, are accepted.
    expect(window15([...lead(good), ...window, ...trail(good)]).ok).toBe(true);
  });
});

describe('buildCashWindow gap checks', () => {
  it('gap-checks the anchor against the bar before it', () => {
    const lead: Row = [6000, 6001, 5999, 6000, 100]; // the 08:29 bar closes 6000
    const anchored = flat(15, 6050); // the 08:30 bar opens 6050
    const list = [
      ...bars(DATE, OPEN - 1, [lead]),
      ...bars(DATE, OPEN, anchored),
    ];
    expect(window15(list)).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'flagged',
    });

    const session = flat(390, 6050);
    const full = [
      ...bars(DATE, OPEN - 1, [lead]),
      ...bars(DATE, OPEN, session),
    ];
    expect(cashSessionLabels(DATE, full)).toEqual({
      ok: false,
      reason: 'flagged',
    });
  });

  it('refuses a NaN 08:29 close as bad_bar for the window and the labels', () => {
    const lead: Row = [6000, 6001, 5999, Number.NaN, 100];
    const list = [
      ...bars(DATE, OPEN - 1, [lead]),
      ...bars(DATE, OPEN, flat(15)),
    ];
    expect(window15(list)).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'bad_bar',
    });
    const full = [
      ...bars(DATE, OPEN - 1, [lead]),
      ...bars(DATE, OPEN, flat(390)),
    ];
    expect(cashSessionLabels(DATE, full)).toEqual({
      ok: false,
      reason: 'bad_bar',
    });
  });

  it("flags a bad last close through the next bar's open gap", () => {
    const next: Row = [6020, 6021, 6019, 6020, 100]; // opens 20 over the 08:44 close
    const window = bars(DATE, OPEN, flat(15));
    const after = bars(DATE, OPEN + 15, [next]);
    expect(window15([...window, ...after])).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'flagged',
    });
    // With no bar after 08:44 in the series there is nothing to check.
    expect(window15(window).ok).toBe(true);
  });

  it('measures a gap against the neighbouring bar when a minute is missing', () => {
    const head = bars(DATE, OPEN, flat(10));
    const jump = (open: number): AnalogBar[] =>
      bars(DATE, OPEN + 11, [[open, open + 1, 5999, 6000, 100], ...flat(3)]);
    // 08:40 is missing: 08:41 opens against the 08:39 close.
    expect(window15([...head, ...jump(6016)])).toEqual({
      ok: false,
      nMinutes: 15,
      reason: 'flagged',
    });
    expect(window15([...head, ...jump(6015)]).ok).toBe(true);
  });

  it('keeps a real fast move (a reverting close spike with no open gap)', () => {
    const spike: Row = [6000, 6021, 5999, 6020, 100]; // 08:40 closes 20 over
    const revert: Row = [6020, 6021, 5999, 6000, 100]; // 08:41 opens at 6020
    const rows = withRow(withRow(flat(15), 10, spike), 11, revert);
    const w = okWindow(window15(bars(DATE, OPEN, rows)));
    expect(w.high).toBe(6021);
    expect(w.features[10]).toBeCloseTo(20 / 6000, 12);
    expect(w.features[11]).toBeCloseTo(0, 12);
  });

  it('accepts a date in the repaired April–June span', () => {
    const date = '2026-05-12'; // CDT: 08:30 CT is 13:30Z
    const w = okWindow(window15(bars(date, OPEN, flat(15)), date));
    expect(w.bars).toBe(15);
  });
});

describe('buildCashWindow contracts', () => {
  it('treats contract spellings and NULLs as one contract', () => {
    const two = (a: string | null, b: string | null): AnalogBar[] =>
      bars(
        DATE,
        OPEN,
        withRow(withRow(flat(15), 0, [6000, 6001, 5999, 6000, 100, a]), 7, [
          6000,
          6001,
          5999,
          6000,
          100,
          b,
        ]),
      );
    expect(okWindow(window15(two('ESZ6', 'ESZ26'))).contract).toBe('ESZ6');
    expect(okWindow(window15(two('ESZ26', 'ESZ6'))).contract).toBe('ESZ6');
    expect(okWindow(window15(two(null, 'ESZ6'))).contract).toBe('ESZ6');
    expect(okWindow(window15(two('ESZ6', null))).contract).toBe('ESZ6');
    expect(okWindow(window15(two(null, null))).contract).toBeNull();
  });

  it('names the canonical one-digit contract for a two-digit spelling', () => {
    const rows = flat(15).map(
      (r): Row => [r[0], r[1], r[2], r[3], r[4], 'ESH27'],
    );
    expect(okWindow(window15(bars(DATE, OPEN, rows))).contract).toBe('ESH7');
  });

  it('keeps different months and different years distinct', () => {
    const pair = (a: string, b: string): WindowResult =>
      window15(
        bars(
          DATE,
          OPEN,
          withRow(withRow(flat(15), 0, [6000, 6001, 5999, 6000, 100, a]), 1, [
            6000,
            6001,
            5999,
            6000,
            100,
            b,
          ]),
        ),
      );
    expect(pair('ESZ6', 'ESH7')).toMatchObject({ reason: 'mixed_contract' });
    expect(pair('ESZ6', 'ESU6')).toMatchObject({ reason: 'mixed_contract' });
    expect(pair('ESZ6', 'ESZ7')).toMatchObject({ reason: 'mixed_contract' });
    expect(pair('ESZ6', 'ESZ27')).toMatchObject({ reason: 'mixed_contract' });
  });
});

// ── formatWindowSummary ──────────────────────────────────────────────

describe('formatWindowSummary', () => {
  const base: AnalogWindow = {
    nMinutes: 30,
    features: [],
    summary: '',
    open: 6000,
    close: 6012.25,
    high: 6015.25,
    low: 5995.5,
    volume: 412_340,
    bars: 30,
    contract: null,
  };

  it('formats the summary line exactly', () => {
    expect(formatWindowSummary(base)).toBe(
      'ES | open 6000.00 | 30m delta +12.25 | 30m high 6015.25 | 30m low 5995.50 | 30m range 19.75 | 30m vol 412.3K',
    );
    expect(formatWindowSummary({ ...base, volume: 3_250_000 })).toMatch(
      / \| 30m vol 3\.25M$/,
    );
    expect(formatWindowSummary({ ...base, volume: 421 })).toMatch(
      / \| 30m vol 421$/,
    );
    expect(formatWindowSummary({ ...base, close: 5996.5 })).toContain(
      ' | 30m delta -3.50 | ',
    );
  });

  it('labels every part with the window length', () => {
    expect(formatWindowSummary({ ...base, nMinutes: 60 })).toBe(
      'ES | open 6000.00 | 60m delta +12.25 | 60m high 6015.25 | 60m low 5995.50 | 60m range 19.75 | 60m vol 412.3K',
    );
  });
});

// ── cashSessionLabels ────────────────────────────────────────────────

/** 390 bars with the high, low and last close the brief names. */
function fullDayRows(): Row[] {
  let rows = flat(390);
  rows = withRow(rows, 100, [6000, 6040, 5999, 6000, 100]); // the day's high
  rows = withRow(rows, 200, [6000, 6001, 5980, 6000, 100]); // the day's low
  return withRow(rows, 389, [6000, 6001, 5999, 6010, 100]); // 14:59 closes 6010
}

const AFTER_FULL: Row = [6010, 6100, 6000, 6090, 100]; // the 15:00 bar

describe('cashSessionLabels', () => {
  it('labels a full day from the 08:30 open', () => {
    const list = bars(DATE, OPEN, [...fullDayRows(), AFTER_FULL]);
    expect(list).toHaveLength(391);
    expect(cashSessionLabels(DATE, list)).toEqual({
      ok: true,
      labels: {
        open: 6000,
        high: 6040,
        low: 5980,
        close: 6010,
        rangePt: 60,
        upExc: 40,
        downExc: 20,
      },
    });
  });

  it('is unchanged by the lead-in and by the bar after the session', () => {
    const rows = fullDayRows();
    const bare = okLabels(cashSessionLabels(DATE, bars(DATE, OPEN, rows)));
    const padded = okLabels(
      cashSessionLabels(DATE, [
        ...bars(DATE, OPEN - 60, flat(60, 6005)),
        ...bars(DATE, OPEN, [...rows, AFTER_FULL]),
      ]),
    );
    expect(padded).toEqual(bare);
  });

  it('labels a half day from 210 bars', () => {
    const date = '2026-11-27';
    let rows = flat(210);
    rows = withRow(rows, 50, [6000, 6030, 5999, 6000, 100]);
    rows = withRow(rows, 120, [6000, 6001, 5990, 6000, 100]);
    rows = withRow(rows, 209, [6000, 6001, 5999, 6005, 100]); // 11:59
    const noon: Row = [6005, 6200, 5800, 6150, 100]; // the 12:00 bar
    const labels = okLabels(
      cashSessionLabels(date, bars(date, OPEN, [...rows, noon])),
    );
    expect(labels).toEqual({
      open: 6000,
      high: 6030,
      low: 5990,
      close: 6005,
      rangePt: 40,
      upExc: 30,
      downExc: 10,
    });
    // 209 bars plus the 12:00 bar leaves minute 209 missing.
    const short = [
      ...bars(date, OPEN, rows.slice(0, 209)),
      ...bars(date, ct(12, 0), [noon]),
    ];
    expect(cashSessionLabels(date, short)).toEqual({
      ok: false,
      reason: 'too_few_bars',
    });
  });

  describe('refusals', () => {
    const noReason: LabelResult = {
      ok: true,
      labels: {
        open: 6000,
        high: 6040,
        low: 5980,
        close: 6010,
        rangePt: 60,
        upExc: 40,
        downExc: 20,
      },
    };
    const refused = (reason: Refusal): LabelResult => ({ ok: false, reason });
    const full = (rows: readonly Row[]): AnalogBar[] =>
      bars(DATE, OPEN, [...rows, AFTER_FULL]);
    const spiked = withRow(
      withRow(fullDayRows(), 150, [6000, 6021, 5999, 6020, 100]),
      151,
      [6020, 6021, 5999, 6000, 100],
    );

    const cases: Array<[string, string, AnalogBar[], LabelResult]> = [
      [
        '2026-11-26 (Thanksgiving) is not_trading_day',
        '2026-11-26',
        bars('2026-11-26', OPEN, [...fullDayRows(), AFTER_FULL]),
        refused('not_trading_day'),
      ],
      [
        'a series with no 08:30 bar is no_anchor',
        DATE,
        bars(DATE, OPEN + 1, flat(389)),
        refused('no_anchor'),
      ],
      [
        '389 bars (13:07 missing) plus the 15:00 bar is too_few_bars',
        DATE,
        dropMinute(full(fullDayRows()), DATE, ct(13, 7)),
        refused('too_few_bars'),
      ],
      [
        'a 20 pt open gap on the 15:00 bar after the session is flagged',
        DATE,
        bars(DATE, OPEN, [...fullDayRows(), [6030, 6100, 6000, 6090, 100]]),
        refused('flagged'),
      ],
      [
        'one NaN high is bad_bar, and no rangePt is computed',
        DATE,
        full(withRow(fullDayRows(), 150, [6000, Number.NaN, 5999, 6000, 100])),
        refused('bad_bar'),
      ],
      [
        'ESZ6 plus ESH7 is mixed_contract',
        DATE,
        full(withRow(withRow(fullDayRows(), 3, ESZ6), 300, ESH7)),
        refused('mixed_contract'),
      ],
      [
        'a 16 pt open gap on the 13:00 bar is flagged',
        DATE,
        full(withRow(fullDayRows(), 270, GAP_16)), // 13:00 is minute 270
        refused('flagged'),
      ],
      [
        'a NaN close and a 16 pt gap is bad_bar (the checks run in order)',
        DATE,
        full(withRow(withRow(fullDayRows(), 270, GAP_16), 150, NAN_CLOSE)),
        refused('bad_bar'),
      ],
      [
        'a 20 pt reverting close spike with no gap is no reason (a crash-day minute): ok',
        DATE,
        full(spiked),
        noReason,
      ],
    ];

    it.each(cases)(
      'refuses labels with a reason: %s',
      (_name, date, list, expected) => {
        expect(cashSessionLabels(date, list)).toEqual(expected);
      },
    );

    it('covers every refusal the core can return', () => {
      const reasons = cases.flatMap(([, , , expected]) =>
        expected.ok ? [] : [expected.reason],
      );
      expect([...new Set(reasons)].sort()).toEqual(
        [
          'bad_bar',
          'flagged',
          'mixed_contract',
          'no_anchor',
          'not_trading_day',
          'too_few_bars',
        ].sort(),
      );
    });
  });
});

// ── The shared parity fixture ────────────────────────────────────────

type FixtureBar = [
  ts: string,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: number,
  contract: string | null,
];

interface WindowExpect {
  features: number[];
  summary: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  bars: number;
  contract: string | null;
}

interface ParityFixture {
  version: number;
  note: string;
  windows: Array<{
    name: string;
    date: string;
    nMinutes: AnalogWindowMinutes;
    bars: FixtureBar[];
    expect: { ok: true; window: WindowExpect } | { ok: false; reason: Refusal };
  }>;
  labels: Array<{
    name: string;
    date: string;
    bars: FixtureBar[];
    expect:
      | { ok: true; labels: CashSessionLabels }
      | { ok: false; reason: Refusal };
  }>;
  summaries: Array<{
    name: string;
    window: {
      nMinutes: AnalogWindowMinutes;
      open: number;
      close: number;
      high: number;
      low: number;
      volume: number;
    };
    expect: string;
  }>;
}

/** The Python backfill reads the same file; prices are NUMERIC text. */
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/day-analog-parity.json', import.meta.url),
    'utf8',
  ),
) as ParityFixture;

const toBars = (rows: readonly FixtureBar[]): AnalogBar[] =>
  rows.map(([ts, open, high, low, close, volume, contract]) => ({
    ts,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume,
    contract,
  }));

describe('matches every case in the shared parity fixture', () => {
  it('has cases in each list, each with a unique name', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.windows.length).toBeGreaterThanOrEqual(12);
    expect(fixture.labels.length).toBeGreaterThanOrEqual(4);
    expect(fixture.summaries.length).toBeGreaterThanOrEqual(6);
    for (const list of [fixture.windows, fixture.labels, fixture.summaries]) {
      const names = list.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('covers every refusal the core can return and an ok result', () => {
    const reasons = new Set<string>();
    for (const c of [...fixture.windows, ...fixture.labels]) {
      reasons.add(c.expect.ok ? 'ok' : c.expect.reason);
    }
    expect([...reasons].sort()).toEqual(
      [
        'bad_bar',
        'flagged',
        'mixed_contract',
        'no_anchor',
        'not_trading_day',
        'ok',
        'too_few_bars',
      ].sort(),
    );
  });

  describe.each(fixture.windows)('window: $name', (c) => {
    it('matches its expectation', () => {
      const result = buildCashWindow(c.date, c.nMinutes, toBars(c.bars));
      if (!c.expect.ok) {
        expect(result).toEqual({
          ok: false,
          nMinutes: c.nMinutes,
          reason: c.expect.reason,
        });
        return;
      }
      const want = c.expect.window;
      const got = okWindow(result);
      expect(got.nMinutes).toBe(c.nMinutes);
      expect(got.features).toHaveLength(want.features.length);
      got.features.forEach((f, i) => {
        expect(f).toBeCloseTo(want.features[i] ?? Number.NaN, 12);
      });
      expect({ ...got, features: [] }).toEqual({
        ...want,
        nMinutes: c.nMinutes,
        features: [],
      });
    });
  });

  describe.each(fixture.labels)('labels: $name', (c) => {
    it('matches its expectation', () => {
      expect(cashSessionLabels(c.date, toBars(c.bars))).toEqual(c.expect);
    });
  });

  describe.each(fixture.summaries)('summary: $name', (c) => {
    it('matches its expectation exactly', () => {
      const w: AnalogWindow = {
        ...c.window,
        features: [],
        summary: '',
        bars: c.window.nMinutes,
        contract: null,
      };
      expect(formatWindowSummary(w)).toBe(c.expect);
    });
  });
});

// ── buildDayAnalogWindows ────────────────────────────────────────────

const mockFetch = vi.mocked(fetchFuturesBars);

/** The stored form of `bars`: prices as the NUMERIC text the read returns. */
function stored(
  date: string,
  fromCtMin: number,
  rows: readonly Row[],
): StoredFuturesBar[] {
  return bars(date, fromCtMin, rows).map((b) => ({
    ts: b.ts,
    open: b.open.toFixed(4),
    high: b.high.toFixed(4),
    low: b.low.toFixed(4),
    close: b.close.toFixed(4),
    volume: b.volume,
    buyVolume: null,
    sellVolume: null,
    buyPrints: null,
    sellPrints: null,
    contract: b.contract,
  }));
}

/** What the read returns for a full day: lead-in, 390 session bars, 15:00. */
function fullDayStored(date: string, contract: string | null = null) {
  const withContract = (rows: readonly Row[]): Row[] =>
    rows.map(([o, h, l, c, v]) => [o, h, l, c, v, contract]);
  return [
    ...stored(date, OPEN - 60, withContract(flat(60))),
    ...stored(date, OPEN, withContract([...fullDayRows(), AFTER_FULL])),
  ];
}

/** CT wall-clock `hour:minute:second` on `date`, DST-safe through the UTC stamp. */
function at(date: string, hour: number, minute: number, second = 0): Date {
  return new Date(Date.parse(isoAt(date, ct(hour, minute))) + second * 1000);
}

const status = (r: { ok: true } | { ok: false; reason: Refusal }): string =>
  r.ok ? 'ok' : r.reason;

/** Each window's result and the labels' result, as one comparable object. */
const statuses = (b: DayAnalogBuild) => ({
  windows: b.windows.map(status),
  labels: status(b.labels),
});

describe('buildDayAnalogWindows', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads 07:30 CT to the bar after the close in UTC, across DST', async () => {
    const cases = [
      // CST before the March change, CDT after it, CST again on a half day.
      ['2026-03-06', '2026-03-06T13:30:00.000Z', '2026-03-06T21:01:00.000Z'],
      ['2026-03-09', '2026-03-09T12:30:00.000Z', '2026-03-09T20:01:00.000Z'],
      ['2026-11-27', '2026-11-27T13:30:00.000Z', '2026-11-27T18:01:00.000Z'],
    ] as const;
    for (const [date, start, end] of cases) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue([]);
      await buildDayAnalogWindows(date, at(date, 16, 0));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('ES', start, end);
    }
  });

  it('holds a window until 75 s after its end', async () => {
    mockFetch.mockResolvedValue([
      ...stored(DATE, OPEN - 60, flat(60)),
      ...stored(DATE, OPEN, flat(40)), // 08:30 - 09:09
    ]);
    const build = (second: number, minute = 1, hour = 9) =>
      buildDayAnalogWindows(DATE, at(DATE, hour, minute, second));

    // N = 30 ends 09:00; its bar after, 09:00, closes at 09:01.
    expect(statuses(await build(14))).toEqual({
      windows: ['ok', 'incomplete', 'incomplete'],
      labels: 'incomplete',
    });
    expect(statuses(await build(15))).toEqual({
      windows: ['ok', 'ok', 'incomplete'],
      labels: 'incomplete',
    });
    expect(statuses(await build(30, 9))).toEqual({
      windows: ['ok', 'ok', 'incomplete'],
      labels: 'incomplete',
    });

    mockFetch.mockResolvedValue(fullDayStored(DATE));
    expect(statuses(await build(14, 1, 15))).toEqual({
      windows: ['ok', 'ok', 'ok'],
      labels: 'incomplete',
    });
    expect(statuses(await build(15, 1, 15))).toEqual({
      windows: ['ok', 'ok', 'ok'],
      labels: 'ok',
    });

    // The half day ends at 12:00.
    const half = '2026-11-27';
    mockFetch.mockResolvedValue([
      ...stored(half, OPEN - 60, flat(60)),
      ...stored(half, OPEN, flat(211)), // 08:30 - 12:00
    ]);
    const buildHalf = (second: number) =>
      buildDayAnalogWindows(half, at(half, 12, 1, second));
    expect((await buildHalf(14)).labels).toEqual({
      ok: false,
      reason: 'incomplete',
    });
    expect((await buildHalf(15)).labels.ok).toBe(true);
  });

  it('drops the still-forming bar from the series', async () => {
    mockFetch.mockResolvedValue([
      ...stored(DATE, OPEN - 60, flat(60)),
      ...stored(DATE, OPEN, flat(15)), // 08:30 - 08:44, last close 6000
      // No 08:45 bar. 08:46 opens 20 pt above the 08:44 close.
      ...stored(DATE, ct(8, 46), flat(24, 6020)), // 08:46 - 09:09
    ]);
    const windows = async (minute: number, second: number) =>
      statuses(await buildDayAnalogWindows(DATE, at(DATE, 8, minute, second)))
        .windows;

    // The 08:46 bar finishes at 08:47, so at 08:46:30 it is still forming.
    expect(await windows(46, 30)).toEqual(['ok', 'incomplete', 'incomplete']);
    // At 08:47:00 it is kept and its gap flags the 15-minute window.
    expect(await windows(47, 0)).toEqual([
      'flagged',
      'incomplete',
      'incomplete',
    ]);
    // N = 15 is ready at 08:46:15, whatever the series holds.
    expect(await windows(46, 14)).toEqual([
      'incomplete',
      'incomplete',
      'incomplete',
    ]);
  });

  it('builds all three windows and labels after the close', async () => {
    mockFetch.mockResolvedValue(fullDayStored(DATE, 'ESZ6'));
    const built = await buildDayAnalogWindows(DATE, at(DATE, 15, 5));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(built.date).toBe(DATE);
    expect(statuses(built)).toEqual({
      windows: ['ok', 'ok', 'ok'],
      labels: 'ok',
    });
    const windows = built.windows.map(okWindow);
    expect(windows.map((w) => w.nMinutes)).toEqual([15, 30, 60]);
    expect(windows.map((w) => w.features.length)).toEqual([15, 30, 60]);
    // Text prices and the volume reach the core as numbers.
    expect(windows.map((w) => [w.open, w.volume, w.bars, w.contract])).toEqual([
      [6000, 1500, 15, 'ESZ6'],
      [6000, 3000, 30, 'ESZ6'],
      [6000, 6000, 60, 'ESZ6'],
    ]);
    expect(okLabels(built.labels)).toEqual({
      open: 6000,
      high: 6040,
      low: 5980,
      close: 6010,
      rangePt: 60,
      upExc: 40,
      downExc: 20,
    });
  });

  it('uses the current time when asOf is omitted', async () => {
    mockFetch.mockResolvedValue(fullDayStored(DATE));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(DATE, 9, 9, 30));
    expect(statuses(await buildDayAnalogWindows(DATE))).toEqual({
      windows: ['ok', 'ok', 'incomplete'],
      labels: 'incomplete',
    });
  });

  it('skips the read on a holiday', async () => {
    const built = await buildDayAnalogWindows(
      '2026-11-26', // Thanksgiving
      at('2026-11-27', 16, 0),
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(built).toEqual({
      date: '2026-11-26',
      windows: ANALOG_WINDOW_MINUTES.map((nMinutes) => ({
        ok: false,
        nMinutes,
        reason: 'not_trading_day',
      })),
      labels: { ok: false, reason: 'not_trading_day' },
    });
  });

  it('refuses a bar whose price text is malformed', async () => {
    const day = fullDayStored(DATE);
    const corrupt = (ctMinutes: number): StoredFuturesBar[] =>
      day.map((b) =>
        b.ts === isoAt(DATE, ctMinutes) ? { ...b, close: 'abc' } : b,
      );

    // 08:35 is inside every window and the session.
    mockFetch.mockResolvedValue(corrupt(ct(8, 35)));
    expect(await buildDayAnalogWindows(DATE, at(DATE, 15, 5))).toEqual({
      date: DATE,
      windows: ANALOG_WINDOW_MINUTES.map((nMinutes) => ({
        ok: false,
        nMinutes,
        reason: 'bad_bar',
      })),
      labels: { ok: false, reason: 'bad_bar' },
    });

    // 10:00 is past every window: only the labels read it.
    mockFetch.mockResolvedValue(corrupt(ct(10, 0)));
    const late = await buildDayAnalogWindows(DATE, at(DATE, 15, 5));
    expect(statuses(late)).toEqual({
      windows: ['ok', 'ok', 'ok'],
      labels: 'bad_bar',
    });
    for (const w of late.windows.map(okWindow)) {
      expect(w.features.every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects when the database read fails', async () => {
    const failure = new Error('neon down');
    mockFetch.mockRejectedValue(failure);

    await expect(buildDayAnalogWindows(DATE, at(DATE, 15, 5))).rejects.toBe(
      failure,
    );
  });
});
