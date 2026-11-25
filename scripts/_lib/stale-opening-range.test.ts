// @vitest-environment node

/**
 * The pure part of the stale opening-range repair
 * (scripts/repair-stale-opening-range.ts -> ./stale-opening-range.ts): which
 * stored rows are stale against their own date's candles, what a repair writes,
 * the date-own-range path for dates before Schwab's candles, the report and the
 * arguments. The SQL runs in stale-opening-range-pglite.test.ts.
 *
 * One session of 5-minute bars on 2026-05-01 (EDT: 9:30 ET is 13:30Z), whose
 * 9:30-10:00 ET bars give, by slot (CT):
 *   8:30  none ended, floor = the open 7180; with the running bar 7186 / 7175
 *   8:35  7186 / 7175 as of, 7190 / 7175 with the running bar
 *   8:40  7190 / 7175 as of, 7194 / 7175 with the running bar
 *   8:45  7194 / 7175 as of, 7198 / 7175 with the running bar
 *   8:55  7200 / 7175 as of, 7203 / 7175 with the running bar
 *   9:00 and later: 7203 / 7175, complete
 * A previous session's range (7170.52 / 7130.33, 04-30's) is below all of it.
 */

import { describe, expect, it } from 'vitest';

import { parseEntryTimeMinutes } from '../../src/utils/entry-time.js';
import type { SlotCandle } from '../../src/utils/snapshot-slot.js';
import {
  formatApplyReport,
  formatReport,
  parseArgs,
  planDate,
  STALE_TOLERANCE,
  summarize,
  type DatePlan,
  type RangeRow,
  type RowResult,
} from './stale-opening-range.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DATE = '2026-05-01';
const OPEN_MS = Date.UTC(2026, 4, 1, 13, 30);
const FIVE = 5 * 60_000;

/** [open, high, low, close] of each 5-minute bar from 9:30 ET. */
const BAR_PRICES: ReadonlyArray<readonly [number, number, number, number]> = [
  [7180, 7186, 7175, 7183], // 9:30
  [7183, 7190, 7181, 7188], // 9:35
  [7188, 7194, 7186, 7192], // 9:40
  [7192, 7198, 7189, 7195], // 9:45
  [7195, 7200, 7192, 7197], // 9:50
  [7197, 7203, 7194, 7201], // 9:55
  [7201, 7210, 7199, 7208], // 10:00
  [7208, 7212, 7205, 7210], // 10:05
];

const CANDLES: SlotCandle[] = BAR_PRICES.map(([open, high, low, close], i) => ({
  datetime: OPEN_MS + i * FIVE,
  open,
  high,
  low,
  close,
}));

const STALE = { high: '7170.52', low: '7130.33' };
/** The close of the session before DATE, as /api/history reports it. */
const PREVIOUS_CLOSE = 7150;

let nextId = 1;

/** A market_snapshots row as the script reads it: DECIMALs as text. */
function row(
  entry: string,
  over: Partial<RangeRow> = {},
  date = DATE,
): RangeRow {
  const slot = parseEntryTimeMinutes(entry);
  return {
    id: nextId++,
    date,
    entry_time: entry,
    spx: '7185.00',
    spx_open: '7180.00',
    spx_high: '7300.00',
    spx_low: '7170.00',
    prev_close: PREVIOUS_CLOSE.toFixed(2),
    median_hl_pct: '0.8800',
    opening_range_high: STALE.high,
    opening_range_low: STALE.low,
    opening_range_pct_consumed: '0.5000',
    opening_range_signal: 'MODERATE',
    is_backtest: false,
    flag_reliable: true,
    missing_yesterday: false,
    saved_day_offset: 0,
    saved_minutes_ct: Number.isNaN(slot) ? 600 : slot,
    ...over,
  };
}

const withRange = (high: string | null, low: string | null) => ({
  opening_range_high: high,
  opening_range_low: low,
});

function plan(
  rows: readonly RangeRow[],
  candles = CANDLES,
  previousClose: number | null = PREVIOUS_CLOSE,
): DatePlan {
  return planDate({ date: DATE, rows, candles, feature: null, previousClose });
}

function resultOf(p: DatePlan, id: number): RowResult {
  const found = p.rows.find((r) => r.row.id === id);
  if (found == null) throw new Error(`no result for row ${id}`);
  return found;
}

// ── Whole-day stale: a tab left open (05-22, 11-12, 11-16) ──────────────────

describe('a whole day carrying the previous session’s range', () => {
  const rows = [
    row('9:00 AM CT', { id: 101, spx: '7195.00' }),
    row('9:05 AM CT', { id: 102, spx: '7200.00' }),
    row('10:00 AM CT', { id: 103, spx: '7205.00' }),
    row('1:00 PM CT', { id: 104, spx: '7190.00' }),
  ];

  it('repairs every row to the complete range, with the consumed and signal recomputed', () => {
    const p = plan(rows);

    for (const id of [101, 102, 103, 104]) {
      const r = resultOf(p, id);
      expect(r.kind, String(id)).toBe('repair');
      if (r.kind !== 'repair') continue;
      expect(r.after.high).toBe('7203.00');
      expect(r.after.low).toBe('7175.00');
    }
    const first = resultOf(p, 101);
    // (7203 - 7175) / 7195 * 100 / 0.88 = 0.4422 on a 0.88 median.
    expect(first).toMatchObject({
      before: {
        high: '7170.52',
        low: '7130.33',
        consumed: '0.5000',
        signal: 'MODERATE',
      },
      after: { consumed: '0.4422', signal: 'MODERATE' },
    });
    expect(summarize([p])).toMatchObject({ repairs: 4, stale: 4 });
  });

  it('grades each row on its own spot and median', () => {
    const p = plan([
      row('9:00 AM CT', { id: 111, spx: '7195.00', median_hl_pct: '2.0000' }),
    ]);

    // The same range over a median of 2 is 0.1946: GREEN, not MODERATE.
    expect(resultOf(p, 111)).toMatchObject({
      kind: 'repair',
      after: { consumed: '0.1946', signal: 'GREEN' },
    });
  });
});

// ── Morning stale until a reload (05-01, 05-07, 08-03) ──────────────────────

describe('a morning of rows carrying the previous session’s range', () => {
  const rows = [
    row('8:30 AM CT', { id: 201 }),
    row('8:35 AM CT', { id: 202, spx: '7185.00' }),
    row('8:40 AM CT', { id: 203, spx: '7186.00' }),
    row('8:55 AM CT', { id: 204, spx: '7190.00' }),
    row('9:10 AM CT', { id: 205, spx: '7200.00' }),
  ];

  it('repairs each row to the range as of its own slot', () => {
    const p = plan(rows);

    expect(resultOf(p, 202)).toMatchObject({
      kind: 'repair',
      // 8:35 CT: the 9:30 bar has ended, the 9:35 one is running.
      after: { high: '7186.00', low: '7175.00', consumed: '0.1740' },
    });
    expect(resultOf(p, 203)).toMatchObject({
      after: { high: '7190.00', low: '7175.00', consumed: '0.2372' },
    });
    expect(resultOf(p, 204)).toMatchObject({
      after: { high: '7200.00', low: '7175.00', consumed: '0.3951' },
    });
    // 9:10 CT is past 10:00 ET: the whole opening range.
    expect(resultOf(p, 205)).toMatchObject({
      after: { high: '7203.00', low: '7175.00', consumed: '0.4419' },
    });
  });

  it('sets all four columns to NULL at 8:30 CT, where no bar has ended', () => {
    const r = resultOf(plan(rows), 201);

    expect(r).toMatchObject({
      kind: 'repair',
      after: { high: null, low: null, consumed: null, signal: null },
    });
  });

  it('grades GREEN before 9:00 CT on a small partial range, as the live card did', () => {
    // 8:35 CT: 11 points over 7185 on a 0.88 median is 0.174.
    expect(resultOf(plan(rows), 202)).toMatchObject({
      after: { signal: 'GREEN' },
    });
  });
});

// ── One stale same-day save (03-27, 8:45 CT) ────────────────────────────────

describe('a single stale save among good ones', () => {
  it('repairs the 8:45 row and leaves a row that holds the as-of range alone', () => {
    const stale = row('8:45 AM CT', { id: 301, spx: '7192.00' });
    const good = row('9:00 AM CT', {
      id: 302,
      ...withRange('7203.00', '7175.00'),
      spx: '7195.00',
    });

    const p = plan([stale, good]);

    expect(resultOf(p, 301)).toMatchObject({
      kind: 'repair',
      // 8:45 CT: bars 9:30, 9:35, 9:40 ended.
      after: { high: '7194.00', low: '7175.00' },
    });
    expect(resultOf(p, 302).kind).toBe('ok');
  });
});

// ── The band: as-of up to the bar running at the slot ───────────────────────

describe('the stale test', () => {
  it('leaves a live row that saw the running bar alone, and counts it as an as-of rebase', () => {
    // 8:35 CT: as of 7186 / 7175, with the 9:35 bar running 7190 / 7175.
    const live = row('8:35 AM CT', {
      id: 401,
      ...withRange('7190.00', '7175.00'),
    });

    const r = resultOf(plan([live]), 401);

    expect(r.kind).toBe('rebase');
    expect(summarize([plan([live])])).toMatchObject({ rebase: 1, repairs: 0 });
  });

  it('leaves a row holding exactly the as-of range alone, uncounted', () => {
    const exact = row('8:35 AM CT', {
      id: 402,
      ...withRange('7186.00', '7175.00'),
    });

    expect(resultOf(plan([exact]), 402).kind).toBe('ok');
  });

  it.each([
    // [label, high, low, stale]; 8:35 CT band: high [7186, 7190], low [7175, 7175]
    ['a high 0.05 under the floor', '7185.95', '7175.00', false],
    ['a high 0.06 under the floor', '7185.94', '7175.00', true],
    ['a high 0.05 over the running bar', '7190.05', '7175.00', false],
    ['a high 0.06 over the running bar', '7190.06', '7175.00', true],
    ['a low 0.05 under the running bar', '7186.00', '7174.95', false],
    ['a low 0.06 under the running bar', '7186.00', '7174.94', true],
    ['a low 0.05 over the as-of low', '7186.00', '7175.05', false],
    ['a low 0.06 over the as-of low', '7186.00', '7175.06', true],
  ])('%s', (_label, high, low, stale) => {
    const r = resultOf(
      plan([row('8:35 AM CT', { id: 410, ...withRange(high, low) })]),
      410,
    );

    expect(r.kind === 'repair').toBe(stale);
    expect(STALE_TOLERANCE).toBe(0.05);
  });

  it('judges a row from 10:00 ET on against the one complete range: no running bar to allow', () => {
    // 9:00 CT: 7203 / 7175 exactly, with nothing running that counts.
    const partial = row('9:00 AM CT', {
      id: 420,
      ...withRange('7200.00', '7175.00'),
    });

    expect(resultOf(plan([partial]), 420).kind).toBe('repair');
  });

  it('at 8:30 CT, calls a range inside [open, first bar] live and one outside stale', () => {
    // The open is 7180, the first bar 7186 / 7175: a live save saw a partial bar.
    const inside = row('8:30 AM CT', {
      id: 430,
      ...withRange('7183.00', '7178.00'),
    });
    const outside = row('8:30 AM CT', {
      id: 431,
      ...withRange('7170.52', '7130.33'),
    });

    const p = plan([inside, outside]);

    expect(resultOf(p, 430).kind).toBe('rebase');
    expect(resultOf(p, 431).kind).toBe('repair');
  });
});

// ── Rows it must not grade or write ─────────────────────────────────────────

describe('rows left alone, each named', () => {
  it('lists a stale row with a NULL median on its own and writes nothing to it', () => {
    const p = plan([row('9:00 AM CT', { id: 501, median_hl_pct: null })]);

    expect(resultOf(p, 501)).toMatchObject({
      kind: 'skip',
      reason: 'null-median',
      stale: true,
    });
    expect(summarize([p])).toMatchObject({ nullMedian: 1, repairs: 0 });
  });

  it('does not list a NULL-median row whose range is fine', () => {
    const fine = row('9:00 AM CT', {
      id: 502,
      median_hl_pct: null,
      ...withRange('7203.00', '7175.00'),
    });

    expect(resultOf(plan([fine]), 502).kind).toBe('ok');
    expect(summarize([plan([fine])]).nullMedian).toBe(0);
  });

  it.each([
    ['NULL', null],
    ['0', '0.00'],
    ['NaN', 'NaN'],
  ])('does not grade a stale row whose spot is %s', (_label, spx) => {
    expect(
      resultOf(plan([row('9:00 AM CT', { id: 510, spx })]), 510),
    ).toMatchObject({ kind: 'skip', reason: 'no-spot', stale: true });
  });

  it('skips a row with no stored range', () => {
    expect(
      resultOf(
        plan([row('9:00 AM CT', { id: 520, ...withRange(null, null) })]),
        520,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'no-stored-range' });
  });

  it.each([
    ['one side NULL', '7203.00', null],
    ['a stored NaN', 'NaN', '7175.00'],
  ])('skips a row with an unreadable stored range: %s', (_label, high, low) => {
    expect(
      resultOf(
        plan([row('9:00 AM CT', { id: 530, ...withRange(high, low) })]),
        530,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'unreadable-stored-range' });
  });

  it('skips the pre-market row, which has no slot', () => {
    expect(resultOf(plan([row('pre-market', { id: 540 })]), 540)).toMatchObject(
      { kind: 'skip', reason: 'no-slot' },
    );
  });

  it('skips a slot before the open, which the as-of rule cannot read', () => {
    expect(resultOf(plan([row('8:00 AM CT', { id: 550 })]), 550)).toMatchObject(
      { kind: 'skip', reason: 'no-as-of-state' },
    );
  });

  it('skips every row of a date whose first bar is not 9:30 ET: the as-of rule has no state', () => {
    const late = CANDLES.slice(1);

    expect(
      resultOf(plan([row('9:00 AM CT', { id: 560 })], late), 560),
    ).toMatchObject({ kind: 'skip', reason: 'no-as-of-state' });
  });

  it('does not write a consumed value the column cannot hold', () => {
    // 28 points over 7195 on a median of 0.0001 is about 3,900: past DECIMAL(6,4).
    expect(
      resultOf(
        plan([row('9:00 AM CT', { id: 570, median_hl_pct: '0.0001' })]),
        570,
      ),
    ).toMatchObject({ kind: 'skip', reason: 'consumed-overflow', stale: true });
  });
});

// ── Dates before Schwab's candles: the date's own range ─────────────────────

describe('a date before the candles, from its own rows (the Feb replay artifacts)', () => {
  const OWN = { high: '6981.59', low: '6956.78' };
  const PREVIOUS = { high: '6938.54', low: '6905.87' };
  const feb = (entry: string, over: Partial<RangeRow> = {}) =>
    row(
      entry,
      { ...withRange(OWN.high, OWN.low), spx: '6960.00', ...over },
      '2026-02-10',
    );
  const febPlan = (rows: readonly RangeRow[]) =>
    planDate({
      date: '2026-02-10',
      rows,
      candles: null,
      feature: null,
      previousClose: PREVIOUS_CLOSE,
    });

  it('repairs the stale 2:55 PM row to the range the date’s other rows hold', () => {
    const rows = [
      feb('9:05 AM CT', { id: 601 }),
      feb('10:00 AM CT', { id: 602 }),
      feb('11:00 AM CT', { id: 603 }),
      feb('2:55 PM CT', { id: 604, ...withRange(PREVIOUS.high, PREVIOUS.low) }),
    ];

    const p = febPlan(rows);

    expect(p.source).toBe('own-range');
    expect(resultOf(p, 604)).toMatchObject({
      kind: 'repair',
      after: { high: '6981.59', low: '6956.78' },
    });
    // (6981.59 - 6956.78) / 6960 * 100 / 0.88 = 0.4051
    expect(resultOf(p, 604)).toMatchObject({
      after: { consumed: '0.4051', signal: 'MODERATE' },
    });
    for (const id of [601, 602, 603]) {
      expect(resultOf(p, id).kind, String(id)).toBe('ok');
    }
  });

  it('reports a row before 10:00 ET that differs, and does not repair it: a partial range has no candles to come from', () => {
    const rows = [
      feb('9:05 AM CT', { id: 611 }),
      feb('10:00 AM CT', { id: 612 }),
      feb('8:45 AM CT', { id: 613, ...withRange(PREVIOUS.high, PREVIOUS.low) }),
    ];

    expect(resultOf(febPlan(rows), 613)).toMatchObject({
      kind: 'skip',
      reason: 'early-slot-no-candles',
    });
  });

  it('repairs nothing when no range is the date’s own: a tie, or one row alone', () => {
    const tie = [
      feb('9:05 AM CT', { id: 621 }),
      feb('10:00 AM CT', {
        id: 622,
        ...withRange(PREVIOUS.high, PREVIOUS.low),
      }),
    ];
    const alone = [feb('10:00 AM CT', { id: 623 })];

    expect(resultOf(febPlan(tie), 622)).toMatchObject({
      kind: 'skip',
      reason: 'ambiguous-own-range',
    });
    expect(resultOf(febPlan(alone), 623)).toMatchObject({
      kind: 'skip',
      reason: 'ambiguous-own-range',
    });
  });

  it('lets only rows from 10:00 ET on vote for the date’s own range: three partial-range rows do not outvote two complete ones', () => {
    const rows = [
      feb('9:00 AM CT', { id: 651 }),
      feb('10:00 AM CT', { id: 652 }),
      feb('11:00 AM CT', {
        id: 653,
        ...withRange(PREVIOUS.high, PREVIOUS.low),
      }),
      feb('8:35 AM CT', { id: 654, ...withRange('6950.00', '6940.00') }),
      feb('8:40 AM CT', { id: 655, ...withRange('6950.00', '6940.00') }),
      feb('8:45 AM CT', { id: 656, ...withRange('6950.00', '6940.00') }),
    ];

    const p = febPlan(rows);

    expect(resultOf(p, 653)).toMatchObject({
      kind: 'repair',
      after: { high: '6981.59', low: '6956.78' },
    });
    for (const id of [654, 655, 656]) {
      expect(resultOf(p, id), String(id)).toMatchObject({
        kind: 'skip',
        reason: 'early-slot-no-candles',
      });
    }
  });

  it('repairs nothing when two ranges tie for the most rows, whichever row is asked', () => {
    const rows = [
      feb('9:05 AM CT', { id: 641 }),
      feb('10:00 AM CT', { id: 642 }),
      feb('11:00 AM CT', {
        id: 643,
        ...withRange(PREVIOUS.high, PREVIOUS.low),
      }),
      feb('2:55 PM CT', { id: 644, ...withRange(PREVIOUS.high, PREVIOUS.low) }),
    ];

    const p = febPlan(rows);

    for (const id of [641, 642, 643, 644]) {
      expect(resultOf(p, id), String(id)).toMatchObject({
        kind: 'skip',
        reason: 'ambiguous-own-range',
      });
    }
  });

  it('still lists a stale row with a NULL median, and writes nothing', () => {
    const rows = [
      feb('9:05 AM CT', { id: 631 }),
      feb('10:00 AM CT', { id: 632 }),
      feb('2:55 PM CT', {
        id: 633,
        ...withRange(PREVIOUS.high, PREVIOUS.low),
        median_hl_pct: null,
      }),
    ];

    expect(resultOf(febPlan(rows), 633)).toMatchObject({
      kind: 'skip',
      reason: 'null-median',
    });
  });
});

// ── training_features follows the repaired pick ─────────────────────────────

describe('the feature row', () => {
  const feature = {
    opening_range_signal: 'MODERATE',
    opening_range_pct_consumed: '0.5000',
  };
  const pickRows = () => [
    // The pick is the row nearest 10:00 CT: this one, stale and repairable.
    row('10:00 AM CT', { id: 701, spx: '7195.00' }),
    row('9:00 AM CT', { id: 702, spx: '7195.00' }),
  ];
  const run = (rows: readonly RangeRow[], f: typeof feature | null) =>
    planDate({
      date: DATE,
      rows,
      candles: CANDLES,
      feature: f,
      previousClose: PREVIOUS_CLOSE,
    });

  it('copies the repaired pick row’s signal and consumed when the features hold the old ones', () => {
    const p = run(pickRows(), feature);

    expect(p.feature).toEqual({
      kind: 'copy',
      rowId: 701,
      before: { signal: 'MODERATE', consumed: '0.5000' },
      after: { signal: 'MODERATE', consumed: '0.4422' },
    });
  });

  it('copies nothing when the features hold values that are not the pick row’s old ones', () => {
    const p = run(pickRows(), {
      ...feature,
      opening_range_pct_consumed: '0.3000',
    });

    expect(p.feature).toEqual({ kind: 'out-of-sync', rowId: 701 });
  });

  it('has no features row to update when there is none', () => {
    expect(run(pickRows(), null).feature).toEqual({
      kind: 'no-features-row',
      rowId: 701,
    });
  });

  it('copies nothing when the pick row was not repaired', () => {
    const fine = [
      row('10:00 AM CT', { id: 711, ...withRange('7203.00', '7175.00') }),
      row('9:00 AM CT', { id: 712 }),
    ];

    expect(run(fine, feature).feature).toEqual({ kind: 'none' });
  });
});

// ── The previous session: reported, never repaired ──────────────────────────

describe('the stored previous close (the spec’s known limit)', () => {
  it.each([
    ['3.00 under the real close', '7147.00', false],
    ['3.01 under the real close', '7146.99', true],
    ['3.00 over the real close', '7153.00', false],
    ['3.01 over the real close', '7153.01', true],
    ['a week-early close, 363.66 off', '7513.66', true],
    ['a stored NaN', 'NaN', true],
  ])('%s', (_label, stored, off) => {
    const r = row('10:00 AM CT', {
      id: 901,
      prev_close: stored,
      ...withRange('7203.00', '7175.00'),
    });

    const check = plan([r]).previousClose;

    expect(check?.expected).toBe(PREVIOUS_CLOSE);
    expect(check?.off).toEqual(
      off ? [{ id: 901, entryTime: '10:00 AM CT', stored }] : [],
    );
  });

  it('does not list a row with no stored previous close: there is nothing stored to be wrong', () => {
    const r = row('10:00 AM CT', {
      id: 902,
      prev_close: null,
      ...withRange('7203.00', '7175.00'),
    });

    expect(plan([r]).previousClose?.off).toEqual([]);
  });

  it('lists a row and repairs its range as two separate matters: the range write never touches prev_close', () => {
    const r = row('9:00 AM CT', { id: 903, prev_close: '7513.66' });

    const p = plan([r]);

    expect(p.previousClose?.off.map((o) => o.id)).toEqual([903]);
    expect(resultOf(p, 903)).toMatchObject({ kind: 'repair' });
    expect(resultOf(p, 903)).not.toHaveProperty('after.prev_close');
  });

  it('says the check was not run when /api/history did not report the previous session', () => {
    const r = row('10:00 AM CT', { id: 904, prev_close: '7513.66' });

    const p = plan([r], CANDLES, null);

    expect(p.previousClose).toEqual({ expected: null, off: [] });
    expect(summarize([p])).toMatchObject({
      prevCloseOff: 0,
      datesPrevUnreported: 1,
    });
  });

  it('does not check a date with no candles: its history was never asked', () => {
    const p = planDate({
      date: '2026-02-10',
      rows: [row('10:00 AM CT', { id: 905, prev_close: '7513.66' })],
      candles: null,
      feature: null,
      previousClose: null,
    });

    expect(p.previousClose).toBeNull();
    expect(summarize([p])).toMatchObject({
      prevCloseOff: 0,
      datesPrevUnreported: 0,
    });
  });

  it('counts the listed rows in the summary and prints them under their date, with the real close', () => {
    const rows = [
      row('9:00 AM CT', { id: 906, prev_close: '7513.66' }),
      row('9:05 AM CT', { id: 907, prev_close: '7513.66' }),
      row('9:10 AM CT', { id: 908 }),
    ];
    const p = plan(rows);

    const text = formatReport({ apply: false, dates: [p], backupFile: null });

    expect(summarize([p]).prevCloseOff).toBe(2);
    expect(text).toMatch(/prev_close/);
    const line = text
      .split('\n')
      .find((l) => l.includes('real previous close'));
    expect(line).toContain('2026-05-01: real previous close 7150.00');
    expect(line).toContain('2 rows off (first stored 7513.66): ids 906, 907');
    expect(line).not.toContain('908');
  });

  it('prints the dates whose previous session was not reported', () => {
    const p = plan([row('10:00 AM CT', { id: 909 })], CANDLES, null);

    const text = formatReport({ apply: false, dates: [p], backupFile: null });

    expect(text).toMatch(/previous session not reported[^\n]*2026-05-01/i);
  });
});

// ── The report ──────────────────────────────────────────────────────────────

describe('the dry-run report', () => {
  const rows = [
    row('8:35 AM CT', { id: 801, spx: '7185.00' }),
    row('9:00 AM CT', { id: 802, spx: '7195.00', median_hl_pct: null }),
    row('9:05 AM CT', { id: 803, ...withRange('7203.00', '7175.00') }),
    row('8:40 AM CT', { id: 804, ...withRange('7192.00', '7175.00') }),
  ];
  const text = formatReport({
    apply: false,
    dates: [plan(rows)],
    backupFile: null,
  });

  it('says it wrote nothing', () => {
    expect(text).toMatch(/DRY RUN/);
    expect(text).not.toMatch(/APPLIED/);
  });

  it('prints each repaired row’s old and new values with the candles it used', () => {
    // Row 801: stored 7170.52 / 7130.33, as of 8:35 CT 7186.00 / 7175.00.
    expect(text).toContain('id 801');
    expect(text).toContain('7170.52');
    expect(text).toContain('7186.00');
    expect(text).toContain('0.1740');
    // The bars it came from: 9:30 ET ended by 9:35 ET; the 9:35 bar is running.
    expect(text).toContain('9:30');
    expect(text).toContain('o7180.00 h7186.00 l7175.00 c7183.00');
    expect(text).toMatch(/9:35.*running/);
    // The inputs of the grade.
    expect(text).toContain('spx 7185.00');
    expect(text).toContain('median 0.8800');
  });

  it('lists the NULL-median row on its own, with a note that nothing is written to it', () => {
    expect(text).toMatch(/NULL median_hl_pct/i);
    expect(text).toContain('id 802');
  });

  it('counts the as-of rebase and the rows left alone', () => {
    expect(text).toMatch(/as-of rebase[^\n]*1/i);
  });

  it('prints the counts by column', () => {
    expect(text).toMatch(/opening_range_high[^\n]*1/);
    expect(text).toMatch(/opening_range_signal[^\n]*1/);
  });

  it('names a date it could not read and why', () => {
    const failed: DatePlan = {
      date: '2026-05-04',
      source: 'skipped',
      skipped: 'history-failed',
      detail: 'HTTP 502 (schwab_fetch_failed)',
      rows: [],
      feature: { kind: 'none' },
      previousClose: null,
    };

    const out = formatReport({
      apply: false,
      dates: [failed],
      backupFile: null,
    });

    expect(out).toContain('2026-05-04');
    expect(out).toContain('HTTP 502 (schwab_fetch_failed)');
  });

  it('says APPLIED, and where the backup is, after a write', () => {
    const out = formatApplyReport({
      backupFile: 'docs/tmp/stale-opening-range/backup-x.json',
      planned: 3,
      written: 2,
      changedSinceRead: [7],
      featuresPlanned: 1,
      featuresWritten: 1,
    });

    expect(out).toContain('APPLIED');
    expect(out).toContain('docs/tmp/stale-opening-range/backup-x.json');
    expect(out).toContain('2 of 3');
    expect(out).toContain('7');
  });
});

// ── The arguments ───────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('is a dry run by default, over every date', () => {
    expect(parseArgs([])).toMatchObject({
      apply: false,
      date: null,
      all: false,
      since: null,
      until: null,
      undoFile: null,
    });
  });

  it('limits a run to one date', () => {
    expect(parseArgs(['--date', '2026-11-16'])).toMatchObject({
      date: '2026-11-16',
    });
  });

  it('refuses --apply without --date or --all: it names what to write', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/--date.*--all/);
  });

  it('takes --apply with one date, or with --all', () => {
    expect(parseArgs(['--apply', '--date', '2026-11-16']).apply).toBe(true);
    expect(parseArgs(['--apply', '--all']).apply).toBe(true);
  });

  it('refuses --date together with --all, --since or --until', () => {
    expect(() => parseArgs(['--date', '2026-11-16', '--all'])).toThrow();
    expect(() =>
      parseArgs(['--date', '2026-11-16', '--since', '2026-11-01']),
    ).toThrow();
    expect(() =>
      parseArgs(['--date', '2026-11-16', '--until', '2026-11-30']),
    ).toThrow();
  });

  it.each(['2026-13-01', '2026-11-31', '20261116', 'tomorrow', ''])(
    'refuses %j as a date',
    (value) => {
      expect(() => parseArgs(['--date', value])).toThrow(/date/i);
    },
  );

  it('refuses an unknown argument and a flag with no value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown/i);
    expect(() => parseArgs(['--date'])).toThrow(/value|needs/i);
  });

  it('takes an undo file, and --apply with it needs no date', () => {
    expect(parseArgs(['--undo-file', 'b.json'])).toMatchObject({
      undoFile: 'b.json',
      apply: false,
    });
    expect(parseArgs(['--undo-file', 'b.json', '--apply']).apply).toBe(true);
  });

  it('refuses --dry-run together with --apply', () => {
    expect(() => parseArgs(['--dry-run', '--apply', '--all'])).toThrow();
  });

  it('reads --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
